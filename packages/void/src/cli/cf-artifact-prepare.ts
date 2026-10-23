import { execSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { parseRootWranglerConfig, readBindingFieldPresence } from '@void/deploy-cloudflare';
import { isRecord } from '@void/deploy-core';
import { dirname, isAbsolute, join, relative, resolve } from 'pathslash';
import { isNodeTarget, readConfig } from '../config.ts';
import { collectMigrations } from '../migrations/collect.ts';
import { detectFramework } from '../plugin-inference.ts';
import { hasEmailHandlers } from '../router/email.ts';
import { WRANGLER_AUTH_CREDENTIAL_ENV_VARS } from '../shared/untrusted-env.ts';
import { getOwnVersion } from './agents.ts';
import { assertCloudflareArtifactOutputDirectory } from './cf-artifact-output.ts';
import { packageCloudflareArtifact } from './cf-artifact-package.ts';
import {
  assertCloudflareMigrationApplyOrder,
  type CloudflareArtifactManifest,
  type CloudflareArtifactProvenance,
  type CloudflareArtifactRequirements,
} from './cf-artifact-schema.ts';
import {
  deduplicateGeneratedCompatibilityFlags,
  resolveGeneratedDeployConfigPathDefault,
} from './deploy-artifact-validation.ts';
import { createCloudflareWorkerBuildEnv } from './deploy-cloudflare-build.ts';
import {
  type CloudflareDeploySource,
  prepareCloudflareDeploySource,
} from './deploy-cloudflare-preflight.ts';
import { log } from './deploy-helpers.ts';
import {
  assertRemoteMigrationsDeployable,
  validateAuthMigrationSchema,
} from './deploy-migrations.ts';
import { resolveProjectCommand } from './preset.ts';
import { resolvePinnedApiBaseUrl } from './provision.ts';

export type PrepareCloudflareArtifactOptions = {
  /** Directory to write the artifact into; it must be missing or an empty real directory. */
  outDir: string;
  /** Idempotent seed SQL file, relative to `root`. */
  seed?: string;
  /** Source commit, recorded as information only. */
  commit?: string;
  /** Test hook: replaces running the app's build command. */
  runBuild?: (env: NodeJS.ProcessEnv) => void;
};

/** Build-side facts that {@link deriveCloudflareArtifactRequirements} turns into requirements. */
export type CloudflareArtifactRequirementsInput = {
  /** The app's D1 database, or `null` when the app needs none. */
  d1: null | {
    binding: string;
    /** The root config's `migrations_table` for the binding. Absent means `d1_migrations`. */
    migrationsTable?: string;
    /** Migration file names in the order `collectMigrations` returns them, which is the apply order. */
    migrations: ReadonlyArray<string>;
    /** Whether `meta/_journal.json` exists beside the migrations. */
    journal: boolean;
  };
  /** Whether the desired KV set includes the `ISR_CACHE` binding. */
  isrCache: boolean;
  /** `inbound`: the app has email handlers. `send`: the app imports `void/email`. */
  email: { inbound: boolean; send: boolean };
  /** The built Worker config (`dist/ssr/wrangler.json`), parsed. Its `secrets.required` lists the secrets. */
  builtConfig: Record<string, unknown>;
  /** Whether a seed file is supplied. */
  seed: boolean;
};

/** The migrations table `wrangler d1 migrations apply` uses when the root config does not name one. */
const DEFAULT_D1_MIGRATIONS_TABLE = 'd1_migrations';
const ISR_CACHE_BINDING = 'ISR_CACHE';
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/;

/**
 * Build the app without Cloudflare credentials, run Void's build-side gates, and package a
 * Cloudflare artifact for a separate trusted publish. Experimental.
 */
export async function prepareCloudflareArtifact(
  root: string,
  options: PrepareCloudflareArtifactOptions,
): Promise<CloudflareArtifactManifest> {
  // Project code runs below, so the credentials are refused before any of it is loaded.
  refuseCloudflareCredentials();
  // The inputs that can fail cheaply are checked before the build, which takes the longest.
  const outDir = resolve(options.outDir);
  assertCloudflareArtifactOutputDirectory(outDir);
  const commit = validateCommit(options.commit);
  root = resolve(root);
  const seedFile = options.seed === undefined ? undefined : resolveSeedFile(root, options.seed);

  const voidConfig = readConfig(root);
  if (isNodeTarget(voidConfig.target)) {
    throw new Error(
      `A Cloudflare artifact needs a Void Cloudflare Worker build, but this app targets ${voidConfig.target}.`,
    );
  }
  if (voidConfig.output === 'static') {
    throw new Error(
      'A Cloudflare artifact needs a Void Worker build, but this app builds static output.',
    );
  }
  // A framework has its own Worker output, which this pipeline does not package.
  if (detectFramework(root)) {
    throw new Error(
      'A Cloudflare artifact supports only native Void apps, but this app uses a framework.',
    );
  }

  const source = await prepareCloudflareDeploySource(root, { platform: 'cloudflare' }, voidConfig);
  if (!source) {
    throw new Error(
      'This app is not supported for a Cloudflare artifact. The reason is logged above.',
    );
  }
  assertArtifactScope(source);
  if (seedFile !== undefined && !source.desired.d1) {
    throw new Error('A seed file needs a D1 database, and this app does not use one.');
  }

  log.step('Building the app without Cloudflare credentials...');
  const buildEnv = createCloudflareWorkerBuildEnv({
    accountId: undefined,
    apiBaseUrl: resolvePinnedApiBaseUrl({}),
    preserveBindings: false,
  });
  const runBuild =
    options.runBuild ??
    ((env: NodeJS.ProcessEnv) => {
      execSync(resolveProjectCommand(root, 'vite build'), { cwd: root, stdio: 'inherit', env });
    });
  runBuild(buildEnv);

  const generatedConfigPath = resolveGeneratedDeployConfigPathDefault(root);
  // The native build step deduplicates the generated compatibility flags before it uploads.
  deduplicateGeneratedCompatibilityFlags(generatedConfigPath, source.configPath);

  log.step('Running the build-side checks...');
  // Build plugins can add or rewrite migrations, so every gate reads the post-build set.
  const migrations = collectMigrations(source.migrationsDir);
  if (source.desired.d1) {
    assertCloudflareMigrationApplyOrder(migrations.map((migration) => migration.name));
    assertRemoteMigrationsDeployable(root, source.dialect, source.migrationsDir, migrations);
  }
  if (source.authEnabled) {
    await validateAuthMigrationSchema(root, migrations);
  }

  const requirements = deriveCloudflareArtifactRequirements({
    d1: source.desired.d1
      ? {
          binding: source.desired.d1.binding,
          migrationsTable: readMigrationsTable(source.configPath, source.desired.d1.binding),
          migrations: migrations.map((migration) => migration.name),
          journal: existsSync(join(source.migrationsDir, 'meta', '_journal.json')),
        }
      : null,
    isrCache: source.desired.kvNamespaces.some(
      (namespace) => namespace.binding === ISR_CACHE_BINDING,
    ),
    email: {
      inbound: hasEmailHandlers(source.emailHandlers),
      send: source.analysis.bindings.needsEmail === true,
    },
    builtConfig: readBuiltWorkerConfig(generatedConfigPath),
    seed: seedFile !== undefined,
  });

  const provenance: CloudflareArtifactProvenance = {
    voidVersion: getOwnVersion(),
    commit,
    builtAt: new Date().toISOString(),
  };
  log.step('Packaging the Cloudflare artifact...');
  return packageCloudflareArtifact({
    workerDirectory: dirname(generatedConfigPath),
    outDir,
    requirements,
    migrationsDirectory: requirements.d1 === null ? undefined : source.migrationsDir,
    seedFile,
    provenance,
  });
}

/**
 * Derive the artifact requirements from the deploy source and the built config. Pure. The
 * migration names keep the order given, because that order is the apply order.
 */
export function deriveCloudflareArtifactRequirements(
  input: CloudflareArtifactRequirementsInput,
): CloudflareArtifactRequirements {
  return {
    d1:
      input.d1 === null
        ? null
        : {
            binding: input.d1.binding,
            migrationsTable: input.d1.migrationsTable ?? DEFAULT_D1_MIGRATIONS_TABLE,
            migrations: [...input.d1.migrations],
            journal: input.d1.journal,
          },
    isrCache: input.isrCache,
    email: { inbound: input.email.inbound, send: input.email.send },
    secrets: requiredSecretNames(input.builtConfig),
    seed: input.seed,
  };
}

/** Throw when a Cloudflare credential is set. Only the variable names are reported, never their values. */
function refuseCloudflareCredentials(): void {
  const present = WRANGLER_AUTH_CREDENTIAL_ENV_VARS.filter(
    (name) => process.env[name] !== undefined,
  );
  if (present.length > 0) {
    throw new Error(
      `A Cloudflare artifact runs project code, so it must run without Cloudflare credentials. Unset ${present.join(', ')} and rerun.`,
    );
  }
}

function validateCommit(commit: string | undefined): string | null {
  if (commit === undefined) {
    return null;
  }
  if (!COMMIT_PATTERN.test(commit)) {
    throw new Error(
      `The commit must be 7 to 64 lowercase hex characters, but it is ${JSON.stringify(commit)}.`,
    );
  }
  return commit;
}

/**
 * Resolve the seed inside `root`. Both the lexical path and the real directory must stay under
 * the real root, and the seed itself must be a regular file rather than a symlink.
 */
function resolveSeedFile(root: string, seed: string): string {
  const path = resolve(root, seed);
  if (escapesDirectory(root, path)) {
    throw new Error(`The seed file ${JSON.stringify(seed)} must be inside the app root.`);
  }
  let realDirectory: string;
  try {
    realDirectory = realpathSync(dirname(path));
  } catch {
    throw new Error(`The seed file ${JSON.stringify(seed)} does not exist.`);
  }
  if (escapesDirectory(realpathSync(root), realDirectory)) {
    throw new Error(`The seed file ${JSON.stringify(seed)} must be inside the app root.`);
  }
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats === undefined) {
    throw new Error(`The seed file ${JSON.stringify(seed)} does not exist.`);
  }
  if (stats.isSymbolicLink()) {
    throw new Error(
      `The seed file ${JSON.stringify(seed)} is a symlink, and symlinks are not permitted.`,
    );
  }
  if (!stats.isFile()) {
    throw new Error(`The seed file ${JSON.stringify(seed)} is not a regular file.`);
  }
  return path;
}

/** Whether `target` lies outside `base`. A relative path that starts with `..` leaves `base`. */
function escapesDirectory(base: string, target: string): boolean {
  const within = relative(base, target);
  return within.split(/[\\/]/)[0] === '..' || isAbsolute(within);
}

/** Refuse the app shapes this pipeline cannot package. Each message names the shape. */
function assertArtifactScope(source: CloudflareDeploySource): void {
  if (source.dialect !== 'sqlite') {
    throw new Error(
      `A Cloudflare artifact supports only SQLite (D1) apps, but this app uses ${source.dialect === 'mysql' ? 'MySQL' : 'PostgreSQL'}, which needs a Hyperdrive config.`,
    );
  }
  if (source.needsSandbox) {
    throw new Error(
      'A Cloudflare artifact does not support Sandbox (containers) yet. Use `void deploy --platform cloudflare` for this app.',
    );
  }
  // Live's Durable Object class migration needs a check against the live Worker, which the
  // artifact does not carry. `prepareDeployArtifact` refuses Live for the same reason.
  if (source.needsLive) {
    throw new Error(
      'A Cloudflare artifact does not support Live yet, because its Durable Object class migration must be checked against the live Worker. Use `void deploy --platform cloudflare` for this app.',
    );
  }
}

/** The D1 binding's `migrations_table` from the root config. Undefined when it is not set. */
function readMigrationsTable(configPath: string, binding: string): string | undefined {
  const field = readBindingFieldPresence(
    parseRootWranglerConfig(configPath),
    'd1_databases',
    binding,
    'migrations_table',
  );
  if (!field.present) {
    return undefined;
  }
  if (typeof field.value !== 'string' || field.value.length === 0) {
    throw new Error(`D1 binding ${binding} has an invalid migrations_table.`);
  }
  return field.value;
}

function readBuiltWorkerConfig(path: string): Record<string, unknown> {
  const config: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(config)) {
    throw new Error(`The built Worker config ${path} must be a JSON object.`);
  }
  return config;
}

/** Sorted, unique `secrets.required` names. A build with no secrets omits the field. */
function requiredSecretNames(builtConfig: Record<string, unknown>): Array<string> {
  const secrets = builtConfig.secrets;
  if (secrets === undefined) {
    return [];
  }
  if (!isRecord(secrets)) {
    throw new Error('The built Worker config field secrets must be an object.');
  }
  const required = secrets.required;
  if (required === undefined) {
    return [];
  }
  if (!Array.isArray(required) || !required.every((name) => typeof name === 'string')) {
    throw new Error(
      'The built Worker config field secrets.required must be an array of secret names.',
    );
  }
  return [...new Set<string>(required)].sort();
}
