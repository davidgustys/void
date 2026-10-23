/* oxlint-disable typescript-eslint/no-explicit-any -- these tests break one field of the kitchen-sink config on purpose; `Draft` is the loose shape that keeps each edit readable. */
import { OutputWorkerSchema } from '@cloudflare/config';
import { describe, expect, it } from 'vite-plus/test';
import { CloudflareArtifactError } from '../../src/cli/cf-artifact-files.ts';
import type { CloudflareArtifactRequirements } from '../../src/cli/cf-artifact-schema.ts';
import type { CloudflareArtifactTarget } from '../../src/cli/cf-artifact-target.ts';
import {
  bindCloudflareArtifactWorker,
  type CloudflareWorkerConfig,
} from '../../src/cli/cf-artifact-worker-config.ts';
import { generateQueueResolverSource } from '../../src/queues/dispatch.ts';
import { catchArtifactError, makeRequirements, makeTarget } from '../helpers/cf-artifact.ts';

// Built kitchen-sink config, including the complete module manifest.
const KITCHEN_SINK: unknown = JSON.parse(`
{"name":"playground-kitchen-sink","compatibilityDate":"2026-02-24","compatibilityFlags":["nodejs_compat"],"assets":{"notFoundHandling":"none","runWorkerFirst":["/**"]},"triggers":[{"type":"scheduled","schedule":"* * * * *"},{"type":"queue","name":"demo-queue","maxBatchTimeout":1}],"env":{"__VOID_AI_GATEWAY":{"type":"text","value":"kitchen-sink-gw"},"APP_NAME":{"type":"secret"},"SECRET_KEY":{"type":"secret"},"API_URL":{"type":"secret"},"BETTER_AUTH_SECRET":{"type":"secret"},"DB":{"type":"d1","name":"default","id":"local"},"KV":{"type":"kv","id":"local"},"STORAGE":{"type":"r2","name":"default"},"QUEUE_DEMO_QUEUE":{"type":"queue","name":"demo-queue"},"WsNotificationsWs":{"type":"durable-object","worker":"playground-kitchen-sink","exportName":"WsNotificationsWs"},"AI":{"type":"ai"},"__VOID_VERSION_METADATA":{"type":"version-metadata"},"ASSETS":{"type":"assets"}},"exports":{"WsNotificationsWs":{"type":"durable-object","storage":"sqlite"}},"manifest":{"type":"complete","mainModule":"index.js","modules":{"index.js":{"type":"esm"},"index.js.map":{"type":"sourcemap"},"assets/_default-D4xoUc9r.js":{"type":"esm"},"assets/_default-D4xoUc9r.js.map":{"type":"sourcemap"},"assets/_virtual_void-db-Bbe80Md3.js":{"type":"esm"},"assets/_virtual_void-db-Bbe80Md3.js.map":{"type":"sourcemap"},"assets/ai-Ce-hYkit.js":{"type":"esm"},"assets/ai-Ce-hYkit.js.map":{"type":"sourcemap"},"assets/ai-D7C21TbM.js":{"type":"esm"},"assets/ai-D7C21TbM.js.map":{"type":"sourcemap"},"assets/ai.server-Cj9JcNma.js":{"type":"esm"},"assets/ai.server-Cj9JcNma.js.map":{"type":"sourcemap"},"assets/auth-3sGB0zJ1-Dr8ueavj.js":{"type":"esm"},"assets/auth-3sGB0zJ1-Dr8ueavj.js.map":{"type":"sourcemap"},"assets/auth-Bk6ToW7y.js":{"type":"esm"},"assets/auth-Bk6ToW7y.js.map":{"type":"sourcemap"},"assets/auth-DLM35qdf.js":{"type":"esm"},"assets/auth.server-CspUh1x2.js":{"type":"esm"},"assets/auth.server-CspUh1x2.js.map":{"type":"sourcemap"},"assets/base64-DVrOndmI-CI5uM_Kn.js":{"type":"esm"},"assets/base64-DVrOndmI-CI5uM_Kn.js.map":{"type":"sourcemap"},"assets/bun-sqlite-dialect-DoOVo4ja--mKxuJ_S.js":{"type":"esm"},"assets/bun-sqlite-dialect-DoOVo4ja--mKxuJ_S.js.map":{"type":"sourcemap"},"assets/client-CxaEfiMK.js":{"type":"esm"},"assets/client-CxaEfiMK.js.map":{"type":"sourcemap"},"assets/compiled-query-CtYfz0zI.js":{"type":"esm"},"assets/compiled-query-CtYfz0zI.js.map":{"type":"sourcemap"},"assets/cron-BjCvnPsh.js":{"type":"esm"},"assets/cron-BjCvnPsh.js.map":{"type":"sourcemap"},"assets/cron.server-_EBRRNkB.js":{"type":"esm"},"assets/cron.server-_EBRRNkB.js.map":{"type":"sourcemap"},"assets/d1-sqlite-dialect-m0f01-4z-Be-UIZgu.js":{"type":"esm"},"assets/d1-sqlite-dialect-m0f01-4z-Be-UIZgu.js.map":{"type":"sourcemap"},"assets/db-DsFdyDvb.js":{"type":"esm"},"assets/db-DsFdyDvb.js.map":{"type":"sourcemap"},"assets/db.server-BnhWKPoi.js":{"type":"esm"},"assets/db.server-BnhWKPoi.js.map":{"type":"sourcemap"},"assets/demo-queue-CiYfTRdo.js":{"type":"esm"},"assets/demo-queue-CiYfTRdo.js.map":{"type":"sourcemap"},"assets/dist-By-shSLw.js":{"type":"esm"},"assets/dist-By-shSLw.js.map":{"type":"sourcemap"},"assets/dist-Co8_SzRD.js":{"type":"esm"},"assets/dist-Co8_SzRD.js.map":{"type":"sourcemap"},"assets/dist-EsNJ3FjD.js":{"type":"esm"},"assets/dist-EsNJ3FjD.js.map":{"type":"sourcemap"},"assets/dist-evYDN35Z.js":{"type":"esm"},"assets/dist-evYDN35Z.js.map":{"type":"sourcemap"},"assets/email-J9-B3Gkn.js":{"type":"esm"},"assets/email-J9-B3Gkn.js.map":{"type":"sourcemap"},"assets/env-0jrMQJI_-DcN87vfA.js":{"type":"esm"},"assets/env-0jrMQJI_-DcN87vfA.js.map":{"type":"sourcemap"},"assets/env-D20s8LkK.js":{"type":"esm"},"assets/env-D20s8LkK.js.map":{"type":"sourcemap"},"assets/env-raw-D74P4ebM-TTieJXAO.js":{"type":"esm"},"assets/env-raw-D74P4ebM-TTieJXAO.js.map":{"type":"sourcemap"},"assets/env.server-D_RA3CQc.js":{"type":"esm"},"assets/env.server-D_RA3CQc.js.map":{"type":"sourcemap"},"assets/factory-DCJdCjuD.js":{"type":"esm"},"assets/factory-DCJdCjuD.js.map":{"type":"sourcemap"},"assets/handler-DHWopRt6.js":{"type":"esm"},"assets/handler-DHWopRt6.js.map":{"type":"sourcemap"},"assets/heartbeat-DtlK85LK.js":{"type":"esm"},"assets/heartbeat-DtlK85LK.js.map":{"type":"sourcemap"},"assets/index.server-1lX1Loh5.js":{"type":"esm"},"assets/index.server-1lX1Loh5.js.map":{"type":"sourcemap"},"assets/kv-CaKuKIx7.js":{"type":"esm"},"assets/kv-CaKuKIx7.js.map":{"type":"sourcemap"},"assets/kv-M03vfdFB.js":{"type":"esm"},"assets/kv-M03vfdFB.js.map":{"type":"sourcemap"},"assets/kv.server-Bz4_4R-c.js":{"type":"esm"},"assets/kv.server-Bz4_4R-c.js.map":{"type":"sourcemap"},"assets/kysely-adapter-B5heKps4.js":{"type":"esm"},"assets/layout-BnZ5N22p.js":{"type":"esm"},"assets/layout-BnZ5N22p.js.map":{"type":"sourcemap"},"assets/node-sqlite-dialect-DZHnFVqJ.js":{"type":"esm"},"assets/node-sqlite-dialect-DZHnFVqJ.js.map":{"type":"sourcemap"},"assets/pages-Dce1iMKT.js":{"type":"esm"},"assets/pages-Dce1iMKT.js.map":{"type":"sourcemap"},"assets/postal-mime-DufnbxrP.js":{"type":"esm"},"assets/postal-mime-DufnbxrP.js.map":{"type":"sourcemap"},"assets/profile-DECpWyYX.js":{"type":"esm"},"assets/profile-DECpWyYX.js.map":{"type":"sourcemap"},"assets/queues-DADREwjT.js":{"type":"esm"},"assets/queues-DADREwjT.js.map":{"type":"sourcemap"},"assets/queues.server-ry6_YuGb.js":{"type":"esm"},"assets/queues.server-ry6_YuGb.js.map":{"type":"sourcemap"},"assets/reset-Mp0nYD1I.js":{"type":"esm"},"assets/reset-Mp0nYD1I.js.map":{"type":"sourcemap"},"assets/revalidate-JyQChqCl.js":{"type":"esm"},"assets/revalidate-JyQChqCl.js.map":{"type":"sourcemap"},"assets/revalidate.server-BhB5KSrg.js":{"type":"esm"},"assets/revalidate.server-BhB5KSrg.js.map":{"type":"sourcemap"},"assets/runtime-D1bbcjAg.js":{"type":"esm"},"assets/runtime-D1bbcjAg.js.map":{"type":"sourcemap"},"assets/server-renderer-5aROpwa_.js":{"type":"esm"},"assets/server-renderer-5aROpwa_.js.map":{"type":"sourcemap"},"assets/sqlite-adapter-CiF5HrGj.js":{"type":"esm"},"assets/sqlite-adapter-CiF5HrGj.js.map":{"type":"sourcemap"},"assets/sqlite-introspector-DSCAP82F-CRRnbE_n.js":{"type":"esm"},"assets/sqlite-introspector-DSCAP82F-CRRnbE_n.js.map":{"type":"sourcemap"},"assets/storage-BEBLdV_3.js":{"type":"esm"},"assets/storage-BEBLdV_3.js.map":{"type":"sourcemap"},"assets/storage-wKTiW5ES.js":{"type":"esm"},"assets/storage-wKTiW5ES.js.map":{"type":"sourcemap"},"assets/storage.server-CNJaBB_T.js":{"type":"esm"},"assets/storage.server-CNJaBB_T.js.map":{"type":"sourcemap"},"assets/support__ticket_-OPQ4bNFp.js":{"type":"esm"},"assets/support__ticket_-OPQ4bNFp.js.map":{"type":"sourcemap"},"assets/virtual_void-routes-C4Xp_Xzs.js":{"type":"esm"},"assets/virtual_void-routes-C4Xp_Xzs.js.map":{"type":"sourcemap"}}}}
`);

type Draft = any;

type Fixture = {
  workerConfig: Draft;
  requirements: CloudflareArtifactRequirements;
  target: CloudflareArtifactTarget;
  bundleModules: Array<string>;
};

const SECRET_VALUE = 'sentinel-secret-value-7f3a9c';
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const D1_ID = '6f1c2a4e-9b3d-4c5e-8f70-a1b2c3d4e5f6';
const KV_ID = 'abcdef0123456789abcdef0123456789';
const ISR_ID = 'fedcba9876543210fedcba9876543210';

function baseRequirements(): CloudflareArtifactRequirements {
  return makeRequirements({
    d1: {
      binding: 'DB',
      migrationsTable: 'd1_migrations',
      migrations: ['0001_init.sql'],
      journal: true,
    },
    isrCache: true,
    email: { inbound: true, send: true },
    secrets: ['API_URL', 'APP_NAME', 'BETTER_AUTH_SECRET', 'SECRET_KEY'],
    seed: false,
  });
}

function baseTarget(): CloudflareArtifactTarget {
  return makeTarget({
    accountId: ACCOUNT_ID,
    workerName: 'talewill-pr-42',
    bindings: {
      DB: { type: 'd1', id: D1_ID, name: 'talewill-pr-42-db' },
      KV: { type: 'kv', id: KV_ID },
      STORAGE: { type: 'r2', bucket: 'talewill-pr-42-files', jurisdiction: 'eu' },
    },
    queues: { 'demo-queue': 'talewill-pr-42-demo-queue' },
    isrCache: { id: ISR_ID },
    email: {
      projectSlug: 'talewill',
      domain: 'talewill.example',
      send: {
        from: 'hello@talewill.example',
        allowedDestinationAddresses: ['ops@talewill.example'],
        allowedSenderAddresses: ['hello@talewill.example'],
      },
    },
    secrets: {
      API_URL: SECRET_VALUE,
      APP_NAME: SECRET_VALUE,
      BETTER_AUTH_SECRET: SECRET_VALUE,
      SECRET_KEY: SECRET_VALUE,
    },
    routes: [{ pattern: 'talewill.example/api/*', zoneName: 'talewill.example' }],
    workersDev: false,
    previewUrls: true,
    seed: false,
  });
}

function fixture(): Fixture {
  const workerConfig: Draft = structuredClone(KITCHEN_SINK);
  return {
    workerConfig,
    requirements: baseRequirements(),
    target: baseTarget(),
    bundleModules: Object.keys(workerConfig.manifest.modules),
  };
}

function bind(fx: Fixture) {
  return bindCloudflareArtifactWorker({
    workerConfig: fx.workerConfig,
    requirements: fx.requirements,
    target: fx.target,
    bundleModules: fx.bundleModules,
  });
}

/** The env of a bound config. Zod types it as optional, and a bound config always sets it. */
function envOf(config: CloudflareWorkerConfig): Record<string, any> {
  return config.env ?? {};
}

describe('bindCloudflareArtifactWorker', () => {
  it('binds the kitchen-sink config to the target and removes every placeholder', () => {
    const fx = fixture();
    const { config, versionMetadataBinding, secretNames } = bind(fx);

    expect(config.name).toBe('talewill-pr-42');
    expect(config.compatibilityDate).toBe('2026-02-24');
    expect(config.compatibilityFlags).toEqual(['nodejs_compat']);
    expect(config.assets).toEqual({ notFoundHandling: 'none', runWorkerFirst: ['/**'] });
    expect(config.env).toEqual({
      __VOID_AI_GATEWAY: { type: 'text', value: 'kitchen-sink-gw' },
      API_URL: { type: 'secret' },
      APP_NAME: { type: 'secret' },
      SECRET_KEY: { type: 'secret' },
      BETTER_AUTH_SECRET: { type: 'secret' },
      DB: { type: 'd1', name: 'talewill-pr-42-db', id: D1_ID },
      KV: { type: 'kv', id: KV_ID },
      STORAGE: { type: 'r2', name: 'talewill-pr-42-files', jurisdiction: 'eu' },
      QUEUE_DEMO_QUEUE: { type: 'queue', name: 'talewill-pr-42-demo-queue' },
      WsNotificationsWs: {
        type: 'durable-object',
        worker: 'talewill-pr-42',
        exportName: 'WsNotificationsWs',
      },
      AI: { type: 'ai' },
      __VOID_VERSION_METADATA: { type: 'version-metadata' },
      ASSETS: { type: 'assets' },
      ISR_CACHE: { type: 'kv', id: ISR_ID },
      __VOID_PROJECT_SLUG: { type: 'text', value: 'talewill' },
      __VOID_EMAIL_DOMAIN: { type: 'text', value: 'talewill.example' },
      SEND_EMAIL: {
        type: 'send-email',
        allowedDestinationAddresses: ['ops@talewill.example'],
        allowedSenderAddresses: ['hello@talewill.example'],
      },
      __VOID_EMAIL_FROM: { type: 'text', value: 'hello@talewill.example' },
    });
    expect(config.exports).toEqual({
      WsNotificationsWs: { type: 'durable-object', storage: 'sqlite' },
    });
    expect(config.triggers).toEqual([
      { type: 'scheduled', schedule: '* * * * *' },
      { type: 'queue', name: 'talewill-pr-42-demo-queue', maxBatchTimeout: 1 },
      { type: 'fetch', pattern: 'talewill.example/api/*', zone: 'talewill.example' },
    ]);
    expect(config.manifest).toEqual(fx.workerConfig.manifest);
    expect(config.workersDev).toBe(false);
    expect(config.previewUrls).toBe(true);
    expect(JSON.stringify(config)).not.toMatch(/"(local|default)"/);
    expect(versionMetadataBinding).toBe('__VOID_VERSION_METADATA');
    expect(secretNames).toEqual(['API_URL', 'APP_NAME', 'BETTER_AUTH_SECRET', 'SECRET_KEY']);
    expect(() => OutputWorkerSchema.parse(config)).not.toThrow();
    expect(JSON.stringify({ config, secretNames })).not.toContain(SECRET_VALUE);
  });

  it('drops the artifact routing and sets routing from the target only', () => {
    const fx = fixture();
    fx.workerConfig.domains = [
      'talewill.example',
      { hostname: 'app.talewill.example', production: true, previews: false },
    ];
    fx.workerConfig.workersDev = true;
    fx.workerConfig.previewUrls = false;
    fx.workerConfig.triggers.push(
      { type: 'fetch', pattern: 'talewill.example/*', zone: 'talewill.example' },
      { type: 'email', addresses: ['hi@talewill.example'] },
    );
    const { config } = bind(fx);

    expect(config).not.toHaveProperty('domains');
    expect(config.workersDev).toBe(false);
    expect(config.previewUrls).toBe(true);
    expect(config.triggers).toEqual([
      { type: 'scheduled', schedule: '* * * * *' },
      { type: 'queue', name: 'talewill-pr-42-demo-queue', maxBatchTimeout: 1 },
      { type: 'fetch', pattern: 'talewill.example/api/*', zone: 'talewill.example' },
    ]);
  });

  it('binds observability settings that name no destinations unchanged', () => {
    const fx = fixture();
    fx.workerConfig.observability = {
      enabled: true,
      headSamplingRate: 0.5,
      logs: { enabled: true, headSamplingRate: 0.1, invocationLogs: true, persist: true },
      traces: { enabled: true, headSamplingRate: 0.2, persist: false },
    };
    expect(bind(fx).config.observability).toEqual(fx.workerConfig.observability);
  });

  describe('trusted additions', () => {
    it('replaces an ISR_CACHE the artifact declares with the target cache', () => {
      const fx = fixture();
      fx.workerConfig.env.ISR_CACHE = { type: 'kv', id: 'local' };
      expect(envOf(bind(fx).config).ISR_CACHE).toEqual({ type: 'kv', id: ISR_ID });
    });

    it('adds only the slug and domain for inbound email', () => {
      const fx = fixture();
      fx.requirements.email = { inbound: true, send: false };
      fx.target.email = {
        projectSlug: 'talewill',
        domain: 'talewill.example',
      };
      const { config } = bind(fx);

      const env = envOf(config);
      expect(env.__VOID_PROJECT_SLUG).toEqual({ type: 'text', value: 'talewill' });
      expect(env.__VOID_EMAIL_DOMAIN).toEqual({ type: 'text', value: 'talewill.example' });
      expect(env).not.toHaveProperty('SEND_EMAIL');
      expect(env).not.toHaveProperty('__VOID_EMAIL_FROM');
    });

    it('adds each target variable as text', () => {
      const fx = fixture();
      fx.target.vars = { LOG_LEVEL: 'info' };
      expect(envOf(bind(fx).config).LOG_LEVEL).toEqual({ type: 'text', value: 'info' });
    });
  });

  it.each<[string, (fx: Fixture) => void]>([
    [
      'env.ISR_CACHE',
      (fx) => {
        fx.requirements.isrCache = false;
        fx.target.isrCache = undefined;
        fx.workerConfig.env.ISR_CACHE = { type: 'kv', id: 'local' };
      },
    ],
    [
      'target.isrCache',
      (fx) => {
        fx.requirements.isrCache = false;
      },
    ],
    [
      'target.email',
      (fx) => {
        fx.requirements.email = { inbound: false, send: false };
      },
    ],
    [
      'target.email',
      (fx) => {
        delete fx.target.email;
      },
    ],
    [
      'target.email.send',
      (fx) => {
        delete fx.target.email?.send;
      },
    ],
    [
      'target.email.send',
      (fx) => {
        fx.requirements.email = { inbound: true, send: false };
      },
    ],
  ])('refuses mismatched %s', (field, mutate) => {
    const fx = fixture();
    mutate(fx);
    expect(rejection(fx).message).toContain(field);
  });

  describe('rejections', () => {
    const REJECTIONS: Array<[string, (config: Draft, fx: Fixture) => void]> = [
      [
        'manifest.type',
        (config) => {
          config.manifest.type = 'partial';
          delete config.manifest.modules['index.js'];
        },
      ],
      ['manifest.mainModule', (config) => (config.manifest.modules['index.js'].type = 'cjs')],
      [
        '../escape.js',
        (config, fx) => {
          config.manifest.modules['../escape.js'] = { type: 'esm' };
          fx.bundleModules.push('../escape.js');
        },
      ],
      ['"extra.js"', (_config, fx) => fx.bundleModules.push('extra.js')],
      [
        'index.js.map',
        (_config, fx) =>
          (fx.bundleModules = fx.bundleModules.filter((path) => path !== 'index.js.map')),
      ],
      ['python', (config) => (config.manifest.modules['index.js.map'].type = 'python')],
      [
        'env.MISSING_SECRET',
        (_config, fx) =>
          (fx.requirements.secrets = [...fx.requirements.secrets, 'MISSING_SECRET'].sort()),
      ],
      ['env.DB', (_config, fx) => (fx.requirements.d1 = null)],
      [
        'env.DB',
        (_config, fx) => {
          if (fx.requirements.d1) {
            fx.requirements.d1.binding = 'DATABASE';
          }
        },
      ],
      ['target.bindings.DB', (_config, fx) => delete fx.target.bindings.DB],
      [
        'env.KV',
        (_config, fx) => (fx.target.bindings.KV = { type: 'r2', bucket: 'talewill-pr-42-kv' }),
      ],
      [
        'target.bindings.SPARE',
        (_config, fx) => (fx.target.bindings.SPARE = { type: 'kv', id: KV_ID }),
      ],
      [
        'target.queues.unused',
        (_config, fx) => (fx.target.queues.unused = 'talewill-pr-42-unused'),
      ],
      [
        'triggers[21]',
        (config) => {
          for (let index = 0; index < 20; index++) {
            config.triggers.push({ type: 'scheduled', schedule: '* * * * *' });
          }
        },
      ],
      [
        'triggers[2]',
        (config) => config.triggers.push({ type: 'connect', protocol: 'tcp', port: 22 }),
      ],
      ['triggers[2].name', (config) => config.triggers.push({ type: 'queue', name: 'demo-queue' })],
      [
        'env.FLAG',
        (config, fx) => {
          config.env.FLAG = { type: 'text', value: 'on' };
          fx.target.vars = { FLAG: 'off' };
        },
      ],
      [
        '__proto__',
        (config) =>
          Object.defineProperty(config.env, '__proto__', {
            value: { type: 'secret' },
            enumerable: true,
            configurable: true,
            writable: true,
          }),
      ],
    ];

    it.each(REJECTIONS)('rejects invalid %s', (field, mutate) => {
      const fx = fixture();
      mutate(fx.workerConfig, fx);
      const error = rejection(fx);
      expect(error.code).toBe('worker-config');
      expect(error.message).toContain(field);
      expect(error.message).not.toContain(SECRET_VALUE);
    });
  });

  it.each<[string, Draft, string?]>([
    ['tailConsumers', [{ worker: 'other' }]],
    ['logpush', true],
    ['bogus', 1],
    [
      'env.MAILER',
      {
        type: 'send-email',
        destinationAddress: 'ops@example.com',
      },
    ],
    ['env.HD', { type: 'hyperdrive', id: '00000000000000000000000000000000' }],
    ['env.__VOID_TOKEN', { type: 'text', value: 'x' }],
    ['env.__VOID_EMAIL_FROM', { type: 'text', value: 'a@talewill.example' }],
    ['env.__VOID_AI_BINDING', { type: 'json', value: { a: 1 } }],
    ['env.EXTRA_SECRET', { type: 'secret' }],
    ['env.WsNotificationsWs.worker', 'other-worker', 'env.WsNotificationsWs'],
    ['env.WsNotificationsWs.exportName', 'Missing', 'env.WsNotificationsWs'],
    [
      'exports.WsNotificationsWs',
      {
        type: 'durable-object',
        storage: 'legacy-kv',
      },
      'exports["WsNotificationsWs"]',
    ],
    ['exports.Flow', { type: 'workflow', name: 'flow' }, 'exports["Flow"]'],
    ['triggers.0.schedule', '@daily'],
    ['triggers.1.maxBatchSize', 101],
    ['triggers.1.visibilityTimeoutMs', 1000],
    ['triggers.1.maxConcurrency', null],
    ['triggers.1.deadLetterQueue', 'nowhere'],
    ['limits', { cpuMs: 0 }, 'limits.cpuMs'],
    ['limits', { cpuMs: 50, subrequests: 10 }, 'limits.subrequests'],
    ['env.BIG', { type: 'text', value: 'é'.repeat(2561) }],
    ['env.BIG_JSON', { type: 'json', value: 'x'.repeat(5200) }],
    ['env.__VOID_VERSION_METADATA_2', { type: 'version-metadata' }, 'version-metadata'],
    ['env.QUEUE_DEMO_QUEUE.deliveryDelay', 5, 'env.QUEUE_DEMO_QUEUE'],
    ['compatibilityDate', '2026/02/24'],
    ['compatibilityFlags', ['node compat']],
    ['env.PIPE', { type: 'pipeline', name: 'pipe' }],
    [
      'observability',
      { logs: { enabled: true, destinations: [] } },
      'observability.logs.destinations',
    ],
    [
      'observability',
      { traces: { destinations: ['account-destination'] } },
      'observability.traces.destinations',
    ],
  ])('rejects config field %s', (path, value, field) => {
    const fx = fixture();
    const parts = path.split('.');
    const key = parts.pop()!;
    let parent = fx.workerConfig;
    for (const part of parts) {
      parent = parent[part];
    }
    parent[key] = value;
    const error = rejection(fx);
    expect(error.code).toBe('worker-config');
    expect(error.message).toContain(field ?? path.replace(/\.(\d+)/g, '[$1]'));
    expect(error.message).not.toContain(SECRET_VALUE);
  });

  describe('queue dispatch', () => {
    /** A config whose only triggers are the given consumers, with no producer of the old queue. */
    function queueFixture(consumers: Array<{ logical: string; physical: string }>): Fixture {
      const fx = fixture();
      delete fx.workerConfig.env.QUEUE_DEMO_QUEUE;
      fx.workerConfig.triggers = consumers.map(({ logical }) => ({
        type: 'queue',
        name: logical,
        maxBatchTimeout: 1,
      }));
      fx.target.queues = Object.fromEntries(
        consumers.map(({ logical, physical }) => [logical, physical]),
      );
      return fx;
    }

    // Each row is checked against the runtime resolver, so the local copy cannot drift from it.
    const PARITY: Array<{
      name: string;
      logical: Array<string>;
      physical: Array<string>;
      failsAt: number | undefined;
    }> = [
      {
        name: 'suffix-sharing names',
        logical: ['emails', 'pr-emails'],
        physical: ['app-pr-1-emails', 'app-pr-1-pr-emails'],
        failsAt: undefined,
      },
      {
        name: 'suffix-sharing names in reverse order',
        logical: ['pr-emails', 'emails'],
        physical: ['app-pr-1-pr-emails', 'app-pr-1-emails'],
        failsAt: undefined,
      },
      {
        name: 'a longer name steals a shorter one',
        logical: ['emails', 'pr-emails'],
        physical: ['x-pr-emails', 'app-pr-1-pr-emails'],
        failsAt: 0,
      },
      {
        name: 'a shorter name steals a longer one',
        logical: ['x-emails', 'emails'],
        physical: ['x-emails', 'app-x-emails'],
        failsAt: 1,
      },
      {
        name: 'nested suffixes',
        logical: ['a-b', 'b'],
        physical: ['x-a-b', 'x-b'],
        failsAt: undefined,
      },
      {
        name: 'nested suffixes in reverse order',
        logical: ['b', 'a-b'],
        physical: ['x-b', 'x-a-b'],
        failsAt: undefined,
      },
      {
        name: 'exact names',
        logical: ['emails', 'app-emails'],
        physical: ['emails', 'app-emails'],
        failsAt: undefined,
      },
      {
        name: 'a deep chain',
        logical: ['a', 'b-a', 'c-b-a'],
        physical: ['x-a', 'x-b-a', 'x-c-b-a'],
        failsAt: undefined,
      },
      {
        name: 'a deep chain with a middle consumer stolen',
        logical: ['a', 'b-a', 'c-b-a'],
        physical: ['x-a', 'x-c-b-a', 'y-c-b-a'],
        failsAt: 1,
      },
    ];

    it.each(PARITY)('agrees with the runtime resolver: $name', ({ logical, physical, failsAt }) => {
      // The runtime resolver, evaluated from the source a queue Worker is generated with.
      const resolve = new Function(
        `${generateQueueResolverSource(logical)}\nreturn __resolveQueueIndex;`,
      )() as (name: string) => number;
      const runtimeFailsAt = physical.findIndex((name, index) => resolve(name) !== index);
      expect(runtimeFailsAt === -1 ? undefined : runtimeFailsAt).toBe(failsAt);

      const fx = queueFixture(
        logical.map((name, index) => ({ logical: name, physical: physical[index] })),
      );
      if (failsAt === undefined) {
        expect(() => bind(fx)).not.toThrow();
      } else {
        expect(rejection(fx).message).toContain(`triggers[${failsAt}].name`);
      }
    });
  });

  it('does not mutate the artifact or the target, on success or on rejection', () => {
    const fx = fixture();
    const before = structuredClone(fx);
    bind(fx);
    expect(fx).toEqual(before);

    const failing = fixture();
    failing.workerConfig.logpush = true;
    const beforeFailing = structuredClone(failing);
    rejection(failing);
    expect(failing).toEqual(beforeFailing);
  });
});

function rejection(fx: Fixture): CloudflareArtifactError {
  return catchArtifactError(() => bind(fx));
}
