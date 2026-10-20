import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, type Stats, writeFileSync } from 'node:fs';
import { canonicalJson, isRecord } from '@void/deploy-core';
import { join } from 'pathslash';
import { compareWranglerMigrationPaths } from '../migrations/apply-order.ts';
import {
  assertCloudflareArtifactPath,
  CloudflareArtifactError,
  type CloudflareArtifactFile,
  type CloudflareArtifactFileOptions,
  DEFAULT_CLOUDFLARE_ARTIFACT_LIMITS,
  verifyCloudflareArtifactFiles,
} from './cf-artifact-files.ts';

export const CLOUDFLARE_ARTIFACT_FORMAT = 'void-cloudflare-artifact';
/** The only envelope version this build reads or writes. */
export const CLOUDFLARE_ARTIFACT_VERSION = 1;
export const CLOUDFLARE_ARTIFACT_MANIFEST_FILE = 'void-artifact.json';
export const CLOUDFLARE_ARTIFACT_OUTPUT_DIR = '.cloudflare/output/v0';
export const CLOUDFLARE_ARTIFACT_MIGRATIONS_DIR = 'migrations';
export const CLOUDFLARE_ARTIFACT_SEED_FILE = 'seed.sql';
export const MAX_CLOUDFLARE_ARTIFACT_MANIFEST_BYTES: number = 16 * 1024 * 1024;

export type CloudflareArtifactRequirements = {
  /** The app's D1 database, when it has one. */
  d1: null | {
    binding: string;
    migrationsTable: string;
    /** Migration file names in apply order, each stored at `migrations/<name>`. */
    migrations: Array<string>;
    /** Whether `migrations/meta/_journal.json` is included. */
    journal: boolean;
  };
  /** Whether the publisher must bind an `ISR_CACHE` KV namespace. */
  isrCache: boolean;
  email: { inbound: boolean; send: boolean };
  /** Required secret names, sorted by code unit. */
  secrets: Array<string>;
  /** Whether `seed.sql` is included. */
  seed: boolean;
};

/** Information only. Never used for a decision. */
export type CloudflareArtifactProvenance = {
  voidVersion: string;
  commit: string | null;
  builtAt: string | null;
};

export type CloudflareArtifactManifest = {
  format: typeof CLOUDFLARE_ARTIFACT_FORMAT;
  version: typeof CLOUDFLARE_ARTIFACT_VERSION;
  provenance: CloudflareArtifactProvenance;
  requirements: CloudflareArtifactRequirements;
  files: Array<CloudflareArtifactFile>;
  digest: string;
};

const MAX_MIGRATIONS = 10_000;
const MAX_SECRETS = 256;
const MAX_BUILT_AT_LENGTH = 40;
const MAX_QUOTED_LENGTH = 80;
const RESERVED_SECRET_PREFIX = '__VOID_';
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MIGRATION_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.sql$/;
const VOID_VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
const COMMIT = /^[0-9a-f]{7,64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const MANIFEST_KEYS = ['format', 'version', 'provenance', 'requirements', 'files', 'digest'];
const PROVENANCE_KEYS = ['voidVersion', 'commit', 'builtAt'];
const REQUIREMENTS_KEYS = ['d1', 'isrCache', 'email', 'secrets', 'seed'];
const D1_KEYS = ['binding', 'migrationsTable', 'migrations', 'journal'];
const EMAIL_KEYS = ['inbound', 'send'];
const FILE_KEYS = ['path', 'size', 'sha256'];

const OUTPUT_PREFIX = `${CLOUDFLARE_ARTIFACT_OUTPUT_DIR}/`;
const MIGRATIONS_PREFIX = `${CLOUDFLARE_ARTIFACT_MIGRATIONS_DIR}/`;
const CONFIG_PATH = `${OUTPUT_PREFIX}config.json`;
const WORKER_CONFIG_PATH = `${OUTPUT_PREFIX}workers/default/worker.config.json`;
const WORKER_CONTENT_PREFIXES = [
  `${OUTPUT_PREFIX}workers/default/bundle/`,
  `${OUTPUT_PREFIX}workers/default/assets/`,
];
const JOURNAL_PATH = `${MIGRATIONS_PREFIX}meta/_journal.json`;

/** Compare by UTF-16 code unit, so the order does not depend on the locale. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Quote an untrusted value for a message, cut to 80 characters. */
function quoteValue(value: string): string {
  const quoted = JSON.stringify(value);
  return quoted.length > MAX_QUOTED_LENGTH
    ? `${quoted.slice(0, MAX_QUOTED_LENGTH - 3)}...`
    : quoted;
}

/** Name a field in a message. The empty path names the manifest itself. */
function fieldLabel(field: string): string {
  return field === '' ? 'The artifact manifest' : `The artifact manifest field ${field}`;
}

function childField(field: string, key: string): string {
  return field === '' ? key : `${field}.${key}`;
}

function manifestError(message: string): CloudflareArtifactError {
  return new CloudflareArtifactError('manifest', message);
}

/** A shape error about `field`; `problem` completes the sentence "<field> <problem>.". */
function fieldError(field: string, problem: string): CloudflareArtifactError {
  return manifestError(`${fieldLabel(field)} ${problem}.`);
}

/** Return `value` as an object whose keys are exactly `keys`. */
function exactObject(
  value: unknown,
  field: string,
  keys: ReadonlyArray<string>,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw fieldError(field, 'must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw fieldError(field, `has an unknown key ${quoteValue(key)}`);
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      throw fieldError(childField(field, key), 'is missing');
    }
  }
  return value;
}

function matchString(value: unknown, field: string, pattern: RegExp, expected: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw fieldError(field, `must be ${expected}`);
  }
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw fieldError(field, 'must be a boolean');
  }
  return value;
}

function arrayValue(value: unknown, field: string, maxLength: number): Array<unknown> {
  if (!Array.isArray(value)) {
    throw fieldError(field, 'must be an array');
  }
  if (value.length > maxLength) {
    throw fieldError(field, `must have at most ${maxLength} entries`);
  }
  return value;
}

/** Compute the envelope digest: SHA-256 of the canonical JSON of every field except `digest`. */
export function cloudflareArtifactDigest(
  manifest: Omit<CloudflareArtifactManifest, 'digest'>,
): string {
  const { format, version, provenance, requirements, files } = manifest;
  const canonical = canonicalJson({ format, version, provenance, requirements, files });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Build a manifest: sort files and secrets, compute the digest, and validate the result by parsing it. */
export function createCloudflareArtifactManifest(input: {
  provenance: CloudflareArtifactProvenance;
  requirements: CloudflareArtifactRequirements;
  files: ReadonlyArray<CloudflareArtifactFile>;
}): CloudflareArtifactManifest {
  const unsigned: Omit<CloudflareArtifactManifest, 'digest'> = {
    format: CLOUDFLARE_ARTIFACT_FORMAT,
    version: CLOUDFLARE_ARTIFACT_VERSION,
    provenance: input.provenance,
    requirements: {
      ...input.requirements,
      secrets: [...input.requirements.secrets].sort(compareCodeUnits),
    },
    files: [...input.files].sort((a, b) => compareCodeUnits(a.path, b.path)),
  };
  return parseCloudflareArtifactManifest({
    ...unsigned,
    digest: cloudflareArtifactDigest(unsigned),
  });
}

/** Strictly validate an untrusted manifest value. Returns a fresh object with only known keys. */
export function parseCloudflareArtifactManifest(value: unknown): CloudflareArtifactManifest {
  const manifest = exactObject(value, '', MANIFEST_KEYS);
  if (manifest.format !== CLOUDFLARE_ARTIFACT_FORMAT) {
    throw fieldError('format', `must equal ${JSON.stringify(CLOUDFLARE_ARTIFACT_FORMAT)}`);
  }
  if (manifest.version !== CLOUDFLARE_ARTIFACT_VERSION) {
    if (typeof manifest.version === 'number') {
      throw manifestError(`The artifact version ${String(manifest.version)} is unsupported.`);
    }
    throw fieldError('version', `must equal ${CLOUDFLARE_ARTIFACT_VERSION}`);
  }
  const provenance = parseProvenance(manifest.provenance);
  const requirements = parseRequirements(manifest.requirements);
  const files = parseFiles(manifest.files);
  const digest = matchString(
    manifest.digest,
    'digest',
    SHA256_HEX,
    'a lowercase SHA-256 hex string',
  );

  checkLayout(requirements, files);

  const parsed: CloudflareArtifactManifest = {
    format: CLOUDFLARE_ARTIFACT_FORMAT,
    version: CLOUDFLARE_ARTIFACT_VERSION,
    provenance,
    requirements,
    files,
    digest,
  };
  if (digest !== cloudflareArtifactDigest(parsed)) {
    throw new CloudflareArtifactError(
      'digest',
      'The artifact manifest digest does not match its contents.',
    );
  }
  return parsed;
}

function parseProvenance(value: unknown): CloudflareArtifactProvenance {
  const provenance = exactObject(value, 'provenance', PROVENANCE_KEYS);
  const voidVersion = matchString(
    provenance.voidVersion,
    'provenance.voidVersion',
    VOID_VERSION,
    'a version of 1 to 64 letters, digits, dots, plus signs or hyphens',
  );
  const commit =
    provenance.commit === null
      ? null
      : matchString(
          provenance.commit,
          'provenance.commit',
          COMMIT,
          'null or a lowercase hex commit of 7 to 64 characters',
        );
  return { voidVersion, commit, builtAt: parseBuiltAt(provenance.builtAt) };
}

function parseBuiltAt(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== 'string' ||
    value.length > MAX_BUILT_AT_LENGTH ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw fieldError(
      'provenance.builtAt',
      `must be null or a parseable date string of at most ${MAX_BUILT_AT_LENGTH} characters`,
    );
  }
  return value;
}

function parseRequirements(value: unknown): CloudflareArtifactRequirements {
  const requirements = exactObject(value, 'requirements', REQUIREMENTS_KEYS);
  const d1 = requirements.d1 === null ? null : parseD1(requirements.d1);
  const isrCache = booleanValue(requirements.isrCache, 'requirements.isrCache');
  const email = exactObject(requirements.email, 'requirements.email', EMAIL_KEYS);
  return {
    d1,
    isrCache,
    email: {
      inbound: booleanValue(email.inbound, 'requirements.email.inbound'),
      send: booleanValue(email.send, 'requirements.email.send'),
    },
    secrets: parseSecrets(requirements.secrets),
    seed: booleanValue(requirements.seed, 'requirements.seed'),
  };
}

function parseD1(value: unknown): NonNullable<CloudflareArtifactRequirements['d1']> {
  const d1 = exactObject(value, 'requirements.d1', D1_KEYS);
  const identifierHint = 'an identifier of letters, digits and underscores, at most 64 characters';
  return {
    binding: matchString(d1.binding, 'requirements.d1.binding', IDENTIFIER, identifierHint),
    migrationsTable: matchString(
      d1.migrationsTable,
      'requirements.d1.migrationsTable',
      IDENTIFIER,
      identifierHint,
    ),
    migrations: parseMigrations(d1.migrations),
    journal: booleanValue(d1.journal, 'requirements.d1.journal'),
  };
}

/** Keep the names in the order given: it is the apply order, not a sort key. */
function parseMigrations(value: unknown): Array<string> {
  const entries = arrayValue(value, 'requirements.d1.migrations', MAX_MIGRATIONS);
  const names: Array<string> = [];
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const field = `requirements.d1.migrations[${index}]`;
    const name = matchString(
      entry,
      field,
      MIGRATION_NAME,
      'a file name ending in .sql, with no directory part',
    );
    if (seen.has(name)) {
      throw fieldError(field, 'repeats an earlier migration name');
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

function parseSecrets(value: unknown): Array<string> {
  const entries = arrayValue(value, 'requirements.secrets', MAX_SECRETS);
  const names: Array<string> = [];
  for (const [index, entry] of entries.entries()) {
    const field = `requirements.secrets[${index}]`;
    const name = matchString(
      entry,
      field,
      SECRET_NAME,
      'an environment variable name of letters, digits and underscores, at most 128 characters',
    );
    if (name.startsWith(RESERVED_SECRET_PREFIX)) {
      throw fieldError(field, `uses the reserved ${RESERVED_SECRET_PREFIX} prefix`);
    }
    const previous = names.at(-1);
    if (previous !== undefined && compareCodeUnits(previous, name) >= 0) {
      throw fieldError(field, 'must sort after the previous secret name by code unit');
    }
    names.push(name);
  }
  return names;
}

function parseFiles(value: unknown): Array<CloudflareArtifactFile> {
  const entries = arrayValue(value, 'files', DEFAULT_CLOUDFLARE_ARTIFACT_LIMITS.maxFiles);
  const files: Array<CloudflareArtifactFile> = [];
  for (const [index, entry] of entries.entries()) {
    const field = `files[${index}]`;
    const file = exactObject(entry, field, FILE_KEYS);
    const { path, size, sha256 } = file;
    // Every field is type-checked before the path is judged, so bad types never reach string methods.
    if (typeof path !== 'string') {
      throw fieldError(childField(field, 'path'), 'must be a string');
    }
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      throw fieldError(childField(field, 'size'), 'must be a non-negative safe integer');
    }
    const hash = matchString(
      sha256,
      childField(field, 'sha256'),
      SHA256_HEX,
      'a lowercase SHA-256 hex string',
    );
    try {
      assertCloudflareArtifactPath(path);
    } catch {
      // The shared check quotes the whole path in its message; keep the code, cap the message.
      throw new CloudflareArtifactError(
        'path',
        `${fieldLabel(childField(field, 'path'))} is not a safe relative path: ${quoteValue(path)}.`,
        path,
      );
    }
    const previous = files.at(-1);
    if (previous !== undefined && compareCodeUnits(previous.path, path) >= 0) {
      throw fieldError(childField(field, 'path'), 'must sort after the previous path by code unit');
    }
    if (path === CLOUDFLARE_ARTIFACT_MANIFEST_FILE) {
      throw fieldError(
        childField(field, 'path'),
        `must not list ${CLOUDFLARE_ARTIFACT_MANIFEST_FILE}`,
      );
    }
    files.push({ path, size, sha256: hash });
  }
  return files;
}

function layoutError(message: string, path: string): CloudflareArtifactError {
  return new CloudflareArtifactError('layout', message, path);
}

function isAllowedOutputPath(path: string): boolean {
  return (
    path === CONFIG_PATH ||
    path === WORKER_CONFIG_PATH ||
    WORKER_CONTENT_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

/** Throw unless the file list has the layout a publish can apply. Runs after the shape checks. */
function checkLayout(
  requirements: CloudflareArtifactRequirements,
  files: ReadonlyArray<CloudflareArtifactFile>,
): void {
  const d1 = requirements.d1;
  const paths = new Set(files.map((file) => file.path));
  const migrationPaths = new Set(
    (d1?.migrations ?? []).map((name) => `${MIGRATIONS_PREFIX}${name}`),
  );

  for (const { path } of files) {
    if (path === CLOUDFLARE_ARTIFACT_SEED_FILE) {
      continue;
    }
    if (path.startsWith(OUTPUT_PREFIX)) {
      if (!isAllowedOutputPath(path)) {
        throw layoutError(
          `The artifact file ${quoteValue(path)} is not part of the Cloudflare build output.`,
          path,
        );
      }
      continue;
    }
    if (path.startsWith(MIGRATIONS_PREFIX)) {
      if (d1 === null) {
        throw layoutError(
          `The artifact file ${quoteValue(path)} needs requirements.d1, which is null.`,
          path,
        );
      }
      if (path === JOURNAL_PATH) {
        if (!d1.journal) {
          throw layoutError(
            `The artifact contains ${JOURNAL_PATH} but requirements.d1.journal is false.`,
            path,
          );
        }
        continue;
      }
      if (!migrationPaths.has(path)) {
        throw layoutError(
          `The artifact file ${quoteValue(path)} is not a migration listed in requirements.d1.`,
          path,
        );
      }
      continue;
    }
    throw layoutError(`The artifact file ${quoteValue(path)} is outside the allowed roots.`, path);
  }

  for (const required of [CONFIG_PATH, WORKER_CONFIG_PATH]) {
    if (!paths.has(required)) {
      throw layoutError(`The artifact is missing the required file ${required}.`, required);
    }
  }
  for (const migrationPath of migrationPaths) {
    if (!paths.has(migrationPath)) {
      throw layoutError(
        `The artifact lists ${migrationPath} but does not contain it.`,
        migrationPath,
      );
    }
  }
  if (d1 !== null && d1.journal && !paths.has(JOURNAL_PATH)) {
    throw layoutError(
      `requirements.d1.journal is true but the artifact does not contain ${JOURNAL_PATH}.`,
      JOURNAL_PATH,
    );
  }
  if (requirements.seed && d1 === null) {
    throw layoutError(
      'requirements.seed is true, so requirements.d1 must not be null.',
      CLOUDFLARE_ARTIFACT_SEED_FILE,
    );
  }
  const hasSeedFile = paths.has(CLOUDFLARE_ARTIFACT_SEED_FILE);
  if (requirements.seed !== hasSeedFile) {
    throw layoutError(
      requirements.seed
        ? `requirements.seed is true but the artifact does not contain ${CLOUDFLARE_ARTIFACT_SEED_FILE}.`
        : `The artifact contains ${CLOUDFLARE_ARTIFACT_SEED_FILE} but requirements.seed is false.`,
      CLOUDFLARE_ARTIFACT_SEED_FILE,
    );
  }
}

/** Write `void-artifact.json` into `root` (pretty JSON, trailing newline, mode 0o644). */
export function writeCloudflareArtifactManifest(
  root: string,
  manifest: CloudflareArtifactManifest,
): void {
  writeFileSync(
    join(root, CLOUDFLARE_ARTIFACT_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    {
      mode: 0o644,
    },
  );
}

/** Whether `path` is a real directory: a symlink, or a path that cannot be inspected, is not. */
function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read and validate `void-artifact.json` in `root`, then verify that the directory matches its
 * file list exactly (excluding the manifest file itself). Returns the parsed manifest.
 */
export function readCloudflareArtifact(
  root: string,
  options?: CloudflareArtifactFileOptions,
): CloudflareArtifactManifest {
  // Check the root first: a symlinked root must not lead to a manifest behind it.
  if (!isRealDirectory(root)) {
    throw new CloudflareArtifactError(
      'root',
      `The artifact root must be a real directory: ${root}`,
    );
  }
  const manifestPath = join(root, CLOUDFLARE_ARTIFACT_MANIFEST_FILE);
  let stats: Stats;
  try {
    // lstat never follows a link, so a symlinked manifest is rejected rather than read.
    stats = lstatSync(manifestPath);
  } catch {
    throw new CloudflareArtifactError(
      'manifest',
      `The artifact manifest ${CLOUDFLARE_ARTIFACT_MANIFEST_FILE} is missing or cannot be inspected.`,
      CLOUDFLARE_ARTIFACT_MANIFEST_FILE,
    );
  }
  if (stats.isSymbolicLink()) {
    throw new CloudflareArtifactError(
      'symlink',
      `The artifact manifest ${CLOUDFLARE_ARTIFACT_MANIFEST_FILE} is a symlink.`,
      CLOUDFLARE_ARTIFACT_MANIFEST_FILE,
    );
  }
  if (!stats.isFile()) {
    throw new CloudflareArtifactError(
      'special-file',
      `The artifact manifest ${CLOUDFLARE_ARTIFACT_MANIFEST_FILE} is not a regular file.`,
      CLOUDFLARE_ARTIFACT_MANIFEST_FILE,
    );
  }
  if (stats.nlink > 1) {
    throw new CloudflareArtifactError(
      'hardlink',
      `The artifact manifest ${CLOUDFLARE_ARTIFACT_MANIFEST_FILE} has more than one hard link.`,
      CLOUDFLARE_ARTIFACT_MANIFEST_FILE,
    );
  }
  if (stats.size > MAX_CLOUDFLARE_ARTIFACT_MANIFEST_BYTES) {
    throw new CloudflareArtifactError(
      'limit',
      `The artifact manifest ${CLOUDFLARE_ARTIFACT_MANIFEST_FILE} is larger than ${MAX_CLOUDFLARE_ARTIFACT_MANIFEST_BYTES} bytes.`,
      CLOUDFLARE_ARTIFACT_MANIFEST_FILE,
    );
  }

  const text = readFileSync(manifestPath, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // The parser's own message can quote input, so it is not passed on.
    throw new CloudflareArtifactError(
      'manifest',
      `The artifact manifest ${CLOUDFLARE_ARTIFACT_MANIFEST_FILE} is not valid JSON.`,
      CLOUDFLARE_ARTIFACT_MANIFEST_FILE,
    );
  }
  const manifest = parseCloudflareArtifactManifest(value);
  verifyCloudflareArtifactFiles(root, manifest.files, {
    ...options,
    exclude: [...(options?.exclude ?? []), CLOUDFLARE_ARTIFACT_MANIFEST_FILE],
  });
  return manifest;
}

/**
 * Throw unless `names`, in the order Void validates them, is the order `cf d1 migrations apply`
 * uses. Void sorts by code unit, so `10_b.sql` precedes `9_a.sql`; Cloudflare compares the numeric
 * prefix, so `9_a.sql` applies first. The error names the first position where the orders disagree.
 */
export function assertCloudflareMigrationApplyOrder(names: ReadonlyArray<string>): void {
  const applied = [...names].sort(compareWranglerMigrationPaths);
  const position = names.findIndex((name, index) => name !== applied[index]);
  if (position === -1) {
    return;
  }
  throw new CloudflareArtifactError(
    'layout',
    `Cloudflare applies migrations in a different order than Void validates. At position ${position + 1}, Void validates ${names[position]} but Cloudflare applies ${applied[position]}. An unpadded numeric prefix such as \`9_\` and \`10_\` is the usual cause, so rename the migration files so both orders agree, then rebuild. Rename only migrations that are not applied yet, because a renamed applied migration runs again.`,
    CLOUDFLARE_ARTIFACT_MIGRATIONS_DIR,
  );
}
