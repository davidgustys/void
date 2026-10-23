import {
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
import { basename, dirname, join, resolve } from 'node:path';
import {
  getWorkerAssetsDir,
  getWorkerBundleDir,
  readBuildOutput,
} from '@cloudflare/build-output-utils';
import { parseSync } from 'vite';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vite-plus/test';
import { CloudflareArtifactError } from '../../src/cli/cf-artifact-files.ts';
import { packageCloudflareArtifact } from '../../src/cli/cf-artifact-package.ts';
import {
  MAX_CLOUDFLARE_ARTIFACT_SEED_BYTES,
  type StagedCloudflareArtifact,
  stageCloudflareArtifact,
} from '../../src/cli/cf-artifact-stage.ts';
import { CloudflareArtifactTargetError } from '../../src/cli/cf-artifact-target.ts';
import {
  JOURNAL,
  SECRET_VALUES,
  makeRequirements,
  makeTarget,
  PROVENANCE,
  writeBuiltProject,
  copyArtifact as copyFixtureArtifact,
  rehashArtifact,
  pathsUnder,
  readJson,
  writeJson,
} from '../helpers/cf-artifact.ts';

// The staging tests read the real Build Output reader, and make it fail once to test cleanup.
vi.mock('@cloudflare/build-output-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cloudflare/build-output-utils')>();
  return { ...actual, readBuildOutput: vi.fn(actual.readBuildOutput) };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, mkdtempSync: vi.fn(actual.mkdtempSync) };
});

const isWindows = process.platform === 'win32';
// Packaging runs the real cf config codemod, so the fixture build gets the packaging timeout.
const FIXTURE_TIMEOUT_MS = isWindows ? 90_000 : 30_000;

const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const ROOT_CONFIG_JSON = '.cloudflare/output/v0/config.json';
const WORKER_CONFIG_JSON = '.cloudflare/output/v0/workers/default/worker.config.json';
const BUNDLE_MODULE = '.cloudflare/output/v0/workers/default/bundle/index.js';

const REQUIREMENTS = makeRequirements();
const D1 = REQUIREMENTS.d1!;
const TARGET = makeTarget();

type WorkerConfigJson = { name: string; env: Record<string, unknown>; [key: string]: unknown };

const roots: Array<string> = [];
const stagedResults: Array<StagedCloudflareArtifact> = [];
let fixtureRoot = '';
let baseArtifact = '';

beforeAll(async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'void-cf-artifact-stage-fixture-'));
  const project = writeBuiltProject(fixtureRoot);
  baseArtifact = join(fixtureRoot, 'artifact');
  await packageCloudflareArtifact({
    ...project,
    requirements: REQUIREMENTS,
    provenance: PROVENANCE,
  });
}, FIXTURE_TIMEOUT_MS);

afterEach(async () => {
  for (const staged of stagedResults.splice(0)) {
    await staged.dispose();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-artifact-stage-test-'));
  roots.push(root);
  return root;
}

function copyArtifact(): string {
  return copyFixtureArtifact(baseArtifact, join(tempRoot(), 'artifact'));
}

function copyArtifactWithoutSeed(): string {
  const dir = copyArtifact();
  rmSync(join(dir, 'seed.sql'));
  rehashArtifact(dir, { ...REQUIREMENTS, seed: false });
  return dir;
}

function copyArtifactWithMigrations(names: Array<string>): string {
  const dir = copyArtifact();
  rmSync(join(dir, 'migrations'), { recursive: true, force: true });
  mkdirSync(join(dir, 'migrations'));
  for (const name of names) {
    writeFileSync(join(dir, 'migrations', name), 'SELECT 1;\n');
  }
  rehashArtifact(dir, { ...REQUIREMENTS, d1: { ...D1, migrations: names, journal: false } });
  return dir;
}

function copyArtifactWithoutMigrations(): string {
  const dir = copyArtifact();
  rmSync(join(dir, 'migrations'), { recursive: true, force: true });
  rehashArtifact(dir, { ...REQUIREMENTS, d1: { ...D1, migrations: [], journal: false } });
  return dir;
}

function rewriteJson(artifactDir: string, path: string, value: unknown): void {
  writeJson(join(artifactDir, path), value);
  rehashArtifact(artifactDir);
}

async function stage(artifactDir: string, target: unknown): Promise<StagedCloudflareArtifact> {
  const staged = await stageCloudflareArtifact(artifactDir, target);
  stagedResults.push(staged);
  return staged;
}

function workspaceDirectories(): Array<string> {
  return vi
    .mocked(mkdtempSync)
    .mock.results.filter((result) => result.type === 'return')
    .map((result) => String(result.value))
    .filter((path) => basename(path).startsWith('void-artifact-publish-') && existsSync(path))
    .sort();
}

async function rejection(artifactDir: string, target: unknown): Promise<unknown> {
  const before = workspaceDirectories();
  const error: unknown = await stage(artifactDir, target).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Error);
  expect(workspaceDirectories()).toEqual(before);
  return error;
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

it('stages a valid artifact into a fresh upload tree', async () => {
  const dir = copyArtifact();
  const staged = await stage(dir, TARGET);
  const { directory: upload } = staged.output;

  const built = await readBuildOutput(upload);
  expect(built.workers.default.config.name).toBe('void-preview-42');

  const uploaded = readJson<WorkerConfigJson>(join(upload, WORKER_CONFIG_JSON));
  expect(uploaded.name).toBe('void-preview-42');
  expect(uploaded.env).toMatchObject({
    DB: { type: 'd1', name: 'preview-42-db', id: '0b1f8c2e-1111-4222-8333-944455556666' },
    KV: { type: 'kv', id: 'fedcba9876543210fedcba9876543210' },
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
  expect(pathsUnder(getWorkerBundleDir(upload))).toEqual(['chunks/util.js', 'index.js']);
  expect(readFileSync(join(getWorkerBundleDir(upload), 'index.js'), 'utf8')).toBe(
    readFileSync(join(dir, BUNDLE_MODULE), 'utf8'),
  );
  expect(pathsUnder(getWorkerAssetsDir(upload))).toEqual(['index.html']);
  expect(staged.output.assetsDirectory).toBe(getWorkerAssetsDir(upload));

  expect(readJson(staged.generatedConfigPath)).toMatchObject({
    name: TARGET.workerName,
    account_id: ACCOUNT_ID,
  });
  expect(readJson(staged.rootConfigPath)).toMatchObject({
    d1_databases: [{ migrations_dir: join(staged.workspace, 'migrations') }],
  });

  expect(readdirSync(staged.neutralRoot)).toEqual([]);
  expect(staged.migrationsDirectory).toBe(join(staged.workspace, 'migrations'));
  expect(staged.migrationNames).toEqual(['0000_init.sql', '0001_add_users.sql']);
  expect(staged.seedSql).toBe(readFileSync(join(dir, 'seed.sql'), 'utf8'));
  expect(staged.target).toEqual(TARGET);

  const migrations = staged.migrationsDirectory!;
  expect(pathsUnder(migrations)).toEqual([
    '0000_init.sql',
    '0001_add_users.sql',
    'meta/_journal.json',
  ]);
  for (const path of pathsUnder(migrations)) {
    expect(readFileSync(join(migrations, path), 'utf8')).toBe(
      readFileSync(join(dir, 'migrations', path), 'utf8'),
    );
  }
  const before = readFileSync(join(migrations, '0000_init.sql'), 'utf8');
  writeFileSync(join(dir, 'migrations', '0000_init.sql'), 'DROP TABLE users;');
  expect(readFileSync(join(migrations, '0000_init.sql'), 'utf8')).toBe(before);
  await staged.dispose();
  expect(existsSync(staged.workspace)).toBe(false);
  await expect(staged.dispose()).resolves.toBeUndefined();
});

it.skipIf(isWindows)('keeps the workspace and its configs private', async () => {
  const staged = await stage(copyArtifact(), TARGET);

  expect(statSync(staged.workspace).mode & 0o777).toBe(0o700);
  expect(statSync(staged.migrationsDirectory!).mode & 0o777).toBe(0o700);
  expect(statSync(staged.generatedConfigPath).mode & 0o777).toBe(0o600);
  expect(statSync(staged.rootConfigPath).mode & 0o777).toBe(0o600);
});

it('keeps target secret values out of workspace files', async () => {
  const staged = await stage(copyArtifact(), TARGET);

  expect(staged.target.secrets).toEqual(SECRET_VALUES);
  const files = pathsUnder(staged.workspace).map((path) => join(staged.workspace, path));
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

it('rejects a file changed since manifest creation', async () => {
  const dir = copyArtifact();
  writeFileSync(join(dir, 'migrations', '0000_init.sql'), 'CREATE TABLE users (id TEXT);\n');

  expectArtifactError(await rejection(dir, TARGET), 'mismatch', 'does not match');
});

it('requires a version-metadata binding', async () => {
  const dir = copyArtifact();
  const worker = readJson<WorkerConfigJson>(join(dir, WORKER_CONFIG_JSON));
  delete worker.env.__VOID_VERSION_METADATA;
  rewriteJson(dir, WORKER_CONFIG_JSON, worker);

  expectArtifactError(await rejection(dir, TARGET), 'worker-config', 'version-metadata');
});

it('rejects a seed target when the artifact has no seed', async () => {
  const error = await rejection(copyArtifactWithoutSeed(), TARGET);

  expectTargetError(error, 'seed', 'has no seed.sql');
});

it('rejects a seed over the single-argument limit and says why', async () => {
  const dir = copyArtifact();
  writeFileSync(join(dir, 'seed.sql'), 'x'.repeat(MAX_CLOUDFLARE_ARTIFACT_SEED_BYTES + 1));
  rehashArtifact(dir);

  expectArtifactError(await rejection(dir, TARGET), 'limit', '128 KiB');
});

it('rejects a seed that is not valid UTF-8 instead of altering it', async () => {
  const dir = copyArtifact();
  writeFileSync(join(dir, 'seed.sql'), Buffer.from([0x49, 0xff, 0xfe, 0x00]));
  rehashArtifact(dir);

  expectArtifactError(await rejection(dir, TARGET), 'layout', 'not valid UTF-8');
});

it('requires manifest and directory migration orders to agree', async () => {
  const dir = copyArtifact();
  rehashArtifact(dir, { ...REQUIREMENTS, d1: { ...D1, migrations: [...D1.migrations].reverse() } });

  expectArtifactError(await rejection(dir, TARGET), 'layout', 'in that order');
});

it('requires Void and Cloudflare migration orders to agree', async () => {
  const dir = copyArtifactWithMigrations(['10_b.sql', '9_a.sql']);

  expectArtifactError(
    await rejection(dir, TARGET),
    'layout',
    'Cloudflare applies migrations in a different order than Void validates. At position 1, Void validates 10_b.sql but Cloudflare applies 9_a.sql.',
  );
});

it('gives D1 an empty staged directory when it has no migrations', async () => {
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
  rehashArtifact(dir);

  expect(messageOf(await rejection(dir, TARGET))).toContain('Destructive migrations detected');
});

it('rejects a journal entry with no migration file', async () => {
  const dir = copyArtifact();
  const journal = {
    ...JOURNAL,
    entries: [
      ...JOURNAL.entries,
      { idx: 2, version: '6', when: 1_760_000_200_000, tag: '0002_missing', breakpoints: true },
    ],
  };
  writeJson(join(dir, 'migrations', 'meta', '_journal.json'), journal);
  rehashArtifact(dir);

  expect(messageOf(await rejection(dir, TARGET))).toContain('Migration drift detected');
});

it('removes its workspace after a staging failure', async () => {
  const dir = copyArtifact();
  const before = workspaceDirectories();
  vi.mocked(readBuildOutput).mockRejectedValueOnce(new Error('injected failure'));

  await expect(stageCloudflareArtifact(dir, TARGET)).rejects.toThrow('injected failure');

  const [uploadPath = ''] = vi.mocked(readBuildOutput).mock.lastCall ?? [];
  expect(uploadPath).toContain('void-artifact-publish-');
  expect(existsSync(dirname(uploadPath))).toBe(false);
  expect(workspaceDirectories()).toEqual(before);
});

/** Follow runtime static imports and re-exports in the SDK source, excluding type-only edges. */
function staticImportGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  function visit(file: string): void {
    if (seen.has(file)) {
      return;
    }
    seen.add(file);
    const parsed = parseSync(file, readFileSync(file, 'utf8'));
    expect(parsed.errors, file).toEqual([]);
    const sources = [
      ...parsed.module.staticImports
        .filter((item) => item.entries.length === 0 || item.entries.some((e) => !e.isType))
        .map((item) => item.moduleRequest.value),
      ...parsed.module.staticExports.flatMap((item) =>
        item.entries.filter((e) => !e.isType && e.moduleRequest).map((e) => e.moduleRequest!.value),
      ),
    ];
    for (const source of sources) {
      if (source.startsWith('.')) {
        visit(resolve(dirname(file), source));
      } else {
        seen.add(source);
      }
    }
  }
  visit(entry);
  return seen;
}

it.each(['stage', 'publish'])(
  'keeps %s imports separate from build-side artifact modules',
  (name) => {
    const graph = staticImportGraph(
      resolve(import.meta.dirname, `../../src/cli/cf-artifact-${name}.ts`),
    );
    expect([...graph].some((path) => path.endsWith('/cf-artifact-worker-config.ts'))).toBe(true);
    for (const file of ['cf-artifact-prepare.ts', 'cf-artifact-package.ts']) {
      expect([...graph].filter((path) => path.endsWith(`/${file}`))).toEqual([]);
    }
    if (name === 'stage') {
      expect([...graph].filter((path) => /^(node:)?child_process$/.test(path))).toEqual([]);
    }
  },
);

it.each<[Record<string, unknown>, string]>([
  [{ accountId: 'f'.repeat(32) }, 'accountId'],
  [
    {
      buildContext: { isPreview: true, mode: 'production' },
    },
    'buildContext.isPreview',
  ],
  [{ complianceRegion: 'public' }, 'complianceRegion'],
  [{ name: 'not-allowed-here' }, 'fails the schema'],
])('rejects root config %j', async (config, field) => {
  const dir = copyArtifact();
  rewriteJson(dir, ROOT_CONFIG_JSON, {
    buildContext: { isPreview: false, mode: 'production' },
    ...config,
  });
  expectArtifactError(await rejection(dir, TARGET), 'worker-config', field);
});

it.each<[string, () => unknown, string, string]>([
  ['bad account', () => ({ ...TARGET, accountId: 'not-an-account' }), 'accountId', 'accountId'],
  [
    'missing secret',
    () => ({ ...TARGET, secrets: { API_KEY: SECRET_VALUES.API_KEY } }),
    'secrets',
    'missing SIGNING_KEY',
  ],
  [
    'extra secret',
    () => ({ ...TARGET, secrets: { ...SECRET_VALUES, EXTRA_TOKEN: 'extra-value-for-tests' } }),
    'secrets',
    'not required by the artifact: EXTRA_TOKEN',
  ],
  [
    'no readiness route',
    () => ({ ...TARGET, workersDev: false, previewUrls: false }),
    'routes',
    'readiness has nothing to probe',
  ],
  [
    'no subdomain',
    () => {
      const target = { ...TARGET };
      delete target.workersDevSubdomain;
      return target;
    },
    'routes',
    'readiness has nothing to probe',
  ],
])('refuses target with %s without leaking secrets', async (_name, target, field, message) => {
  const error = await rejection(copyArtifact(), target());
  expectTargetError(error, field, message);
  for (const secret of [...Object.values(SECRET_VALUES), 'extra-value-for-tests']) {
    expect(messageOf(error)).not.toContain(secret);
  }
});
