import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  getWorkerAssetsDir,
  getWorkerBundleDir,
  readBuildOutput,
} from '@cloudflare/build-output-utils';
import { toSlash } from 'pathslash';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vite-plus/test';
import {
  CloudflareArtifactError,
  listCloudflareArtifactFiles,
} from '../../src/cli/cf-artifact-files.ts';
import {
  type PackageCloudflareArtifactInput,
  packageCloudflareArtifact,
} from '../../src/cli/cf-artifact-package.ts';
import {
  CLOUDFLARE_ARTIFACT_MANIFEST_FILE,
  type CloudflareArtifactRequirements,
  createCloudflareArtifactManifest,
  writeCloudflareArtifactManifest,
} from '../../src/cli/cf-artifact-schema.ts';
import {
  MAX_CLOUDFLARE_ARTIFACT_SEED_BYTES,
  type StagedCloudflareArtifact,
  stageCloudflareArtifact,
} from '../../src/cli/cf-artifact-stage.ts';
import { CloudflareArtifactTargetError } from '../../src/cli/cf-artifact-target.ts';

// The staging tests read the real Build Output reader, and make it fail once to test cleanup.
vi.mock('@cloudflare/build-output-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cloudflare/build-output-utils')>();
  return { ...actual, readBuildOutput: vi.fn(actual.readBuildOutput) };
});

const isWindows = process.platform === 'win32';
// Packaging runs the real cf config codemod, so the fixture build gets the packaging timeout.
const FIXTURE_TIMEOUT_MS = isWindows ? 90_000 : 30_000;

const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const ROOT_CONFIG_JSON = '.cloudflare/output/v0/config.json';
const WORKER_CONFIG_JSON = '.cloudflare/output/v0/workers/default/worker.config.json';
const BUNDLE_MODULE = '.cloudflare/output/v0/workers/default/bundle/index.js';

const D1: NonNullable<CloudflareArtifactRequirements['d1']> = {
  binding: 'DB',
  migrationsTable: 'd1_migrations',
  migrations: ['0000_init.sql', '0001_add_users.sql'],
  journal: true,
};
const REQUIREMENTS: CloudflareArtifactRequirements = {
  d1: D1,
  isrCache: false,
  email: { inbound: false, send: false },
  secrets: ['API_KEY', 'SIGNING_KEY'],
  seed: true,
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

const SECRET_VALUES = {
  API_KEY: 'api-key-value-for-tests',
  SIGNING_KEY: 'signing-key-value-for-tests',
};

/** A valid target, with IDs in the shape Cloudflare issues. */
const TARGET = {
  accountId: ACCOUNT_ID,
  workerName: 'void-preview-42',
  bindings: {
    DB: { type: 'd1', id: '0b1f8c2e-1111-4222-8333-944455556666', name: 'preview-42-db' },
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

/** The parts of a Worker config that these tests read or change. Everything else passes through. */
type WorkerConfigJson = { name: string; env: Record<string, unknown>; [key: string]: unknown };

const roots: Array<string> = [];
const stagedResults: Array<StagedCloudflareArtifact> = [];
let fixtureRoot = '';
let baseArtifact = '';

beforeAll(async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'void-cf-artifact-stage-fixture-'));
  const project = writeFixtureProject(fixtureRoot);
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
}, FIXTURE_TIMEOUT_MS);

afterEach(async () => {
  for (const staged of stagedResults.splice(0)) {
    await staged.dispose();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

/** Write a fake built Worker and an app: `dist/ssr`, one asset, migrations with a journal, and a seed. */
function writeFixtureProject(root: string): {
  workerDirectory: string;
  migrationsDirectory: string;
  seedFile: string;
} {
  const workerDirectory = join(root, 'dist', 'ssr');
  mkdirSync(join(workerDirectory, 'chunks'), { recursive: true });
  writeFileSync(
    join(workerDirectory, 'index.js'),
    'export default { fetch() { return new Response("ok") } };\n',
  );
  writeFileSync(join(workerDirectory, 'chunks', 'util.js'), 'export const version = "1";\n');
  writeFileSync(join(workerDirectory, 'wrangler.json'), JSON.stringify(WRANGLER_CONFIG));
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
  writeFileSync(seedFile, "INSERT OR IGNORE INTO users (id) VALUES ('seed');\n");
  return { workerDirectory, migrationsDirectory, seedFile };
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-artifact-stage-test-'));
  roots.push(root);
  return root;
}

/** A private copy of the base artifact, which one test may change. */
function copyArtifact(): string {
  const dir = join(tempRoot(), 'artifact');
  cpSync(baseArtifact, dir, { recursive: true });
  return dir;
}

/** A copy of the base artifact with no seed, re-signed for `seed: false`. */
function copyArtifactWithoutSeed(): string {
  const dir = copyArtifact();
  rmSync(join(dir, 'seed.sql'));
  resign(dir, { ...REQUIREMENTS, seed: false });
  return dir;
}

/**
 * A copy of the base artifact whose migrations are `names`, in that order, with no journal. Each
 * file is valid SQL, so only the order and name checks can reject the copy.
 */
function copyArtifactWithMigrations(names: Array<string>): string {
  const dir = copyArtifact();
  rmSync(join(dir, 'migrations'), { recursive: true, force: true });
  mkdirSync(join(dir, 'migrations'));
  for (const name of names) {
    writeFileSync(join(dir, 'migrations', name), 'SELECT 1;\n');
  }
  resign(dir, { ...REQUIREMENTS, d1: { ...D1, migrations: names, journal: false } });
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
function resign(
  artifactDir: string,
  requirements: CloudflareArtifactRequirements = REQUIREMENTS,
): void {
  const files = listCloudflareArtifactFiles(artifactDir, {
    exclude: [CLOUDFLARE_ARTIFACT_MANIFEST_FILE],
  });
  writeCloudflareArtifactManifest(
    artifactDir,
    createCloudflareArtifactManifest({ provenance: PROVENANCE, requirements, files }),
  );
}

/** Replace a JSON file of the artifact, then re-sign it, so only the content check can reject it. */
function rewriteJson(artifactDir: string, path: string, value: unknown): void {
  writeJson(join(artifactDir, path), value);
  resign(artifactDir);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

/** Stage an artifact and keep the result, so that `afterEach` disposes it. */
async function stage(artifactDir: string, target: unknown): Promise<StagedCloudflareArtifact> {
  const staged = await stageCloudflareArtifact(artifactDir, target);
  stagedResults.push(staged);
  return staged;
}

/** The workspace directories that staging creates in the temp directory. */
function workspaceDirectories(): Array<string> {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith('void-artifact-publish-'))
    .sort();
}

/**
 * Stage an artifact that must be rejected. Asserts that the rejection left no workspace behind,
 * and returns the rejection.
 */
async function rejection(artifactDir: string, target: unknown): Promise<unknown> {
  const before = workspaceDirectories();
  let failure: { error: unknown } | undefined;
  try {
    await stage(artifactDir, target);
  } catch (error) {
    failure = { error };
  }
  expect(workspaceDirectories()).toEqual(before);
  expect(failure, 'staging should have been rejected').toBeDefined();
  return failure?.error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function expectArtifactError(error: unknown, code: string, text: string): void {
  expect(error).toBeInstanceOf(CloudflareArtifactError);
  expect(error).toMatchObject({ code, message: expect.stringContaining(text) });
}

function expectTargetError(error: unknown, field: string, text: string): void {
  expect(error).toBeInstanceOf(CloudflareArtifactTargetError);
  expect(error).toMatchObject({ field, message: expect.stringContaining(text) });
}

/** Every regular file under `root`, as an absolute path. */
function filePathsUnder(root: string): Array<string> {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/** Every regular file under `root`, as POSIX paths relative to it. */
function filesUnder(root: string): Array<string> {
  return filePathsUnder(root)
    .map((path) => toSlash(relative(root, path)))
    .sort();
}

it('stages a valid artifact into a fresh upload tree', async () => {
  const dir = copyArtifact();
  const staged = await stage(dir, TARGET);
  const { directory: upload } = staged.output;

  const built = await readBuildOutput(upload);
  expect(built.workers.default.config.name).toBe('void-preview-42');

  const uploaded = readJson<WorkerConfigJson>(join(upload, WORKER_CONFIG_JSON));
  expect(uploaded.name).toBe('void-preview-42');
  expect(uploaded.env).toMatchObject({
    DB: { type: 'd1', name: 'preview-42-db', id: TARGET.bindings.DB.id },
    KV: { type: 'kv', id: TARGET.bindings.KV.id },
    QUEUE: { type: 'queue', name: 'preview-42-demo-queue' },
    API_KEY: { type: 'secret' },
    SIGNING_KEY: { type: 'secret' },
    __VOID_VERSION_METADATA: { type: 'version-metadata' },
    ASSETS: { type: 'assets' },
  });
  expect(uploaded.triggers).toEqual(
    expect.arrayContaining([
      { type: 'scheduled', schedule: '*/5 * * * *' },
      expect.objectContaining({ type: 'queue', name: 'preview-42-demo-queue' }),
    ]),
  );
  expect(JSON.stringify(uploaded)).not.toMatch(/"(local|default)"/);

  expect(readJson(join(upload, ROOT_CONFIG_JSON))).toEqual({
    accountId: ACCOUNT_ID,
    buildContext: { isPreview: false, mode: 'production' },
  });
  expect(filesUnder(getWorkerBundleDir(upload))).toEqual(['chunks/util.js', 'index.js']);
  expect(readFileSync(join(getWorkerBundleDir(upload), 'index.js'), 'utf8')).toBe(
    readFileSync(join(dir, BUNDLE_MODULE), 'utf8'),
  );
  expect(filesUnder(getWorkerAssetsDir(upload))).toEqual(['index.html']);
  expect(staged.output.assetsDirectory).toBe(getWorkerAssetsDir(upload));

  expect(staged.generatedConfigPath).toBe(
    join(staged.workspace, 'config', 'generated.wrangler.json'),
  );
  expect(staged.rootConfigPath).toBe(join(staged.workspace, 'config', 'root.wrangler.json'));
  expect(readJson(staged.generatedConfigPath)).toMatchObject({
    name: 'void-preview-42',
    account_id: ACCOUNT_ID,
    workers_dev: true,
    preview_urls: true,
    routes: [],
    version_metadata: { binding: '__VOID_VERSION_METADATA' },
  });
  expect(readJson(staged.rootConfigPath)).toMatchObject({
    name: 'void-preview-42',
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'preview-42-db',
        database_id: TARGET.bindings.DB.id,
        migrations_dir: join(staged.workspace, 'migrations'),
        migrations_table: 'd1_migrations',
      },
    ],
  });

  expect(readdirSync(staged.neutralRoot)).toEqual([]);
  expect(staged.migrationsDirectory).toBe(join(staged.workspace, 'migrations'));
  expect(staged.migrationNames).toEqual(['0000_init.sql', '0001_add_users.sql']);
  expect(staged.seedSql).toBe(readFileSync(join(dir, 'seed.sql'), 'utf8'));
  expect(staged.target).toEqual(TARGET);

  await staged.dispose();
  expect(existsSync(staged.workspace)).toBe(false);
  await expect(staged.dispose()).resolves.toBeUndefined();
});

it.skipIf(isWindows)('keeps the workspace and its configs private', async () => {
  const staged = await stage(copyArtifact(), TARGET);

  expect(statSync(staged.workspace).mode & 0o777).toBe(0o700);
  expect(statSync(staged.generatedConfigPath).mode & 0o777).toBe(0o600);
  expect(statSync(staged.rootConfigPath).mode & 0o777).toBe(0o600);
});

it('keeps secret values out of every file in the workspace', async () => {
  const staged = await stage(copyArtifact(), TARGET);

  expect(staged.target.secrets).toEqual(SECRET_VALUES);
  const files = filePathsUnder(staged.workspace);
  expect(files.length).toBeGreaterThan(0);
  for (const path of files) {
    const contents = readFileSync(path, 'utf8');
    for (const value of Object.values(SECRET_VALUES)) {
      expect(contents, path).not.toContain(value);
    }
  }
});

it('disposes only the upload tree through output.dispose', async () => {
  const staged = await stage(copyArtifact(), TARGET);

  await staged.output.dispose();

  expect(existsSync(staged.output.directory)).toBe(false);
  expect(existsSync(staged.neutralRoot)).toBe(true);
  expect(existsSync(staged.generatedConfigPath)).toBe(true);
});

it('returns no seed SQL when the target does not ask for a seed', async () => {
  const staged = await stage(copyArtifact(), { ...TARGET, seed: false });

  expect(staged.seedSql).toBeUndefined();
  expect(staged.migrationNames).toEqual(['0000_init.sql', '0001_add_users.sql']);
});

it('rejects an invalid target before anything is written', async () => {
  const error = await rejection(copyArtifact(), { ...TARGET, accountId: 'not-an-account' });

  expectTargetError(error, 'accountId', 'accountId');
});

it('rejects an artifact file that no longer matches its manifest', async () => {
  const dir = copyArtifact();
  writeFileSync(join(dir, 'migrations', '0000_init.sql'), 'CREATE TABLE users (id TEXT);\n');

  expectArtifactError(await rejection(dir, TARGET), 'mismatch', 'does not match');
});

it('rejects a root config whose accountId differs from the target', async () => {
  const dir = copyArtifact();
  rewriteJson(dir, ROOT_CONFIG_JSON, {
    accountId: 'f'.repeat(32),
    buildContext: { isPreview: false, mode: 'production' },
  });

  expectArtifactError(await rejection(dir, TARGET), 'worker-config', 'accountId');
});

it('rejects a root config for a preview build', async () => {
  const dir = copyArtifact();
  rewriteJson(dir, ROOT_CONFIG_JSON, {
    buildContext: { isPreview: true, mode: 'production' },
  });

  expectArtifactError(await rejection(dir, TARGET), 'worker-config', 'buildContext.isPreview');
});

it('rejects a root config that sets a compliance region', async () => {
  const dir = copyArtifact();
  rewriteJson(dir, ROOT_CONFIG_JSON, {
    complianceRegion: 'public',
    buildContext: { isPreview: false, mode: 'production' },
  });

  expectArtifactError(await rejection(dir, TARGET), 'worker-config', 'complianceRegion');
});

it('rejects a root config with an unknown key', async () => {
  const dir = copyArtifact();
  rewriteJson(dir, ROOT_CONFIG_JSON, {
    name: 'not-allowed-here',
    buildContext: { isPreview: false, mode: 'production' },
  });

  expectArtifactError(await rejection(dir, TARGET), 'worker-config', 'fails the schema');
});

it('rejects a Worker config with no version-metadata binding', async () => {
  const dir = copyArtifact();
  const worker = readJson<WorkerConfigJson>(join(dir, WORKER_CONFIG_JSON));
  delete worker.env.__VOID_VERSION_METADATA;
  rewriteJson(dir, WORKER_CONFIG_JSON, worker);

  expectArtifactError(await rejection(dir, TARGET), 'worker-config', 'version-metadata');
});

it('rejects a target that omits a required secret, and names it without any value', async () => {
  const error = await rejection(copyArtifact(), {
    ...TARGET,
    secrets: { API_KEY: SECRET_VALUES.API_KEY },
  });

  expectTargetError(error, 'secrets', 'missing SIGNING_KEY');
  for (const value of Object.values(SECRET_VALUES)) {
    expect(messageOf(error)).not.toContain(value);
  }
});

it('rejects a target that supplies a secret the artifact does not require', async () => {
  const error = await rejection(copyArtifact(), {
    ...TARGET,
    secrets: { ...SECRET_VALUES, EXTRA_TOKEN: 'extra-value-for-tests' },
  });

  expectTargetError(error, 'secrets', 'not required by the artifact: EXTRA_TOKEN');
  expect(messageOf(error)).not.toContain('extra-value-for-tests');
  for (const value of Object.values(SECRET_VALUES)) {
    expect(messageOf(error)).not.toContain(value);
  }
});

it('rejects a target with no route and no readiness path', async () => {
  const error = await rejection(copyArtifact(), {
    ...TARGET,
    workersDev: false,
    previewUrls: false,
  });

  expectTargetError(error, 'routes', 'readiness has nothing to probe');
});

it('rejects a target with no route and no workers.dev subdomain', async () => {
  const withoutSubdomain: Record<string, unknown> = { ...TARGET };
  delete withoutSubdomain.workersDevSubdomain;

  expectTargetError(
    await rejection(copyArtifact(), withoutSubdomain),
    'routes',
    'readiness has nothing to probe',
  );
});

it('rejects a seed target when the artifact has no seed', async () => {
  const error = await rejection(copyArtifactWithoutSeed(), TARGET);

  expectTargetError(error, 'seed', 'has no seed.sql');
});

it('rejects a seed over the single-argument limit and says why', async () => {
  const dir = copyArtifact();
  writeFileSync(join(dir, 'seed.sql'), 'x'.repeat(MAX_CLOUDFLARE_ARTIFACT_SEED_BYTES + 1));
  resign(dir);

  expectArtifactError(await rejection(dir, TARGET), 'limit', '128 KiB');
});

it('rejects a seed that is not valid UTF-8 instead of altering it', async () => {
  const dir = copyArtifact();
  writeFileSync(join(dir, 'seed.sql'), Buffer.from([0x49, 0xff, 0xfe, 0x00]));
  resign(dir);

  expectArtifactError(await rejection(dir, TARGET), 'layout', 'not valid UTF-8');
});

it('rejects migrations listed in a different order from the directory', async () => {
  const dir = copyArtifact();
  resign(dir, { ...REQUIREMENTS, d1: { ...D1, migrations: [...D1.migrations].reverse() } });

  expectArtifactError(await rejection(dir, TARGET), 'layout', 'in that order');
});

it('rejects migrations that Cloudflare would apply in a different order', async () => {
  const dir = copyArtifactWithMigrations(['10_b.sql', '9_a.sql']);

  expectArtifactError(
    await rejection(dir, TARGET),
    'layout',
    'Cloudflare applies migrations in a different order than Void validates. At position 1, Void validates 10_b.sql but Cloudflare applies 9_a.sql.',
  );
});

it('stages migrations whose timestamp names already sort in apply order', async () => {
  const staged = await stage(copyArtifactWithMigrations(['0000_x.sql', '0001_y.sql']), TARGET);

  expect(staged.migrationNames).toEqual(['0000_x.sql', '0001_y.sql']);
});

it('stages a D1 artifact that has no migrations folder', async () => {
  const staged = await stage(copyArtifactWithoutMigrations(), TARGET);

  expect(staged.migrationNames).toEqual([]);
  expect(staged.target).toEqual(TARGET);
});

it('stages the migrations into a copy inside the workspace, with the same files as the artifact', async () => {
  const dir = copyArtifact();
  const staged = await stage(dir, TARGET);
  const copy = join(staged.workspace, 'migrations');

  expect(staged.migrationsDirectory).toBe(copy);
  expect(filesUnder(copy)).toEqual(['0000_init.sql', '0001_add_users.sql', 'meta/_journal.json']);
  for (const path of filesUnder(copy)) {
    expect(readFileSync(join(copy, path), 'utf8'), path).toBe(
      readFileSync(join(dir, 'migrations', path), 'utf8'),
    );
  }
});

it.skipIf(isWindows)('keeps the staged migrations directory private', async () => {
  const staged = await stage(copyArtifact(), TARGET);

  expect(statSync(join(staged.workspace, 'migrations')).mode & 0o777).toBe(0o700);
});

it('keeps the staged migrations when the artifact changes after staging', async () => {
  const dir = copyArtifact();
  const staged = await stage(dir, TARGET);
  const copy = join(staged.workspace, 'migrations', '0000_init.sql');
  const before = readFileSync(copy, 'utf8');

  writeFileSync(join(dir, 'migrations', '0000_init.sql'), 'DROP TABLE users;\n');

  expect(readFileSync(copy, 'utf8')).toBe(before);
});

it('points a D1 artifact with no migrations at an empty directory in the workspace', async () => {
  const staged = await stage(copyArtifactWithoutMigrations(), TARGET);
  const directory = join(staged.workspace, 'migrations');

  expect(staged.migrationsDirectory).toBe(directory);
  expect(statSync(directory).isDirectory()).toBe(true);
  expect(readdirSync(directory)).toEqual([]);
  expect(readJson(staged.rootConfigPath)).toMatchObject({
    d1_databases: [{ migrations_dir: directory }],
  });
});

it('rejects a destructive migration that has no allow pragma', async () => {
  const dir = copyArtifact();
  writeFileSync(join(dir, 'migrations', '0001_add_users.sql'), 'DROP TABLE users;\n');
  resign(dir);

  expect(messageOf(await rejection(dir, TARGET))).toContain('Destructive migrations detected');
});

it('rejects a journal that lists a migration missing from the directory', async () => {
  const dir = copyArtifact();
  const journal = {
    ...JOURNAL,
    entries: [
      ...JOURNAL.entries,
      { idx: 2, version: '6', when: 1_760_000_200_000, tag: '0002_missing', breakpoints: true },
    ],
  };
  writeJson(join(dir, 'migrations', 'meta', '_journal.json'), journal);
  resign(dir);

  expect(messageOf(await rejection(dir, TARGET))).toContain('Migration drift detected');
});

it('removes the workspace when a step fails after it was created', async () => {
  const dir = copyArtifact();
  const before = workspaceDirectories();
  vi.mocked(readBuildOutput).mockRejectedValueOnce(new Error('injected failure'));

  await expect(stageCloudflareArtifact(dir, TARGET)).rejects.toThrow('injected failure');

  const [uploadPath = ''] = vi.mocked(readBuildOutput).mock.lastCall ?? [];
  expect(uploadPath).toContain('void-artifact-publish-');
  expect(existsSync(dirname(uploadPath))).toBe(false);
  expect(workspaceDirectories()).toEqual(before);
});

it('keeps the trusted stage module free of the build-side prepare module and child_process', () => {
  // Stage runs in the trusted CI job, so it must not load the build-side prepare module or spawn processes.
  const source = readFileSync(
    new URL('../../src/cli/cf-artifact-stage.ts', import.meta.url),
    'utf8',
  );
  expect(source).not.toMatch(/['"]\.\/cf-artifact-prepare\.ts['"]/);
  expect(source).not.toMatch(/['"](node:)?child_process['"]/);
});
