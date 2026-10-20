/* oxlint-disable typescript-eslint/no-explicit-any -- these tests break one field of a valid manifest on purpose; `Draft` is the loose shape that keeps each edit readable. */
import { createHash } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { canonicalJson } from '@void/deploy-core';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  type CloudflareArtifactErrorCode,
  type CloudflareArtifactFile,
  CloudflareArtifactError,
  DEFAULT_CLOUDFLARE_ARTIFACT_LIMITS,
  listCloudflareArtifactFiles,
} from '../../src/cli/cf-artifact-files.ts';
import {
  assertCloudflareMigrationApplyOrder,
  CLOUDFLARE_ARTIFACT_MANIFEST_FILE,
  CLOUDFLARE_ARTIFACT_OUTPUT_DIR,
  CLOUDFLARE_ARTIFACT_SEED_FILE,
  type CloudflareArtifactManifest,
  type CloudflareArtifactProvenance,
  type CloudflareArtifactRequirements,
  MAX_CLOUDFLARE_ARTIFACT_MANIFEST_BYTES,
  cloudflareArtifactDigest,
  createCloudflareArtifactManifest,
  parseCloudflareArtifactManifest,
  readCloudflareArtifact,
  writeCloudflareArtifactManifest,
} from '../../src/cli/cf-artifact-schema.ts';

const roots: Array<string> = [];
const isWindows = process.platform === 'win32';
const MANIFEST = CLOUDFLARE_ARTIFACT_MANIFEST_FILE;
const SEED = CLOUDFLARE_ARTIFACT_SEED_FILE;
const OUTPUT = `${CLOUDFLARE_ARTIFACT_OUTPUT_DIR}/`;
const CONFIG = `${OUTPUT}config.json`;
const WORKER_CONFIG = `${OUTPUT}workers/default/worker.config.json`;
const JOURNAL = 'migrations/meta/_journal.json';

/** A loosely typed manifest copy, so one test can break exactly one field. */
type Draft = Record<string, any>;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Create a temp root that the next `afterEach` removes. */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-artifact-schema-'));
  roots.push(root);
  return root;
}

function sha256(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

function fileEntry(path: string, contents: string): CloudflareArtifactFile {
  return { path, size: Buffer.byteLength(contents), sha256: sha256(contents) };
}

/** Run `action` and return the artifact error it throws. */
function catchArtifactError(action: () => unknown): CloudflareArtifactError {
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

function expectArtifactError(
  action: () => unknown,
  code: CloudflareArtifactErrorCode,
  path?: string,
): void {
  const error = catchArtifactError(action);
  expect(error.code).toBe(code);
  expect(error.path).toBe(path);
}

/** A small valid artifact: output config, one bundle file, one asset, two migrations, a journal, and a seed. Listed in sorted order. */
const FIXTURE_TREE: ReadonlyArray<readonly [string, string]> = [
  [CONFIG, '{"version":1}\n'],
  [`${OUTPUT}workers/default/assets/index.html`, '<h1>ok</h1>\n'],
  [`${OUTPUT}workers/default/bundle/index.js`, 'export default {};\n'],
  [WORKER_CONFIG, '{"main":"index.js"}\n'],
  ['migrations/0001_init.sql', 'create table notes (id integer);\n'],
  ['migrations/0002_users.sql', 'create table users (id integer);\n'],
  [JOURNAL, '{"entries":[]}\n'],
  [SEED, 'insert or ignore into users (id) values (1);\n'],
];

const PROVENANCE: CloudflareArtifactProvenance = {
  voidVersion: '0.1.0-preview.1',
  commit: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
  builtAt: '2026-10-01T12:00:00.000Z',
};

/** Migrations stay in apply order, which here is not sorted order. Secrets are given unsorted. */
const REQUIREMENTS: CloudflareArtifactRequirements = {
  d1: {
    binding: 'DB',
    migrationsTable: 'd1_migrations',
    migrations: ['0002_users.sql', '0001_init.sql'],
    journal: true,
  },
  isrCache: false,
  email: { inbound: false, send: true },
  secrets: ['SESSION_SECRET', 'API_KEY'],
  seed: true,
};

function fixtureEntries(): Array<CloudflareArtifactFile> {
  return FIXTURE_TREE.map(([path, contents]) => fileEntry(path, contents));
}

/** A valid manifest in memory. Shape and layout tests start from this and break one thing. */
function validManifest(): CloudflareArtifactManifest {
  return createCloudflareArtifactManifest({
    provenance: PROVENANCE,
    requirements: REQUIREMENTS,
    files: fixtureEntries(),
  });
}

function draftOf(manifest: CloudflareArtifactManifest): Draft {
  return JSON.parse(JSON.stringify(manifest));
}

function writeFixtureTree(root: string): void {
  for (const [path, contents] of FIXTURE_TREE) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
}

/** Write the fixture tree and a valid envelope for it into a new root. */
function writeFixtureArtifact(): { root: string; manifest: CloudflareArtifactManifest } {
  const root = tempRoot();
  writeFixtureTree(root);
  const manifest = createCloudflareArtifactManifest({
    provenance: PROVENANCE,
    requirements: REQUIREMENTS,
    files: listCloudflareArtifactFiles(root),
  });
  writeCloudflareArtifactManifest(root, manifest);
  return { root, manifest };
}

/** Recompute `draft.digest` so that only the rule under test can fail. */
function signed(draft: Draft): Draft {
  draft.digest = cloudflareArtifactDigest(draft as Omit<CloudflareArtifactManifest, 'digest'>);
  return draft;
}

function byPath(a: CloudflareArtifactFile, b: CloudflareArtifactFile): number {
  return a.path < b.path ? -1 : 1;
}

/** Add a file entry to a draft, keeping its file list sorted. */
function addFile(draft: Draft, path: string): void {
  draft.files = [...draft.files, { path, size: 1, sha256: sha256('x') }].sort(byPath);
}

function removeFile(draft: Draft, path: string): void {
  draft.files = draft.files.filter((file: CloudflareArtifactFile) => file.path !== path);
}

function removeMigrationFiles(draft: Draft): void {
  draft.files = draft.files.filter(
    (file: CloudflareArtifactFile) => !file.path.startsWith('migrations/'),
  );
}

it('round-trips a manifest through write and read, keeping migration order', () => {
  const { root, manifest } = writeFixtureArtifact();

  expect(readCloudflareArtifact(root)).toEqual(manifest);
  expect(manifest.requirements.d1?.migrations).toEqual(['0002_users.sql', '0001_init.sql']);
  expect(manifest.requirements.secrets).toEqual(['API_KEY', 'SESSION_SECRET']);
});

it('writes pretty JSON with a trailing newline', () => {
  const { root, manifest } = writeFixtureArtifact();
  expect(readFileSync(join(root, MANIFEST), 'utf8')).toBe(`${JSON.stringify(manifest, null, 2)}\n`);
});

it('normalizes file and secret order when creating', () => {
  const manifest = createCloudflareArtifactManifest({
    provenance: PROVENANCE,
    requirements: REQUIREMENTS,
    files: fixtureEntries().reverse(),
  });

  expect(manifest).toEqual(validManifest());
  expect(manifest.files.map((file) => file.path)).toEqual(FIXTURE_TREE.map(([path]) => path));
  expect(manifest.requirements.secrets).toEqual(['API_KEY', 'SESSION_SECRET']);
});

it('validates the manifest it creates', () => {
  expectArtifactError(
    () =>
      createCloudflareArtifactManifest({
        provenance: PROVENANCE,
        requirements: { ...REQUIREMENTS, seed: false },
        files: fixtureEntries(),
      }),
    'layout',
    SEED,
  );
});

it('accepts an artifact without a D1 database', () => {
  const files = fixtureEntries().filter(
    (file) => !file.path.startsWith('migrations/') && file.path !== SEED,
  );
  const manifest = createCloudflareArtifactManifest({
    provenance: { voidVersion: '1.0.0', commit: null, builtAt: null },
    requirements: {
      d1: null,
      isrCache: true,
      email: { inbound: true, send: false },
      secrets: [],
      seed: false,
    },
    files,
  });

  expect(parseCloudflareArtifactManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
});

it('computes SHA-256 over the canonical JSON of every field except digest', () => {
  const manifest = validManifest();
  const canonical = canonicalJson({
    format: manifest.format,
    version: manifest.version,
    provenance: manifest.provenance,
    requirements: manifest.requirements,
    files: manifest.files,
  });

  expect(manifest.digest).toBe(sha256(canonical));
});

it('does not depend on the key order of the input objects', () => {
  const reordered = createCloudflareArtifactManifest({
    files: fixtureEntries(),
    requirements: {
      seed: REQUIREMENTS.seed,
      secrets: REQUIREMENTS.secrets,
      email: { send: true, inbound: false },
      isrCache: false,
      d1: {
        journal: true,
        migrations: ['0002_users.sql', '0001_init.sql'],
        migrationsTable: 'd1_migrations',
        binding: 'DB',
      },
    },
    provenance: {
      builtAt: PROVENANCE.builtAt,
      commit: PROVENANCE.commit,
      voidVersion: PROVENANCE.voidVersion,
    },
  });

  expect(reordered.digest).toBe(validManifest().digest);
});

it.each<[string, (draft: Draft) => void]>([
  [
    'a file hash',
    (draft) => {
      draft.files[0].sha256 = sha256('changed');
    },
  ],
  [
    'a file size',
    (draft) => {
      draft.files[0].size += 1;
    },
  ],
  [
    'the migration order',
    (draft) => {
      draft.requirements.d1.migrations.reverse();
    },
  ],
  [
    'the isrCache flag',
    (draft) => {
      draft.requirements.isrCache = true;
    },
  ],
  [
    'a secret',
    (draft) => {
      draft.requirements.secrets = ['API_KEY'];
    },
  ],
  [
    'the seed flag',
    (draft) => {
      draft.requirements.seed = false;
    },
  ],
  [
    'the Void version',
    (draft) => {
      draft.provenance.voidVersion = '0.1.1';
    },
  ],
  [
    'the commit',
    (draft) => {
      draft.provenance.commit = null;
    },
  ],
  [
    'the build time',
    (draft) => {
      draft.provenance.builtAt = '2026-10-02T12:00:00.000Z';
    },
  ],
])('changes the digest when %s changes', (_label, change) => {
  const draft = draftOf(validManifest());
  change(draft);
  expect(cloudflareArtifactDigest(draft as Omit<CloudflareArtifactManifest, 'digest'>)).not.toBe(
    validManifest().digest,
  );
});

it('rejects a digest that does not match the contents', () => {
  const draft = draftOf(validManifest());
  draft.digest = '0'.repeat(64);
  expectArtifactError(() => parseCloudflareArtifactManifest(draft), 'digest');
});

it('rejects a changed file hash that was not re-signed', () => {
  const draft = draftOf(validManifest());
  draft.files[0].sha256 = sha256('tampered');
  expectArtifactError(() => parseCloudflareArtifactManifest(draft), 'digest');
});

it('rejects a tampered manifest on disk', () => {
  const { root } = writeFixtureArtifact();
  const draft: Draft = JSON.parse(readFileSync(join(root, MANIFEST), 'utf8'));
  draft.provenance.voidVersion = '9.9.9';
  writeFileSync(join(root, MANIFEST), JSON.stringify(draft));
  expectArtifactError(() => readCloudflareArtifact(root), 'digest');
});

type ShapeCase = { name: string; field: string; edit: (draft: Draft) => void };

/** Each row breaks one shape rule. The error must be a 'manifest' error that names `field`. */
const SHAPE_CASES: Array<ShapeCase> = [
  {
    name: 'an unknown top-level key',
    field: 'extra',
    edit: (draft) => {
      draft.extra = true;
    },
  },
  {
    name: 'an unknown key in provenance',
    field: 'provenance',
    edit: (draft) => {
      draft.provenance.extra = 1;
    },
  },
  {
    name: 'an unknown key in requirements.d1',
    field: 'requirements.d1',
    edit: (draft) => {
      draft.requirements.d1.extra = 1;
    },
  },
  {
    name: 'an unknown key in requirements.email',
    field: 'requirements.email',
    edit: (draft) => {
      draft.requirements.email.extra = true;
    },
  },
  {
    name: 'an unknown key in a file entry',
    field: 'files[0]',
    edit: (draft) => {
      draft.files[0].extra = 1;
    },
  },
  {
    name: 'a missing top-level key',
    field: 'digest',
    edit: (draft) => {
      delete draft.digest;
    },
  },
  {
    name: 'a missing nullable provenance key',
    field: 'provenance.commit',
    edit: (draft) => {
      delete draft.provenance.commit;
    },
  },
  {
    name: 'a missing requirements.d1 key',
    field: 'requirements.d1.journal',
    edit: (draft) => {
      delete draft.requirements.d1.journal;
    },
  },
  {
    name: 'a requirements block that is an array',
    field: 'requirements',
    edit: (draft) => {
      draft.requirements = [];
    },
  },
  {
    name: 'a d1 block that is a string',
    field: 'requirements.d1',
    edit: (draft) => {
      draft.requirements.d1 = 'DB';
    },
  },
  {
    name: 'a wrong format',
    field: 'format',
    edit: (draft) => {
      draft.format = 'void-other';
    },
  },
  {
    name: 'version 2',
    field: 'version',
    edit: (draft) => {
      draft.version = 2;
    },
  },
  {
    name: 'a string version',
    field: 'version',
    edit: (draft) => {
      draft.version = '1';
    },
  },
  {
    name: 'a voidVersion with a space',
    field: 'provenance.voidVersion',
    edit: (draft) => {
      draft.provenance.voidVersion = '1 0';
    },
  },
  {
    name: 'an empty voidVersion',
    field: 'provenance.voidVersion',
    edit: (draft) => {
      draft.provenance.voidVersion = '';
    },
  },
  {
    name: 'a voidVersion over 64 characters',
    field: 'provenance.voidVersion',
    edit: (draft) => {
      draft.provenance.voidVersion = 'a'.repeat(65);
    },
  },
  {
    name: 'an uppercase commit',
    field: 'provenance.commit',
    edit: (draft) => {
      draft.provenance.commit = 'A1B2C3D';
    },
  },
  {
    name: 'a commit shorter than 7 characters',
    field: 'provenance.commit',
    edit: (draft) => {
      draft.provenance.commit = 'abc123';
    },
  },
  {
    name: 'a commit that is not hex',
    field: 'provenance.commit',
    edit: (draft) => {
      draft.provenance.commit = 'z'.repeat(8);
    },
  },
  {
    name: 'a builtAt that is not a date',
    field: 'provenance.builtAt',
    edit: (draft) => {
      draft.provenance.builtAt = 'not a date';
    },
  },
  {
    name: 'a builtAt longer than 40 characters',
    field: 'provenance.builtAt',
    edit: (draft) => {
      draft.provenance.builtAt = `2026-10-01T12:00:00.${'0'.repeat(30)}Z`;
    },
  },
  {
    name: 'a numeric builtAt',
    field: 'provenance.builtAt',
    edit: (draft) => {
      draft.provenance.builtAt = 1_700_000_000;
    },
  },
  {
    name: 'a binding that starts with a digit',
    field: 'requirements.d1.binding',
    edit: (draft) => {
      draft.requirements.d1.binding = '1DB';
    },
  },
  {
    name: 'a binding with a dash',
    field: 'requirements.d1.binding',
    edit: (draft) => {
      draft.requirements.d1.binding = 'my-db';
    },
  },
  {
    name: 'a binding over 64 characters',
    field: 'requirements.d1.binding',
    edit: (draft) => {
      draft.requirements.d1.binding = 'a'.repeat(65);
    },
  },
  {
    name: 'a migrationsTable with a space',
    field: 'requirements.d1.migrationsTable',
    edit: (draft) => {
      draft.requirements.d1.migrationsTable = 'd1 migrations';
    },
  },
  {
    name: 'a duplicate migration',
    field: 'requirements.d1.migrations[1]',
    edit: (draft) => {
      draft.requirements.d1.migrations = ['0001_init.sql', '0001_init.sql'];
    },
  },
  {
    name: 'a migration name containing a slash',
    field: 'requirements.d1.migrations[0]',
    edit: (draft) => {
      draft.requirements.d1.migrations = ['sub/0001_init.sql'];
    },
  },
  {
    name: 'a migration name without .sql',
    field: 'requirements.d1.migrations[0]',
    edit: (draft) => {
      draft.requirements.d1.migrations = ['0001_init.txt'];
    },
  },
  {
    name: 'a migration name that starts with a dot',
    field: 'requirements.d1.migrations[0]',
    edit: (draft) => {
      draft.requirements.d1.migrations = ['.0001_init.sql'];
    },
  },
  {
    name: 'more than 10000 migrations',
    field: 'requirements.d1.migrations',
    edit: (draft) => {
      draft.requirements.d1.migrations = Array.from(
        { length: 10_001 },
        (_, index) => `m${index}.sql`,
      );
    },
  },
  {
    name: 'a non-boolean journal',
    field: 'requirements.d1.journal',
    edit: (draft) => {
      draft.requirements.d1.journal = 'yes';
    },
  },
  {
    name: 'a non-boolean isrCache',
    field: 'requirements.isrCache',
    edit: (draft) => {
      draft.requirements.isrCache = 0;
    },
  },
  {
    name: 'a non-boolean email flag',
    field: 'requirements.email.send',
    edit: (draft) => {
      draft.requirements.email.send = 1;
    },
  },
  {
    name: 'unsorted secrets',
    field: 'requirements.secrets[1]',
    edit: (draft) => {
      draft.requirements.secrets = ['SESSION_SECRET', 'API_KEY'];
    },
  },
  {
    name: 'duplicate secrets',
    field: 'requirements.secrets[1]',
    edit: (draft) => {
      draft.requirements.secrets = ['API_KEY', 'API_KEY'];
    },
  },
  {
    name: 'a __VOID_ secret',
    field: 'requirements.secrets[0]',
    edit: (draft) => {
      draft.requirements.secrets = ['__VOID_TOKEN'];
    },
  },
  {
    name: 'a secret name with a dash',
    field: 'requirements.secrets[0]',
    edit: (draft) => {
      draft.requirements.secrets = ['MY-SECRET'];
    },
  },
  {
    name: 'more than 256 secrets',
    field: 'requirements.secrets',
    edit: (draft) => {
      draft.requirements.secrets = Array.from({ length: 257 }, (_, index) => `S${index}`);
    },
  },
  {
    name: 'a non-string file path',
    field: 'files[0].path',
    edit: (draft) => {
      draft.files[0].path = 42;
    },
  },
  {
    name: 'a null file path',
    field: 'files[0].path',
    edit: (draft) => {
      draft.files[0].path = null;
    },
  },
  {
    name: 'a negative size',
    field: 'files[0].size',
    edit: (draft) => {
      draft.files[0].size = -1;
    },
  },
  {
    name: 'a fractional size',
    field: 'files[0].size',
    edit: (draft) => {
      draft.files[0].size = 1.5;
    },
  },
  {
    name: 'a size beyond the safe integer range',
    field: 'files[0].size',
    edit: (draft) => {
      draft.files[0].size = Number.MAX_SAFE_INTEGER + 2;
    },
  },
  {
    name: 'an uppercase sha256',
    field: 'files[0].sha256',
    edit: (draft) => {
      draft.files[0].sha256 = sha256('a').toUpperCase();
    },
  },
  {
    name: 'a short sha256',
    field: 'files[0].sha256',
    edit: (draft) => {
      draft.files[0].sha256 = 'abc';
    },
  },
  {
    name: 'a digest that is not hex',
    field: 'digest',
    edit: (draft) => {
      draft.digest = 'g'.repeat(64);
    },
  },
  {
    name: 'unsorted files',
    field: 'files[1].path',
    edit: (draft) => {
      [draft.files[0], draft.files[1]] = [draft.files[1], draft.files[0]];
    },
  },
  {
    name: 'duplicate files',
    field: 'files[1].path',
    edit: (draft) => {
      draft.files[1] = { ...draft.files[0] };
    },
  },
  {
    name: 'the manifest file listed in files',
    field: MANIFEST,
    edit: (draft) => {
      draft.files.push({ path: MANIFEST, size: 1, sha256: sha256('x') });
    },
  },
  {
    name: 'more files than the limit allows',
    field: 'files',
    edit: (draft) => {
      draft.files = Array.from(
        { length: DEFAULT_CLOUDFLARE_ARTIFACT_LIMITS.maxFiles + 1 },
        () => ({}),
      );
    },
  },
];

it.each(SHAPE_CASES)('rejects $name with a manifest error', ({ field, edit }) => {
  const draft = draftOf(validManifest());
  edit(draft);
  const error = catchArtifactError(() => parseCloudflareArtifactManifest(draft));
  expect(error.code).toBe('manifest');
  expect(error.message).toContain(field);
});

it.each([undefined, null, [], 'manifest', 1, true])(
  'rejects the manifest value %j with a manifest error',
  (value) => {
    expectArtifactError(() => parseCloudflareArtifactManifest(value), 'manifest');
  },
);

it('reports an unsupported version with its number', () => {
  const draft = draftOf(validManifest());
  draft.version = 2;
  const error = catchArtifactError(() => parseCloudflareArtifactManifest(draft));
  expect(error.code).toBe('manifest');
  expect(error.message).toBe('The artifact version 2 is unsupported.');
});

it('rejects a __proto__ key that JSON.parse keeps as an own property', () => {
  const text = JSON.stringify(validManifest()).replace('{', '{"__proto__":{"polluted":true},');
  expectArtifactError(() => parseCloudflareArtifactManifest(JSON.parse(text)), 'manifest');
});

it.each(['../escape.txt', '/etc/passwd', '.cloudflare//config.json', 'migrations\\0001_init.sql'])(
  'rejects the unsafe file path %j with a path error',
  (path) => {
    const draft = draftOf(validManifest());
    draft.files[0].path = path;
    expectArtifactError(() => parseCloudflareArtifactManifest(draft), 'path', path);
  },
);

it('quotes at most 80 characters of an untrusted value in its message', () => {
  const draft = draftOf(validManifest());
  draft.files[0].path = `../${'a'.repeat(300)}`;
  const error = catchArtifactError(() => parseCloudflareArtifactManifest(draft));
  expect(error.code).toBe('path');
  expect(error.message.length).toBeLessThan(200);
  expect(error.message).not.toContain('a'.repeat(100));

  const keyed = draftOf(validManifest());
  keyed['k'.repeat(300)] = 1;
  const keyError = catchArtifactError(() => parseCloudflareArtifactManifest(keyed));
  expect(keyError.code).toBe('manifest');
  expect(keyError.message.length).toBeLessThan(200);
  expect(keyError.message).not.toContain('k'.repeat(100));
});

type LayoutCase = { name: string; path: string; edit: (draft: Draft) => void };

/** Each row breaks one layout rule. The digest is re-signed, so only the layout check can fail. */
const LAYOUT_CASES: Array<LayoutCase> = [
  {
    name: 'a path outside the allowed roots',
    path: 'README.md',
    edit: (draft) => addFile(draft, 'README.md'),
  },
  {
    name: 'an output file outside the Worker directories',
    path: `${OUTPUT}routes.json`,
    edit: (draft) => addFile(draft, `${OUTPUT}routes.json`),
  },
  {
    name: 'a second Worker directory',
    path: `${OUTPUT}workers/other/worker.config.json`,
    edit: (draft) => addFile(draft, `${OUTPUT}workers/other/worker.config.json`),
  },
  {
    name: 'a containers directory',
    path: `${OUTPUT}containers/app/Dockerfile`,
    edit: (draft) => addFile(draft, `${OUTPUT}containers/app/Dockerfile`),
  },
  {
    name: 'a file beside the Worker bundle and assets',
    path: `${OUTPUT}workers/default/secrets.json`,
    edit: (draft) => addFile(draft, `${OUTPUT}workers/default/secrets.json`),
  },
  {
    name: 'a missing worker.config.json',
    path: WORKER_CONFIG,
    edit: (draft) => removeFile(draft, WORKER_CONFIG),
  },
  {
    name: 'a missing config.json',
    path: CONFIG,
    edit: (draft) => removeFile(draft, CONFIG),
  },
  {
    name: 'a listed migration that is absent',
    path: 'migrations/0003_posts.sql',
    edit: (draft) => {
      draft.requirements.d1.migrations.push('0003_posts.sql');
    },
  },
  {
    name: 'a migration that is present but not listed',
    path: 'migrations/0003_posts.sql',
    edit: (draft) => addFile(draft, 'migrations/0003_posts.sql'),
  },
  {
    name: 'a migration in a subdirectory',
    path: 'migrations/archive/0001_init.sql',
    edit: (draft) => addFile(draft, 'migrations/archive/0001_init.sql'),
  },
  {
    name: 'a non-SQL file under migrations',
    path: 'migrations/notes.txt',
    edit: (draft) => addFile(draft, 'migrations/notes.txt'),
  },
  {
    name: 'a journal present without the flag',
    path: JOURNAL,
    edit: (draft) => {
      draft.requirements.d1.journal = false;
    },
  },
  {
    name: 'the journal flag without the file',
    path: JOURNAL,
    edit: (draft) => removeFile(draft, JOURNAL),
  },
  {
    name: 'seed.sql without the seed flag',
    path: SEED,
    edit: (draft) => {
      draft.requirements.seed = false;
    },
  },
  {
    name: 'the seed flag without seed.sql',
    path: SEED,
    edit: (draft) => removeFile(draft, SEED),
  },
  {
    name: 'the seed flag with no D1 database',
    path: SEED,
    edit: (draft) => {
      draft.requirements.d1 = null;
      removeMigrationFiles(draft);
    },
  },
  {
    name: 'migration files without a D1 database',
    path: 'migrations/0001_init.sql',
    edit: (draft) => {
      draft.requirements.d1 = null;
    },
  },
];

it.each(LAYOUT_CASES)('rejects $name with a layout error', ({ path, edit }) => {
  const draft = draftOf(validManifest());
  edit(draft);
  expectArtifactError(() => parseCloudflareArtifactManifest(signed(draft)), 'layout', path);
});

it('reports a layout error before checking the digest', () => {
  // The digest is not re-signed here, so only the layout check can explain the failure.
  const draft = draftOf(validManifest());
  removeFile(draft, CONFIG);
  expectArtifactError(() => parseCloudflareArtifactManifest(draft), 'layout', CONFIG);
});

it.skipIf(isWindows)('rejects a manifest that is a symlink', () => {
  const { root } = writeFixtureArtifact();
  const real = join(tempRoot(), MANIFEST);
  renameSync(join(root, MANIFEST), real);
  symlinkSync(real, join(root, MANIFEST));
  expectArtifactError(() => readCloudflareArtifact(root), 'symlink', MANIFEST);
});

it.skipIf(isWindows)('rejects a symlinked root before reading the manifest behind it', () => {
  const { root } = writeFixtureArtifact();
  const link = join(tempRoot(), 'linked');
  symlinkSync(root, link);
  // The manifest behind the link is invalid JSON, so reading through the link would report 'manifest'.
  writeFileSync(join(root, MANIFEST), '{"format":');
  expectArtifactError(() => readCloudflareArtifact(link), 'root');
});

it('rejects a missing root with a root error', () => {
  expectArtifactError(() => readCloudflareArtifact(join(tempRoot(), 'missing')), 'root');
});

it('rejects a manifest with a second hard link', () => {
  const { root } = writeFixtureArtifact();
  linkSync(join(root, MANIFEST), join(tempRoot(), 'copy.json'));
  expectArtifactError(() => readCloudflareArtifact(root), 'hardlink', MANIFEST);
});

it('rejects a manifest over the byte limit before reading it', () => {
  const { root } = writeFixtureArtifact();
  truncateSync(join(root, MANIFEST), MAX_CLOUDFLARE_ARTIFACT_MANIFEST_BYTES + 1);
  expectArtifactError(() => readCloudflareArtifact(root), 'limit', MANIFEST);
});

it('rejects a manifest that is a directory', () => {
  const { root } = writeFixtureArtifact();
  rmSync(join(root, MANIFEST));
  mkdirSync(join(root, MANIFEST));
  expectArtifactError(() => readCloudflareArtifact(root), 'special-file', MANIFEST);
});

it('rejects a manifest that is not valid JSON', () => {
  const { root } = writeFixtureArtifact();
  writeFileSync(join(root, MANIFEST), '{"format":');
  expectArtifactError(() => readCloudflareArtifact(root), 'manifest', MANIFEST);
});

it('rejects a missing manifest', () => {
  const { root } = writeFixtureArtifact();
  rmSync(join(root, MANIFEST));
  expectArtifactError(() => readCloudflareArtifact(root), 'manifest', MANIFEST);
});

it('rejects a file on disk that the manifest does not list', () => {
  const { root } = writeFixtureArtifact();
  writeFileSync(join(root, 'extra.txt'), 'x');
  expectArtifactError(() => readCloudflareArtifact(root), 'unexpected', 'extra.txt');
});

it('rejects an unlisted file nested in the Worker bundle', () => {
  const { root } = writeFixtureArtifact();
  writeFileSync(join(root, `${OUTPUT}workers/default/bundle/extra.js`), 'x');
  expectArtifactError(
    () => readCloudflareArtifact(root),
    'unexpected',
    `${OUTPUT}workers/default/bundle/extra.js`,
  );
});

it('rejects a listed file that is missing', () => {
  const { root } = writeFixtureArtifact();
  rmSync(join(root, SEED));
  expectArtifactError(() => readCloudflareArtifact(root), 'missing', SEED);
});

it('rejects a listed file changed by one byte', () => {
  const { root } = writeFixtureArtifact();
  const seed = join(root, SEED);
  const bytes = readFileSync(seed);
  bytes[0] = bytes[0] ^ 1;
  writeFileSync(seed, bytes);
  expectArtifactError(() => readCloudflareArtifact(root), 'mismatch', SEED);
});

it('passes reader options through to the file check', () => {
  const { root } = writeFixtureArtifact();
  const error = catchArtifactError(() =>
    readCloudflareArtifact(root, { limits: { maxFileBytes: 1 } }),
  );
  expect(error.code).toBe('limit');
});

it('honours a caller exclusion and still excludes the manifest', () => {
  const { root, manifest } = writeFixtureArtifact();
  writeFileSync(join(root, 'notes.txt'), 'not listed in the manifest');
  // notes.txt passes only because the caller excluded it; the manifest passes because the reader does.
  expect(readCloudflareArtifact(root, { exclude: ['notes.txt'] })).toEqual(manifest);
});

describe('assertCloudflareMigrationApplyOrder', () => {
  it('accepts names already in Cloudflare apply order, including none', () => {
    expect(() => assertCloudflareMigrationApplyOrder([])).not.toThrow();
    expect(() =>
      assertCloudflareMigrationApplyOrder(['0000_init.sql', '0001_add_users.sql']),
    ).not.toThrow();
    expect(() => assertCloudflareMigrationApplyOrder(['9_a.sql', '10_b.sql'])).not.toThrow();
  });

  it('refuses an unpadded prefix that Void sorts after a later one, and names both', () => {
    expect(() => assertCloudflareMigrationApplyOrder(['10_b.sql', '9_a.sql'])).toThrow(
      'Cloudflare applies migrations in a different order than Void validates. At position 1, Void validates 10_b.sql but Cloudflare applies 9_a.sql.',
    );
  });

  it('names the first position where the orders disagree, not the first name', () => {
    expect(() =>
      assertCloudflareMigrationApplyOrder(['0001_a.sql', '0002_b.sql', '10_x.sql', '9_y.sql']),
    ).toThrow(
      'At position 3, Void validates 10_x.sql but Cloudflare applies 9_y.sql. An unpadded numeric prefix such as `9_` and `10_` is the usual cause, so rename the migration files so both orders agree, then rebuild.',
    );
  });
});
