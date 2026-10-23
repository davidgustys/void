import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutputWorkerSchema } from '@cloudflare/config';
import {
  parseRootWranglerConfig,
  readCloudflareTriggerConfig,
  resolveD1MigrateTarget,
} from '@void/deploy-cloudflare';
import { afterEach, expect, it } from 'vite-plus/test';
import {
  createCloudflareArtifactWranglerConfigs,
  writeCloudflareArtifactWranglerConfigs,
} from '../../src/cli/cf-artifact-wrangler-config.ts';
import { readVersionMetadataBinding } from '../../src/shared/version-metadata.ts';
import { makeRequirements, makeTarget } from '../helpers/cf-artifact.ts';

type Input = Parameters<typeof createCloudflareArtifactWranglerConfigs>[0];
type Worker = Input['worker'];
const ACCOUNT_ID = '1234567890abcdef1234567890abcdef';
const WORKER_NAME = 'acmeapps-pr-42';
const DB_NAME = 'acmeapps-pr-42-db';
const DB_ID = '0b1f8c2e-1111-4222-8333-944455556666';
const MIGRATIONS_DIR = '/srv/artifact/migrations';
const ROUTE = { pattern: 'pr-42.example.com/*', zoneName: 'example.com' };
const FETCH = { type: 'fetch' as const, pattern: ROUTE.pattern, zone: ROUTE.zoneName };
const CONSUMER = {
  queue: 'acmeapps-pr-42-emails',
  dead_letter_queue: 'acmeapps-pr-42-dlq',
  max_batch_size: 10,
  max_batch_timeout: 2,
  max_concurrency: 4,
  max_retries: 3,
  retry_delay: 5,
};
const roots: Array<string> = [];
const isWindows = process.platform === 'win32';

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-artifact-wrangler-'));
  roots.push(root);
  return root;
}
function worker(overrides: Partial<Worker> = {}): Worker {
  return {
    ...OutputWorkerSchema.parse({
      name: WORKER_NAME,
      compatibilityDate: '2026-02-24',
      compatibilityFlags: ['nodejs_compat'],
      triggers: [
        FETCH,
        { type: 'scheduled', schedule: '*/5 * * * *' },
        { type: 'scheduled', schedule: '0 3 * * *' },
        {
          type: 'queue',
          name: 'acmeapps-pr-42-emails',
          deadLetterQueue: 'acmeapps-pr-42-dlq',
          maxBatchSize: 10,
          maxBatchTimeout: 2,
          maxConcurrency: 4,
          maxRetries: 3,
          retryDelay: 5,
        },
      ],
      env: {
        DB: { type: 'd1', name: DB_NAME, id: DB_ID },
        __VOID_VERSION_METADATA: { type: 'version-metadata' },
      },
    }),
    ...overrides,
  };
}
function input(overrides: Partial<Input> = {}): Input {
  return {
    worker: worker(),
    target: makeTarget({
      accountId: ACCOUNT_ID,
      workerName: WORKER_NAME,
      bindings: { DB: { type: 'd1', id: DB_ID, name: DB_NAME } },
      queues: { emails: 'acmeapps-pr-42-emails' },
      secrets: {},
      routes: [ROUTE],
      workersDev: false,
      previewUrls: false,
      seed: false,
    }),
    requirements: makeRequirements({ secrets: [], seed: false }),
    migrationsDirectory: MIGRATIONS_DIR,
    ...overrides,
  };
}
function configs(overrides: Partial<Input> = {}) {
  return createCloudflareArtifactWranglerConfigs(input(overrides));
}

it('writes exact configs that the real trigger, D1 and version-metadata readers consume', () => {
  const result = configs();
  expect(result.generated).toStrictEqual({
    name: WORKER_NAME,
    account_id: ACCOUNT_ID,
    compatibility_date: '2026-02-24',
    compatibility_flags: ['nodejs_compat'],
    routes: [{ pattern: ROUTE.pattern, zone_name: ROUTE.zoneName }],
    workers_dev: false,
    preview_urls: false,
    triggers: { crons: ['*/5 * * * *', '0 3 * * *'] },
    queues: { consumers: [CONSUMER] },
    workflows: [],
    version_metadata: { binding: '__VOID_VERSION_METADATA' },
  });
  expect(result.root).toStrictEqual({
    name: WORKER_NAME,
    account_id: ACCOUNT_ID,
    routes: [{ pattern: ROUTE.pattern, zone_name: ROUTE.zoneName }],
    workers_dev: false,
    preview_urls: false,
    d1_databases: [
      {
        binding: 'DB',
        database_name: DB_NAME,
        database_id: DB_ID,
        migrations_dir: MIGRATIONS_DIR,
        migrations_table: 'd1_migrations',
      },
    ],
  });
  const { generatedPath, rootPath } = writeCloudflareArtifactWranglerConfigs(tempDir(), result);
  const trigger = readCloudflareTriggerConfig(generatedPath, rootPath);
  expect(trigger).toMatchObject({
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: ROUTE.pattern, zone_name: ROUTE.zoneName }],
    crons: ['*/5 * * * *', '0 3 * * *'],
    queueConsumers: [CONSUMER],
  });
  for (const key of ['preserveRoutes', 'preserveWorkersDev', 'preservePreviewUrls', 'addresses']) {
    expect(trigger).not.toHaveProperty(key, expect.anything());
  }
  expect(readVersionMetadataBinding(parseRootWranglerConfig(generatedPath))).toBe(
    '__VOID_VERSION_METADATA',
  );
  expect(resolveD1MigrateTarget(parseRootWranglerConfig(rootPath), 'DB')).toStrictEqual({
    ok: true,
    token: DB_NAME,
  });
  expect(JSON.parse(readFileSync(generatedPath, 'utf8'))).toEqual(result.generated);
  expect(JSON.parse(readFileSync(rootPath, 'utf8'))).toEqual(result.root);
  if (!isWindows) {
    expect(statSync(generatedPath).mode & 0o777).toBe(0o600);
    expect(statSync(rootPath).mode & 0o777).toBe(0o600);
  }
});

it.each([
  { observability: undefined, expected: undefined },
  { observability: { enabled: false }, expected: { enabled: false } },
  {
    observability: {
      enabled: true,
      headSamplingRate: 0.5,
      redactQueryString: true,
      issues: { enabled: false },
      logs: { enabled: true, headSamplingRate: 0.1, invocationLogs: false, persist: true },
      traces: { enabled: true, headSamplingRate: 0.2, persist: false },
    },
    expected: {
      enabled: true,
      head_sampling_rate: 0.5,
      redact_query_string: true,
      issues: { enabled: false },
      logs: { enabled: true, head_sampling_rate: 0.1, invocation_logs: false, persist: true },
      traces: { enabled: true, head_sampling_rate: 0.2, persist: false },
    },
  },
])(
  'includes only explicit observability in the trigger snapshot: %j',
  ({ observability, expected }) => {
    const result = configs({ worker: worker({ observability }) });
    const { generatedPath, rootPath } = writeCloudflareArtifactWranglerConfigs(tempDir(), result);

    expect(readCloudflareTriggerConfig(generatedPath, rootPath).observability).toEqual(expected);
    if (observability === undefined) {
      expect(result.generated).not.toHaveProperty('observability');
    }
  },
);

it('maps only queue fields with values to snake_case', () => {
  const result = configs({
    worker: worker({
      triggers: [
        { type: 'queue', name: 'jobs' },
        { type: 'queue', name: 'mail', maxConcurrency: null, visibilityTimeoutMs: 30_000 },
      ],
    }),
    target: { ...input().target, routes: [] },
    requirements: makeRequirements({ d1: null }),
    migrationsDirectory: undefined,
  });
  expect(result.generated.queues).toStrictEqual({
    consumers: [{ queue: 'jobs' }, { queue: 'mail', visibility_timeout_ms: 30_000 }],
  });
});

it('emits minimal configs without D1, triggers, routes or version metadata', () => {
  const result = configs({
    worker: OutputWorkerSchema.parse({
      name: WORKER_NAME,
      compatibilityDate: '2026-02-24',
      env: {},
    }),
    target: { ...input().target, routes: [], workersDev: true, previewUrls: true },
    requirements: makeRequirements({ d1: null }),
    migrationsDirectory: undefined,
  });
  expect(result.generated).toStrictEqual({
    name: WORKER_NAME,
    account_id: ACCOUNT_ID,
    compatibility_date: '2026-02-24',
    routes: [],
    workers_dev: true,
    preview_urls: true,
    triggers: { crons: [] },
    queues: { consumers: [] },
    workflows: [],
  });
  expect(result.root).toStrictEqual({
    name: WORKER_NAME,
    account_id: ACCOUNT_ID,
    routes: [],
    workers_dev: true,
    preview_urls: true,
  });
});

it.each<[string, Partial<Worker>, RegExp]>([
  ['name mismatch', { name: 'other-worker' }, /does not match target/],
  [
    'duplicate version metadata',
    {
      env: {
        __VOID_VERSION_METADATA: { type: 'version-metadata' },
        OTHER_VERSION: { type: 'version-metadata' },
      },
    },
    /at most one/,
  ],
  [
    'different route',
    { triggers: [{ ...FETCH, pattern: 'other.example.com/*' }] },
    /do not match the target routes/,
  ],
  [
    'different zone',
    { triggers: [{ ...FETCH, zone: 'other.example.com' }] },
    /do not match the target routes/,
  ],
  ['missing fetch trigger', { triggers: [] }, /do not match the target routes/],
  [
    'unmapped trigger',
    { triggers: [FETCH, { type: 'email', addresses: ['hi@example.com'] }] },
    /not part of an artifact publish/,
  ],
  ['missing D1', { env: {} }, /must be a D1 binding/],
  [
    'wrong D1 type',
    { env: { DB: { type: 'kv', id: 'abcdef0123456789abcdef0123456789' } } },
    /must be a D1 binding/,
  ],
])('refuses %s', (_name, overrides, message) => {
  expect(() => configs({ worker: worker(overrides) })).toThrow(message);
});

it.each<[Partial<Input>, RegExp]>([
  [{ migrationsDirectory: 'migrations' }, /must be an absolute path/],
  [{ requirements: makeRequirements({ d1: null }) }, /has no D1 database/],
])('refuses invalid migration config %j', (overrides, message) => {
  expect(() => configs(overrides)).toThrow(message);
});

it.skipIf(isWindows)('refuses a symlinked output directory', () => {
  const real = tempDir();
  const link = join(tempDir(), 'link');
  symlinkSync(real, link);
  expect(() => writeCloudflareArtifactWranglerConfigs(link, configs())).toThrow(/real directory/);
  expect(existsSync(join(real, 'generated.wrangler.json'))).toBe(false);
});

it('refuses a missing output directory', () => {
  expect(() =>
    writeCloudflareArtifactWranglerConfigs(join(tempDir(), 'missing'), configs()),
  ).toThrow(/ENOENT/);
});

it.each(['generated', 'root'])(
  'preserves an existing %s file and removes partial writes',
  (existing) => {
    const dir = tempDir();
    const file = join(dir, `${existing}.wrangler.json`);
    const other = join(dir, `${existing === 'root' ? 'generated' : 'root'}.wrangler.json`);
    writeFileSync(file, 'keep me');
    expect(() => writeCloudflareArtifactWranglerConfigs(dir, configs())).toThrow(/EEXIST/);
    expect(readFileSync(file, 'utf8')).toBe('keep me');
    expect(existsSync(other)).toBe(false);
  },
);

it.each<[Record<string, unknown>, Record<string, unknown>, RegExp]>([
  [{}, { triggers: { crons: [] } }, /root config must not set triggers/],
  [{ addresses: ['hi@example.com'] }, {}, /must not set addresses/],
  [{}, { addresses: ['hi@example.com'] }, /must not set addresses/],
  [{}, { name: 'other-worker' }, /name differs/],
])('refuses unsafe writer config %j %j', (generated, root, message) => {
  const result = configs();
  expect(() =>
    writeCloudflareArtifactWranglerConfigs(tempDir(), {
      generated: { ...result.generated, ...generated },
      root: { ...result.root, ...root },
    }),
  ).toThrow(message);
});
