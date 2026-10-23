import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  getWorkerAssetsDir,
  getWorkerBundleDir,
  readBuildOutput,
  writeRootConfig,
  writeWorkerConfig,
} from '@cloudflare/build-output-utils';
import { OutputRootConfigSchema } from '@cloudflare/config';
import { dirname, join, resolve } from 'pathslash';
import { collectMigrations } from '../migrations/collect.ts';
import { assertJournalCoherence, validateMigrations } from '../migrations/validate.ts';
import {
  CloudflareArtifactError,
  resolveCloudflareArtifactPath,
  verifyCloudflareArtifactFiles,
} from './cf-artifact-files.ts';
import {
  assertCloudflareMigrationApplyOrder,
  CLOUDFLARE_ARTIFACT_MIGRATIONS_DIR,
  CLOUDFLARE_ARTIFACT_OUTPUT_DIR,
  CLOUDFLARE_ARTIFACT_SEED_FILE,
  type CloudflareArtifactManifest,
  type CloudflareArtifactRequirements,
  readCloudflareArtifact,
} from './cf-artifact-schema.ts';
import {
  type CloudflareArtifactTarget,
  CloudflareArtifactTargetError,
  parseCloudflareArtifactTarget,
} from './cf-artifact-target.ts';
import {
  type BoundCloudflareArtifactWorker,
  bindCloudflareArtifactWorker,
} from './cf-artifact-worker-config.ts';
import {
  createCloudflareArtifactWranglerConfigs,
  writeCloudflareArtifactWranglerConfigs,
} from './cf-artifact-wrangler-config.ts';
import type { CfBuildOutput } from './cf-build-output.ts';

export type StagedCloudflareArtifact = {
  manifest: CloudflareArtifactManifest;
  target: CloudflareArtifactTarget;
  worker: BoundCloudflareArtifactWorker;
  /** Private workspace (mode 0o700) holding everything below. */
  workspace: string;
  /** An empty directory, used as the project root and cwd for every Cloudflare operation. */
  neutralRoot: string;
  /** The fresh upload tree, ready for the cf uploader. */
  output: CfBuildOutput;
  generatedConfigPath: string;
  rootConfigPath: string;
  /**
   * Absolute path of the staged copy of the migrations, inside the workspace, when the artifact has
   * D1. The apply step reads only this copy.
   */
  migrationsDirectory: string | undefined;
  /** Migration file names in apply order; empty without D1. */
  migrationNames: Array<string>;
  /** Seed SQL to run after migrations, when the target asks for it. */
  seedSql: string | undefined;
  /** Remove the workspace. Safe to call more than once. */
  dispose(): Promise<void>;
};

/** The largest seed the publish step can pass as a single command argument. */
export const MAX_CLOUDFLARE_ARTIFACT_SEED_BYTES: number = 100 * 1024;

const WORKER_DIRECTORY = `${CLOUDFLARE_ARTIFACT_OUTPUT_DIR}/workers/default`;
const ROOT_CONFIG_PATH = `${CLOUDFLARE_ARTIFACT_OUTPUT_DIR}/config.json`;
const WORKER_CONFIG_PATH = `${WORKER_DIRECTORY}/worker.config.json`;
const BUNDLE_PREFIX = `${WORKER_DIRECTORY}/bundle/`;
const ASSETS_PREFIX = `${WORKER_DIRECTORY}/assets/`;
const MIGRATIONS_PREFIX = `${CLOUDFLARE_ARTIFACT_MIGRATIONS_DIR}/`;
const WORKSPACE_PREFIX = 'void-artifact-publish-';
/** The workspace holds the upload tree and the Wrangler-format configs, so only its owner may read it. */
const PRIVATE_DIRECTORY_MODE = 0o700;
const MAX_SHOWN_LENGTH = 80;

type UploadTreeInput = {
  root: string;
  upload: string;
  manifest: CloudflareArtifactManifest;
  target: CloudflareArtifactTarget;
  worker: BoundCloudflareArtifactWorker;
};

/**
 * Validate an artifact and a publish target, then build every config and a fresh upload tree
 * in a private workspace. Makes no network call and runs no subprocess.
 */
export async function stageCloudflareArtifact(
  artifactDir: string,
  target: unknown,
): Promise<StagedCloudflareArtifact> {
  const publishTarget = parseCloudflareArtifactTarget(target);
  const root = resolve(artifactDir);
  const manifest = readCloudflareArtifact(root);
  const { requirements } = manifest;

  checkRootConfig(readArtifactJson(root, ROOT_CONFIG_PATH), publishTarget);
  const worker = bindCloudflareArtifactWorker({
    workerConfig: readArtifactJson(root, WORKER_CONFIG_PATH),
    requirements,
    target: publishTarget,
    bundleModules: listUnder(manifest, BUNDLE_PREFIX),
  });
  if (worker.versionMetadataBinding === undefined) {
    throw new CloudflareArtifactError(
      'worker-config',
      'The artifact has no version-metadata binding, so readiness could not prove which version it checked.',
      WORKER_CONFIG_PATH,
    );
  }
  checkSecrets(publishTarget, worker.secretNames);
  checkReadinessPath(publishTarget);
  const seedSql = readSeed(root, publishTarget, requirements);

  const workspace = mkdtempSync(join(tmpdir(), WORKSPACE_PREFIX));
  try {
    chmodSync(workspace, PRIVATE_DIRECTORY_MODE);
    const neutralRoot = makePrivateDirectory(join(workspace, 'neutral'));
    const configDirectory = makePrivateDirectory(join(workspace, 'config'));
    const upload = makePrivateDirectory(join(workspace, 'upload'));
    const migrations = stageMigrations(root, manifest, workspace);
    const assetsDirectory = await writeUploadTree({
      root,
      upload,
      manifest,
      target: publishTarget,
      worker,
    });
    const configs = createCloudflareArtifactWranglerConfigs({
      worker: worker.config,
      target: publishTarget,
      requirements,
      migrationsDirectory: migrations?.directory,
    });
    const { generatedPath, rootPath } = writeCloudflareArtifactWranglerConfigs(
      configDirectory,
      configs,
    );

    return {
      manifest,
      target: publishTarget,
      worker,
      workspace,
      neutralRoot,
      output: {
        directory: upload,
        ...(assetsDirectory === undefined ? {} : { assetsDirectory }),
        dispose: async () => {
          rmSync(upload, { recursive: true, force: true });
        },
      },
      generatedConfigPath: generatedPath,
      rootConfigPath: rootPath,
      migrationsDirectory: migrations?.directory,
      migrationNames: migrations?.names ?? [],
      seedSql,
      dispose: async () => {
        rmSync(workspace, { recursive: true, force: true });
      },
    };
  } catch (error) {
    discardWorkspace(workspace, error);
    throw error;
  }
}

/** Cut `text` to at most 80 characters, marking the cut with "...". */
function clip(text: string): string {
  const characters = Array.from(text);
  return characters.length > MAX_SHOWN_LENGTH
    ? `${characters.slice(0, MAX_SHOWN_LENGTH - 3).join('')}...`
    : text;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Parse a JSON file inside the artifact. A parse error names the file, never its contents. */
function readArtifactJson(root: string, path: string): unknown {
  const text = readFileSync(resolveCloudflareArtifactPath(root, path), 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new CloudflareArtifactError('worker-config', `${path} is not valid JSON.`, path);
  }
}

/** The relative paths of the manifest's files under `prefix`, with the prefix removed. */
function listUnder(manifest: CloudflareArtifactManifest, prefix: string): Array<string> {
  return manifest.files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => file.path.slice(prefix.length));
}

function makePrivateDirectory(path: string): string {
  mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
  return path;
}

/**
 * Check the root Build Output config: the account must match the target, the artifact may not set
 * a compliance region, and the build must not be a preview.
 */
function checkRootConfig(value: unknown, target: CloudflareArtifactTarget): void {
  const parsed = OutputRootConfigSchema.safeParse(value);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw rootConfigError(issuePath(issue), `fails the schema: ${clip(issue.message)}`);
  }
  const config = parsed.data;
  if (config.accountId !== undefined && config.accountId !== target.accountId) {
    throw rootConfigError('accountId', 'must be absent or equal to the target account ID');
  }
  if (config.complianceRegion !== undefined) {
    throw rootConfigError('complianceRegion', 'must be absent for a preview artifact');
  }
  if (config.buildContext.isPreview !== false) {
    throw rootConfigError(
      'buildContext.isPreview',
      'must be false, because Cloudflare refuses to upload a preview build',
    );
  }
}

function rootConfigError(field: string, problem: string): CloudflareArtifactError {
  return new CloudflareArtifactError('worker-config', `${field} ${problem}.`, ROOT_CONFIG_PATH);
}

function issuePath(issue: { path: ReadonlyArray<PropertyKey> }): string {
  return issue.path.length === 0 ? 'The root config' : issue.path.map(String).join('.');
}

/**
 * The target's secret names must be exactly the artifact's required names. Only names appear in
 * the message, never values.
 */
function checkSecrets(target: CloudflareArtifactTarget, required: ReadonlyArray<string>): void {
  const missing = required.filter((name) => !Object.hasOwn(target.secrets, name));
  const extra = Object.keys(target.secrets)
    .filter((name) => !required.includes(name))
    .sort(compareCodeUnits);
  if (missing.length === 0 && extra.length === 0) {
    return;
  }
  const problems: Array<string> = [];
  if (missing.length > 0) {
    problems.push(`missing ${missing.join(', ')}`);
  }
  if (extra.length > 0) {
    problems.push(`not required by the artifact: ${extra.join(', ')}`);
  }
  throw new CloudflareArtifactTargetError(
    'secrets',
    `must match the artifact's required secrets: ${problems.join('; ')}.`,
  );
}

/** Readiness needs something to probe: a route, or workers.dev or preview URLs on a known subdomain. */
function checkReadinessPath(target: CloudflareArtifactTarget): void {
  if (target.routes.length > 0) {
    return;
  }
  if ((target.workersDev || target.previewUrls) && target.workersDevSubdomain !== undefined) {
    return;
  }
  throw new CloudflareArtifactTargetError(
    'routes',
    'is empty, so readiness has nothing to probe. A preview needs a route, or workersDev or previewUrls with a known workersDevSubdomain.',
  );
}

/**
 * Copy the migrations and journal that the requirements list into a private `migrations` directory
 * in the workspace, then check the copy. The copy must match the manifest's sizes and hashes, so a
 * file changed after verification is rejected. The order checks and migration gates run on the copy,
 * and the apply step reads only the copy. Returns `undefined` when the artifact has no D1 database.
 */
function stageMigrations(
  root: string,
  manifest: CloudflareArtifactManifest,
  workspace: string,
): { directory: string; names: Array<string> } | undefined {
  const d1 = manifest.requirements.d1;
  if (d1 === null) {
    return undefined;
  }
  const directory = makePrivateDirectory(join(workspace, CLOUDFLARE_ARTIFACT_MIGRATIONS_DIR));
  const files = manifest.files
    .filter((file) => file.path.startsWith(MIGRATIONS_PREFIX))
    .map((file) => ({ ...file, path: file.path.slice(MIGRATIONS_PREFIX.length) }));
  copyUnder(
    root,
    MIGRATIONS_PREFIX,
    directory,
    files.map((file) => file.path),
  );
  verifyCloudflareArtifactFiles(directory, files);

  const collected = collectMigrations(directory);
  const found = collected.map((migration) => migration.name);
  assertCloudflareMigrationApplyOrder(found);
  const matches =
    found.length === d1.migrations.length &&
    found.every((name, index) => name === d1.migrations[index]);
  if (!matches) {
    throw new CloudflareArtifactError(
      'layout',
      `The migrations on disk are ${found.join(', ') || 'none'}, but requirements.d1.migrations lists ${d1.migrations.join(', ') || 'none'}, in that order.`,
      CLOUDFLARE_ARTIFACT_MIGRATIONS_DIR,
    );
  }
  validateMigrations(collected);
  if (d1.journal) {
    assertJournalCoherence(directory, collected);
  }
  return { directory, names: [...d1.migrations] };
}

/**
 * Read the seed when the target asks for it. The seed must fit in one command argument and be
 * valid UTF-8, so the publish step never sends altered SQL.
 */
function readSeed(
  root: string,
  target: CloudflareArtifactTarget,
  requirements: CloudflareArtifactRequirements,
): string | undefined {
  if (!target.seed) {
    return undefined;
  }
  if (!requirements.seed) {
    throw new CloudflareArtifactTargetError(
      'seed',
      'is true, but the artifact has no seed.sql. Set seed to false, or add a seed to the app.',
    );
  }
  const path = resolveCloudflareArtifactPath(root, CLOUDFLARE_ARTIFACT_SEED_FILE);
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_CLOUDFLARE_ARTIFACT_SEED_BYTES) {
    throw new CloudflareArtifactError(
      'limit',
      `seed.sql is ${bytes.byteLength} bytes, more than the ${MAX_CLOUDFLARE_ARTIFACT_SEED_BYTES}-byte limit. The publish step passes the seed as one command argument, and Linux limits one argument to 128 KiB.`,
      CLOUDFLARE_ARTIFACT_SEED_FILE,
    );
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CloudflareArtifactError(
      'layout',
      `${CLOUDFLARE_ARTIFACT_SEED_FILE} is not valid UTF-8.`,
      CLOUDFLARE_ARTIFACT_SEED_FILE,
    );
  }
}

/**
 * Write the fresh upload tree in `upload`: the root and Worker configs, then every bundle module
 * and asset, copied from the artifact. Returns the assets directory when the artifact has assets.
 */
async function writeUploadTree(input: UploadTreeInput): Promise<string | undefined> {
  const { root, upload, manifest, target, worker } = input;
  await writeRootConfig(
    upload,
    { accountId: target.accountId },
    { isPreview: false, mode: 'production' },
  );
  await writeWorkerConfig({
    root: upload,
    config: worker.config,
    manifest: worker.config.manifest,
  });
  copyUnder(root, BUNDLE_PREFIX, getWorkerBundleDir(upload), listUnder(manifest, BUNDLE_PREFIX));
  const assets = listUnder(manifest, ASSETS_PREFIX);
  copyUnder(root, ASSETS_PREFIX, getWorkerAssetsDir(upload), assets);

  const built = await readBuildOutput(upload);
  if (built.workers.default.config.name !== target.workerName) {
    throw new CloudflareArtifactError(
      'worker-config',
      'The upload tree names a Worker other than the target.',
      WORKER_CONFIG_PATH,
    );
  }
  return assets.length > 0 ? getWorkerAssetsDir(upload) : undefined;
}

/** Copy each relative path under `prefix` in the artifact to the same relative path under `destination`. */
function copyUnder(
  root: string,
  prefix: string,
  destination: string,
  relativePaths: ReadonlyArray<string>,
): void {
  for (const relativePath of relativePaths) {
    const copy = join(destination, relativePath);
    mkdirSync(dirname(copy), { recursive: true });
    copyFileSync(resolveCloudflareArtifactPath(root, `${prefix}${relativePath}`), copy);
  }
}

/**
 * Remove the workspace after a failed stage, then let the caller rethrow the original error. A
 * removal failure is attached as `cause`, so it is never the error that surfaces.
 */
function discardWorkspace(workspace: string, error: unknown): void {
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch (removeError) {
    if (error instanceof Error && error.cause === undefined) {
      error.cause = removeError;
    }
  }
}
