import { lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { convertToWranglerConfig, OutputWorkerSchema } from '@cloudflare/config';
import { isAbsolute, join, resolve } from 'pathslash';
import type { CloudflareArtifactRequirements } from './cf-artifact-schema.ts';
import type { CloudflareArtifactTarget } from './cf-artifact-target.ts';

export type CloudflareArtifactWranglerConfigs = {
  /** Read by activation as the upload config: triggers, version metadata, traffic context. */
  generated: Record<string, unknown>;
  /** Read by activation as the source config, and by the D1 migration runner. */
  root: Record<string, unknown>;
};

type BoundWorker = ReturnType<typeof OutputWorkerSchema.parse>;
type BoundEnv = NonNullable<BoundWorker['env']>;
type BoundTrigger = NonNullable<BoundWorker['triggers']>[number];
type QueueTrigger = Extract<BoundTrigger, { type: 'queue' }>;

const GENERATED_FILE = 'generated.wrangler.json';
const ROOT_FILE = 'root.wrangler.json';
const SHARED_KEYS = ['name', 'account_id', 'routes', 'workers_dev', 'preview_urls'] as const;
const ROOT_KEYS = new Set<string>([...SHARED_KEYS, 'd1_databases', 'observability']);

/** Bound queue fields with Wrangler's `queues.consumers` spelling. */
const QUEUE_CONSUMER_FIELDS = [
  ['deadLetterQueue', 'dead_letter_queue'],
  ['maxBatchSize', 'max_batch_size'],
  ['maxBatchTimeout', 'max_batch_timeout'],
  ['maxConcurrency', 'max_concurrency'],
  ['maxRetries', 'max_retries'],
  ['retryDelay', 'retry_delay'],
  ['visibilityTimeoutMs', 'visibility_timeout_ms'],
] as const satisfies ReadonlyArray<readonly [keyof QueueTrigger, string]>;

/** Build both Wrangler-format configs from validated inputs. Pure. */
export function createCloudflareArtifactWranglerConfigs(input: {
  worker: BoundWorker;
  target: CloudflareArtifactTarget;
  requirements: CloudflareArtifactRequirements;
  /** Absolute path of the artifact's migrations directory. Required when requirements.d1 is set. */
  migrationsDirectory?: string;
}): CloudflareArtifactWranglerConfigs {
  const { worker, target, requirements, migrationsDirectory } = input;
  if (worker.name !== target.workerName) {
    throw new Error(
      `Worker name ${JSON.stringify(worker.name)} does not match target ${JSON.stringify(target.workerName)}.`,
    );
  }
  const triggers = readBoundTriggers(worker.triggers ?? []);
  assertRoutesMatch(triggers.fetch, target);
  const env = worker.env ?? {};
  const versionMetadata = versionMetadataBindingName(env);
  const d1Database = readD1Database(env, requirements, migrationsDirectory);
  const compatibilityFlags = worker.compatibilityFlags ?? [];
  const { observability } = convertToWranglerConfig({
    worker: {
      name: worker.name,
      compatibilityDate: worker.compatibilityDate,
      env: {},
      ...(worker.observability === undefined ? {} : { observability: worker.observability }),
    },
    containers: [],
  });

  const generated: Record<string, unknown> = {
    name: target.workerName,
    account_id: target.accountId,
    compatibility_date: worker.compatibilityDate,
    ...(compatibilityFlags.length > 0 ? { compatibility_flags: [...compatibilityFlags] } : {}),
    routes: wranglerRoutes(target),
    workers_dev: target.workersDev,
    preview_urls: target.previewUrls,
    ...(observability === undefined ? {} : { observability }),
    triggers: { crons: triggers.crons },
    queues: { consumers: triggers.consumers },
    workflows: [],
    ...(versionMetadata === undefined ? {} : { version_metadata: { binding: versionMetadata } }),
  };
  const root: Record<string, unknown> = {
    name: target.workerName,
    account_id: target.accountId,
    routes: wranglerRoutes(target),
    workers_dev: target.workersDev,
    preview_urls: target.previewUrls,
    ...(d1Database === undefined ? {} : { d1_databases: [d1Database] }),
    ...(observability === undefined ? {} : { observability }),
  };
  return { generated, root };
}

/**
 * Write both configs into `directory` as new private files, read them back, and require that
 * they match what was passed in. Returns the absolute paths of the two files.
 */
export function writeCloudflareArtifactWranglerConfigs(
  directory: string,
  configs: CloudflareArtifactWranglerConfigs,
): { generatedPath: string; rootPath: string } {
  const root = resolve(directory);
  if (!lstatSync(root).isDirectory()) {
    throw new Error(`${directory} must be a real directory, not a symlink or a file.`);
  }
  assertPublishedPair(configs.generated, configs.root);

  const generatedPath = join(root, GENERATED_FILE);
  const rootPath = join(root, ROOT_FILE);
  const written: Array<string> = [];
  try {
    writeNewConfig(generatedPath, configs.generated);
    written.push(generatedPath);
    writeNewConfig(rootPath, configs.root);
    written.push(rootPath);
    assertPublishedPair(
      readBackConfig(generatedPath, configs.generated),
      readBackConfig(rootPath, configs.root),
    );
  } catch (error) {
    // Remove only what this call created, so a failed write never leaves a partial pair.
    for (const path of written) {
      rmSync(path, { force: true });
    }
    throw error;
  }
  return { generatedPath, rootPath };
}

type FetchRoute = { pattern: string; zone: string | undefined };

function readBoundTriggers(triggers: ReadonlyArray<BoundTrigger>): {
  crons: Array<string>;
  consumers: Array<Record<string, unknown>>;
  fetch: Array<FetchRoute>;
} {
  const crons: Array<string> = [];
  const consumers: Array<Record<string, unknown>> = [];
  const fetch: Array<FetchRoute> = [];
  for (const trigger of triggers) {
    switch (trigger.type) {
      case 'scheduled':
        crons.push(trigger.schedule);
        break;
      case 'queue':
        consumers.push(queueConsumer(trigger));
        break;
      case 'fetch':
        fetch.push({ pattern: trigger.pattern, zone: trigger.zone });
        break;
      default:
        // Email and connect triggers have no Wrangler mapping here. Dropping them would publish
        // a config that silently differs from the artifact.
        throw new Error(
          `Worker trigger type ${trigger.type} is not part of an artifact publish; use scheduled, queue or fetch.`,
        );
    }
  }
  return { crons, consumers, fetch };
}

function queueConsumer(trigger: QueueTrigger): Record<string, unknown> {
  const consumer: Record<string, unknown> = { queue: trigger.name };
  for (const [camel, snake] of QUEUE_CONSUMER_FIELDS) {
    const value = trigger[camel];
    // A null concurrency limit means none. Wrangler has no null form, so the key is omitted.
    if (value !== undefined && value !== null) {
      consumer[snake] = value;
    }
  }
  return consumer;
}

function assertRoutesMatch(
  fetch: ReadonlyArray<FetchRoute>,
  target: CloudflareArtifactTarget,
): void {
  const matches =
    fetch.length === target.routes.length &&
    target.routes.every(
      (route, index) =>
        fetch[index]?.pattern === route.pattern && fetch[index]?.zone === route.zoneName,
    );
  if (!matches) {
    throw new Error('Worker fetch triggers do not match the target routes in order.');
  }
}

function versionMetadataBindingName(env: BoundEnv): string | undefined {
  const names = Object.entries(env)
    .filter(([, binding]) => binding.type === 'version-metadata')
    .map(([name]) => name);
  if (names.length > 1) {
    throw new Error(
      `Worker has ${names.length} version-metadata bindings; at most one is allowed.`,
    );
  }
  return names[0];
}

function readD1Database(
  env: BoundEnv,
  requirements: CloudflareArtifactRequirements,
  migrationsDirectory: string | undefined,
): Record<string, unknown> | undefined {
  if (requirements.d1 === null) {
    if (migrationsDirectory !== undefined) {
      throw new Error('migrationsDirectory was given, but the artifact has no D1 database.');
    }
    return undefined;
  }
  const { binding, migrationsTable } = requirements.d1;
  if (migrationsDirectory === undefined || !isAbsolute(migrationsDirectory)) {
    throw new Error('migrationsDirectory must be an absolute path when the artifact has D1.');
  }
  const entry = Object.hasOwn(env, binding) ? env[binding] : undefined;
  if (entry?.type !== 'd1') {
    throw new Error(`Worker binding ${binding} must be a D1 binding.`);
  }
  if (!entry.name || !entry.id) {
    throw new Error(`Worker D1 binding ${binding} must carry a database name and id.`);
  }
  return {
    binding,
    database_name: entry.name,
    database_id: entry.id,
    migrations_dir: migrationsDirectory,
    migrations_table: migrationsTable,
  };
}

function wranglerRoutes(
  target: CloudflareArtifactTarget,
): Array<{ pattern: string; zone_name: string }> {
  return target.routes.map((route) => ({ pattern: route.pattern, zone_name: route.zoneName }));
}

function writeNewConfig(path: string, config: Record<string, unknown>): void {
  // `wx` fails on an existing path, including a symlink, so no file is overwritten.
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

function readBackConfig(path: string, expected: Record<string, unknown>): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isDeepStrictEqual(parsed, expected)) {
    throw new Error(`${path} does not read back as the config that was written.`);
  }
  return parsed as Record<string, unknown>;
}

function assertPublishedPair(
  generated: Record<string, unknown>,
  root: Record<string, unknown>,
): void {
  for (const [label, config] of [
    ['generated', generated],
    ['root', root],
  ] as const) {
    if (Object.hasOwn(config, 'addresses')) {
      throw new Error(`The ${label} config must not set addresses; omit it to keep Email Routing.`);
    }
  }
  for (const key of SHARED_KEYS) {
    if (!Object.hasOwn(generated, key) || !Object.hasOwn(root, key)) {
      throw new Error(`${key} must be set in both Wrangler-format configs.`);
    }
    if (!isDeepStrictEqual(generated[key], root[key])) {
      throw new Error(`${key} differs between the generated and root configs.`);
    }
  }
  for (const key of Object.keys(root)) {
    if (!ROOT_KEYS.has(key)) {
      throw new Error(`The root config must not set ${key}.`);
    }
  }
}
