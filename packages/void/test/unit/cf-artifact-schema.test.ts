/* oxlint-disable typescript-eslint/no-explicit-any -- these tests break one field of a valid manifest on purpose; `Draft` is the loose shape that keeps each edit readable. */
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
import { join } from 'node:path';
import { canonicalJson } from '@void/deploy-core';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { quoteArtifactValue } from '../../src/cli/cf-artifact-diagnostic.ts';
import {
  type CloudflareArtifactFile,
  DEFAULT_CLOUDFLARE_ARTIFACT_LIMITS,
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
} from '../../src/cli/cf-artifact-schema.ts';
import {
  fileEntry,
  sha256,
  catchArtifactError,
  expectArtifactError,
  writeArtifact,
} from '../helpers/cf-artifact.ts';

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

/** Write the fixture tree and a valid envelope for it into a new root. */
function writeFixtureArtifact(): { root: string; manifest: CloudflareArtifactManifest } {
  const root = tempRoot();
  const manifest = writeArtifact(root, FIXTURE_TREE, REQUIREMENTS);
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

it('validates the manifest it creates', () =>
  expectArtifactError(
    () =>
      createCloudflareArtifactManifest({
        provenance: PROVENANCE,
        requirements: { ...REQUIREMENTS, seed: false },
        files: fixtureEntries(),
      }),
    'layout',
    SEED,
  ));

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

it.each<[string, (draft: Draft) => void]>([
  ['a file hash', (draft) => (draft.files[0].sha256 = sha256('changed'))],
  ['a file size', (draft) => (draft.files[0].size += 1)],
  ['the migration order', (draft) => draft.requirements.d1.migrations.reverse()],
  ['the isrCache flag', (draft) => (draft.requirements.isrCache = true)],
  ['a secret', (draft) => (draft.requirements.secrets = ['API_KEY'])],
  ['the seed flag', (draft) => (draft.requirements.seed = false)],
  ['the Void version', (draft) => (draft.provenance.voidVersion = '0.1.1')],
  ['the commit', (draft) => (draft.provenance.commit = null)],
  ['the build time', (draft) => (draft.provenance.builtAt = '2026-10-02T12:00:00.000Z')],
])('changes the digest when %s changes', (_label, change) => {
  const draft = draftOf(validManifest());
  change(draft);
  expect(cloudflareArtifactDigest(draft as Omit<CloudflareArtifactManifest, 'digest'>)).not.toBe(
    validManifest().digest,
  );
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

type ShapeCase = [field: string, edit: (draft: Draft) => void];

/** Each row breaks one shape rule. The error must be a 'manifest' error that names `field`. */
const SHAPE_CASES: Array<ShapeCase> = [
  ['extra', (draft) => (draft.extra = true)],
  ['provenance', (draft) => (draft.provenance.extra = 1)],
  ['requirements.d1', (draft) => (draft.requirements.d1.extra = 1)],
  ['requirements.email', (draft) => (draft.requirements.email.extra = true)],
  ['files[0]', (draft) => (draft.files[0].extra = 1)],
  ['digest', (draft) => delete draft.digest],
  ['provenance.commit', (draft) => delete draft.provenance.commit],
  ['requirements.d1.journal', (draft) => delete draft.requirements.d1.journal],
  ['requirements', (draft) => (draft.requirements = [])],
  ['requirements.d1', (draft) => (draft.requirements.d1 = 'DB')],
  ['format', (draft) => (draft.format = 'void-other')],
  ['version', (draft) => (draft.version = 2)],
  ['version', (draft) => (draft.version = '1')],
  ['provenance.voidVersion', (draft) => (draft.provenance.voidVersion = '1 0')],
  ['provenance.voidVersion', (draft) => (draft.provenance.voidVersion = '')],
  ['provenance.voidVersion', (draft) => (draft.provenance.voidVersion = 'a'.repeat(65))],
  ['provenance.commit', (draft) => (draft.provenance.commit = 'A1B2C3D')],
  ['provenance.commit', (draft) => (draft.provenance.commit = 'abc123')],
  ['provenance.commit', (draft) => (draft.provenance.commit = 'z'.repeat(8))],
  ['provenance.builtAt', (draft) => (draft.provenance.builtAt = 'not a date')],
  [
    'provenance.builtAt',
    (draft) => (draft.provenance.builtAt = `2026-10-01T12:00:00.${'0'.repeat(30)}Z`),
  ],
  ['provenance.builtAt', (draft) => (draft.provenance.builtAt = 1_700_000_000)],
  ['requirements.d1.binding', (draft) => (draft.requirements.d1.binding = '1DB')],
  ['requirements.d1.binding', (draft) => (draft.requirements.d1.binding = 'my-db')],
  ['requirements.d1.binding', (draft) => (draft.requirements.d1.binding = 'a'.repeat(65))],
  [
    'requirements.d1.migrationsTable',
    (draft) => (draft.requirements.d1.migrationsTable = 'd1 migrations'),
  ],
  [
    'requirements.d1.migrations[1]',
    (draft) => (draft.requirements.d1.migrations = ['0001_init.sql', '0001_init.sql']),
  ],
  [
    'requirements.d1.migrations[0]',
    (draft) => (draft.requirements.d1.migrations = ['sub/0001_init.sql']),
  ],
  [
    'requirements.d1.migrations[0]',
    (draft) => (draft.requirements.d1.migrations = ['0001_init.txt']),
  ],
  [
    'requirements.d1.migrations[0]',
    (draft) => (draft.requirements.d1.migrations = ['.0001_init.sql']),
  ],
  [
    'requirements.d1.migrations',
    (draft) =>
      (draft.requirements.d1.migrations = Array.from(
        { length: 10_001 },
        (_, index) => `m${index}.sql`,
      )),
  ],
  ['requirements.d1.journal', (draft) => (draft.requirements.d1.journal = 'yes')],
  ['requirements.isrCache', (draft) => (draft.requirements.isrCache = 0)],
  ['requirements.email.send', (draft) => (draft.requirements.email.send = 1)],
  [
    'requirements.secrets[1]',
    (draft) => (draft.requirements.secrets = ['SESSION_SECRET', 'API_KEY']),
  ],
  ['requirements.secrets[1]', (draft) => (draft.requirements.secrets = ['API_KEY', 'API_KEY'])],
  ['requirements.secrets[0]', (draft) => (draft.requirements.secrets = ['__VOID_TOKEN'])],
  ['requirements.secrets[0]', (draft) => (draft.requirements.secrets = ['MY-SECRET'])],
  [
    'requirements.secrets',
    (draft) =>
      (draft.requirements.secrets = Array.from({ length: 257 }, (_, index) => `S${index}`)),
  ],
  ['files[0].path', (draft) => (draft.files[0].path = 42)],
  ['files[0].path', (draft) => (draft.files[0].path = null)],
  ['files[0].size', (draft) => (draft.files[0].size = -1)],
  ['files[0].size', (draft) => (draft.files[0].size = 1.5)],
  ['files[0].size', (draft) => (draft.files[0].size = Number.MAX_SAFE_INTEGER + 2)],
  ['files[0].sha256', (draft) => (draft.files[0].sha256 = sha256('a').toUpperCase())],
  ['files[0].sha256', (draft) => (draft.files[0].sha256 = 'abc')],
  ['digest', (draft) => (draft.digest = 'g'.repeat(64))],
  [
    'files[1].path',
    (draft) => ([draft.files[0], draft.files[1]] = [draft.files[1], draft.files[0]]),
  ],
  ['files[1].path', (draft) => (draft.files[1] = { ...draft.files[0] })],
  [MANIFEST, (draft) => draft.files.push({ path: MANIFEST, size: 1, sha256: sha256('x') })],
  [
    'files',
    (draft) =>
      (draft.files = Array.from(
        { length: DEFAULT_CLOUDFLARE_ARTIFACT_LIMITS.maxFiles + 1 },
        () => ({}),
      )),
  ],
];

it.each(SHAPE_CASES)('rejects %s with a manifest error', (field, edit) => {
  const draft = draftOf(validManifest());
  edit(draft);
  const error = catchArtifactError(() => parseCloudflareArtifactManifest(draft));
  expect(error.code).toBe('manifest');
  expect(error.message).toContain(field);
});

it.each([undefined, null, [], 'manifest', 1, true])(
  'rejects the manifest value %j with a manifest error',
  (value) => expectArtifactError(() => parseCloudflareArtifactManifest(value), 'manifest'),
);

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

type LayoutCase = [path: string, edit: (draft: Draft) => void];

/** Each row breaks one layout rule. The digest is re-signed, so only the layout check can fail. */
const LAYOUT_CASES: Array<LayoutCase> = [
  ['README.md', (draft) => addFile(draft, 'README.md')],
  [`${OUTPUT}routes.json`, (draft) => addFile(draft, `${OUTPUT}routes.json`)],
  [
    `${OUTPUT}workers/other/worker.config.json`,
    (draft) => addFile(draft, `${OUTPUT}workers/other/worker.config.json`),
  ],
  [
    `${OUTPUT}containers/app/Dockerfile`,
    (draft) => addFile(draft, `${OUTPUT}containers/app/Dockerfile`),
  ],
  [
    `${OUTPUT}workers/default/secrets.json`,
    (draft) => addFile(draft, `${OUTPUT}workers/default/secrets.json`),
  ],
  [WORKER_CONFIG, (draft) => removeFile(draft, WORKER_CONFIG)],
  [CONFIG, (draft) => removeFile(draft, CONFIG)],
  ['migrations/0003_posts.sql', (draft) => draft.requirements.d1.migrations.push('0003_posts.sql')],
  ['migrations/0003_posts.sql', (draft) => addFile(draft, 'migrations/0003_posts.sql')],
  [
    'migrations/archive/0001_init.sql',
    (draft) => addFile(draft, 'migrations/archive/0001_init.sql'),
  ],
  ['migrations/notes.txt', (draft) => addFile(draft, 'migrations/notes.txt')],
  [JOURNAL, (draft) => (draft.requirements.d1.journal = false)],
  [JOURNAL, (draft) => removeFile(draft, JOURNAL)],
  [SEED, (draft) => (draft.requirements.seed = false)],
  [SEED, (draft) => removeFile(draft, SEED)],
  [
    SEED,
    (draft) => {
      draft.requirements.d1 = null;
      removeMigrationFiles(draft);
    },
  ],
  ['migrations/0001_init.sql', (draft) => (draft.requirements.d1 = null)],
];

it.each(LAYOUT_CASES)('rejects %s with a layout error', (path, edit) => {
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

  it('refuses an unpadded prefix that Void sorts after a later one, and names both', () =>
    expect(() => assertCloudflareMigrationApplyOrder(['10_b.sql', '9_a.sql'])).toThrow(
      'Cloudflare applies migrations in a different order than Void validates. At position 1, Void validates 10_b.sql but Cloudflare applies 9_a.sql.',
    ));

  it('names the first position where the orders disagree, not the first name', () =>
    expect(() =>
      assertCloudflareMigrationApplyOrder(['0001_a.sql', '0002_b.sql', '10_x.sql', '9_y.sql']),
    ).toThrow(
      'At position 3, Void validates 10_x.sql but Cloudflare applies 9_y.sql. An unpadded numeric prefix such as `9_` and `10_` is the usual cause, so rename the migration files so both orders agree, then rebuild.',
    ));
});

it('quotes and bounds untrusted diagnostic values once for all artifact readers', () => {
  expect(quoteArtifactValue('a\nb"')).toBe(JSON.stringify('a\nb"'));
  expect(quoteArtifactValue('a'.repeat(78))).toHaveLength(80);
  expect(quoteArtifactValue('a'.repeat(79))).toBe('"' + 'a'.repeat(76) + '...');
  expect(quoteArtifactValue('😀'.repeat(100))).toHaveLength(80);
  expect(quoteArtifactValue('X'.repeat(200), 'unquoted')).toBe(
    JSON.stringify('X'.repeat(80)) + '...',
  );
  const unicode = quoteArtifactValue('😀'.repeat(100), 'code-points');
  expect(Array.from(unicode)).toHaveLength(80);
  expect(unicode).toBe('"' + '😀'.repeat(76) + '...');
});
