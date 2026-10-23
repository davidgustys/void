import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { isRecord } from '@void/deploy-core';
import { dirname, join, relative, resolve } from 'pathslash';
import { listCloudflareArtifactFiles } from './cf-artifact-files.ts';
import { assertCloudflareArtifactOutputDirectory } from './cf-artifact-output.ts';
import {
  CLOUDFLARE_ARTIFACT_MANIFEST_FILE,
  CLOUDFLARE_ARTIFACT_MIGRATIONS_DIR,
  CLOUDFLARE_ARTIFACT_OUTPUT_DIR,
  CLOUDFLARE_ARTIFACT_SEED_FILE,
  type CloudflareArtifactManifest,
  type CloudflareArtifactProvenance,
  type CloudflareArtifactRequirements,
  createCloudflareArtifactManifest,
  readCloudflareArtifact,
  writeCloudflareArtifactManifest,
} from './cf-artifact-schema.ts';
import { prepareCfBuildOutput } from './cf-build-output.ts';

export type PackageCloudflareArtifactInput = {
  /** Void's built Worker directory (`dist/ssr`), containing `wrangler.json` and the bundle. */
  workerDirectory: string;
  /** Directory to write the artifact into. It must be missing or an empty real directory. */
  outDir: string;
  requirements: CloudflareArtifactRequirements;
  /** The app's migrations directory. Required when `requirements.d1` is not null. */
  migrationsDirectory?: string;
  /** The seed SQL file. Required exactly when `requirements.seed` is true. */
  seedFile?: string;
  provenance: CloudflareArtifactProvenance;
};

/** Base-name prefixes of local files that hold secret names and values. They must never ship. */
const LOCAL_SECRET_PREFIXES = ['.dev.vars', '.env'];

/**
 * Package an already-built Worker into a verified artifact directory. It writes the artifact only
 * into `outDir`, and uses a disposable scratch directory under the system temp directory while
 * converting.
 */
export async function packageCloudflareArtifact(
  input: PackageCloudflareArtifactInput,
): Promise<CloudflareArtifactManifest> {
  const { workerDirectory, requirements, migrationsDirectory, seedFile, provenance } = input;
  assertInputsMatchRequirements(input);
  const outDir = resolve(input.outDir);
  const created = prepareOutDir(outDir);
  try {
    await copyBuildOutput(workerDirectory, outDir);
    if (requirements.d1 !== null && migrationsDirectory !== undefined) {
      copyMigrations(migrationsDirectory, requirements.d1, outDir);
    }
    if (requirements.seed && seedFile !== undefined) {
      copyRegularFile(seedFile, join(outDir, CLOUDFLARE_ARTIFACT_SEED_FILE));
    }
    assertNoLocalSecrets(outDir);
    const files = listCloudflareArtifactFiles(outDir, {
      exclude: [CLOUDFLARE_ARTIFACT_MANIFEST_FILE],
    });
    const manifest = createCloudflareArtifactManifest({ provenance, requirements, files });
    writeCloudflareArtifactManifest(outDir, manifest);
    return readCloudflareArtifact(outDir);
  } catch (error) {
    try {
      removeWrites(outDir, created);
    } catch (cleanupError) {
      throw attachCleanupFailure(error, cleanupError);
    }
    throw error;
  }
}

/** Throw unless the optional inputs are present exactly when the requirements need them. */
function assertInputsMatchRequirements(input: PackageCloudflareArtifactInput): void {
  const { requirements, migrationsDirectory, seedFile } = input;
  if (requirements.d1 !== null && migrationsDirectory === undefined) {
    throw new Error('requirements.d1 is set, so migrationsDirectory is required.');
  }
  if (requirements.d1 === null && migrationsDirectory !== undefined) {
    throw new Error('requirements.d1 is null, so migrationsDirectory must not be given.');
  }
  if (requirements.seed && seedFile === undefined) {
    throw new Error('requirements.seed is true, so seedFile is required.');
  }
  if (!requirements.seed && seedFile !== undefined) {
    throw new Error('requirements.seed is false, so seedFile must not be given.');
  }
}

/**
 * Make `outDir` ready for writing and return whether this call created it. An existing directory
 * must be a real directory with no entries, so nothing unrelated can end up in the artifact.
 */
function prepareOutDir(outDir: string): boolean {
  if (!assertCloudflareArtifactOutputDirectory(outDir)) {
    mkdirSync(outDir, { recursive: true });
    return true;
  }
  return false;
}

/**
 * Refuse a Worker that declares containers before the codemod runs, because a container with a
 * Dockerfile would start a `docker build`. An unreadable or invalid wrangler.json is left to the
 * codemod to report.
 */
function assertNoContainers(workerDirectory: string): void {
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(join(workerDirectory, 'wrangler.json'), 'utf8'));
  } catch {
    return;
  }
  if (isRecord(config) && Array.isArray(config.containers) && config.containers.length > 0) {
    throw new Error('Containers (Sandbox) are not supported in preview artifacts.');
  }
}

/** Copy the Worker's Cloudflare Build Output into `outDir`. Containers need Sandbox, so they are refused. */
async function copyBuildOutput(workerDirectory: string, outDir: string): Promise<void> {
  assertNoContainers(workerDirectory);
  const prepared = await prepareCfBuildOutput(workerDirectory);
  if (!prepared) {
    throw new Error(
      `The Worker build in ${workerDirectory} could not be converted into Cloudflare Build Output.`,
    );
  }
  try {
    cpSync(join(prepared.directory, '.cloudflare'), join(outDir, '.cloudflare'), {
      recursive: true,
      dereference: false,
    });
  } finally {
    await prepared.dispose();
  }
  if (existsSync(join(outDir, CLOUDFLARE_ARTIFACT_OUTPUT_DIR, 'containers'))) {
    throw new Error('Containers (Sandbox) are not supported in preview artifacts.');
  }
}

/**
 * Copy the migrations that the requirements list, plus the journal when it is required. Nothing else.
 * A D1 database used only for queries or auth may have no migrations folder, so a missing folder is
 * skipped when nothing is listed and no journal is required.
 */
function copyMigrations(
  migrationsDirectory: string,
  d1: NonNullable<CloudflareArtifactRequirements['d1']>,
  outDir: string,
): void {
  if (
    d1.migrations.length === 0 &&
    !d1.journal &&
    lstatSync(migrationsDirectory, { throwIfNoEntry: false }) === undefined
  ) {
    return;
  }
  assertRealDirectory(migrationsDirectory, 'The migrations directory');
  const onDisk = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const available = new Set(onDisk);
  const listed = new Set(d1.migrations);
  for (const name of d1.migrations) {
    if (!available.has(name)) {
      throw new Error(
        `The migration ${name} is listed in requirements.d1 but is missing from ${migrationsDirectory}.`,
      );
    }
  }
  for (const name of onDisk) {
    if (!listed.has(name)) {
      throw new Error(
        `The migration ${name} in ${migrationsDirectory} is not listed in requirements.d1.`,
      );
    }
  }
  for (const name of d1.migrations) {
    copyRegularFile(
      join(migrationsDirectory, name),
      join(outDir, CLOUDFLARE_ARTIFACT_MIGRATIONS_DIR, name),
    );
  }
  if (d1.journal) {
    // Check `meta` itself: a symlinked `meta` would make `_journal.json` look like a regular file.
    const meta = join(migrationsDirectory, 'meta');
    assertRealDirectory(meta, 'The migrations meta directory');
    copyRegularFile(
      join(meta, '_journal.json'),
      join(outDir, CLOUDFLARE_ARTIFACT_MIGRATIONS_DIR, 'meta', '_journal.json'),
    );
  }
}

/** Throw unless `path` is a real directory. A symlink to one, or a missing path, is not. */
function assertRealDirectory(path: string, label: string): void {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${label} is missing or is not a real directory: ${path}`);
  }
}

/** Copy `source` to `destination`, after checking that `source` is a regular file and not a symlink. */
function copyRegularFile(source: string, destination: string): void {
  const stats = lstatSync(source, { throwIfNoEntry: false });
  if (stats === undefined) {
    throw new Error(`The file ${source} is missing.`);
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`The file ${source} is a symlink, and symlinks are not permitted.`);
  }
  if (!stats.isFile()) {
    throw new Error(`The file ${source} is not a regular file.`);
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

/** Throw if a local secret file name appears under `directory`. Symlinks are not followed. */
function assertNoLocalSecrets(directory: string, root = directory): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (LOCAL_SECRET_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) {
      throw new Error(`The artifact must not contain a local secret file: ${relative(root, path)}`);
    }
    if (entry.isDirectory()) {
      assertNoLocalSecrets(path, root);
    }
  }
}

/** Remove what a failed call wrote: the directory itself if this call created it, otherwise its contents. */
function removeWrites(outDir: string, created: boolean): void {
  if (created) {
    rmSync(outDir, { recursive: true, force: true });
    return;
  }
  for (const name of readdirSync(outDir)) {
    rmSync(join(outDir, name), { recursive: true, force: true });
  }
}

/**
 * Attach a failed cleanup to the error that caused it, so the caller still gets the original error.
 * The original gets `cause`. If it already has one, it becomes the first entry of an AggregateError
 * with the same message.
 */
function attachCleanupFailure(error: unknown, cleanupError: unknown): unknown {
  if (!(error instanceof Error)) {
    return new AggregateError(
      [error, cleanupError],
      'The artifact failed, and its cleanup failed.',
    );
  }
  if (error.cause === undefined) {
    error.cause = cleanupError;
    return error;
  }
  return new AggregateError([error, cleanupError], error.message);
}
