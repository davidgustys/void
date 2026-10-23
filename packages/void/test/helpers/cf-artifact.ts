import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { toSlash } from 'pathslash';
import { expect } from 'vite-plus/test';
import {
  CloudflareArtifactError,
  type CloudflareArtifactErrorCode,
  type CloudflareArtifactFile,
  listCloudflareArtifactFiles,
} from '../../src/cli/cf-artifact-files.ts';
import {
  CLOUDFLARE_ARTIFACT_MANIFEST_FILE,
  type CloudflareArtifactManifest,
  type CloudflareArtifactRequirements,
  createCloudflareArtifactManifest,
  writeCloudflareArtifactManifest,
} from '../../src/cli/cf-artifact-schema.ts';

export const PROVENANCE = { voidVersion: '0.0.0-test', commit: null, builtAt: null };
export const MIGRATIONS: Array<string> = ['0000_init.sql', '0001_add_users.sql'];
export const SEED_SQL = "INSERT OR IGNORE INTO users (id) VALUES ('seed');\n";
export const SECRET_VALUES = {
  API_KEY: 'api-key-value-for-tests',
  SIGNING_KEY: 'signing-key-value-for-tests',
};
export const JOURNAL: {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
} = {
  version: '7',
  dialect: 'sqlite',
  entries: MIGRATIONS.map((name, idx) => ({
    idx,
    version: '6',
    when: 1_760_000_000_000 + idx * 100_000,
    tag: name.slice(0, -4),
    breakpoints: true,
  })),
};

export function makeRequirements(
  overrides: Partial<CloudflareArtifactRequirements> = {},
): CloudflareArtifactRequirements {
  return {
    d1: {
      binding: 'DB',
      migrationsTable: 'd1_migrations',
      migrations: [...MIGRATIONS],
      journal: true,
    },
    isrCache: false,
    email: { inbound: false, send: false },
    secrets: Object.keys(SECRET_VALUES),
    seed: true,
    ...overrides,
  };
}

export function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

export function fileEntry(path: string, contents: string): CloudflareArtifactFile {
  return { path, size: Buffer.byteLength(contents), sha256: sha256(contents) };
}

export function catchArtifactError(action: () => unknown): CloudflareArtifactError {
  try {
    action();
  } catch (error) {
    if (error instanceof CloudflareArtifactError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the artifact check to throw.');
}

export function expectArtifactError(
  action: () => unknown,
  code: CloudflareArtifactErrorCode,
  path?: string,
): void {
  const error = catchArtifactError(action);
  expect(error.code).toBe(code);
  expect(error.path).toBe(path);
}

export function pathsUnder(root: string): Array<string> {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => toSlash(relative(root, join(entry.parentPath, entry.name))))
    .sort();
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Callers own and explicitly remove the temporary root. */
export function writeArtifact(
  root: string,
  tree: ReadonlyArray<readonly [string, string]>,
  requirements: CloudflareArtifactRequirements = makeRequirements(),
): CloudflareArtifactManifest {
  for (const [path, contents] of tree) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return rehashArtifact(root, requirements);
}

export function copyArtifact(source: string, destination: string): string {
  cpSync(source, destination, { recursive: true });
  return destination;
}

/** Rehash edited files so content validation, rather than integrity, is exercised. */
export function rehashArtifact(
  root: string,
  requirements: CloudflareArtifactRequirements = makeRequirements(),
): CloudflareArtifactManifest {
  const files = listCloudflareArtifactFiles(root, { exclude: [CLOUDFLARE_ARTIFACT_MANIFEST_FILE] });
  const manifest = createCloudflareArtifactManifest({
    provenance: PROVENANCE,
    requirements,
    files,
  });
  writeCloudflareArtifactManifest(root, manifest);
  return manifest;
}

export const WRANGLER_CONFIG: Record<string, unknown> = {
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
  secrets: { required: Object.keys(SECRET_VALUES) },
  assets: {
    binding: 'ASSETS',
    directory: '../client',
    not_found_handling: 'none',
    run_worker_first: ['/**'],
  },
};

export function writeBuiltProject(
  root: string,
  config: Record<string, unknown> = WRANGLER_CONFIG,
): {
  root: string;
  workerDirectory: string;
  outDir: string;
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
  writeJson(join(workerDirectory, 'wrangler.json'), config);
  writeFileSync(join(workerDirectory, '.dev.vars'), 'SECRET_KEY=local-only\n');
  mkdirSync(join(root, 'dist', 'client'), { recursive: true });
  writeFileSync(join(root, 'dist', 'client', 'index.html'), '<h1>preview</h1>\n');
  const migrationsDirectory = join(root, 'migrations');
  mkdirSync(join(migrationsDirectory, 'meta'), { recursive: true });
  writeFileSync(
    join(migrationsDirectory, MIGRATIONS[0]),
    'CREATE TABLE users (id TEXT PRIMARY KEY);\n',
  );
  writeFileSync(
    join(migrationsDirectory, MIGRATIONS[1]),
    'ALTER TABLE users ADD COLUMN name TEXT;\n',
  );
  writeJson(join(migrationsDirectory, 'meta', '_journal.json'), JOURNAL);
  writeJson(join(migrationsDirectory, 'meta', '0000_snapshot.json'), { version: '7' });
  const seedFile = join(root, 'seed.sql');
  writeFileSync(seedFile, SEED_SQL);
  return { root, workerDirectory, outDir: join(root, 'artifact'), migrationsDirectory, seedFile };
}
