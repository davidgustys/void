import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import {
  CloudflareArtifactError,
  listCloudflareArtifactFiles,
} from '../../src/cli/cf-artifact-files.ts';
import {
  packageCloudflareArtifact,
  type PackageCloudflareArtifactInput,
} from '../../src/cli/cf-artifact-package.ts';
import {
  CloudflareArtifactPublishError,
  type PublishCloudflareArtifactOptions,
  publishCloudflareArtifact,
} from '../../src/cli/cf-artifact-publish.ts';
import {
  CLOUDFLARE_ARTIFACT_MANIFEST_FILE,
  type CloudflareArtifactRequirements,
  createCloudflareArtifactManifest,
  writeCloudflareArtifactManifest,
} from '../../src/cli/cf-artifact-schema.ts';
import { CloudflareArtifactTargetError } from '../../src/cli/cf-artifact-target.ts';
import type { CloudflareDeployDeps, DeployWranglerRun } from '../../src/cli/deploy-types.ts';

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
const MIGRATIONS = ['0000_init.sql', '0001_add_users.sql'];
const D1_DATABASE_NAME = 'preview-42-db';
const SEED_SQL = "INSERT OR IGNORE INTO users (id) VALUES ('seed');\n";
const SECRET_VALUES = {
  API_KEY: 'api-key-value-for-tests',
  SIGNING_KEY: 'signing-key-value-for-tests',
};

// Every Cloudflare credential and transport selector, cleared so a developer's shell cannot reach
// a real account or change the API base.
const CLOUDFLARE_ENV_VARS = [
  'CLOUDFLARE_API_TOKEN',
  'CF_API_TOKEN',
  'CLOUDFLARE_API_KEY',
  'CF_API_KEY',
  'CLOUDFLARE_EMAIL',
  'CF_EMAIL',
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
];

const D1: NonNullable<CloudflareArtifactRequirements['d1']> = {
  binding: 'DB',
  migrationsTable: 'd1_migrations',
  migrations: MIGRATIONS,
  journal: true,
};
const REQUIREMENTS: CloudflareArtifactRequirements = {
  d1: D1,
  isrCache: false,
  email: { inbound: false, send: false },
  secrets: ['API_KEY', 'SIGNING_KEY'],
  seed: true,
};
const NO_D1_REQUIREMENTS: CloudflareArtifactRequirements = {
  ...REQUIREMENTS,
  d1: null,
  seed: false,
};
const PROVENANCE = { voidVersion: '0.0.0-test', commit: null, builtAt: null };

const JOURNAL = {
  version: '7',
  dialect: 'sqlite',
  entries: [
    { idx: 0, version: '6', when: 1_760_000_000_000, tag: '0000_init', breakpoints: true },
    { idx: 1, version: '6', when: 1_760_000_100_000, tag: '0001_add_users', breakpoints: true },
  ],
};

/** A Wrangler config with every binding kind the artifact checks: D1, KV, a queue, a cron, secrets, one asset. */
const WRANGLER_CONFIG = {
  name: 'void-fixture-app',
  main: 'index.js',
  compatibility_date: '2026-10-12',
  d1_databases: [{ binding: 'DB', database_name: 'default', database_id: 'local' }],
  kv_namespaces: [{ binding: 'KV', id: 'local' }],
  queues: {
    producers: [{ binding: 'QUEUE', queue: 'demo-queue' }],
    consumers: [{ queue: 'demo-queue', max_batch_timeout: 1 }],
  },
  triggers: { crons: ['*/5 * * * *'] },
  version_metadata: { binding: '__VOID_VERSION_METADATA' },
  secrets: { required: ['API_KEY', 'SIGNING_KEY'] },
  assets: {
    binding: 'ASSETS',
    directory: '../client',
    not_found_handling: 'none',
    run_worker_first: ['/**'],
  },
};
/** The same Worker with no D1 database. `undefined` is dropped when the config is written. */
const WRANGLER_CONFIG_WITHOUT_D1 = { ...WRANGLER_CONFIG, d1_databases: undefined };

/** A valid target, with IDs in the shape Cloudflare issues. */
const TARGET = {
  accountId: ACCOUNT_ID,
  workerName: 'void-preview-42',
  bindings: {
    DB: { type: 'd1', id: '0b1f8c2e-1111-4222-8333-944455556666', name: D1_DATABASE_NAME },
    KV: { type: 'kv', id: 'fedcba9876543210fedcba9876543210' },
  },
  queues: { 'demo-queue': 'preview-42-demo-queue' },
  secrets: { ...SECRET_VALUES },
  routes: [],
  workersDev: true,
  previewUrls: true,
  workersDevSubdomain: 'preview-tests',
  seed: true,
};
const NO_D1_TARGET = {
  ...TARGET,
  bindings: { KV: TARGET.bindings.KV },
  seed: false,
};

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
  const project = writeFixtureProject(join(fixtureRoot, 'app'), WRANGLER_CONFIG);
  baseArtifact = join(fixtureRoot, 'artifact');
  const input: PackageCloudflareArtifactInput = {
    workerDirectory: project.workerDirectory,
    outDir: baseArtifact,
    requirements: REQUIREMENTS,
    migrationsDirectory: project.migrationsDirectory,
    seedFile: project.seedFile,
    provenance: PROVENANCE,
  };
  await packageCloudflareArtifact(input);

  const noD1Project = writeFixtureProject(
    join(fixtureRoot, 'app-no-d1'),
    WRANGLER_CONFIG_WITHOUT_D1,
  );
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
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

/** Write a fake built Worker and an app: `dist/ssr`, one asset, migrations with a journal, and a seed. */
function writeFixtureProject(
  root: string,
  wranglerConfig: Record<string, unknown>,
): { workerDirectory: string; migrationsDirectory: string; seedFile: string } {
  const workerDirectory = join(root, 'dist', 'ssr');
  mkdirSync(join(workerDirectory, 'chunks'), { recursive: true });
  writeFileSync(
    join(workerDirectory, 'index.js'),
    'export default { fetch() { return new Response("ok") } };\n',
  );
  writeFileSync(join(workerDirectory, 'chunks', 'util.js'), 'export const version = "1";\n');
  writeFileSync(join(workerDirectory, 'wrangler.json'), JSON.stringify(wranglerConfig));
  writeFileSync(join(workerDirectory, '.dev.vars'), 'API_KEY=local-only\n');
  const client = join(root, 'dist', 'client');
  mkdirSync(client, { recursive: true });
  writeFileSync(join(client, 'index.html'), '<h1>preview</h1>\n');

  const migrationsDirectory = join(root, 'migrations');
  mkdirSync(join(migrationsDirectory, 'meta'), { recursive: true });
  writeFileSync(
    join(migrationsDirectory, '0000_init.sql'),
    'CREATE TABLE users (id TEXT PRIMARY KEY);\n',
  );
  writeFileSync(
    join(migrationsDirectory, '0001_add_users.sql'),
    'ALTER TABLE users ADD COLUMN name TEXT;\n',
  );
  writeFileSync(join(migrationsDirectory, 'meta', '_journal.json'), JSON.stringify(JOURNAL));
  writeFileSync(join(migrationsDirectory, 'meta', '0000_snapshot.json'), '{"version":"7"}');

  const seedFile = join(root, 'seed.sql');
  writeFileSync(seedFile, SEED_SQL);
  return { workerDirectory, migrationsDirectory, seedFile };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-artifact-publish-test-'));
  roots.push(root);
  return root;
}

/** A private copy of the base artifact, which one test may change. */
function copyArtifact(): string {
  const dir = join(tempRoot(), 'artifact');
  cpSync(baseArtifact, dir, { recursive: true });
  return dir;
}

/** A copy of the base artifact with D1 and no migrations folder, re-signed for an empty migration list. */
function copyArtifactWithoutMigrations(): string {
  const dir = copyArtifact();
  rmSync(join(dir, 'migrations'), { recursive: true, force: true });
  resign(dir, { ...REQUIREMENTS, d1: { ...D1, migrations: [], journal: false } });
  return dir;
}

/** Re-sign an edited artifact: list its files and write a new manifest over them. */
function resign(artifactDir: string, requirements: CloudflareArtifactRequirements): void {
  const files = listCloudflareArtifactFiles(artifactDir, {
    exclude: [CLOUDFLARE_ARTIFACT_MANIFEST_FILE],
  });
  writeCloudflareArtifactManifest(
    artifactDir,
    createCloudflareArtifactManifest({ provenance: PROVENANCE, requirements, files }),
  );
}

/** Every regular file under `root`, as an absolute path. */
function filePathsUnder(root: string): Array<string> {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

type ActivationOptions = CloudflareVersionActivationOptions;

type FakeOptions = {
  /** Migrations the database has not applied yet, in apply order. */
  pending?: ReadonlyArray<string>;
  /** Make `auth.whoami` report no session. */
  authenticated?: boolean;
  /** Make `d1.migrations.apply` fail. */
  failApply?: boolean;
  /** Make `d1.execute` fail, and echo the SQL in its error the way a CLI can. */
  failExecute?: boolean;
  /** The activation result, or a function of the activation options. */
  activation?:
    | CloudflareVersionActivation
    | ((options: ActivationOptions) => CloudflareVersionActivation);
  /** Called with each operation before it is answered. */
  onOperation?: (operation: CloudflareOperation) => void;
};

type Fake = {
  deps: CloudflareDeployDeps;
  operations: Array<CloudflareOperation>;
  activations: Array<ActivationOptions>;
  /** The generated config as it was on disk while each activation ran. */
  activationConfigs: Array<Record<string, unknown>>;
};

/**
 * Injected Cloudflare seams. Every operation is recorded and answered locally, so nothing reaches
 * Cloudflare. The uploader hash is constant, so the pins never change during a test.
 */
function fakeCloudflare(options: FakeOptions = {}): Fake {
  const operations: Array<CloudflareOperation> = [];
  const activations: Array<ActivationOptions> = [];
  const activationConfigs: Array<Record<string, unknown>> = [];
  let pending = [...(options.pending ?? MIGRATIONS)];
  const runWrangler: DeployWranglerRun = (operation) => {
    operations.push(operation);
    options.onOperation?.(operation);
    switch (operation.type) {
      case 'auth.whoami':
        return options.authenticated === false
          ? refuse('not logged in')
          : answer({ loggedIn: true, accounts: [] });
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
          ? refuse(`D1_ERROR while running: ${operation.sql}`)
          : answer([{ results: [], success: true }]);
      default:
        return refuse(`unexpected operation ${operation.type}`);
    }
  };
  const deps: CloudflareDeployDeps = {
    runWrangler,
    hashWranglerUploader: () => 'uploader-hash-unchanged',
    activateVersion: async (activationOptions) => {
      activations.push(activationOptions);
      if (activationOptions.configPath !== undefined) {
        activationConfigs.push(JSON.parse(readFileSync(activationOptions.configPath, 'utf8')));
      }
      return typeof options.activation === 'function'
        ? options.activation(activationOptions)
        : (options.activation ?? READY_ACTIVATION);
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
function expectWorkspacesRemoved(): void {
  expect(staging.workspaces.length).toBeGreaterThan(0);
  for (const workspace of staging.workspaces) {
    expect(existsSync(workspace)).toBe(false);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

it('authenticates, migrates, seeds, then activates one version', async () => {
  const fake = fakeCloudflare();

  const result = await publish(TARGET, fake);

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
    atomic: false,
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
  expect(triggerConfig).toEqual(expect.objectContaining({ workers_dev: true, preview_urls: true }));
  for (const key of [
    'preserve',
    'preserveRoutes',
    'preserveWorkersDev',
    'preservePreviewUrls',
    'addresses',
  ]) {
    expect(triggerConfig).not.toHaveProperty(key);
  }

  expect(result).toEqual({
    workerName: 'void-preview-42',
    versionId: 'version-2',
    previousVersionId: 'version-1',
    previewUrl: READY_ACTIVATION.previewUrl,
    migrations: MIGRATIONS,
    seeded: true,
  });
  expectWorkspacesRemoved();
});

it('passes atomic publication through to the activation', async () => {
  const fake = fakeCloudflare();

  await publish(TARGET, fake, { atomic: true });

  expect(fake.activations[0]).toMatchObject({ atomic: true });
});

it('rejects an invalid target before any operation or activation', async () => {
  const fake = fakeCloudflare();

  const error = await publish({ ...TARGET, accountId: 'not-an-account-id' }, fake).catch(
    (failure: unknown) => failure,
  );

  expect(error).toBeInstanceOf(CloudflareArtifactTargetError);
  expect(fake.operations).toEqual([]);
  expect(fake.activations).toEqual([]);
});

it('rejects a tampered artifact file before any operation or activation', async () => {
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

it('stops at a failed migration: no seed, no activation, and the workspace is removed', async () => {
  const fake = fakeCloudflare({ failApply: true });

  const error = await publishFailure(publish(TARGET, fake));

  expect(error).toMatchObject({ reason: 'migrations' });
  expect(operationTypes(fake)).toContain('d1.migrations.apply');
  expect(operationTypes(fake)).not.toContain('d1.execute');
  expect(fake.activations).toEqual([]);
  expectWorkspacesRemoved();
});

it('applies only the staged migrations, ignoring a stray seed file added to the artifact after staging', async () => {
  // Staging copies the migrations into the workspace, so a file added to the artifact later never
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
  expectWorkspacesRemoved();
});

it('does not seed when the uploader changes after the migrations', async () => {
  // The final `d1.migrations.list` is the last operation before the seed. Changing the hash as it
  // runs means the migration checks passed, and only the seed's own pin check can refuse.
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
  expectWorkspacesRemoved();
});

it('stops before activation when the seed fails, and keeps the SQL out of the message', async () => {
  const fake = fakeCloudflare({ failExecute: true });

  const error = await publishFailure(publish(TARGET, fake));

  expect(error).toMatchObject({ reason: 'seed' });
  expect(error.cause).toBeInstanceOf(Error);
  expect(error.message).not.toContain('INSERT OR IGNORE');
  expect(fake.activations).toEqual([]);
  expectWorkspacesRemoved();
});

it('reports an activation failure with its reason, version and rollback, and removes the workspace', async () => {
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
  expectWorkspacesRemoved();
});

it('runs no D1 operation for an artifact without D1', async () => {
  const fake = fakeCloudflare();

  const result = await publish(NO_D1_TARGET, fake, {}, noD1Artifact);

  expect(operationTypes(fake)).toEqual(['auth.whoami']);
  expect(result).toMatchObject({ migrations: [], seeded: false });
  expect(fake.activations).toHaveLength(1);
  expect(parseCloudflareVersionMessage(fake.activations[0].message)).toMatchObject({
    schema: 2,
    migrations: [],
  });
  expectWorkspacesRemoved();
});

it('runs no seed when the target does not ask for one', async () => {
  const fake = fakeCloudflare();

  const result = await publish({ ...TARGET, seed: false }, fake);

  expect(operationTypes(fake)).not.toContain('d1.execute');
  expect(operationTypes(fake)).toContain('d1.migrations.apply');
  expect(result).toMatchObject({ seeded: false, migrations: MIGRATIONS });
});

it('seeds a D1 database that has no migrations, and runs no migration operation', async () => {
  const dir = copyArtifactWithoutMigrations();
  const fake = fakeCloudflare();

  const result = await publish(TARGET, fake, {}, dir);

  expect(operationTypes(fake)).toEqual(['auth.whoami', 'd1.execute']);
  expect(fake.operations[1]).toMatchObject({ database: D1_DATABASE_NAME, sql: SEED_SQL });
  expect(result).toMatchObject({ migrations: [], seeded: true });
  expect(fake.activations).toHaveLength(1);
});

it('stops before any operation when the target API base differs from the environment', async () => {
  const fake = fakeCloudflare();

  const error = await publishFailure(
    publish({ ...TARGET, apiBaseUrl: 'https://api.example.test/client/v4' }, fake),
  );

  expect(error).toMatchObject({ reason: 'connect' });
  expect(error.message).toContain('CLOUDFLARE_API_BASE_URL');
  expect(fake.operations).toEqual([]);
  expect(fake.activations).toEqual([]);
  expectWorkspacesRemoved();
});

it('stops before migrations when Cloudflare reports no session', async () => {
  const fake = fakeCloudflare({ authenticated: false });

  const error = await publishFailure(publish(TARGET, fake));

  expect(error).toMatchObject({ reason: 'auth' });
  expect(operationTypes(fake)).not.toContain('d1.migrations.apply');
  expect(fake.activations).toEqual([]);
  expectWorkspacesRemoved();
});

it('keeps secret values off disk, out of every operation, and out of every error', async () => {
  let workspaceText = '';
  const fake = fakeCloudflare({
    onOperation: (operation) => {
      // Staging has finished by the first operation, so the workspace holds everything it wrote.
      if (operation.type === 'auth.whoami') {
        const workspace = staging.workspaces.at(-1) ?? '';
        workspaceText = filePathsUnder(workspace)
          .map((path) => readFileSync(path, 'utf8'))
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
  // The candidate secrets are the one place a value may appear, and they reach only activation.
  expect(fake.activations[0].candidateSecrets).toEqual(SECRET_VALUES);

  const failing = await publishFailure(
    publish(
      TARGET,
      fakeCloudflare({ activation: { ok: false, reason: 'upload-failed', status: 1 } }),
    ),
  );
  for (const value of Object.values(SECRET_VALUES)) {
    expect(messageOf(failing)).not.toContain(value);
  }
});
