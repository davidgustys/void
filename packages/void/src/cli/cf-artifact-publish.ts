import { readFileSync } from 'node:fs';
import {
  activateCloudflareVersion,
  encodeCloudflareVersionMessage,
  readCloudflareTriggerConfig,
  resolveD1MigrateTarget,
  type CloudflareVersionActivationOptions,
} from '@void/deploy-cloudflare';
import { collectMigrations } from '../migrations/collect.ts';
import { CLOUDFLARE_ARTIFACT_MIGRATIONS_DIR } from './cf-artifact-schema.ts';
import { type StagedCloudflareArtifact, stageCloudflareArtifact } from './cf-artifact-stage.ts';
import { createActiveSecretPinner } from './cf-version-runner.ts';
import { type CloudflareD1Context, executeCloudflareD1Sql } from './cloudflare-operations.ts';
import {
  activateCloudflareVersionWithProgress,
  cloudflareCandidateActivationOptions,
  confirmCloudflareDeployAuthentication,
  connectCloudflareDeployAccount,
  createCfActivationRunner,
  formatCloudflareActivationError,
} from './deploy-cloudflare-helpers.ts';
import { log } from './deploy-helpers.ts';
import {
  applyAndVerifyRemoteD1Migrations,
  checkWranglerMigrationApplySet,
} from './deploy-migrations.ts';
import type { CloudflareDeployDeps } from './deploy-types.ts';

export type PublishCloudflareArtifactOptions = {
  /** Test and advanced hooks, as for the native deploy. */
  deps?: CloudflareDeployDeps;
  /** Publish a version that adds Durable Object classes in one atomic step, without staged readiness. */
  atomic?: boolean;
};

export type PublishedCloudflareArtifact = {
  workerName: string;
  versionId: string;
  previousVersionId: string | null;
  /** The URL readiness probed. */
  previewUrl: string;
  /** Migrations in the artifact, in apply order. */
  migrations: Array<string>;
  seeded: boolean;
};

/** A publish step failed. `reason` is an activation failure reason, or 'connect' | 'auth' | 'migrations' | 'seed'. */
export class CloudflareArtifactPublishError extends Error {
  /** Activation failure reason, or 'connect' | 'auth' | 'migrations' | 'seed'. */
  readonly reason: string;
  readonly versionId?: string;
  readonly rollback?: string;

  constructor(
    reason: string,
    message: string,
    details: {
      versionId?: string | undefined;
      rollback?: string | undefined;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'CloudflareArtifactPublishError';
    this.reason = reason;
    if (details.versionId !== undefined) {
      this.versionId = details.versionId;
    }
    if (details.rollback !== undefined) {
      this.rollback = details.rollback;
    }
    if (details.cause !== undefined) {
      this.cause = details.cause;
    }
  }
}

/**
 * Publish a validated Void Cloudflare artifact into existing resources. Creates no resources.
 * Experimental.
 */
export async function publishCloudflareArtifact(
  artifactDir: string,
  target: unknown,
  options: PublishCloudflareArtifactOptions = {},
): Promise<PublishedCloudflareArtifact> {
  const staged = await stageCloudflareArtifact(artifactDir, target);
  try {
    return await publishStagedArtifact(staged, options);
  } finally {
    await staged.dispose();
  }
}

type AppliedMigrations = {
  token: string;
  /** Restores the point saved before the migrations, when any were pending. */
  restoreCommand: string | undefined;
};

async function publishStagedArtifact(
  staged: StagedCloudflareArtifact,
  options: PublishCloudflareArtifactOptions,
): Promise<PublishedCloudflareArtifact> {
  const deps = options.deps ?? {};
  const { target } = staged;
  const connection = await connectCloudflareDeployAccount({
    root: staged.neutralRoot,
    configPath: staged.rootConfigPath,
    rootConfig: readRootConfig(staged.rootConfigPath),
    deps,
    persistAccount: false,
  });
  if (!connection) {
    throw new CloudflareArtifactPublishError(
      'connect',
      'Could not connect to Cloudflare. See the error logged above.',
    );
  }
  if (target.apiBaseUrl !== undefined && target.apiBaseUrl !== connection.apiBaseUrl) {
    throw new CloudflareArtifactPublishError(
      'connect',
      `The target sets apiBaseUrl to ${target.apiBaseUrl}, but this run uses ${connection.apiBaseUrl}. The API base comes from the environment, so set CLOUDFLARE_API_BASE_URL to the target's value.`,
    );
  }
  if (!(await confirmCloudflareDeployAuthentication(connection, staged.rootConfigPath))) {
    throw new CloudflareArtifactPublishError(
      'auth',
      'Cloudflare authentication failed. See the error logged above.',
    );
  }

  const migrations = await applyMigrations(staged, connection);
  const seeded = await seedDatabase(staged, connection, migrations?.token);
  const execution = await activateStagedVersion({
    staged,
    connection,
    deps,
    atomic: options.atomic ?? false,
    workersDevSubdomain: target.workersDevSubdomain ?? connection.workersDevSubdomain,
  });
  if (!execution.ok) {
    const restoreHint = migrations?.restoreCommand
      ? `\n\nD1 migrations were applied before activation, and a Worker rollback does not undo them. To undo them, restore this point (discards every later write):\n  ${migrations.restoreCommand}`
      : '';
    throw new CloudflareArtifactPublishError(
      execution.reason,
      `${formatCloudflareActivationError(execution)}${restoreHint}`,
      { versionId: execution.versionId, rollback: execution.rollback },
    );
  }
  return {
    workerName: target.workerName,
    versionId: execution.versionId,
    previousVersionId: execution.previousVersionId,
    previewUrl: execution.previewUrl,
    migrations: [...staged.migrationNames],
    seeded,
  };
}

/**
 * Run the migration gate and apply the staged migrations. Returns `undefined` when the artifact
 * has no migrations, so the D1 step is skipped.
 */
async function applyMigrations(
  staged: StagedCloudflareArtifact,
  connection: ConnectedArtifactAccount,
): Promise<AppliedMigrations | undefined> {
  const d1 = staged.manifest.requirements.d1;
  const migrationsDirectory = staged.migrationsDirectory;
  if (d1 === null || migrationsDirectory === undefined || staged.migrationNames.length === 0) {
    return undefined;
  }
  const token = resolveD1Token(connection.rootConfig, d1.binding, 'migrations');
  // The gate checks the directory wrangler will read, so stray files and order drift are rejected.
  const gate = await checkWranglerMigrationApplySet(
    staged.rootConfigPath,
    connection.rootConfig,
    d1.binding,
    migrationsDirectory,
    collectMigrations(migrationsDirectory),
    CLOUDFLARE_ARTIFACT_MIGRATIONS_DIR,
  );
  if (!gate.ok) {
    throw new CloudflareArtifactPublishError('migrations', gate.reason);
  }
  const applied = await applyAndVerifyRemoteD1Migrations(
    token,
    staged.rootConfigPath,
    connection.runWrangler,
    connection.assertUploaderStillPinned,
  );
  if (!applied) {
    throw new CloudflareArtifactPublishError(
      'migrations',
      'The D1 migrations did not apply and verify, so no Worker version was uploaded. See the error logged above.',
    );
  }
  return { token, restoreCommand: applied.restoreCommand };
}

/** Run the seed, when the target asks for one. Returns whether it ran. */
async function seedDatabase(
  staged: StagedCloudflareArtifact,
  connection: ConnectedArtifactAccount,
  migrationToken: string | undefined,
): Promise<boolean> {
  const { seedSql } = staged;
  if (seedSql === undefined) {
    return false;
  }
  const d1 = staged.manifest.requirements.d1;
  if (d1 === null) {
    throw new CloudflareArtifactPublishError(
      'seed',
      'The seed needs a D1 database, and the artifact has none.',
    );
  }
  const token = migrationToken ?? resolveD1Token(connection.rootConfig, d1.binding, 'seed');
  const entry = findD1Entry(connection.rootConfig, d1.binding);
  const context: CloudflareD1Context = {
    operation: {
      accountId: connection.accountId,
      apiBaseUrl: connection.apiBaseUrl,
      configPath: staged.rootConfigPath,
      workerName: staged.target.workerName,
      runWrangler: connection.runWrangler,
    },
    binding: d1.binding,
    migrateToken: token,
    migrationsDir: typeof entry?.migrations_dir === 'string' ? entry.migrations_dir : undefined,
    migrationsTable:
      typeof entry?.migrations_table === 'string' ? entry.migrations_table : 'd1_migrations',
  };
  // The migrations ran with credentials, so the uploader must still match its pinned hash first.
  if (!connection.assertUploaderStillPinned()) {
    throw new CloudflareArtifactPublishError(
      'auth',
      'The Cloudflare uploader changed before the seed, so the credentials were not used. See the error logged above.',
    );
  }
  log.step('Seeding the D1 database...');
  try {
    await executeCloudflareD1Sql(context, seedSql);
  } catch (error) {
    // The cause can echo the SQL, so it is attached rather than put in the message.
    throw new CloudflareArtifactPublishError(
      'seed',
      'The seed did not run after the migrations, so no Worker version was uploaded.',
      { cause: error },
    );
  }
  return true;
}

/**
 * Upload, check readiness on, and activate the staged version. The uploader comes from the
 * pinned cf output when the connection uses cf, and from the injected runner otherwise.
 */
async function activateStagedVersion(input: {
  staged: StagedCloudflareArtifact;
  connection: ConnectedArtifactAccount;
  deps: CloudflareDeployDeps;
  atomic: boolean;
  workersDevSubdomain: string | undefined;
}): Promise<ArtifactActivation> {
  const { staged, connection, deps } = input;
  const { target } = staged;
  const cfOutput = connection.usesCf ? staged.output : null;
  if (connection.usesCf && !connection.cfUploaderIsPinned()) {
    throw new CloudflareArtifactPublishError(
      'auth',
      'The Cloudflare uploader changed, so the credentials were not used. See the error logged above.',
    );
  }
  const activationRunner = createCfActivationRunner({
    cfOutput,
    accountId: connection.accountId,
    apiBaseUrl: connection.apiBaseUrl,
    workerName: target.workerName,
    configPath: staged.generatedConfigPath,
    runWrangler: connection.runWrangler,
    cfUploaderIsPinned: connection.cfUploaderIsPinned,
    verifyCompatibilityRunner: connection.assertUploaderStillPinned,
  });
  // Target secrets go to the candidate upload itself, which skips pinning. With no target secrets,
  // a secret inherited from the live version must be pinned before the upload.
  const hasTargetSecrets = Object.keys(target.secrets).length > 0;
  const pinActiveSecrets = hasTargetSecrets
    ? undefined
    : createActiveSecretPinner({
        output: cfOutput,
        handoffPending: false,
        requiredNames: staged.worker.secretNames,
      });
  const secretOptions: SecretActivationOptions = hasTargetSecrets
    ? { candidateSecrets: { ...target.secrets } }
    : pinActiveSecrets
      ? { pinActiveSecrets }
      : {};
  try {
    return await activateCloudflareVersionWithProgress(
      deps.activateVersion ?? activateCloudflareVersion,
      {
        ...cloudflareCandidateActivationOptions({
          root: staged.neutralRoot,
          rootConfigPath: staged.rootConfigPath,
          uploadConfigPath: staged.generatedConfigPath,
          accountId: connection.accountId,
          apiBaseUrl: connection.apiBaseUrl,
          workerName: target.workerName,
          workersDevSubdomain: input.workersDevSubdomain,
          runWrangler: connection.runWrangler,
          readExistingWorker: deps.readExistingWorker,
          existingWorker: null,
          pinnedHandoffLink: null,
          initialCloudflareCandidate: null,
          assertUploaderStillPinned: connection.assertUploaderStillPinned,
          approvedKv: [],
          queueConsumerCleanup: [],
        }),
        runWrangler: activationRunner,
        verifyUploader: cfOutput
          ? connection.cfUploaderIsPinned
          : connection.assertUploaderStillPinned,
        requireVersionMetadata: true,
        requirePreviewForReadiness: false,
        message: encodeCloudflareVersionMessage(
          staged.migrationNames,
          readCloudflareTriggerConfig(staged.generatedConfigPath, staged.rootConfigPath),
        ),
        atomic: input.atomic,
        ...secretOptions,
      },
    );
  } finally {
    await cfOutput?.dispose();
  }
}

/** The account and runners that `connectCloudflareDeployAccount` returns. */
type ConnectedArtifactAccount = NonNullable<
  Awaited<ReturnType<typeof connectCloudflareDeployAccount>>
>;

type ArtifactActivation = Awaited<ReturnType<typeof activateCloudflareVersion>>;

type SecretActivationOptions = Pick<
  CloudflareVersionActivationOptions,
  'candidateSecrets' | 'pinActiveSecrets'
>;

function readRootConfig(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function findD1Entry(
  rootConfig: Record<string, unknown>,
  binding: string,
): Record<string, unknown> | undefined {
  const entries = Array.isArray(rootConfig.d1_databases)
    ? (rootConfig.d1_databases as Array<Record<string, unknown>>)
    : [];
  return entries.find((entry) => entry.binding === binding);
}

function resolveD1Token(
  rootConfig: Record<string, unknown>,
  binding: string,
  stage: 'migrations' | 'seed',
): string {
  const target = resolveD1MigrateTarget(rootConfig, binding);
  if (!target.ok) {
    throw new CloudflareArtifactPublishError(
      stage,
      `Cannot resolve the D1 database for binding ${binding}: ${target.reason}.`,
    );
  }
  return target.token;
}
