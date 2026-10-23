import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  type CloudflareCommandResult,
  type CloudflareOperation,
  type CloudflareVersionActivation,
  type CloudflareVersionActivationOptions,
  parseCloudflareVersionMessage,
} from '@void/deploy-cloudflare';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vite-plus/test';
import { CloudflareArtifactError } from '../../src/cli/cf-artifact-files.ts';
import { packageCloudflareArtifact } from '../../src/cli/cf-artifact-package.ts';
import {
  CloudflareArtifactPublishError,
  type PublishCloudflareArtifactOptions,
  publishCloudflareArtifact,
} from '../../src/cli/cf-artifact-publish.ts';
import { CloudflareArtifactTargetError } from '../../src/cli/cf-artifact-target.ts';
import type { DeployWranglerRun } from '../../src/cli/deploy-types.ts';
import { WRANGLER_AUTH_CREDENTIAL_ENV_VARS } from '../../src/shared/untrusted-env.ts';
import {
  SECRET_VALUES,
  MIGRATIONS,
  SEED_SQL,
  WRANGLER_CONFIG,
  makeRequirements,
  makeTarget,
  PROVENANCE,
  writeBuiltProject,
  copyArtifact as copyFixtureArtifact,
  rehashArtifact,
  pathsUnder,
} from '../helpers/cf-artifact.ts';

// Record the workspace of every successful staging, so tests can check that publish removed it.
// Listing the temp directory instead would race with the staging tests running in parallel.
const staging = vi.hoisted(() => ({ workspaces: [] as Array<string> }));

vi.mock('../../src/cli/cf-artifact-stage.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/cf-artifact-stage.ts')>();
  return {
    ...actual,
    stageCloudflareArtifact: async (...args: Parameters<typeof actual.stageCloudflareArtifact>) => {
      const staged = await actual.stageCloudflareArtifact(...args);
      staging.workspaces.push(staged.workspace);
      return staged;
    },
  };
});

const isWindows = process.platform === 'win32';
// Packaging runs the real cf config codemod, so each fixture build gets the packaging timeout.
const FIXTURE_TIMEOUT_MS = isWindows ? 90_000 : 30_000;

const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const BUNDLE_MODULE = '.cloudflare/output/v0/workers/default/bundle/index.js';
const D1_DATABASE_NAME = 'preview-42-db';

// Every Cloudflare credential and transport selector, cleared so a developer's shell cannot reach
// a real account or change the API base.
const CLOUDFLARE_ENV_VARS = [
  ...WRANGLER_AUTH_CREDENTIAL_ENV_VARS,
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_BASE_URL',
  'CF_API_BASE_URL',
  'CLOUDFLARE_COMPLIANCE_REGION',
  'CLOUDFLARE_ENV',
  'CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH',
  'CLOUDFLARE_WORKERS_SUBDOMAIN',
  'WRANGLER_API_ENVIRONMENT',
  'CF_ACCESS_CLIENT_ID',
  'CF_ACCESS_CLIENT_SECRET',
  'CF_ACCESS_TOKEN',
  'CF_ACCESS_READINESS_ORIGIN',
];

const REQUIREMENTS = makeRequirements();
const D1 = REQUIREMENTS.d1!;
const NO_D1_REQUIREMENTS = makeRequirements({ d1: null, seed: false });
const TARGET = makeTarget();
const NO_D1_TARGET = makeTarget({ bindings: { KV: TARGET.bindings.KV }, seed: false });
const WRANGLER_CONFIG_WITHOUT_D1 = { ...WRANGLER_CONFIG, d1_databases: undefined };

const READY_ACTIVATION: CloudflareVersionActivation = {
  ok: true,
  versionId: 'version-2',
  previewUrl: 'https://void-preview-42-version-2.preview-tests.workers.dev',
  previousVersionId: 'version-1',
};

const roots: Array<string> = [];
let fixtureRoot = '';
let baseArtifact = '';
let noD1Artifact = '';

beforeAll(async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'void-cf-artifact-publish-fixture-'));
  const project = writeBuiltProject(join(fixtureRoot, 'app'), WRANGLER_CONFIG);
  baseArtifact = join(fixtureRoot, 'artifact');
  await packageCloudflareArtifact({
    ...project,
    outDir: baseArtifact,
    requirements: REQUIREMENTS,
    provenance: PROVENANCE,
  });

  const noD1Project = writeBuiltProject(join(fixtureRoot, 'app-no-d1'), WRANGLER_CONFIG_WITHOUT_D1);
  noD1Artifact = join(fixtureRoot, 'artifact-no-d1');
  await packageCloudflareArtifact({
    workerDirectory: noD1Project.workerDirectory,
    outDir: noD1Artifact,
    requirements: NO_D1_REQUIREMENTS,
    provenance: PROVENANCE,
  });
}, FIXTURE_TIMEOUT_MS * 2);

beforeEach(() => {
  for (const name of CLOUDFLARE_ENV_VARS) {
    vi.stubEnv(name, undefined);
  }
  staging.workspaces.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const workspace of staging.workspaces) {
    expect(existsSync(workspace)).toBe(false);
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-artifact-publish-test-'));
  roots.push(root);
  return root;
}

/** A private copy of the base artifact, which one test may change. */
function copyArtifact(): string {
  return copyFixtureArtifact(baseArtifact, join(tempRoot(), 'artifact'));
}

/** A copy of the base artifact with D1 and no migrations folder, re-signed for an empty migration list. */
function copyArtifactWithoutMigrations(): string {
  const dir = copyArtifact();
  rmSync(join(dir, 'migrations'), { recursive: true, force: true });
  rehashArtifact(dir, { ...REQUIREMENTS, d1: { ...D1, migrations: [], journal: false } });
  return dir;
}

type ActivationOptions = CloudflareVersionActivationOptions;

type FakeOptions = {
  /** Make `auth.whoami` report no session. */
  authenticated?: boolean;
  /** Make `d1.migrations.apply` fail. */
  failApply?: boolean;
  /** Make `d1.execute` fail, and echo the SQL in its error the way a CLI can. */
  failExecute?: boolean;
  executeFailure?: string;
  activation?: CloudflareVersionActivation;
  /** Called with each operation before it is answered. */
  onOperation?: (operation: CloudflareOperation) => void;
};

type Fake = {
  deps: NonNullable<PublishCloudflareArtifactOptions['deps']>;
  operations: Array<CloudflareOperation>;
  activations: Array<ActivationOptions>;
  /** The generated config as it was on disk while each activation ran. */
  activationConfigs: Array<Record<string, unknown>>;
};

function fakeCloudflare(options: FakeOptions = {}): Fake {
  const operations: Array<CloudflareOperation> = [];
  const activations: Array<ActivationOptions> = [];
  const activationConfigs: Array<Record<string, unknown>> = [];
  let pending = [...MIGRATIONS];
  const runWrangler: DeployWranglerRun = (operation) => {
    operations.push(operation);
    options.onOperation?.(operation);
    switch (operation.type) {
      case 'auth.whoami':
        return options.authenticated === false
          ? refuse('not logged in')
          : answer({ loggedIn: true, accounts: [] });
      case 'workers.subdomain.get':
        return answer({ subdomain: 'preview-tests' });
      case 'd1.migrations.list':
        return answer({ pending: [...pending] });
      case 'd1.time-travel.bookmark':
        return answer({ bookmark: 'bookmark-before-migrations' });
      case 'd1.migrations.apply':
        if (options.failApply) {
          return refuse('migration failed');
        }
        pending = [];
        return answer(undefined);
      case 'd1.execute':
        return options.failExecute
          ? refuse(options.executeFailure ?? `D1_ERROR while running: ${operation.sql}`)
          : answer([{ results: [], success: true }]);
      default:
        return refuse(`unexpected operation ${operation.type}`);
    }
  };
  const deps: Fake['deps'] = {
    runWrangler,
    hashWranglerUploader: () => 'uploader-hash-unchanged',
    activateVersion: async (activationOptions) => {
      activations.push(activationOptions);
      if (activationOptions.configPath !== undefined) {
        activationConfigs.push(JSON.parse(readFileSync(activationOptions.configPath, 'utf8')));
      }
      return options.activation ?? READY_ACTIVATION;
    },
  };
  return { deps, operations, activations, activationConfigs };
}

function answer(data: unknown): CloudflareCommandResult {
  return { status: 0, stdout: '', stderr: '', data };
}

function refuse(stderr: string): CloudflareCommandResult {
  return { status: 1, stdout: '', stderr };
}

function publish(
  target: unknown,
  fake: Fake,
  extra: Partial<PublishCloudflareArtifactOptions> = {},
  artifactDir = baseArtifact,
): Promise<unknown> {
  return publishCloudflareArtifact(artifactDir, target, { deps: fake.deps, ...extra });
}

/** Publish something that must fail, and return the publish error. */
async function publishFailure(run: Promise<unknown>): Promise<CloudflareArtifactPublishError> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(CloudflareArtifactPublishError);
    return error as CloudflareArtifactPublishError;
  }
  return expect.fail('publish should have failed');
}

function operationTypes(fake: Fake): Array<string> {
  return fake.operations.map((operation) => operation.type);
}

/** Every workspace that staging created has been removed. */

it.each([false, true])(
  'authenticates, migrates, seeds and activates, atomic: %s',
  async (atomic) => {
    const fake = fakeCloudflare();

    const result = await publish(TARGET, fake, { atomic });

    expect(operationTypes(fake)).toEqual([
      'auth.whoami',
      'd1.migrations.list',
      'd1.time-travel.bookmark',
      'd1.migrations.list',
      'd1.migrations.apply',
      'd1.migrations.list',
      'd1.execute',
    ]);
    expect(fake.operations.at(-1)).toMatchObject({
      type: 'd1.execute',
      database: D1_DATABASE_NAME,
      sql: SEED_SQL,
    });
    expect(fake.activations).toHaveLength(1);
    const [activation] = fake.activations;
    expect(activation).toMatchObject({
      workerName: 'void-preview-42',
      workersDevSubdomain: 'preview-tests',
      candidateSecrets: SECRET_VALUES,
      requireVersionMetadata: true,
      requirePreviewForReadiness: false,
      atomic,
    });
    expect(activation).not.toHaveProperty('allowFirstDeploymentBootstrap');
    expect(activation.pinActiveSecrets).toBeUndefined();
    expect(basename(activation.configPath ?? '')).toBe('generated.wrangler.json');

    const [generated] = fake.activationConfigs;
    expect(generated).toMatchObject({ name: 'void-preview-42', account_id: ACCOUNT_ID });
    expect(generated).not.toHaveProperty('addresses');

    const metadata = parseCloudflareVersionMessage(activation.message);
    expect(metadata).toMatchObject({ schema: 2, migrations: MIGRATIONS });
    const triggerConfig = metadata?.schema === 2 ? metadata.triggerConfig : undefined;
    expect(triggerConfig).toEqual(
      expect.objectContaining({ workers_dev: true, preview_urls: true }),
    );
    for (const key of [
      'preserve',
      'preserveRoutes',
      'preserveWorkersDev',
      'preservePreviewUrls',
      'addresses',
    ]) {
      expect(triggerConfig).not.toHaveProperty(key);
    }

    expect(staging.workspaces).toHaveLength(1);
    expect(result).toEqual({
      workerName: 'void-preview-42',
      versionId: 'version-2',
      previousVersionId: 'version-1',
      previewUrl: READY_ACTIVATION.previewUrl,
      migrations: MIGRATIONS,
      seeded: true,
    });
  },
);

it.each([undefined, 'https://app.example.com'])(
  'uses only the readiness Access origin supplied through deps: %s',
  async (readinessAccessOrigin) => {
    vi.stubEnv('CF_ACCESS_READINESS_ORIGIN', 'https://collector.example.com');
    const fake = fakeCloudflare();
    fake.deps.readinessAccessOrigin = readinessAccessOrigin;

    await publish(TARGET, fake);

    expect(fake.activations[0].readinessHeadersOrigin).toBe(readinessAccessOrigin);
  },
);

it('uses the connection compliance region for the workers.dev lookup', async () => {
  vi.stubEnv('CLOUDFLARE_COMPLIANCE_REGION', 'fedramp_high');
  const fake = fakeCloudflare({
    onOperation: (operation) => {
      if (operation.type === 'auth.whoami') {
        vi.stubEnv('CLOUDFLARE_COMPLIANCE_REGION', 'public');
      }
    },
  });

  await publish(TARGET, fake);

  await expect(fake.activations[0].resolveWorkersDevSubdomain?.()).resolves.toEqual({
    ok: true,
    subdomain: 'preview-tests.fed',
  });
});

it('includes artifact observability in the settings snapshot published after activation', async () => {
  const dir = copyArtifact();
  const workerPath = join(dir, '.cloudflare/output/v0/workers/default/worker.config.json');
  const worker = JSON.parse(readFileSync(workerPath, 'utf8'));
  const observability = { enabled: true, logs: { enabled: true } };
  writeFileSync(workerPath, JSON.stringify({ ...worker, observability }));
  rehashArtifact(dir, REQUIREMENTS);
  const fake = fakeCloudflare();

  await publish(TARGET, fake, {}, dir);

  expect(fake.activationConfigs[0].observability).toEqual(observability);
  const metadata = parseCloudflareVersionMessage(fake.activations[0].message);
  expect(metadata?.schema === 2 && metadata.triggerConfig.observability).toEqual(observability);
});

it('rejects invalid targets before Cloudflare operations', async () => {
  const fake = fakeCloudflare();

  const error = await publish({ ...TARGET, accountId: 'not-an-account-id' }, fake).catch(
    (failure: unknown) => failure,
  );

  expect(error).toBeInstanceOf(CloudflareArtifactTargetError);
  expect(fake.operations).toEqual([]);
  expect(fake.activations).toEqual([]);
});

it('rejects tampered artifacts before Cloudflare operations', async () => {
  const dir = copyArtifact();
  writeFileSync(
    join(dir, BUNDLE_MODULE),
    'export default { fetch() { return new Response("evil") } };\n',
  );
  const fake = fakeCloudflare();

  const error = await publish(TARGET, fake, {}, dir).catch((failure: unknown) => failure);

  expect(error).toBeInstanceOf(CloudflareArtifactError);
  expect(fake.operations).toEqual([]);
  expect(fake.activations).toEqual([]);
});

it('applies staged migrations after the artifact gains an extra SQL file', async () => {
  // reaches the apply step, which reads the directory its root config names.
  const dir = copyArtifact();
  const appliedFiles: Array<Array<string>> = [];
  const fake = fakeCloudflare({
    onOperation: (operation) => {
      if (operation.type === 'auth.whoami') {
        writeFileSync(
          join(dir, 'migrations', 'seed.sql'),
          "INSERT INTO users (id) VALUES ('stray');\n",
        );
      }
      if (operation.type === 'd1.migrations.apply') {
        const config = JSON.parse(readFileSync(operation.configPath, 'utf8'));
        appliedFiles.push(readdirSync(config.d1_databases[0].migrations_dir).sort());
      }
    },
  });

  await publish(TARGET, fake, {}, dir);

  expect(appliedFiles).toEqual([['0000_init.sql', '0001_add_users.sql', 'meta']]);
  expect(fake.activations).toHaveLength(1);
});

it('refuses to seed after the uploader changes', async () => {
  // The last migration-list call is the final operation before seeding.
  let lists = 0;
  let uploaderChanged = false;
  const fake = fakeCloudflare({
    onOperation: (operation) => {
      if (operation.type === 'd1.migrations.list') {
        lists += 1;
        uploaderChanged ||= lists === 3;
      }
    },
  });
  fake.deps.hashWranglerUploader = () =>
    uploaderChanged ? 'uploader-hash-changed' : 'uploader-hash-unchanged';

  const error = await publishFailure(publish(TARGET, fake));

  expect(error).toMatchObject({ reason: 'auth' });
  expect(operationTypes(fake)).not.toContain('d1.execute');
  expect(fake.activations).toEqual([]);
});

it('redacts secret-bearing seed failures and stops activation', async () => {
  const fake = fakeCloudflare({
    failExecute: true,
    executeFailure: `D1_ERROR ${Object.values(SECRET_VALUES).join(' ')} ${SEED_SQL}`,
  });

  const error = await publishFailure(publish(TARGET, fake));

  expect(error).toMatchObject({ reason: 'seed' });
  expect(error.cause).toBeInstanceOf(Error);
  expect(error.message).not.toContain('INSERT OR IGNORE');
  for (const secret of Object.values(SECRET_VALUES)) {
    expect((error.cause as Error).message).toContain(secret);
    expect(error.message).not.toContain(secret);
  }
  expect(fake.activations).toEqual([]);
});

it('reports activation failure details and removes its workspace', async () => {
  const fake = fakeCloudflare({
    activation: {
      ok: false,
      reason: 'readiness-failed',
      versionId: 'version-2',
      rollback: 'succeeded',
    },
  });

  const error = await publishFailure(publish(TARGET, fake));

  expect(error).toMatchObject({
    reason: 'readiness-failed',
    versionId: 'version-2',
    rollback: 'succeeded',
  });
  expect(error.message).toContain('did not pass /__void/ready');
  expect(fake.activations).toHaveLength(1);
});

it('keeps target secrets out of workspace files and operations', async () => {
  let workspaceText = '';
  const fake = fakeCloudflare({
    onOperation: (operation) => {
      // Staging has finished by the first operation, so the workspace holds everything it wrote.
      if (operation.type === 'auth.whoami') {
        const workspace = staging.workspaces.at(-1) ?? '';
        workspaceText = pathsUnder(workspace)
          .map((path) => readFileSync(join(workspace, path), 'utf8'))
          .join('\n');
      }
    },
  });

  await publish(TARGET, fake);

  const operationText = JSON.stringify(fake.operations);
  for (const value of Object.values(SECRET_VALUES)) {
    expect(workspaceText).not.toContain(value);
    expect(operationText).not.toContain(value);
  }
  expect(fake.activations[0].candidateSecrets).toEqual(SECRET_VALUES);
});

it.each<[string, FakeOptions, string]>([
  ['migration failure', { failApply: true }, 'migrations'],
  ['missing session', { authenticated: false }, 'auth'],
  ['API base mismatch', {}, 'connect'],
])('short-circuits publication after %s', async (_name, options, reason) => {
  const fake = fakeCloudflare(options);
  const target =
    reason === 'connect' ? { ...TARGET, apiBaseUrl: 'https://api.example.test/client/v4' } : TARGET;
  const error = await publishFailure(publish(target, fake));
  expect(error.reason).toBe(reason);
  expect(operationTypes(fake)).not.toContain('d1.execute');
  expect(fake.activations).toEqual([]);
  if (reason === 'connect') {
    expect(error.message).toContain('CLOUDFLARE_API_BASE_URL');
    expect(fake.operations).toEqual([]);
  } else if (reason === 'auth') {
    expect(operationTypes(fake)).not.toContain('d1.migrations.apply');
  } else {
    expect(operationTypes(fake)).toContain('d1.migrations.apply');
  }
});

it.each(['no D1', 'no seed', 'no migrations'])('publishes with %s', async (mode) => {
  const fake = fakeCloudflare();
  const target =
    mode === 'no D1' ? NO_D1_TARGET : mode === 'no seed' ? { ...TARGET, seed: false } : TARGET;
  const artifact =
    mode === 'no D1'
      ? noD1Artifact
      : mode === 'no migrations'
        ? copyArtifactWithoutMigrations()
        : baseArtifact;
  const result = await publish(target, fake, {}, artifact);
  const seeded = mode === 'no migrations';
  const migrations = mode === 'no seed' ? MIGRATIONS : [];
  expect(result).toMatchObject({ migrations, seeded });
  expect(fake.activations).toHaveLength(1);
  expect(parseCloudflareVersionMessage(fake.activations[0].message)).toMatchObject({
    schema: 2,
    migrations,
  });
  if (seeded) {
    expect(operationTypes(fake)).toEqual(['auth.whoami', 'd1.execute']);
    expect(fake.operations[1]).toMatchObject({ database: D1_DATABASE_NAME, sql: SEED_SQL });
  } else if (mode === 'no D1') {
    expect(operationTypes(fake)).toEqual(['auth.whoami']);
  } else {
    expect(operationTypes(fake)).toContain('d1.migrations.apply');
    expect(operationTypes(fake)).not.toContain('d1.execute');
  }
});
