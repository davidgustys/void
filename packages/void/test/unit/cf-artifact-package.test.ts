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
import { basename, join, relative } from 'node:path';
import { toSlash } from 'pathslash';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import {
  type PackageCloudflareArtifactInput,
  packageCloudflareArtifact,
} from '../../src/cli/cf-artifact-package.ts';
import {
  type CloudflareArtifactRequirements,
  readCloudflareArtifact,
} from '../../src/cli/cf-artifact-schema.ts';
import { prepareCfBuildOutput } from '../../src/cli/cf-build-output.ts';

// Passthrough spies: the real functions still run, and the tests can inspect calls or force a failure.
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
// These tests run the real cf config codemod, so they share the timeout of the cf-build-output tests.
const PACKAGE_TIMEOUT_MS = isWindows ? 45_000 : 15_000;

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
  secrets: [],
  seed: true,
};
const PROVENANCE = { voidVersion: '0.0.0-test', commit: null, builtAt: null };

/** A Worker config with D1, KV, a queue producer and consumer, and a cron. Every ID is a placeholder. */
const WORKER_CONFIG: Record<string, unknown> = {
  name: 'void-test',
  main: 'index.js',
  compatibility_date: '2026-10-12',
  d1_databases: [{ binding: 'DB', database_name: 'default', database_id: 'local' }],
  kv_namespaces: [{ binding: 'KV', id: 'local' }],
  queues: {
    producers: [{ binding: 'QUEUE', queue: 'demo-queue' }],
    consumers: [{ queue: 'demo-queue', max_batch_timeout: 1 }],
  },
  triggers: { crons: ['* * * * *'] },
  assets: {
    binding: 'ASSETS',
    directory: '../client',
    not_found_handling: 'none',
    run_worker_first: ['/**'],
  },
};

type Project = {
  root: string;
  workerDirectory: string;
  outDir: string;
  migrationsDirectory: string;
  seedFile: string;
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Create a temp root that the next `afterEach` removes. */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-artifact-package-'));
  roots.push(root);
  return root;
}

/** Write a fake built Worker: `dist/ssr` with its config, bundle and `.dev.vars`, plus `dist/client`. */
function fakeWorker(root: string, config: Record<string, unknown>): string {
  const workerDirectory = join(root, 'dist', 'ssr');
  mkdirSync(workerDirectory, { recursive: true });
  writeFileSync(
    join(workerDirectory, 'index.js'),
    'export default { fetch() { return new Response("ok") } };\n',
  );
  writeFileSync(join(workerDirectory, 'wrangler.json'), JSON.stringify(config));
  writeFileSync(join(workerDirectory, '.dev.vars'), 'SECRET_KEY=local-only\n');
  const client = join(root, 'dist', 'client');
  mkdirSync(client, { recursive: true });
  writeFileSync(join(client, 'index.html'), '<h1>ok</h1>');
  return workerDirectory;
}

/** Write the app's migrations (with a journal and a snapshot) and its seed file under `root`. */
function fakeApp(root: string): void {
  const migrations = join(root, 'migrations');
  mkdirSync(join(migrations, 'meta'), { recursive: true });
  writeFileSync(join(migrations, '0000_init.sql'), 'CREATE TABLE users (id TEXT PRIMARY KEY);\n');
  writeFileSync(
    join(migrations, '0001_add_users.sql'),
    'ALTER TABLE users ADD COLUMN name TEXT;\n',
  );
  writeFileSync(
    join(migrations, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries: [] }),
  );
  writeFileSync(join(migrations, 'meta', '0000_snapshot.json'), JSON.stringify({ version: '7' }));
  writeFileSync(join(root, 'seed.sql'), "INSERT OR IGNORE INTO users (id) VALUES ('seed');\n");
}

/** A fresh project. The output path does not exist yet. */
function setupProject(config: Record<string, unknown> = WORKER_CONFIG): Project {
  const root = tempRoot();
  const workerDirectory = fakeWorker(root, config);
  fakeApp(root);
  return {
    root,
    workerDirectory,
    outDir: join(root, 'artifact'),
    migrationsDirectory: join(root, 'migrations'),
    seedFile: join(root, 'seed.sql'),
  };
}

/** The packaging input for `project` with the full requirements. */
function inputFor(project: Project): PackageCloudflareArtifactInput {
  return {
    workerDirectory: project.workerDirectory,
    outDir: project.outDir,
    requirements: REQUIREMENTS,
    migrationsDirectory: project.migrationsDirectory,
    seedFile: project.seedFile,
    provenance: PROVENANCE,
  };
}

/** List the regular files under `root` as sorted POSIX paths relative to it. */
function filesUnder(root: string): Array<string> {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => toSlash(relative(root, join(entry.parentPath, entry.name))))
    .sort();
}

/**
 * Make removing `outDir` fail, as a cleanup failure would. Returns the injected failure and a
 * function that restores the real `rmSync`.
 */
async function failCleanupOf(outDir: string): Promise<{ failure: Error; restore: () => void }> {
  const realRmSync = (await vi.importActual<typeof import('node:fs')>('node:fs')).rmSync;
  const failure = new Error('cleanup refused');
  vi.mocked(rmSync).mockImplementation((path, options) => {
    if (path === outDir) {
      throw failure;
    }
    return realRmSync(path, options);
  });
  return { failure, restore: () => vi.mocked(rmSync).mockImplementation(realRmSync) };
}

it(
  'packages the Build Output, migrations and seed into a verified artifact',
  async () => {
    const project = setupProject();
    const { outDir } = project;

    const manifest = await packageCloudflareArtifact(inputFor(project));

    expect(await readCloudflareArtifact(outDir)).toEqual(manifest);
    expect(manifest.requirements).toEqual(REQUIREMENTS);
    expect(filesUnder(outDir).filter((path) => path !== 'void-artifact.json')).toEqual(
      manifest.files.map((file) => file.path),
    );
    expect(filesUnder(join(outDir, 'migrations'))).toEqual([
      '0000_init.sql',
      '0001_add_users.sql',
      'meta/_journal.json',
    ]);
    expect(readFileSync(join(outDir, 'seed.sql'), 'utf8')).toContain('INSERT OR IGNORE');
    expect(filesUnder(outDir).filter((path) => basename(path).startsWith('.dev.vars'))).toEqual([]);
    const workerConfig = JSON.parse(
      readFileSync(
        join(outDir, '.cloudflare/output/v0/workers/default/worker.config.json'),
        'utf8',
      ),
    );
    expect(workerConfig.env).toMatchObject({
      DB: { type: 'd1', name: 'default', id: 'local' },
      KV: { type: 'kv', id: 'local' },
      QUEUE: { type: 'queue', name: 'demo-queue' },
    });
    expect(workerConfig.triggers).toContainEqual({ type: 'scheduled', schedule: '* * * * *' });
  },
  PACKAGE_TIMEOUT_MS,
);

it(
  'omits migrations and seed when the app has no D1 database',
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
    expect(readCloudflareArtifact(project.outDir)).toMatchObject({
      requirements: { d1: null, seed: false },
    });
  },
  PACKAGE_TIMEOUT_MS,
);

it(
  'copies no journal when the requirements do not list one',
  async () => {
    const project = setupProject();

    await packageCloudflareArtifact({
      ...inputFor(project),
      requirements: { ...REQUIREMENTS, d1: { ...D1, journal: false } },
    });

    expect(filesUnder(join(project.outDir, 'migrations'))).toEqual([
      '0000_init.sql',
      '0001_add_users.sql',
    ]);
  },
  PACKAGE_TIMEOUT_MS,
);

it(
  'omits the migrations folder when D1 has no migrations folder and lists no migrations',
  async () => {
    const project = setupProject();
    rmSync(project.migrationsDirectory, { recursive: true, force: true });

    const manifest = await packageCloudflareArtifact({
      ...inputFor(project),
      requirements: { ...REQUIREMENTS, d1: { ...D1, migrations: [], journal: false } },
    });

    expect(manifest.requirements.d1).toEqual({ ...D1, migrations: [], journal: false });
    expect(existsSync(join(project.outDir, 'migrations'))).toBe(false);
    expect(manifest.files.filter((file) => file.path.startsWith('migrations/'))).toEqual([]);
  },
  PACKAGE_TIMEOUT_MS,
);

it(
  'rejects a missing migrations folder when migrations are listed',
  async () => {
    const project = setupProject();
    rmSync(project.migrationsDirectory, { recursive: true, force: true });

    await expect(packageCloudflareArtifact(inputFor(project))).rejects.toThrow(
      'The migrations directory is missing or is not a real directory',
    );
    expect(existsSync(project.outDir)).toBe(false);
  },
  PACKAGE_TIMEOUT_MS,
);

it(
  'rejects a missing migrations folder when the journal is required',
  async () => {
    const project = setupProject();
    rmSync(project.migrationsDirectory, { recursive: true, force: true });

    await expect(
      packageCloudflareArtifact({
        ...inputFor(project),
        requirements: { ...REQUIREMENTS, d1: { ...D1, migrations: [], journal: true } },
      }),
    ).rejects.toThrow('The migrations directory is missing or is not a real directory');
    expect(existsSync(project.outDir)).toBe(false);
  },
  PACKAGE_TIMEOUT_MS,
);

it.skipIf(isWindows)(
  'rejects a symlinked migrations folder even when no migrations are listed',
  async () => {
    const project = setupProject();
    const elsewhere = join(project.root, 'elsewhere');
    mkdirSync(elsewhere);
    rmSync(project.migrationsDirectory, { recursive: true, force: true });
    symlinkSync(elsewhere, project.migrationsDirectory);

    await expect(
      packageCloudflareArtifact({
        ...inputFor(project),
        requirements: { ...REQUIREMENTS, d1: { ...D1, migrations: [], journal: false } },
      }),
    ).rejects.toThrow('The migrations directory is missing or is not a real directory');
    expect(existsSync(project.outDir)).toBe(false);
  },
  PACKAGE_TIMEOUT_MS,
);

it('rejects a migrations directory when the app has no D1 database', async () => {
  const project = setupProject();

  await expect(
    packageCloudflareArtifact({
      workerDirectory: project.workerDirectory,
      outDir: project.outDir,
      requirements: { ...REQUIREMENTS, d1: null, seed: false },
      migrationsDirectory: project.migrationsDirectory,
      provenance: PROVENANCE,
    }),
  ).rejects.toThrow('migrationsDirectory must not be given');
  expect(existsSync(project.outDir)).toBe(false);
});

it('rejects a missing seed file when the requirements need one', async () => {
  const project = setupProject();

  await expect(
    packageCloudflareArtifact({
      workerDirectory: project.workerDirectory,
      outDir: project.outDir,
      requirements: REQUIREMENTS,
      migrationsDirectory: project.migrationsDirectory,
      provenance: PROVENANCE,
    }),
  ).rejects.toThrow('seedFile is required');
  expect(existsSync(project.outDir)).toBe(false);
});

it('rejects a missing migrations directory when D1 is required', async () => {
  const project = setupProject();

  await expect(
    packageCloudflareArtifact({
      workerDirectory: project.workerDirectory,
      outDir: project.outDir,
      requirements: REQUIREMENTS,
      seedFile: project.seedFile,
      provenance: PROVENANCE,
    }),
  ).rejects.toThrow('migrationsDirectory is required');
  expect(existsSync(project.outDir)).toBe(false);
});

it('rejects a seed file when the requirements do not include one', async () => {
  const project = setupProject();

  await expect(
    packageCloudflareArtifact({
      workerDirectory: project.workerDirectory,
      outDir: project.outDir,
      requirements: { ...REQUIREMENTS, seed: false },
      migrationsDirectory: project.migrationsDirectory,
      seedFile: project.seedFile,
      provenance: PROVENANCE,
    }),
  ).rejects.toThrow('seedFile must not be given');
  expect(existsSync(project.outDir)).toBe(false);
});

it('refuses a non-empty output directory and leaves its files alone', async () => {
  const project = setupProject();
  mkdirSync(project.outDir);
  writeFileSync(join(project.outDir, 'keep.txt'), 'keep me');

  await expect(packageCloudflareArtifact(inputFor(project))).rejects.toThrow('must be empty');
  expect(readdirSync(project.outDir)).toEqual(['keep.txt']);
  expect(readFileSync(join(project.outDir, 'keep.txt'), 'utf8')).toBe('keep me');
});

it('refuses an output path that is a file', async () => {
  const project = setupProject();
  writeFileSync(project.outDir, 'not a directory');

  await expect(packageCloudflareArtifact(inputFor(project))).rejects.toThrow('is not a directory');
  expect(readFileSync(project.outDir, 'utf8')).toBe('not a directory');
});

it.skipIf(isWindows)(
  'refuses a symlinked output directory and writes nothing to its target',
  async () => {
    const project = setupProject();
    const target = join(project.root, 'target');
    mkdirSync(target);
    symlinkSync(target, project.outDir);

    await expect(packageCloudflareArtifact(inputFor(project))).rejects.toThrow(
      'must not be a symlink',
    );
    expect(readdirSync(target)).toEqual([]);
  },
);

it(
  'removes the output directory when a listed migration is missing',
  async () => {
    const project = setupProject();
    rmSync(join(project.migrationsDirectory, '0001_add_users.sql'));

    await expect(packageCloudflareArtifact(inputFor(project))).rejects.toThrow(
      '0001_add_users.sql is listed in requirements.d1 but is missing',
    );
    expect(existsSync(project.outDir)).toBe(false);
  },
  PACKAGE_TIMEOUT_MS,
);

it(
  'empties an existing output directory when an unlisted migration is present',
  async () => {
    const project = setupProject();
    mkdirSync(project.outDir);
    writeFileSync(join(project.migrationsDirectory, '0002_unlisted.sql'), 'SELECT 1;\n');

    await expect(packageCloudflareArtifact(inputFor(project))).rejects.toThrow(
      /0002_unlisted\.sql in .* is not listed in requirements\.d1/,
    );
    expect(readdirSync(project.outDir)).toEqual([]);
  },
  PACKAGE_TIMEOUT_MS,
);

it(
  'omits a snapshot and any other file from the migrations directory',
  async () => {
    const project = setupProject();
    writeFileSync(join(project.migrationsDirectory, 'notes.txt'), 'not a migration');

    await packageCloudflareArtifact(inputFor(project));

    expect(filesUnder(join(project.outDir, 'migrations'))).not.toContain('meta/0000_snapshot.json');
    expect(filesUnder(join(project.outDir, 'migrations'))).not.toContain('notes.txt');
  },
  PACKAGE_TIMEOUT_MS,
);

it(
  'removes the output directory when the required journal is missing',
  async () => {
    const project = setupProject();
    rmSync(join(project.migrationsDirectory, 'meta', '_journal.json'));

    await expect(packageCloudflareArtifact(inputFor(project))).rejects.toThrow(
      '_journal.json is missing',
    );
    expect(existsSync(project.outDir)).toBe(false);
  },
  PACKAGE_TIMEOUT_MS,
);

it.skipIf(isWindows)(
  'refuses a symlinked migration and removes the output directory',
  async () => {
    const project = setupProject();
    const real = join(project.root, 'real-init.sql');
    writeFileSync(real, 'CREATE TABLE other (id TEXT);\n');
    rmSync(join(project.migrationsDirectory, '0000_init.sql'));
    symlinkSync(real, join(project.migrationsDirectory, '0000_init.sql'));

    await expect(packageCloudflareArtifact(inputFor(project))).rejects.toThrow('is a symlink');
    expect(existsSync(project.outDir)).toBe(false);
  },
  PACKAGE_TIMEOUT_MS,
);

it.skipIf(isWindows)(
  'refuses a symlinked migrations meta directory',
  async () => {
    const project = setupProject();
    const elsewhere = join(project.root, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, '_journal.json'), '{"entries":[]}');
    rmSync(join(project.migrationsDirectory, 'meta'), { recursive: true });
    symlinkSync(elsewhere, join(project.migrationsDirectory, 'meta'));

    await expect(packageCloudflareArtifact(inputFor(project))).rejects.toThrow(
      'migrations meta directory is missing or is not a real directory',
    );
    expect(existsSync(project.outDir)).toBe(false);
  },
  PACKAGE_TIMEOUT_MS,
);

it.skipIf(isWindows)(
  'empties an existing output directory when the seed file is a symlink',
  async () => {
    const project = setupProject();
    const real = join(project.root, 'real-seed.sql');
    writeFileSync(real, 'SELECT 1;\n');
    rmSync(project.seedFile);
    symlinkSync(real, project.seedFile);
    mkdirSync(project.outDir);

    await expect(packageCloudflareArtifact(inputFor(project))).rejects.toThrow('is a symlink');
    expect(readdirSync(project.outDir)).toEqual([]);
  },
  PACKAGE_TIMEOUT_MS,
);

it.each(['.env', '.dev.vars.local'])(
  'refuses a local %s file in the client assets and removes the output directory',
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

it(
  'names a Worker build that cannot be converted into Build Output',
  async () => {
    const project = setupProject();
    writeFileSync(join(project.workerDirectory, 'wrangler.json'), '[]');

    await expect(packageCloudflareArtifact(inputFor(project))).rejects.toThrow(
      'could not be converted into Cloudflare Build Output',
    );
    expect(existsSync(project.outDir)).toBe(false);
  },
  PACKAGE_TIMEOUT_MS,
);

it(
  'refuses a Worker with containers, because Sandbox is not supported in preview artifacts',
  async () => {
    const project = setupProject({
      ...WORKER_CONFIG,
      containers: [
        {
          name: 'sandbox',
          class_name: 'Sandbox',
          image: 'docker.io/cloudflare/sandbox:1.0.1',
          max_instances: 1,
        },
      ],
      durable_objects: { bindings: [{ name: 'Sandbox', class_name: 'Sandbox' }] },
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Sandbox'] }],
    });

    await expect(packageCloudflareArtifact(inputFor(project))).rejects.toThrow(
      'Containers (Sandbox) are not supported in preview artifacts',
    );
    expect(existsSync(project.outDir)).toBe(false);
  },
  PACKAGE_TIMEOUT_MS,
);

it('refuses a Dockerfile container before the codemod runs', async () => {
  const project = setupProject({
    ...WORKER_CONFIG,
    containers: [{ class_name: 'Sandbox', image: './Dockerfile', max_instances: 1 }],
  });
  vi.mocked(prepareCfBuildOutput).mockClear();

  await expect(packageCloudflareArtifact(inputFor(project))).rejects.toThrow(
    'Containers (Sandbox) are not supported in preview artifacts',
  );
  // The codemod is what runs `docker build`, so it must not be called at all.
  expect(prepareCfBuildOutput).not.toHaveBeenCalled();
  expect(existsSync(project.outDir)).toBe(false);
});

it('leaves an invalid wrangler.json for the codemod to report', async () => {
  const project = setupProject();
  writeFileSync(join(project.workerDirectory, 'wrangler.json'), '{"containers": [');
  vi.mocked(prepareCfBuildOutput).mockClear();

  await expect(packageCloudflareArtifact(inputFor(project))).rejects.toThrow(SyntaxError);
  expect(prepareCfBuildOutput).toHaveBeenCalledTimes(1);
  expect(existsSync(project.outDir)).toBe(false);
});

it(
  'keeps the original error when cleanup also fails',
  async () => {
    const project = setupProject();
    // A listed migration is missing, so copyMigrations fails after the build output is written.
    rmSync(join(project.migrationsDirectory, '0001_add_users.sql'));
    const { failure, restore } = await failCleanupOf(project.outDir);
    try {
      const error = await packageCloudflareArtifact(inputFor(project)).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(AggregateError);
      expect((error as Error).message).toBe(
        `The migration 0001_add_users.sql is listed in requirements.d1 but is missing from ${project.migrationsDirectory}.`,
      );
      expect((error as Error).cause).toBe(failure);
    } finally {
      restore();
    }
  },
  PACKAGE_TIMEOUT_MS,
);

it('wraps the original error in an AggregateError when it already has a cause', async () => {
  const project = setupProject();
  const original = new Error('The Worker build failed.', { cause: 'build detail' });
  vi.mocked(prepareCfBuildOutput).mockRejectedValueOnce(original);
  const { failure, restore } = await failCleanupOf(project.outDir);
  try {
    const error = await packageCloudflareArtifact(inputFor(project)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe(original.message);
    const [first, second] = (error as AggregateError).errors;
    expect(first).toBe(original);
    expect(second).toBe(failure);
  } finally {
    restore();
  }
});
