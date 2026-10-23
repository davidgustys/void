import { expect, it } from 'vite-plus/test';
import {
  type CloudflareArtifactTarget,
  CloudflareArtifactTargetError,
  parseCloudflareArtifactTarget,
} from '../../src/cli/cf-artifact-target.ts';
import { expectError } from '../helpers/cf-artifact.ts';

const ACCOUNT_ID = '1234567890abcdef1234567890abcdef';
const D1_ID = '6f1c2a4e-9b3d-4c5e-8f70-a1b2c3d4e5f6';
const KV_ID = 'abcdef0123456789abcdef0123456789';
const SECRET = 's3cr3t-VALUE-xyz';
const OVERSIZED_SECRET = `${SECRET}${'~'.repeat(5120)}`;
const LONGEST_HOSTNAME = `${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(57)}.com`;
const TOO_LONG_HOSTNAME = `${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(58)}.com`;

class CloudflareTarget {}

function completeTarget(): CloudflareArtifactTarget {
  return {
    accountId: ACCOUNT_ID,
    workerName: 'talewill-pr-42',
    apiBaseUrl: 'https://api.cloudflare.com/client/v4',
    bindings: {
      DB: { type: 'd1', id: D1_ID, name: 'talewill-db' },
      CACHE: { type: 'kv', id: KV_ID },
      FILES: { type: 'r2', bucket: 'talewill-files', jurisdiction: 'eu' },
      ARCHIVE: { type: 'r2', bucket: 'talewill-archive', jurisdiction: 'fedramp' },
      ASSETS: { type: 'r2', bucket: 'talewill-assets' },
    },
    queues: { email: 'talewill-pr-42-email', jobs: 'jobs' },
    isrCache: { id: 'fedcba9876543210fedcba9876543210' },
    email: {
      projectSlug: 'talewill',
      domain: 'talewill.example',
      send: {
        from: 'hello@talewill.example',
        allowedDestinationAddresses: ['ops@talewill.example', 'dev@talewill.example'],
        allowedSenderAddresses: ['hello@talewill.example', 'noreply@talewill.example'],
      },
    },
    vars: { PUBLIC_SITE: 'https://talewill.example', LOG_LEVEL: 'info' },
    secrets: { API_TOKEN: SECRET },
    routes: [
      { pattern: 'talewill.example/api/*', zoneName: 'talewill.example' },
      { pattern: 'app.talewill.example/*', zoneName: 'talewill.example' },
    ],
    workersDev: true,
    previewUrls: true,
    workersDevSubdomain: 'talewill-team',
    seed: true,
  };
}

function minimalTarget(): CloudflareArtifactTarget {
  return {
    accountId: ACCOUNT_ID,
    workerName: 'talewill',
    bindings: {},
    queues: {},
    secrets: {},
    routes: [],
    workersDev: false,
    previewUrls: false,
    seed: false,
  };
}

/** The minimal target with `changes` applied, as untyped input. */
function minimalWith(changes: Record<string, unknown>): unknown {
  return { ...minimalTarget(), ...changes };
}

function minimalWithout(key: string): unknown {
  const target: Record<string, unknown> = { ...minimalTarget() };
  delete target[key];
  return target;
}

/** An object with `count` entries built by `make`. */
function record<T>(count: number, make: (index: number) => [string, T]): Record<string, T> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => make(index)));
}

/** Replace every leaf under `value` in place, so a result that shares a reference would change. */
function overwriteLeaves(value: object): void {
  for (const key of Object.keys(value)) {
    const child: unknown = Reflect.get(value, key);
    if (typeof child === 'object' && child !== null) {
      overwriteLeaves(child);
    } else {
      Reflect.set(value, key, 'changed');
    }
  }
}

const rejections: Array<[string, Record<string, unknown>, string?]> = [
  ['extra', { extra: true }],
  ['vars', { vars: Object.defineProperty({ PORT: '80' }, 'HIDDEN', { value: 'x' }) }],
  ['apiBaseUrl', { apiBaseUrl: undefined }],
  ['accountId', { accountId: ACCOUNT_ID.toUpperCase() }],
  ['accountId', { accountId: 42 }],
  ['workerName', { workerName: 'bad_name' }],
  ['workerName', { workerName: 'a'.repeat(64) }],
  ['workerName', { workerName: 'talewill-' }],
  ['apiBaseUrl', { apiBaseUrl: '/api' }],
  ['apiBaseUrl', { apiBaseUrl: 'http://api.example.com' }],
  ['apiBaseUrl', { apiBaseUrl: 'https://user:pass@api.example.com' }],
  ['apiBaseUrl', { apiBaseUrl: 'https://api.example.com/?token=1' }],
  ['apiBaseUrl', { apiBaseUrl: 'https://api.example.com/?' }],
  ['apiBaseUrl', { apiBaseUrl: 'https://api.example.com/#top' }],
  [
    'bindings',
    {
      bindings: record(65, (index) => [`KV_${index}`, { type: 'kv', id: KV_ID }]),
    },
  ],
  ['bindings.bad-name', { bindings: { 'bad-name': { type: 'kv', id: KV_ID } } }],
  ['bindings.1DB', { bindings: { '1DB': { type: 'kv', id: KV_ID } } }],
  [
    'bindings.__proto__',
    {
      bindings: JSON.parse(`{"__proto__": {"type": "kv", "id": "${KV_ID}"}}`),
    },
  ],
  ['bindings.constructor', { bindings: { constructor: { type: 'kv', id: KV_ID } } }],
  ['bindings.QUEUE.type', { bindings: { QUEUE: { type: 'queue', id: KV_ID } } }],
  ['bindings.CACHE.type', { bindings: { CACHE: { id: KV_ID } } }],
  ['bindings.DB', { bindings: { DB: [] } }],
  ['bindings', { bindings: [] }],
  [
    'bindings.DB.id',
    { bindings: { DB: { type: 'd1', id: 'local', name: 'orders' } } },
    'placeholder ID was supplied',
  ],
  ['bindings.DB.id', { bindings: { DB: { type: 'd1', id: 'not-a-uuid', name: 'orders' } } }],
  [
    'bindings.DB.name',
    {
      bindings: { DB: { type: 'd1', id: D1_ID, name: 'default' } },
    },
    'placeholder ID was supplied',
  ],
  [
    'bindings.DB.name',
    {
      bindings: { DB: { type: 'd1', id: D1_ID, name: 'my db' } },
    },
  ],
  [
    'bindings.DB.name',
    {
      bindings: { DB: { type: 'd1', id: D1_ID } },
    },
  ],
  [
    'bindings.DB.bucket',
    {
      bindings: {
        DB: { type: 'd1', id: D1_ID, name: 'orders', bucket: 'x' },
      },
    },
  ],
  [
    'bindings.CACHE.id',
    { bindings: { CACHE: { type: 'kv', id: 'local' } } },
    'placeholder ID was supplied',
  ],
  ['bindings.CACHE.id', { bindings: { CACHE: { type: 'kv', id: 'abc' } } }],
  ['bindings.CACHE.name', { bindings: { CACHE: { type: 'kv', id: KV_ID, name: 'cache' } } }],
  [
    'bindings.FILES.bucket',
    { bindings: { FILES: { type: 'r2', bucket: 'default' } } },
    'placeholder ID was supplied',
  ],
  ['bindings.FILES.bucket', { bindings: { FILES: { type: 'r2', bucket: 'a' } } }],
  ['bindings.FILES.bucket', { bindings: { FILES: { type: 'r2', bucket: 'Files' } } }],
  ['bindings.FILES.bucket', { bindings: { FILES: { type: 'r2' } } }],
  [
    'bindings.FILES.jurisdiction',
    {
      bindings: { FILES: { type: 'r2', bucket: 'files', jurisdiction: 'us' } },
    },
  ],
  ['queues', { queues: record(65, (index) => [`q${index}`, `q${index}`]) }],
  ['queues.-jobs', { queues: { '-jobs': 'x-jobs' } }],
  ['queues.email', { queues: { email: 'Talewill-email' } }],
  ['queues.emails', { queues: { emails: 'talewill-pr-42-email' } }],
  ['queues.b', { queues: { 'a-b': 'a-b', b: 'a-b' } }],
  ['queues.email', { queues: { email: 42 } }],
  ['queues', { queues: [] }],
  ['isrCache.id', { isrCache: { id: 'local' } }, 'placeholder ID was supplied'],
  ['isrCache.name', { isrCache: { id: KV_ID, name: 'cache' } }],
  ['isrCache', { isrCache: 'cache-id' }],
  ['email.projectSlug', { email: { projectSlug: 'Talewill', domain: 'talewill.example' } }],
  ['email.projectSlug', { email: { projectSlug: 'a'.repeat(57), domain: 'talewill.example' } }],
  ['email.domain', { email: { projectSlug: 'talewill', domain: 'Talewill.example' } }],
  ['email.domain', { email: { projectSlug: 'talewill', domain: TOO_LONG_HOSTNAME } }],
  [
    'email.region',
    {
      email: { projectSlug: 'talewill', domain: 'talewill.example', region: 'eu' },
    },
  ],
  ['email', { email: new Map() }],
  ['vars', { vars: record(65, (index) => [`V_${index}`, 'x']) }],
  ['vars.__VOID_KEY', { vars: { __VOID_KEY: 'x' } }],
  ['vars.1X', { vars: { '1X': 'x' } }],
  [`vars.${'V'.repeat(129)}`, { vars: { ['V'.repeat(129)]: 'x' } }],
  ['vars.BIG', { vars: { BIG: 'a'.repeat(5121) } }],
  ['vars.BIG', { vars: { BIG: 'é'.repeat(2561) } }],
  ['vars.__proto__', { vars: JSON.parse('{"__proto__": "x"}') }],
  ['vars.constructor', { vars: { constructor: 'x' } }],
  ['vars.PORT', { vars: { PORT: 8080 } }],
  ['vars', { vars: new Map() }],
  ['secrets', { secrets: record(129, (index) => [`S_${index}`, 'x']) }],
  ['secrets.__VOID_KEY', { secrets: { __VOID_KEY: SECRET } }],
  ['secrets.constructor', { secrets: { constructor: SECRET } }],
  [
    'routes',
    {
      routes: Array.from({ length: 21 }, (_, index) => ({
        pattern: `talewill.example/r${index}`,
        zoneName: 'talewill.example',
      })),
    },
  ],
  [
    'routes.0.method',
    {
      routes: [{ pattern: 'talewill.example/x', zoneName: 'talewill.example', method: 'GET' }],
    },
  ],
  ['routes.0', { routes: ['talewill.example/x'] }],
  ['routes.0', { routes: new Array(1) }],
  ['routes', { routes: {} }],
  ['workersDev', { workersDev: 'yes' }],
  ['previewUrls', { previewUrls: 1 }],
  ['seed', { seed: null }],
  ['workersDevSubdomain', { workersDevSubdomain: 'Talewill' }],
];

const secretLeaks: Array<[string, unknown, string]> = [
  ['secrets.TOKEN', minimalWith({ secrets: { TOKEN: '', OTHER: SECRET } }), SECRET],
  [
    'secrets.TOKEN',
    minimalWith({ secrets: { TOKEN: OVERSIZED_SECRET, OTHER: SECRET } }),
    OVERSIZED_SECRET,
  ],
  ['secrets.TOKEN', minimalWith({ secrets: { TOKEN: { value: SECRET }, OTHER: SECRET } }), SECRET],
  ['secrets', minimalWith({ secrets: [SECRET] }), SECRET],
  ['accountId', minimalWith({ accountId: 'not-hex', secrets: { TOKEN: SECRET } }), SECRET],
  ['secrets.TOKEN', minimalWith({ vars: { TOKEN: 'public' }, secrets: { TOKEN: SECRET } }), SECRET],
  [
    'routes.0.pattern',
    minimalWith({
      routes: [{ pattern: 'other.example/x', zoneName: 'talewill.example' }],
      secrets: { TOKEN: SECRET },
    }),
    SECRET,
  ],
  [
    'apiBaseUrl',
    minimalWith({
      apiBaseUrl: `https://user:${SECRET}@api.example.com`,
      secrets: { TOKEN: SECRET },
    }),
    SECRET,
  ],
];

it('parses a complete target into a deep copy', () => {
  const input = completeTarget();
  const result = parseCloudflareArtifactTarget(input);

  expect(result).toStrictEqual(completeTarget());
  expect(result).not.toBe(input);
  expect(result.bindings).not.toBe(input.bindings);
  expect(input).toStrictEqual(completeTarget());

  overwriteLeaves(input);
  expect(result).toStrictEqual(completeTarget());
});

it('parses a minimal target without optional fields', () =>
  expect(parseCloudflareArtifactTarget(minimalTarget())).toStrictEqual({
    accountId: ACCOUNT_ID,
    workerName: 'talewill',
    bindings: {},
    queues: {},
    secrets: {},
    routes: [],
    workersDev: false,
    previewUrls: false,
    seed: false,
  }));

it('accepts every size limit at its maximum', () => {
  expect(LONGEST_HOSTNAME).toHaveLength(253);

  const target = minimalWith({
    workerName: 'a'.repeat(63),
    bindings: record(64, (index) => [`KV_${index}`, { type: 'kv', id: KV_ID }]),
    queues: record(64, (index) => {
      const name = index === 0 ? 'q'.repeat(63) : `q${index}`;
      return [name, name];
    }),
    vars: record(64, (index) => [index === 0 ? 'V'.repeat(128) : `V_${index}`, 'x']),
    secrets: record(128, (index) => [`S_${index}`, index === 0 ? 'é'.repeat(2560) : 'x']),
    email: {
      projectSlug: 'a'.repeat(56),
      domain: LONGEST_HOSTNAME,
      send: {
        from: 'hello@talewill.example',
        allowedDestinationAddresses: Array.from(
          { length: 100 },
          (_, index) => `user${index}@talewill.example`,
        ),
        allowedSenderAddresses: ['hello@talewill.example'],
      },
    },
    routes: Array.from({ length: 20 }, (_, index) => ({
      pattern: `talewill.example/${'a'.repeat(index === 0 ? 200 : 1)}`,
      zoneName: 'talewill.example',
    })),
  });

  expect(() => parseCloudflareArtifactTarget(target)).not.toThrow();
});

it.each(['http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787'])(
  'accepts the loopback test API base URL %s',
  (apiBaseUrl) =>
    expect(parseCloudflareArtifactTarget(minimalWith({ apiBaseUrl })).apiBaseUrl).toBe(apiBaseUrl),
);

function assertRejected(target: unknown, field: string, message?: string): void {
  const error = reject(target);
  expect(error.field).toBe(field);
  expect(error.message).toContain(field);
  expect(error.message).not.toContain('\n');
  if (message !== undefined) {
    expect(error.message).toContain(message);
  }
}
it.each(rejections)('rejects invalid %s', (field, changes, message) =>
  assertRejected(minimalWith(changes), field, message),
);
it.each<[string, unknown, string?]>([
  ['target', null],
  ['target', []],
  ['target', Object.assign(new CloudflareTarget(), minimalTarget())],
  ['__proto__', JSON.parse('{"__proto__": true}')],
  ['target', { ...minimalTarget(), [Symbol('extra')]: true }],
  ['accountId', minimalWithout('accountId')],
  ['seed', minimalWithout('seed')],
  [
    'email.send.allowedSenderAddresses',
    sendTarget({
      from: 'hello@talewill.example',
      allowedDestinationAddresses: ['ops@talewill.example'],
      allowedSenderAddresses: ['other@talewill.example'],
    }),
  ],
  [
    'email.send.from',
    sendTarget({
      from: 'hello@-bad.example',
      allowedDestinationAddresses: ['ops@talewill.example'],
      allowedSenderAddresses: ['hello@-bad.example'],
    }),
  ],
  [
    'email.send.allowedDestinationAddresses',
    sendTarget({
      from: 'hello@talewill.example',
      allowedDestinationAddresses: [],
      allowedSenderAddresses: ['hello@talewill.example'],
    }),
  ],
  [
    'email.send.allowedDestinationAddresses',
    sendTarget({
      from: 'hello@talewill.example',
      allowedDestinationAddresses: Array.from(
        { length: 101 },
        (_, index) => `user${index}@talewill.example`,
      ),
      allowedSenderAddresses: ['hello@talewill.example'],
    }),
  ],
  [
    'email.send.allowedSenderAddresses.1',
    sendTarget({
      from: 'hello@talewill.example',
      allowedDestinationAddresses: ['ops@talewill.example'],
      allowedSenderAddresses: ['hello@talewill.example', 'hello@talewill.example'],
    }),
  ],
  [
    'email.send.allowedDestinationAddresses',
    sendTarget({
      from: 'hello@talewill.example',
      allowedSenderAddresses: ['hello@talewill.example'],
    }),
  ],
  [
    'email.send.replyTo',
    sendTarget({
      from: 'hello@talewill.example',
      allowedDestinationAddresses: ['ops@talewill.example'],
      allowedSenderAddresses: ['hello@talewill.example'],
      replyTo: 'ops@talewill.example',
    }),
  ],
  ['routes.0.pattern', routeTarget('other.example/x')],
  ['routes.0.pattern', routeTarget('eviltalewill.example/x')],
  ['routes.0.pattern', routeTarget('https://talewill.example/x')],
  ['routes.0.pattern', routeTarget('talewill.example:8443/x')],
  ['routes.0.pattern', routeTarget('talewill.example/x?y=1')],
  ['routes.0.pattern', routeTarget('talewill.example/a b')],
  ['routes.0.pattern', routeTarget('talewill.example')],
  ['routes.0.pattern', routeTarget(`talewill.example/${'a'.repeat(201)}`)],
  ['routes.0.zoneName', routeTarget('talewill.example/x', '*.talewill.example')],
])('rejects malformed %s', (field, target, message) => assertRejected(target, field, message));

it.each(secretLeaks)('keeps secret values out of the error for %s', (field, target, secret) => {
  const error = reject(target);
  const serialized = JSON.stringify(error);

  expect(error.field).toBe(field);
  for (let start = 0; start + 3 <= secret.length; start++) {
    const fragment = secret.slice(start, start + 3);
    expect(error.message).not.toContain(fragment);
    expect(error.field).not.toContain(fragment);
    expect(serialized).not.toContain(fragment);
  }
});

function reject(input: unknown): CloudflareArtifactTargetError {
  return expectError(() => parseCloudflareArtifactTarget(input), CloudflareArtifactTargetError);
}

function routeTarget(pattern: string, zoneName = 'talewill.example'): unknown {
  return minimalWith({ routes: [{ pattern, zoneName }] });
}
function sendTarget(send: unknown): unknown {
  return minimalWith({ email: { projectSlug: 'talewill', domain: 'talewill.example', send } });
}
