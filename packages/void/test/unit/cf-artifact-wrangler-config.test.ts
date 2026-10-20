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
import { afterEach, describe, expect, it } from 'vite-plus/test';
import type { CloudflareArtifactRequirements } from '../../src/cli/cf-artifact-schema.ts';
import {
  type CloudflareArtifactTarget,
  parseCloudflareArtifactTarget,
} from '../../src/cli/cf-artifact-target.ts';
import {
  createCloudflareArtifactWranglerConfigs,
  writeCloudflareArtifactWranglerConfigs,
} from '../../src/cli/cf-artifact-wrangler-config.ts';
import { readVersionMetadataBinding } from '../../src/shared/version-metadata.ts';

type BoundWorker = Parameters<typeof createCloudflareArtifactWranglerConfigs>[0]['worker'];

const ACCOUNT_ID = '1234567890abcdef1234567890abcdef';
const WORKER_NAME = 'talewill-pr-42';
const DB_NAME = 'talewill-pr-42-db';
const DB_ID = '0b1f8c2e-1111-4222-8333-944455556666';
const MIGRATIONS_DIR = '/srv/artifact/migrations';
const ROUTE = { pattern: 'pr-42.example.com/*', zoneName: 'example.com' };
const isWindows = process.platform === 'win32';

const roots: Array<string> = [];

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

/** A bound Worker config as the Worker builder produces it: D1, two crons, a queue, one route. */
function boundWorker(overrides: Partial<BoundWorker> = {}): BoundWorker {
  return {
    ...OutputWorkerSchema.parse({
      name: WORKER_NAME,
      compatibilityDate: '2026-02-24',
      compatibilityFlags: ['nodejs_compat'],
      triggers: [
        { type: 'fetch', pattern: ROUTE.pattern, zone: ROUTE.zoneName },
        { type: 'scheduled', schedule: '*/5 * * * *' },
        { type: 'scheduled', schedule: '0 3 * * *' },
        {
          type: 'queue',
          name: 'talewill-pr-42-emails',
          deadLetterQueue: 'talewill-pr-42-dlq',
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

function target(overrides: Record<string, unknown> = {}): CloudflareArtifactTarget {
  return parseCloudflareArtifactTarget({
    accountId: ACCOUNT_ID,
    workerName: WORKER_NAME,
    bindings: { DB: { type: 'd1', id: DB_ID, name: DB_NAME } },
    queues: { emails: 'talewill-pr-42-emails' },
    secrets: {},
    routes: [ROUTE],
    workersDev: false,
    previewUrls: false,
    seed: false,
    ...overrides,
  });
}

function requirements(
  overrides: Partial<CloudflareArtifactRequirements> = {},
): CloudflareArtifactRequirements {
  return {
    d1: {
      binding: 'DB',
      migrationsTable: 'd1_migrations',
      migrations: ['0001_init.sql'],
      journal: true,
    },
    isrCache: false,
    email: { inbound: false, send: false },
    secrets: [],
    seed: false,
    ...overrides,
  };
}

function fullConfigs() {
  return createCloudflareArtifactWranglerConfigs({
    worker: boundWorker(),
    target: target(),
    requirements: requirements(),
    migrationsDirectory: MIGRATIONS_DIR,
  });
}

describe('createCloudflareArtifactWranglerConfigs', () => {
  it('builds exact generated and root configs for a full artifact', () => {
    const { generated, root } = fullConfigs();

    expect(generated).toStrictEqual({
      name: WORKER_NAME,
      account_id: ACCOUNT_ID,
      compatibility_date: '2026-02-24',
      compatibility_flags: ['nodejs_compat'],
      routes: [{ pattern: ROUTE.pattern, zone_name: ROUTE.zoneName }],
      workers_dev: false,
      preview_urls: false,
      triggers: { crons: ['*/5 * * * *', '0 3 * * *'] },
      queues: {
        consumers: [
          {
            queue: 'talewill-pr-42-emails',
            dead_letter_queue: 'talewill-pr-42-dlq',
            max_batch_size: 10,
            max_batch_timeout: 2,
            max_concurrency: 4,
            max_retries: 3,
            retry_delay: 5,
          },
        ],
      },
      workflows: [],
      version_metadata: { binding: '__VOID_VERSION_METADATA' },
    });
    expect(root).toStrictEqual({
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
    expect(Object.hasOwn(generated, 'addresses')).toBe(false);
    expect(Object.hasOwn(root, 'addresses')).toBe(false);
  });

  it('writes a snake_case consumer key only for each field the trigger sets', () => {
    const configs = createCloudflareArtifactWranglerConfigs({
      worker: boundWorker({
        triggers: [
          { type: 'queue', name: 'jobs' },
          { type: 'queue', name: 'mail', maxConcurrency: null, visibilityTimeoutMs: 30_000 },
        ],
      }),
      target: target({ routes: [] }),
      requirements: requirements({ d1: null }),
    });

    expect(configs.generated.queues).toStrictEqual({
      consumers: [{ queue: 'jobs' }, { queue: 'mail', visibility_timeout_ms: 30_000 }],
    });
  });

  it('builds a minimal pair for an app with no D1, triggers, routes or version metadata', () => {
    const configs = createCloudflareArtifactWranglerConfigs({
      worker: OutputWorkerSchema.parse({
        name: WORKER_NAME,
        compatibilityDate: '2026-02-24',
        env: {},
      }),
      target: target({ routes: [], workersDev: true, previewUrls: true }),
      requirements: requirements({ d1: null }),
    });

    expect(configs.generated).toStrictEqual({
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
    expect(configs.root).toStrictEqual({
      name: WORKER_NAME,
      account_id: ACCOUNT_ID,
      routes: [],
      workers_dev: true,
      preview_urls: true,
    });
  });

  describe('rejects inputs it cannot publish faithfully', () => {
    it('a Worker name that differs from the target', () => {
      expect(() =>
        createCloudflareArtifactWranglerConfigs({
          worker: boundWorker({ name: 'other-worker' }),
          target: target(),
          requirements: requirements(),
          migrationsDirectory: MIGRATIONS_DIR,
        }),
      ).toThrow(/does not match target/);
    });

    it('two version-metadata entries', () => {
      expect(() =>
        createCloudflareArtifactWranglerConfigs({
          worker: boundWorker({
            env: {
              DB: { type: 'd1', name: DB_NAME, id: DB_ID },
              __VOID_VERSION_METADATA: { type: 'version-metadata' },
              OTHER_VERSION: { type: 'version-metadata' },
            },
          }),
          target: target(),
          requirements: requirements(),
          migrationsDirectory: MIGRATIONS_DIR,
        }),
      ).toThrow(/at most one/);
    });

    it('fetch triggers whose pattern differs from the target route', () => {
      expect(() =>
        createCloudflareArtifactWranglerConfigs({
          worker: boundWorker({
            triggers: [{ type: 'fetch', pattern: 'other.example.com/*', zone: ROUTE.zoneName }],
          }),
          target: target(),
          requirements: requirements(),
          migrationsDirectory: MIGRATIONS_DIR,
        }),
      ).toThrow(/do not match the target routes/);
    });

    it('fetch triggers whose zone differs from the target route', () => {
      expect(() =>
        createCloudflareArtifactWranglerConfigs({
          worker: boundWorker({
            triggers: [{ type: 'fetch', pattern: ROUTE.pattern, zone: 'other.example.com' }],
          }),
          target: target(),
          requirements: requirements(),
          migrationsDirectory: MIGRATIONS_DIR,
        }),
      ).toThrow(/do not match the target routes/);
    });

    it('a target route the Worker has no fetch trigger for', () => {
      expect(() =>
        createCloudflareArtifactWranglerConfigs({
          worker: boundWorker({ triggers: [] }),
          target: target(),
          requirements: requirements(),
          migrationsDirectory: MIGRATIONS_DIR,
        }),
      ).toThrow(/do not match the target routes/);
    });

    it('a trigger type that has no Wrangler mapping', () => {
      expect(() =>
        createCloudflareArtifactWranglerConfigs({
          worker: boundWorker({
            triggers: [
              { type: 'fetch', pattern: ROUTE.pattern, zone: ROUTE.zoneName },
              { type: 'email', addresses: ['hi@example.com'] },
            ],
          }),
          target: target(),
          requirements: requirements(),
          migrationsDirectory: MIGRATIONS_DIR,
        }),
      ).toThrow(/not part of an artifact publish/);
    });

    it('D1 required but the env entry is missing', () => {
      expect(() =>
        createCloudflareArtifactWranglerConfigs({
          worker: boundWorker({
            env: { __VOID_VERSION_METADATA: { type: 'version-metadata' } },
          }),
          target: target(),
          requirements: requirements(),
          migrationsDirectory: MIGRATIONS_DIR,
        }),
      ).toThrow(/must be a D1 binding/);
    });

    it('D1 required but the env entry has another type', () => {
      expect(() =>
        createCloudflareArtifactWranglerConfigs({
          worker: boundWorker({
            env: { DB: { type: 'kv', id: 'abcdef0123456789abcdef0123456789' } },
          }),
          target: target(),
          requirements: requirements(),
          migrationsDirectory: MIGRATIONS_DIR,
        }),
      ).toThrow(/must be a D1 binding/);
    });

    it('a relative migrationsDirectory', () => {
      expect(() =>
        createCloudflareArtifactWranglerConfigs({
          worker: boundWorker(),
          target: target(),
          requirements: requirements(),
          migrationsDirectory: 'migrations',
        }),
      ).toThrow(/must be an absolute path/);
    });

    it('a migrationsDirectory without D1', () => {
      expect(() =>
        createCloudflareArtifactWranglerConfigs({
          worker: boundWorker(),
          target: target({ routes: [ROUTE] }),
          requirements: requirements({ d1: null }),
          migrationsDirectory: MIGRATIONS_DIR,
        }),
      ).toThrow(/has no D1 database/);
    });
  });
});

describe('writeCloudflareArtifactWranglerConfigs', () => {
  it('is read back by the real trigger, D1 and version-metadata readers', () => {
    const configs = fullConfigs();
    const { generatedPath, rootPath } = writeCloudflareArtifactWranglerConfigs(tempDir(), configs);

    const trigger = readCloudflareTriggerConfig(generatedPath, rootPath);
    expect(trigger.workers_dev).toBe(false);
    expect(trigger.preview_urls).toBe(false);
    expect(trigger.routes).toStrictEqual([{ pattern: ROUTE.pattern, zone_name: ROUTE.zoneName }]);
    expect(trigger.crons).toStrictEqual(['*/5 * * * *', '0 3 * * *']);
    expect(trigger.queueConsumers).toStrictEqual([
      {
        queue: 'talewill-pr-42-emails',
        dead_letter_queue: 'talewill-pr-42-dlq',
        max_batch_size: 10,
        max_batch_timeout: 2,
        max_concurrency: 4,
        max_retries: 3,
        retry_delay: 5,
      },
    ]);
    expect(trigger.preserveRoutes).toBeUndefined();
    expect(trigger.preserveWorkersDev).toBeUndefined();
    expect(trigger.preservePreviewUrls).toBeUndefined();
    expect(trigger.addresses).toBeUndefined();

    expect(readVersionMetadataBinding(parseRootWranglerConfig(generatedPath))).toBe(
      '__VOID_VERSION_METADATA',
    );
    expect(resolveD1MigrateTarget(parseRootWranglerConfig(rootPath), 'DB')).toStrictEqual({
      ok: true,
      token: DB_NAME,
    });
  });

  it('writes both files and returns their absolute paths', () => {
    const dir = tempDir();
    const { generatedPath, rootPath } = writeCloudflareArtifactWranglerConfigs(dir, fullConfigs());

    expect(generatedPath).toBe(join(dir, 'generated.wrangler.json'));
    expect(rootPath).toBe(join(dir, 'root.wrangler.json'));
    expect(JSON.parse(readFileSync(generatedPath, 'utf8'))).toStrictEqual(fullConfigs().generated);
    expect(JSON.parse(readFileSync(rootPath, 'utf8'))).toStrictEqual(fullConfigs().root);
  });

  it.skipIf(isWindows)('writes both files with mode 0o600', () => {
    const dir = tempDir();
    const { generatedPath, rootPath } = writeCloudflareArtifactWranglerConfigs(dir, fullConfigs());

    expect(statSync(generatedPath).mode & 0o777).toBe(0o600);
    expect(statSync(rootPath).mode & 0o777).toBe(0o600);
  });

  it.skipIf(isWindows)('refuses a symlinked directory', () => {
    const real = tempDir();
    const link = join(tempDir(), 'link');
    symlinkSync(real, link);

    expect(() => writeCloudflareArtifactWranglerConfigs(link, fullConfigs())).toThrow(
      /real directory/,
    );
    expect(existsSync(join(real, 'generated.wrangler.json'))).toBe(false);
  });

  it('refuses a missing directory', () => {
    expect(() =>
      writeCloudflareArtifactWranglerConfigs(join(tempDir(), 'missing'), fullConfigs()),
    ).toThrow(/ENOENT/);
  });

  it('refuses to overwrite an existing generated file', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'generated.wrangler.json'), 'keep me');

    expect(() => writeCloudflareArtifactWranglerConfigs(dir, fullConfigs())).toThrow(/EEXIST/);
    expect(readFileSync(join(dir, 'generated.wrangler.json'), 'utf8')).toBe('keep me');
    expect(existsSync(join(dir, 'root.wrangler.json'))).toBe(false);
  });

  it('removes the generated file it created when the root file already exists', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'root.wrangler.json'), 'keep me');

    expect(() => writeCloudflareArtifactWranglerConfigs(dir, fullConfigs())).toThrow(/EEXIST/);
    expect(existsSync(join(dir, 'generated.wrangler.json'))).toBe(false);
    expect(readFileSync(join(dir, 'root.wrangler.json'), 'utf8')).toBe('keep me');
  });

  it('refuses a root config that carries trigger fields', () => {
    const configs = fullConfigs();

    expect(() =>
      writeCloudflareArtifactWranglerConfigs(tempDir(), {
        generated: configs.generated,
        root: { ...configs.root, triggers: { crons: [] } },
      }),
    ).toThrow(/root config must not set triggers/);
  });

  it('refuses addresses in either config', () => {
    const configs = fullConfigs();

    expect(() =>
      writeCloudflareArtifactWranglerConfigs(tempDir(), {
        generated: { ...configs.generated, addresses: ['hi@example.com'] },
        root: configs.root,
      }),
    ).toThrow(/must not set addresses/);
  });

  it('refuses a name that differs between the two configs', () => {
    const configs = fullConfigs();

    expect(() =>
      writeCloudflareArtifactWranglerConfigs(tempDir(), {
        generated: configs.generated,
        root: { ...configs.root, name: 'other-worker' },
      }),
    ).toThrow(/name differs/);
  });
});
