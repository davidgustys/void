import { OutputWorkerSchema } from '@cloudflare/config';
import { assertCloudflareArtifactPath, CloudflareArtifactError } from './cf-artifact-files.ts';
import type { CloudflareArtifactRequirements } from './cf-artifact-schema.ts';
import type {
  CloudflareArtifactTarget,
  CloudflareArtifactTargetBinding,
} from './cf-artifact-target.ts';

export type CloudflareWorkerConfig = ReturnType<typeof OutputWorkerSchema.parse>;

export type BoundCloudflareArtifactWorker = {
  /** The Worker config to upload, valid under OutputWorkerSchema. */
  config: CloudflareWorkerConfig;
  /** The env key of the version-metadata binding, if any. */
  versionMetadataBinding: string | undefined;
  /** Secret names the uploaded Worker declares, sorted. Values are supplied separately. */
  secretNames: Array<string>;
};

type Parsed = CloudflareWorkerConfig;
type Manifest = NonNullable<Parsed['manifest']>;
type Consumer = { logical: string; physical: string; position: number };
type ExportPlan = { live: ReadonlySet<string>; output: Map<string, unknown> };

/** State shared by the binding steps of one call. */
type Context = {
  target: CloudflareArtifactTarget;
  requirements: CloudflareArtifactRequirements;
  /** The artifact's own Worker name, which durable-object bindings must reference. */
  artifactName: string;
  /** Classes whose export is a live SQLite class. */
  liveClasses: ReadonlySet<string>;
  /** The uploaded env, by binding name. */
  env: Map<string, unknown>;
  /** Target binding names that an env entry has used. */
  usedBindings: Set<string>;
  /** Logical queue names that a producer, consumer or dead-letter queue has used. */
  usedQueues: Set<string>;
  versionMetadataBinding: string | undefined;
  isrCacheBound: boolean;
};

const MAX_SHOWN_LENGTH = 80;
const MAX_VALUE_BYTES = 5120;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const VOID_PREFIX = '__VOID_';
/** The only `__VOID_` names an artifact may set, and only as `text`. */
const ARTIFACT_VOID_TEXT = new Set(['__VOID_AI_BINDING', '__VOID_AI_GATEWAY']);
const COMPATIBILITY_DATE = /^\d{4}-\d{2}-\d{2}$/;
const COMPATIBILITY_FLAG = /^[a-z0-9_]{1,64}$/;
const MAX_COMPATIBILITY_FLAGS = 32;
const MAX_CPU_MS = 300_000;
const MODULE_TYPES = new Set(['esm', 'cjs', 'wasm', 'text', 'data', 'json', 'sourcemap']);
const SCHEDULE = /^[0-9A-Za-z*/,?#\- ]+$/;
const MAX_SCHEDULE_LENGTH = 100;
const MAX_SCHEDULES = 20;
/** Top-level fields the artifact may set. */
const KEPT_KEYS = new Set([
  'name',
  'compatibilityDate',
  'compatibilityFlags',
  'assets',
  'triggers',
  'limits',
  'observability',
  'env',
  'exports',
  'manifest',
]);
/** Top-level fields the artifact may set, which the target replaces. */
const REPLACED_KEYS = new Set(['domains', 'workersDev', 'previewUrls']);
/** Integer ranges for queue consumer settings. */
const QUEUE_RANGES: ReadonlyArray<readonly [string, number, number]> = [
  ['maxBatchSize', 1, 100],
  ['maxBatchTimeout', 0, 60],
  ['maxRetries', 0, 100],
  ['retryDelay', 0, 43_200],
  ['maxConcurrency', 1, 250],
];
const QUEUE_CONSUMER_KEYS = new Set([
  'type',
  'name',
  'deadLetterQueue',
  ...QUEUE_RANGES.map(([key]) => key),
]);
const encoder = new TextEncoder();

/**
 * Validate an untrusted artifact Worker config and bind it to `target`. Throws
 * CloudflareArtifactError with code 'worker-config' when the config is outside what a
 * preview may publish.
 */
export function bindCloudflareArtifactWorker(input: {
  workerConfig: unknown;
  requirements: CloudflareArtifactRequirements;
  target: CloudflareArtifactTarget;
  /** Paths of every file under the artifact's `workers/default/bundle/`, relative to it. */
  bundleModules: ReadonlyArray<string>;
}): BoundCloudflareArtifactWorker {
  const { requirements, target } = input;
  const parsed = parseArtifactWorker(input.workerConfig);
  checkTopLevel(parsed);
  checkScalars(parsed);
  checkObservability(parsed);
  const manifest = checkManifest(parsed.manifest, input.bundleModules);
  const exported = planExports(parsed.exports);
  const ctx: Context = {
    target,
    requirements,
    artifactName: parsed.name,
    liveClasses: exported.live,
    env: new Map(),
    usedBindings: new Set(),
    usedQueues: new Set(),
    versionMetadataBinding: undefined,
    isrCacheBound: false,
  };
  bindArtifactEnv(parsed.env ?? {}, ctx);
  addTrustedEntries(ctx);
  const { triggers, consumers } = bindTriggers(parsed, ctx);
  checkDispatch(consumers);
  checkUsed(ctx);

  const draft = {
    name: target.workerName,
    compatibilityDate: parsed.compatibilityDate,
    ...(parsed.compatibilityFlags === undefined
      ? {}
      : { compatibilityFlags: [...parsed.compatibilityFlags] }),
    ...(parsed.assets === undefined ? {} : { assets: parsed.assets }),
    // Always set, so an empty list replaces the previous triggers instead of keeping them.
    triggers,
    ...(parsed.limits === undefined ? {} : { limits: { cpuMs: parsed.limits.cpuMs } }),
    ...(parsed.observability === undefined ? {} : { observability: parsed.observability }),
    env: Object.fromEntries(ctx.env),
    ...(parsed.exports === undefined ? {} : { exports: Object.fromEntries(exported.output) }),
    manifest,
    workersDev: target.workersDev,
    previewUrls: target.previewUrls,
  };
  const checked = OutputWorkerSchema.safeParse(draft);
  if (!checked.success) {
    const [issue] = checked.error.issues;
    throw configError(issuePath(issue), `fails the output schema: ${clip(issue.message)}`);
  }
  return {
    config: checked.data,
    versionMetadataBinding: ctx.versionMetadataBinding,
    secretNames: [...requirements.secrets].sort(compareCodeUnits),
  };
}

/** Cut `text` to at most 80 characters, marking the cut with "...". */
function clip(text: string): string {
  const characters = Array.from(text);
  return characters.length > MAX_SHOWN_LENGTH
    ? `${characters.slice(0, MAX_SHOWN_LENGTH - 3).join('')}...`
    : text;
}

/** An artifact-supplied value as a message shows it: JSON-quoted, at most 80 characters. */
function quoted(value: string): string {
  return clip(JSON.stringify(value));
}

/** A worker-config error. `path` names the field, and `problem` completes the sentence. */
function configError(path: string, problem: string): CloudflareArtifactError {
  return new CloudflareArtifactError('worker-config', `${path} ${problem}.`, path);
}

/** The field path of an env entry. A name that breaks the rule is shown quoted. */
function envPath(name: string): string {
  return ENV_NAME.test(name) ? clip(`env.${name}`) : `env[${quoted(name)}]`;
}

function issuePath(issue: { path: ReadonlyArray<PropertyKey> }): string {
  return issue.path.length === 0 ? 'The Worker config' : clip(issue.path.map(String).join('.'));
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The keys of `value` that are set. Zod leaves absent optional keys out of its output. */
function setKeys(value: object): Array<string> {
  return Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .map(([key]) => key);
}

/** The entry under `key` when it is an own key, so `constructor` is never an entry. */
function ownEntry<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function utf8Length(text: string): number {
  return encoder.encode(text).byteLength;
}

function isIntegerIn(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * The runtime's queue dispatch, mirroring `__resolveQueueIndex` in
 * `generateQueueResolverSource` (`packages/void/src/queues/dispatch.ts`). Keep the two in step.
 * An exact name wins. Otherwise the unique longest name that `physical` ends with "-" + name
 * wins. A tie or no match gives -1.
 */
function resolveQueueIndex(physical: string, names: ReadonlyArray<string>): number {
  const exact = names.indexOf(physical);
  if (exact !== -1) {
    return exact;
  }
  let match = -1;
  let matchLength = -1;
  for (const [index, name] of names.entries()) {
    if (!physical.endsWith(`-${name}`)) {
      continue;
    }
    if (name.length > matchLength) {
      match = index;
      matchLength = name.length;
    } else if (name.length === matchLength) {
      match = -1;
    }
  }
  return match;
}

/**
 * Reject a `__proto__` key anywhere in the input. Zod drops such a key without an issue, so
 * the entry would vanish from the upload silently.
 */
function assertNoProtoKeys(value: unknown): void {
  const pending: Array<[unknown, string]> = [[value, 'The Worker config']];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [current, path] = next;
    if (typeof current !== 'object' || current === null) {
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      const childPath = Array.isArray(current) ? `${path}[${key}]` : `${path}.${key}`;
      if (key === '__proto__') {
        throw configError(clip(childPath), 'uses the __proto__ key, which is not allowed');
      }
      pending.push([child, childPath]);
    }
  }
}

function parseArtifactWorker(workerConfig: unknown): Parsed {
  assertNoProtoKeys(workerConfig);
  const result = OutputWorkerSchema.safeParse(workerConfig);
  if (result.success) {
    return result.data;
  }
  const [issue] = result.error.issues;
  // The issue message can quote an artifact key, so it is clipped and the value is not shown.
  throw configError(issuePath(issue), `fails the schema: ${clip(issue.message)}`);
}

function checkTopLevel(parsed: Parsed): void {
  for (const key of setKeys(parsed)) {
    if (!KEPT_KEYS.has(key) && !REPLACED_KEYS.has(key)) {
      throw configError(clip(key), 'is not supported in preview artifacts');
    }
  }
}

function checkScalars(parsed: Parsed): void {
  if (!COMPATIBILITY_DATE.test(parsed.compatibilityDate)) {
    throw configError('compatibilityDate', 'must match YYYY-MM-DD');
  }
  if (parsed.compatibilityFlags !== undefined) {
    const flags = parsed.compatibilityFlags;
    if (flags.length > MAX_COMPATIBILITY_FLAGS) {
      throw configError('compatibilityFlags', `must list at most ${MAX_COMPATIBILITY_FLAGS} flags`);
    }
    const seen = new Set<string>();
    for (const flag of flags) {
      if (!COMPATIBILITY_FLAG.test(flag)) {
        throw configError(
          'compatibilityFlags',
          `has the flag ${quoted(flag)}, which is not 1 to 64 lowercase letters, digits or underscores`,
        );
      }
      if (seen.has(flag)) {
        throw configError('compatibilityFlags', `repeats the flag ${quoted(flag)}`);
      }
      seen.add(flag);
    }
  }
  if (parsed.limits !== undefined) {
    for (const key of setKeys(parsed.limits)) {
      if (key !== 'cpuMs') {
        throw configError(`limits.${clip(key)}`, 'is not supported in preview artifacts');
      }
    }
    if (!isIntegerIn(parsed.limits.cpuMs, 1, MAX_CPU_MS)) {
      throw configError('limits.cpuMs', `must be an integer from 1 to ${MAX_CPU_MS}`);
    }
  }
}

/**
 * Log and trace destinations name sinks already configured on the account, so a preview may not
 * send its telemetry there. An empty list counts as set.
 */
function checkObservability(parsed: Parsed): void {
  for (const signal of ['logs', 'traces'] as const) {
    if (parsed.observability?.[signal]?.destinations !== undefined) {
      throw configError(
        `observability.${signal}.destinations`,
        'is not supported in preview artifacts',
      );
    }
  }
}

function checkManifest(
  manifest: Parsed['manifest'],
  bundleModules: ReadonlyArray<string>,
): Manifest {
  if (manifest === undefined) {
    throw configError('manifest', 'is required');
  }
  if (manifest.type !== 'complete') {
    throw configError('manifest.type', 'must be "complete"');
  }
  const main = ownEntry(manifest.modules, manifest.mainModule);
  if (main === undefined) {
    throw configError('manifest.mainModule', 'must name a module in manifest.modules');
  }
  if (main.type !== 'esm') {
    throw configError('manifest.mainModule', 'must name an esm module');
  }
  for (const [path, module] of Object.entries(manifest.modules)) {
    const field = `manifest.modules[${quoted(path)}]`;
    try {
      assertCloudflareArtifactPath(path);
    } catch {
      throw configError(field, 'is not a safe relative path');
    }
    if (!MODULE_TYPES.has(module.type)) {
      throw configError(
        field,
        `has type ${quoted(module.type)}, which preview artifacts do not allow`,
      );
    }
  }
  const bundle = new Set(bundleModules);
  if (bundle.size !== bundleModules.length) {
    throw configError('bundleModules', 'lists a path more than once');
  }
  for (const path of Object.keys(manifest.modules)) {
    if (!bundle.has(path)) {
      throw configError(`manifest.modules[${quoted(path)}]`, 'is listed but not in the bundle');
    }
  }
  for (const path of bundle) {
    if (ownEntry(manifest.modules, path) === undefined) {
      throw configError(`bundle file ${quoted(path)}`, 'is not listed in manifest.modules');
    }
  }
  return manifest;
}

/**
 * Accept only Durable Object exports that preview artifacts may publish: a live SQLite class,
 * a deleted class, or a class renamed to a live one. Returns the live classes and the export
 * entries to upload.
 */
function planExports(exported: Parsed['exports']): ExportPlan {
  const live = new Set<string>();
  const output = new Map<string, unknown>();
  const renamed = new Map<string, string>();
  for (const [name, entry] of Object.entries(exported ?? {})) {
    const path = `exports[${quoted(name)}]`;
    if (entry.type !== 'durable-object') {
      throw configError(path, `must be a durable-object export, not ${quoted(entry.type)}`);
    }
    const shape: Record<string, unknown> = entry;
    if (shape.storage === 'legacy-kv') {
      throw configError(path, 'uses legacy-kv storage, which preview artifacts do not support');
    }
    if (shape.state === undefined && shape.storage === 'sqlite') {
      if (setKeys(entry).some((key) => key !== 'type' && key !== 'storage')) {
        throw configError(path, 'sets fields beyond type and storage, which a live class may not');
      }
      live.add(name);
      output.set(name, { type: 'durable-object', storage: 'sqlite' });
    } else if (shape.state === 'deleted') {
      if (setKeys(entry).some((key) => key !== 'type' && key !== 'state')) {
        throw configError(path, 'sets fields beyond type and state');
      }
      output.set(name, { type: 'durable-object', state: 'deleted' });
    } else if (shape.state === 'renamed') {
      if (setKeys(entry).some((key) => !['type', 'state', 'renamedTo'].includes(key))) {
        throw configError(path, 'sets fields beyond type, state and renamedTo');
      }
      renamed.set(name, String(shape.renamedTo));
    } else {
      throw configError(path, 'uses a state or storage that preview artifacts do not support');
    }
  }
  for (const [name, renamedTo] of renamed) {
    if (!live.has(renamedTo)) {
      throw configError(
        `exports[${quoted(name)}]`,
        `is renamed to ${quoted(renamedTo)}, which is not a live SQLite class in exports`,
      );
    }
    output.set(name, { type: 'durable-object', state: 'renamed', renamedTo });
  }
  return { live, output };
}

/**
 * Rebuild each env entry the artifact declares, from the target. Every identity the artifact
 * carries is dropped, so a placeholder such as `local` never reaches the upload.
 */
function bindArtifactEnv(env: NonNullable<Parsed['env']>, ctx: Context): void {
  const { requirements } = ctx;
  const secrets: Array<string> = [];
  let d1Bound = false;
  for (const [name, binding] of Object.entries(env)) {
    const path = envPath(name);
    if (!ENV_NAME.test(name)) {
      throw configError(
        path,
        'must be letters, digits and underscores, not starting with a digit, at most 128 characters',
      );
    }
    switch (binding.type) {
      case 'text':
      case 'json': {
        if (
          name.startsWith(VOID_PREFIX) &&
          !(binding.type === 'text' && ARTIFACT_VOID_TEXT.has(name))
        ) {
          throw configError(
            path,
            `uses the ${VOID_PREFIX} prefix, which artifacts may use only for __VOID_AI_BINDING and __VOID_AI_GATEWAY, as text`,
          );
        }
        const bytes =
          binding.type === 'text'
            ? utf8Length(binding.value)
            : utf8Length(JSON.stringify(binding.value));
        if (bytes > MAX_VALUE_BYTES) {
          throw configError(path, `is larger than ${MAX_VALUE_BYTES} UTF-8 bytes`);
        }
        ctx.env.set(
          name,
          binding.type === 'text'
            ? { type: 'text', value: binding.value }
            : { type: 'json', value: binding.value },
        );
        break;
      }
      case 'ai':
        ctx.env.set(name, { type: 'ai' });
        break;
      case 'assets':
        ctx.env.set(name, { type: 'assets' });
        break;
      case 'version-metadata':
        // The schema allows one version-metadata binding, so this is the only one.
        ctx.versionMetadataBinding = name;
        ctx.env.set(name, { type: 'version-metadata' });
        break;
      case 'secret':
        secrets.push(name);
        ctx.env.set(name, { type: 'secret' });
        break;
      case 'd1': {
        const d1 = requirements.d1;
        if (d1 === null || d1.binding !== name) {
          throw configError(path, 'is a D1 binding that requirements.d1 does not declare');
        }
        const target = targetBinding(ctx, name, 'd1', path);
        d1Bound = true;
        ctx.env.set(name, { type: 'd1', name: target.name, id: target.id });
        break;
      }
      case 'kv': {
        if (name === 'ISR_CACHE') {
          if (!requirements.isrCache) {
            throw configError(path, 'is an ISR cache, but requirements.isrCache is false');
          }
          if (ctx.target.isrCache === undefined) {
            throw configError(path, 'needs target.isrCache, which the target does not supply');
          }
          ctx.isrCacheBound = true;
          ctx.env.set(name, { type: 'kv', id: ctx.target.isrCache.id });
        } else {
          ctx.env.set(name, { type: 'kv', id: targetBinding(ctx, name, 'kv', path).id });
        }
        break;
      }
      case 'r2': {
        const target = targetBinding(ctx, name, 'r2', path);
        ctx.env.set(
          name,
          target.jurisdiction === undefined
            ? { type: 'r2', name: target.bucket }
            : { type: 'r2', name: target.bucket, jurisdiction: target.jurisdiction },
        );
        break;
      }
      case 'queue': {
        if (binding.deliveryDelay !== undefined) {
          throw configError(path, 'sets deliveryDelay, which preview artifacts do not support');
        }
        if (binding.name === undefined) {
          throw configError(path, 'must name the logical queue it produces to');
        }
        ctx.env.set(name, {
          type: 'queue',
          name: targetQueue(ctx, binding.name, path),
        });
        break;
      }
      case 'durable-object': {
        if (binding.worker !== ctx.artifactName) {
          throw configError(
            path,
            `names another Worker, ${quoted(binding.worker)}; a durable-object binding may only name the artifact's own Worker`,
          );
        }
        if (!ctx.liveClasses.has(binding.exportName)) {
          throw configError(
            path,
            `uses exportName ${quoted(binding.exportName)}, which is not a live SQLite class in exports`,
          );
        }
        ctx.env.set(name, {
          type: 'durable-object',
          worker: ctx.target.workerName,
          exportName: binding.exportName,
        });
        break;
      }
      default:
        throw configError(
          path,
          `has type ${quoted(binding.type)}, which preview artifacts do not support`,
        );
    }
  }
  if (requirements.d1 !== null && !d1Bound) {
    throw configError(
      envPath(requirements.d1.binding),
      'is required by requirements.d1, but the artifact does not declare it',
    );
  }
  for (const name of secrets) {
    if (!requirements.secrets.includes(name)) {
      throw configError(envPath(name), 'is a secret that requirements.secrets does not list');
    }
  }
  for (const name of requirements.secrets) {
    if (!secrets.includes(name)) {
      throw configError(
        envPath(name),
        'is listed in requirements.secrets, but the artifact does not declare it as a secret',
      );
    }
  }
}

/** The target binding for `name`, which must exist with the given type. Marks it used. */
function targetBinding<T extends CloudflareArtifactTargetBinding['type']>(
  ctx: Context,
  name: string,
  type: T,
  path: string,
): Extract<CloudflareArtifactTargetBinding, { type: T }> {
  const binding = ownEntry(ctx.target.bindings, name);
  if (binding === undefined) {
    throw configError(
      path,
      `needs target.bindings.${clip(name)}, which the target does not supply`,
    );
  }
  if (binding.type !== type) {
    throw configError(
      path,
      `needs target.bindings.${clip(name)} to be ${type}, not ${binding.type}`,
    );
  }
  ctx.usedBindings.add(name);
  return binding as Extract<CloudflareArtifactTargetBinding, { type: T }>;
}

/** The physical queue name for a logical one. Marks the logical name used. */
function targetQueue(ctx: Context, logical: string, path: string): string {
  const physical = ownEntry(ctx.target.queues, logical);
  if (physical === undefined) {
    throw configError(path, `needs queue ${quoted(logical)}, which target.queues does not map`);
  }
  ctx.usedQueues.add(logical);
  return physical;
}

function addTrusted(ctx: Context, name: string, binding: unknown): void {
  if (ctx.env.has(name)) {
    throw configError(envPath(name), 'is already set in env, so the target cannot set it again');
  }
  ctx.env.set(name, binding);
}

/** The entries the target adds: ISR cache, email, and plain variables. */
function addTrustedEntries(ctx: Context): void {
  const { requirements, target } = ctx;
  if (!requirements.isrCache && target.isrCache !== undefined) {
    throw configError('target.isrCache', 'is set, but requirements.isrCache is false');
  }
  if (requirements.isrCache && !ctx.isrCacheBound) {
    if (target.isrCache === undefined) {
      throw configError('target.isrCache', 'is required, because requirements.isrCache is true');
    }
    addTrusted(ctx, 'ISR_CACHE', { type: 'kv', id: target.isrCache.id });
  }

  const emailNeeded = requirements.email.inbound || requirements.email.send;
  const email = target.email;
  if (emailNeeded && email === undefined) {
    throw configError('target.email', 'is required, because the app handles or sends email');
  }
  if (!emailNeeded && email !== undefined) {
    throw configError('target.email', 'is set, but the app neither handles nor sends email');
  }
  if (email !== undefined) {
    addTrusted(ctx, '__VOID_PROJECT_SLUG', { type: 'text', value: email.projectSlug });
    addTrusted(ctx, '__VOID_EMAIL_DOMAIN', { type: 'text', value: email.domain });
    if (requirements.email.send) {
      const send = email.send;
      if (send === undefined) {
        throw configError('target.email.send', 'is required, because the app sends email');
      }
      addTrusted(ctx, 'SEND_EMAIL', {
        type: 'send-email',
        allowedDestinationAddresses: [...send.allowedDestinationAddresses],
        allowedSenderAddresses: [...send.allowedSenderAddresses],
      });
      addTrusted(ctx, '__VOID_EMAIL_FROM', { type: 'text', value: send.from });
    } else if (email.send !== undefined) {
      throw configError('target.email.send', 'is set, but the app does not send email');
    }
  }

  for (const [name, value] of Object.entries(target.vars ?? {})) {
    addTrusted(ctx, name, { type: 'text', value });
  }
}

/**
 * The kept triggers, in order, then the target's routes. Scheduled and queue triggers are
 * checked and their queue names are mapped to physical names.
 */
function bindTriggers(
  parsed: Parsed,
  ctx: Context,
): { triggers: Array<unknown>; consumers: Array<Consumer> } {
  const triggers: Array<unknown> = [];
  const consumers: Array<Consumer> = [];
  let scheduled = 0;
  for (const [position, trigger] of (parsed.triggers ?? []).entries()) {
    const path = `triggers[${position}]`;
    if (trigger.type === 'fetch' || trigger.type === 'email') {
      // Routing belongs to the target, so the artifact's fetch and email triggers are dropped.
      continue;
    }
    if (trigger.type === 'scheduled') {
      scheduled += 1;
      if (scheduled > MAX_SCHEDULES) {
        throw configError(path, `is one of more than ${MAX_SCHEDULES} scheduled triggers`);
      }
      if (trigger.schedule.length > MAX_SCHEDULE_LENGTH || !SCHEDULE.test(trigger.schedule)) {
        throw configError(
          `${path}.schedule`,
          `must be at most ${MAX_SCHEDULE_LENGTH} characters of digits, letters, and * / , ? # - or space; got ${quoted(trigger.schedule)}`,
        );
      }
      triggers.push({ type: 'scheduled', schedule: trigger.schedule });
      continue;
    }
    if (trigger.type === 'queue') {
      const fields: Record<string, unknown> = trigger;
      for (const key of setKeys(trigger)) {
        if (!QUEUE_CONSUMER_KEYS.has(key)) {
          throw configError(`${path}.${clip(key)}`, 'is not supported in preview artifacts');
        }
      }
      for (const [key, min, max] of QUEUE_RANGES) {
        if (fields[key] !== undefined && !isIntegerIn(fields[key], min, max)) {
          throw configError(`${path}.${key}`, `must be an integer from ${min} to ${max}`);
        }
      }
      if (consumers.some((consumer) => consumer.logical === trigger.name)) {
        throw configError(`${path}.name`, `repeats the queue consumer ${quoted(trigger.name)}`);
      }
      const physical = targetQueue(ctx, trigger.name, `${path}.name`);
      const entry: Record<string, unknown> = { type: 'queue', name: physical };
      if (trigger.deadLetterQueue !== undefined) {
        entry.deadLetterQueue = targetQueue(
          ctx,
          trigger.deadLetterQueue,
          `${path}.deadLetterQueue`,
        );
      }
      for (const [key] of QUEUE_RANGES) {
        if (fields[key] !== undefined) {
          entry[key] = fields[key];
        }
      }
      consumers.push({ logical: trigger.name, physical, position });
      triggers.push(entry);
      continue;
    }
    throw configError(
      path,
      `has type ${quoted(trigger.type)}, which preview artifacts do not support`,
    );
  }
  for (const route of ctx.target.routes) {
    triggers.push({ type: 'fetch', pattern: route.pattern, zone: route.zoneName });
  }
  return { triggers, consumers };
}

/** Every consumer must be the runtime's handler for its own physical queue name. */
function checkDispatch(consumers: ReadonlyArray<Consumer>): void {
  const names = consumers.map((consumer) => consumer.logical);
  for (const [index, consumer] of consumers.entries()) {
    if (resolveQueueIndex(consumer.physical, names) !== index) {
      throw configError(
        `triggers[${consumer.position}].name`,
        `maps to the physical queue ${quoted(consumer.physical)}, which does not dispatch to its own consumer at runtime`,
      );
    }
  }
}

/** Every target binding and queue must be used, so nothing the target supplies is ignored. */
function checkUsed(ctx: Context): void {
  for (const name of Object.keys(ctx.target.bindings)) {
    if (!ctx.usedBindings.has(name)) {
      throw configError(`target.bindings.${clip(name)}`, 'is not used by any env entry');
    }
  }
  for (const name of Object.keys(ctx.target.queues)) {
    if (!ctx.usedQueues.has(name)) {
      throw configError(
        `target.queues.${clip(name)}`,
        'is not used by any producer, consumer or dead-letter queue',
      );
    }
  }
}
