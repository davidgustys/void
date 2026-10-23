import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import {
  type PackageCloudflareArtifactInput,
  packageCloudflareArtifact,
} from '../../src/cli/cf-artifact-package.ts';
import { readCloudflareArtifact } from '../../src/cli/cf-artifact-schema.ts';
import { prepareCfBuildOutput } from '../../src/cli/cf-build-output.ts';
import {
  makeRequirements,
  WRANGLER_CONFIG,
  PROVENANCE,
  writeBuiltProject,
  pathsUnder,
} from '../helpers/cf-artifact.ts';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});
vi.mock('../../src/cli/cf-build-output.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/cf-build-output.ts')>();
  return { ...actual, prepareCfBuildOutput: vi.fn(actual.prepareCfBuildOutput) };
});

const roots: Array<string> = [];
const isWindows = process.platform === 'win32';
const PACKAGE_TIMEOUT_MS = isWindows ? 45_000 : 15_000;
const REQUIREMENTS = makeRequirements({ secrets: [] });
const D1 = REQUIREMENTS.d1!;
const WORKER_CONFIG = { ...WRANGLER_CONFIG, secrets: undefined };
type Project = ReturnType<typeof writeBuiltProject>;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function setupProject(config: Record<string, unknown> = WORKER_CONFIG): Project {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-artifact-package-'));
  roots.push(root);
  return writeBuiltProject(root, config);
}

function inputFor(project: Project): PackageCloudflareArtifactInput {
  return { ...project, requirements: REQUIREMENTS, provenance: PROVENANCE };
}

it(
  'packages a verified Build Output, only listed migrations, journal and seed',
  async () => {
    const project = setupProject();
    writeFileSync(join(project.migrationsDirectory, 'notes.txt'), 'not a migration');
    const manifest = await packageCloudflareArtifact(inputFor(project));
    expect(readCloudflareArtifact(project.outDir)).toEqual(manifest);
    expect(manifest.requirements).toEqual(REQUIREMENTS);
    expect(pathsUnder(project.outDir).filter((path) => path !== 'void-artifact.json')).toEqual(
      manifest.files.map((file) => file.path),
    );
    expect(pathsUnder(join(project.outDir, 'migrations'))).toEqual([
      '0000_init.sql',
      '0001_add_users.sql',
      'meta/_journal.json',
    ]);
    expect(readFileSync(join(project.outDir, 'seed.sql'), 'utf8')).toContain('INSERT OR IGNORE');
    expect(
      pathsUnder(project.outDir).filter((path) => basename(path).startsWith('.dev.vars')),
    ).toEqual([]);
    const workerConfig = JSON.parse(
      readFileSync(
        join(project.outDir, '.cloudflare/output/v0/workers/default/worker.config.json'),
        'utf8',
      ),
    );
    expect(workerConfig.env).toMatchObject({
      DB: { type: 'd1', name: 'default', id: 'local' },
      KV: { type: 'kv', id: 'local' },
      QUEUE: { type: 'queue', name: 'demo-queue' },
    });
    expect(workerConfig.triggers).toContainEqual({ type: 'scheduled', schedule: '*/5 * * * *' });
  },
  PACKAGE_TIMEOUT_MS,
);

it(
  'omits migrations and seed without D1',
  async () => {
    const project = setupProject({ ...WORKER_CONFIG, d1_databases: undefined });
    await packageCloudflareArtifact({
      workerDirectory: project.workerDirectory,
      outDir: project.outDir,
      requirements: { ...REQUIREMENTS, d1: null, seed: false },
      provenance: PROVENANCE,
    });
    expect(existsSync(join(project.outDir, 'migrations'))).toBe(false);
    expect(existsSync(join(project.outDir, 'seed.sql'))).toBe(false);
    expect(readCloudflareArtifact(project.outDir).requirements).toMatchObject({
      d1: null,
      seed: false,
    });
  },
  PACKAGE_TIMEOUT_MS,
);

it.each([false, true])(
  'packages D1 without journal, missing directory: %s',
  async (missing) => {
    const project = setupProject();
    if (missing) {
      rmSync(project.migrationsDirectory, { recursive: true });
    }
    const migrations = missing ? [] : D1.migrations;
    const manifest = await packageCloudflareArtifact({
      ...inputFor(project),
      requirements: { ...REQUIREMENTS, d1: { ...D1, migrations, journal: false } },
    });
    expect(manifest.requirements.d1).toEqual({ ...D1, migrations, journal: false });
    expect(
      manifest.files.filter((file) => file.path.startsWith('migrations/')).map((file) => file.path),
    ).toEqual(migrations.map((name) => `migrations/${name}`));
  },
  PACKAGE_TIMEOUT_MS,
);

it.each([
  [{ migrationsDirectory: undefined }, 'migrationsDirectory is required'],
  [{ seedFile: undefined }, 'seedFile is required'],
  [
    { requirements: { ...REQUIREMENTS, d1: null, seed: false } },
    'migrationsDirectory must not be given',
  ],
  [{ requirements: { ...REQUIREMENTS, seed: false } }, 'seedFile must not be given'],
] as Array<[Partial<PackageCloudflareArtifactInput>, string]>)(
  'refuses inconsistent input %j',
  async (overrides, message) => {
    const project = setupProject();
    await expect(packageCloudflareArtifact({ ...inputFor(project), ...overrides })).rejects.toThrow(
      message,
    );
    expect(existsSync(project.outDir)).toBe(false);
  },
);

it('refuses nonempty output and preserves its files', async () => {
  const project = setupProject();
  mkdirSync(project.outDir);
  writeFileSync(join(project.outDir, 'keep.txt'), 'keep me');
  await expect(packageCloudflareArtifact(inputFor(project))).rejects.toThrow('must be empty');
  expect(readdirSync(project.outDir)).toEqual(['keep.txt']);
  expect(readFileSync(join(project.outDir, 'keep.txt'), 'utf8')).toBe('keep me');
});

it('refuses a file as output', async () => {
  const project = setupProject();
  writeFileSync(project.outDir, 'not a directory');
  await expect(packageCloudflareArtifact(inputFor(project))).rejects.toThrow('is not a directory');
  expect(readFileSync(project.outDir, 'utf8')).toBe('not a directory');
});

it.skipIf(isWindows)('refuses linked output without writing through it', async () => {
  const project = setupProject();
  const target = join(project.root, 'target');
  mkdirSync(target);
  symlinkSync(target, project.outDir);
  await expect(packageCloudflareArtifact(inputFor(project))).rejects.toThrow(
    'must not be a symlink',
  );
  expect(readdirSync(target)).toEqual([]);
});

type FailureCase = [
  string,
  (p: Project) => void,
  Partial<PackageCloudflareArtifactInput>,
  string | RegExp,
];
it.each<FailureCase>([
  [
    'missing migrations',
    (p) => rmSync(p.migrationsDirectory, { recursive: true }),
    {},
    'migrations directory is missing',
  ],
  [
    'journal without directory',
    (p) => rmSync(p.migrationsDirectory, { recursive: true }),
    { requirements: { ...REQUIREMENTS, d1: { ...D1, migrations: [] } } },
    'migrations directory is missing',
  ],
  [
    'missing SQL',
    (p) => rmSync(join(p.migrationsDirectory, '0001_add_users.sql')),
    {},
    '0001_add_users.sql is listed in requirements.d1 but is missing',
  ],
  [
    'unlisted SQL',
    (p) => writeFileSync(join(p.migrationsDirectory, '0002_unlisted.sql'), 'SELECT 1;'),
    {},
    /0002_unlisted\.sql in .* is not listed/,
  ],
  [
    'missing journal',
    (p) => rmSync(join(p.migrationsDirectory, 'meta', '_journal.json')),
    {},
    '_journal.json is missing',
  ],
])(
  'cleans up after %s',
  async (_name, edit, overrides, message) => {
    const project = setupProject();
    edit(project);
    // Exercise ownership of both a newly created and a pre-existing empty output.
    for (const existing of [false, true]) {
      if (existing) {
        mkdirSync(project.outDir);
      }
      await expect(
        packageCloudflareArtifact({ ...inputFor(project), ...overrides }),
      ).rejects.toThrow(message);
      if (existing) {
        expect(readdirSync(project.outDir)).toEqual([]);
      } else {
        expect(existsSync(project.outDir)).toBe(false);
      }
    }
  },
  PACKAGE_TIMEOUT_MS,
);

it.skipIf(isWindows).each(['migration', 'meta', 'seed', 'migrations directory'])(
  'rejects a symlinked %s and cleans output',
  async (kind) => {
    const project = setupProject();
    const outside = join(project.root, 'elsewhere');
    const directory = kind === 'meta' || kind === 'migrations directory';
    if (directory) {
      mkdirSync(outside);
      writeFileSync(join(outside, '_journal.json'), '{"entries":[]}');
    } else {
      writeFileSync(outside, 'SELECT 1;');
    }
    const path =
      kind === 'seed'
        ? project.seedFile
        : kind === 'migration'
          ? join(project.migrationsDirectory, D1.migrations[0])
          : kind === 'meta'
            ? join(project.migrationsDirectory, 'meta')
            : project.migrationsDirectory;
    rmSync(path, { recursive: true });
    symlinkSync(outside, path, directory ? 'dir' : 'file');
    const input = inputFor(project);
    if (kind === 'migrations directory') {
      input.requirements = { ...REQUIREMENTS, d1: { ...D1, migrations: [], journal: false } };
    }
    await expect(packageCloudflareArtifact(input)).rejects.toThrow(
      directory ? 'not a real directory' : 'is a symlink',
    );
    expect(existsSync(project.outDir)).toBe(false);
  },
  PACKAGE_TIMEOUT_MS,
);

it.each(['.env', '.dev.vars.local'])(
  'excludes secrets by rejecting client asset %s',
  async (name) => {
    const project = setupProject();
    writeFileSync(join(project.root, 'dist', 'client', name), 'API_TOKEN=local\n');
    await expect(packageCloudflareArtifact(inputFor(project))).rejects.toThrow(
      `.cloudflare/output/v0/workers/default/assets/${name}`,
    );
    expect(existsSync(project.outDir)).toBe(false);
  },
  PACKAGE_TIMEOUT_MS,
);

it.each(['./Dockerfile', 'docker.io/cloudflare/sandbox:1.0.1'])(
  'refuses container %s before the codemod',
  async (image) => {
    const project = setupProject({
      ...WORKER_CONFIG,
      containers: [{ class_name: 'Sandbox', image, max_instances: 1 }],
    });
    vi.mocked(prepareCfBuildOutput).mockClear();
    await expect(packageCloudflareArtifact(inputFor(project))).rejects.toThrow(
      'Containers (Sandbox) are not supported',
    );
    expect(prepareCfBuildOutput).not.toHaveBeenCalled();
    expect(existsSync(project.outDir)).toBe(false);
  },
);

it.each([
  ['[]', 'could not be converted into Cloudflare Build Output'],
  ['{"containers": [', SyntaxError],
])(
  'cleans up an unconvertible config %s',
  async (config, error) => {
    const project = setupProject();
    writeFileSync(join(project.workerDirectory, 'wrangler.json'), config);
    vi.mocked(prepareCfBuildOutput).mockClear();
    await expect(packageCloudflareArtifact(inputFor(project))).rejects.toThrow(error);
    expect(prepareCfBuildOutput).toHaveBeenCalledTimes(1);
    expect(existsSync(project.outDir)).toBe(false);
  },
  PACKAGE_TIMEOUT_MS,
);

it.each([false, true])(
  'retains the original error when cleanup fails, existing cause: %s',
  async (hasCause) => {
    const project = setupProject();
    const original = new Error(
      'The Worker build failed.',
      hasCause ? { cause: 'build detail' } : undefined,
    );
    vi.mocked(prepareCfBuildOutput).mockRejectedValueOnce(original);
    const realRmSync = (await vi.importActual<typeof import('node:fs')>('node:fs')).rmSync;
    const failure = new Error('cleanup refused');
    vi.mocked(rmSync).mockImplementation((path, options) => {
      if (path === project.outDir) {
        throw failure;
      }
      return realRmSync(path, options);
    });
    try {
      const error: unknown = await packageCloudflareArtifact(inputFor(project)).catch(
        (caught: unknown) => caught,
      );
      if (hasCause) {
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors).toEqual([original, failure]);
      } else {
        expect(error).toBe(original);
        expect(original.cause).toBe(failure);
      }
    } finally {
      vi.mocked(rmSync).mockImplementation(realRmSync);
    }
  },
);
