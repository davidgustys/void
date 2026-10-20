import { expect, it } from 'vite-plus/test';
import {
  type CloudflareArtifactTarget,
  CloudflareArtifactTargetError,
  parseCloudflareArtifactTarget,
} from '../../src/cli/cf-artifact-target.ts';

const ACCOUNT_ID = '1234567890abcdef1234567890abcdef';
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
      DB: { type: 'd1', id: '6f1c2a4e-9b3d-4c5e-8f70-a1b2c3d4e5f6', name: 'talewill-db' },
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

/** Parse `input` and return the error it throws. Any other throw fails the test. */
function expectRejection(input: unknown): CloudflareArtifactTargetError {
  try {
    parseCloudflareArtifactTarget(input);
  } catch (error) {
    if (error instanceof CloudflareArtifactTargetError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the target to be rejected.');
}

/** Every three-character slice of `value`. A leaked part of a secret shows up as one of these. */
function fragmentsOf(value: string): Set<string> {
  const fragments = new Set<string>();
  for (let start = 0; start + 3 <= value.length; start++) {
    fragments.add(value.slice(start, start + 3));
  }
  return fragments;
}

const rejections: Array<{ name: string; target: unknown; field: string; message?: string }> = [
  { name: 'a non-object target', target: null, field: 'target' },
  { name: 'an array instead of a target', target: [], field: 'target' },
  {
    name: 'a class instance instead of a plain target',
    target: Object.assign(new CloudflareTarget(), minimalTarget()),
    field: 'target',
  },
  {
    name: 'a __proto__ key at the top level',
    target: JSON.parse('{"__proto__": true}'),
    field: '__proto__',
  },
  { name: 'an unknown top-level key', target: minimalWith({ extra: true }), field: 'extra' },
  {
    name: 'a symbol key on the target',
    target: { ...minimalTarget(), [Symbol('extra')]: true },
    field: 'target',
  },
  {
    name: 'a hidden non-enumerable key on vars',
    target: minimalWith({ vars: Object.defineProperty({ PORT: '80' }, 'HIDDEN', { value: 'x' }) }),
    field: 'vars',
  },
  { name: 'a missing account ID', target: minimalWithout('accountId'), field: 'accountId' },
  { name: 'a missing seed flag', target: minimalWithout('seed'), field: 'seed' },
  {
    name: 'an optional key set to undefined',
    target: minimalWith({ apiBaseUrl: undefined }),
    field: 'apiBaseUrl',
  },

  {
    name: 'an upper-case account ID',
    target: minimalWith({ accountId: ACCOUNT_ID.toUpperCase() }),
    field: 'accountId',
  },
  { name: 'a non-string account ID', target: minimalWith({ accountId: 42 }), field: 'accountId' },
  {
    name: 'a worker name with an underscore',
    target: minimalWith({ workerName: 'bad_name' }),
    field: 'workerName',
  },
  {
    name: 'a worker name over 63 characters',
    target: minimalWith({ workerName: 'a'.repeat(64) }),
    field: 'workerName',
  },
  {
    name: 'a worker name ending in a hyphen',
    target: minimalWith({ workerName: 'talewill-' }),
    field: 'workerName',
  },

  {
    name: 'a relative API base URL',
    target: minimalWith({ apiBaseUrl: '/api' }),
    field: 'apiBaseUrl',
  },
  {
    name: 'an insecure non-loopback API base URL',
    target: minimalWith({ apiBaseUrl: 'http://api.example.com' }),
    field: 'apiBaseUrl',
  },
  {
    name: 'an API base URL with a password',
    target: minimalWith({ apiBaseUrl: 'https://user:pass@api.example.com' }),
    field: 'apiBaseUrl',
  },
  {
    name: 'an API base URL with a query',
    target: minimalWith({ apiBaseUrl: 'https://api.example.com/?token=1' }),
    field: 'apiBaseUrl',
  },
  {
    name: 'an API base URL with an empty query',
    target: minimalWith({ apiBaseUrl: 'https://api.example.com/?' }),
    field: 'apiBaseUrl',
  },
  {
    name: 'an API base URL with a fragment',
    target: minimalWith({ apiBaseUrl: 'https://api.example.com/#top' }),
    field: 'apiBaseUrl',
  },

  {
    name: 'more than 64 bindings',
    target: minimalWith({
      bindings: record(65, (index) => [`KV_${index}`, { type: 'kv', id: KV_ID }]),
    }),
    field: 'bindings',
  },
  {
    name: 'a binding name that is not an identifier',
    target: minimalWith({ bindings: { 'bad-name': { type: 'kv', id: KV_ID } } }),
    field: 'bindings.bad-name',
  },
  {
    name: 'a binding name starting with a digit',
    target: minimalWith({ bindings: { '1DB': { type: 'kv', id: KV_ID } } }),
    field: 'bindings.1DB',
  },
  {
    name: 'a binding named __proto__',
    target: minimalWith({
      bindings: JSON.parse(`{"__proto__": {"type": "kv", "id": "${KV_ID}"}}`),
    }),
    field: 'bindings.__proto__',
  },
  {
    name: 'a binding named constructor',
    target: minimalWith({ bindings: { constructor: { type: 'kv', id: KV_ID } } }),
    field: 'bindings.constructor',
  },
  {
    name: 'a binding of an unknown type',
    target: minimalWith({ bindings: { QUEUE: { type: 'queue', id: KV_ID } } }),
    field: 'bindings.QUEUE.type',
  },
  {
    name: 'a binding with no type',
    target: minimalWith({ bindings: { CACHE: { id: KV_ID } } }),
    field: 'bindings.CACHE.type',
  },
  {
    name: 'a binding that is an array',
    target: minimalWith({ bindings: { DB: [] } }),
    field: 'bindings.DB',
  },
  {
    name: 'bindings given as an array',
    target: minimalWith({ bindings: [] }),
    field: 'bindings',
  },
  {
    name: 'a D1 placeholder ID',
    target: minimalWith({ bindings: { DB: { type: 'd1', id: 'local', name: 'orders' } } }),
    field: 'bindings.DB.id',
    message: 'placeholder ID was supplied',
  },
  {
    name: 'a D1 ID that is not a UUID',
    target: minimalWith({ bindings: { DB: { type: 'd1', id: 'not-a-uuid', name: 'orders' } } }),
    field: 'bindings.DB.id',
  },
  {
    name: 'a D1 placeholder name',
    target: minimalWith({
      bindings: { DB: { type: 'd1', id: '6f1c2a4e-9b3d-4c5e-8f70-a1b2c3d4e5f6', name: 'default' } },
    }),
    field: 'bindings.DB.name',
    message: 'placeholder ID was supplied',
  },
  {
    name: 'a D1 name with a space',
    target: minimalWith({
      bindings: { DB: { type: 'd1', id: '6f1c2a4e-9b3d-4c5e-8f70-a1b2c3d4e5f6', name: 'my db' } },
    }),
    field: 'bindings.DB.name',
  },
  {
    name: 'a D1 binding missing its name',
    target: minimalWith({
      bindings: { DB: { type: 'd1', id: '6f1c2a4e-9b3d-4c5e-8f70-a1b2c3d4e5f6' } },
    }),
    field: 'bindings.DB.name',
  },
  {
    name: 'a D1 binding with a key that belongs to R2',
    target: minimalWith({
      bindings: {
        DB: { type: 'd1', id: '6f1c2a4e-9b3d-4c5e-8f70-a1b2c3d4e5f6', name: 'orders', bucket: 'x' },
      },
    }),
    field: 'bindings.DB.bucket',
  },
  {
    name: 'a KV placeholder ID',
    target: minimalWith({ bindings: { CACHE: { type: 'kv', id: 'local' } } }),
    field: 'bindings.CACHE.id',
    message: 'placeholder ID was supplied',
  },
  {
    name: 'a KV ID of the wrong length',
    target: minimalWith({ bindings: { CACHE: { type: 'kv', id: 'abc' } } }),
    field: 'bindings.CACHE.id',
  },
  {
    name: 'a KV binding with an extra key',
    target: minimalWith({ bindings: { CACHE: { type: 'kv', id: KV_ID, name: 'cache' } } }),
    field: 'bindings.CACHE.name',
  },
  {
    name: 'an R2 placeholder bucket',
    target: minimalWith({ bindings: { FILES: { type: 'r2', bucket: 'default' } } }),
    field: 'bindings.FILES.bucket',
    message: 'placeholder ID was supplied',
  },
  {
    name: 'an R2 bucket that is too short',
    target: minimalWith({ bindings: { FILES: { type: 'r2', bucket: 'a' } } }),
    field: 'bindings.FILES.bucket',
  },
  {
    name: 'an R2 bucket with upper-case letters',
    target: minimalWith({ bindings: { FILES: { type: 'r2', bucket: 'Files' } } }),
    field: 'bindings.FILES.bucket',
  },
  {
    name: 'an R2 binding missing its bucket',
    target: minimalWith({ bindings: { FILES: { type: 'r2' } } }),
    field: 'bindings.FILES.bucket',
  },
  {
    name: 'an unknown R2 jurisdiction',
    target: minimalWith({
      bindings: { FILES: { type: 'r2', bucket: 'files', jurisdiction: 'us' } },
    }),
    field: 'bindings.FILES.jurisdiction',
  },

  {
    name: 'more than 64 queues',
    target: minimalWith({ queues: record(65, (index) => [`q${index}`, `q${index}`]) }),
    field: 'queues',
  },
  {
    name: 'a logical queue name starting with a hyphen',
    target: minimalWith({ queues: { '-jobs': 'x-jobs' } }),
    field: 'queues.-jobs',
  },
  {
    name: 'a physical queue name with upper-case letters',
    target: minimalWith({ queues: { email: 'Talewill-email' } }),
    field: 'queues.email',
  },
  {
    name: 'a queue that breaks the suffix rule',
    target: minimalWith({ queues: { emails: 'talewill-pr-42-email' } }),
    field: 'queues.emails',
  },
  {
    name: 'two queues sharing a physical name',
    target: minimalWith({ queues: { 'a-b': 'a-b', b: 'a-b' } }),
    field: 'queues.b',
  },
  {
    name: 'a queue whose physical name is not a string',
    target: minimalWith({ queues: { email: 42 } }),
    field: 'queues.email',
  },
  { name: 'queues given as an array', target: minimalWith({ queues: [] }), field: 'queues' },

  {
    name: 'an ISR cache with the placeholder ID',
    target: minimalWith({ isrCache: { id: 'local' } }),
    field: 'isrCache.id',
    message: 'placeholder ID was supplied',
  },
  {
    name: 'an ISR cache with an extra key',
    target: minimalWith({ isrCache: { id: KV_ID, name: 'cache' } }),
    field: 'isrCache.name',
  },
  {
    name: 'an ISR cache that is not an object',
    target: minimalWith({ isrCache: 'cache-id' }),
    field: 'isrCache',
  },

  {
    name: 'an email project slug with upper-case letters',
    target: minimalWith({ email: { projectSlug: 'Talewill', domain: 'talewill.example' } }),
    field: 'email.projectSlug',
  },
  {
    name: 'an email project slug over 56 characters',
    target: minimalWith({ email: { projectSlug: 'a'.repeat(57), domain: 'talewill.example' } }),
    field: 'email.projectSlug',
  },
  {
    name: 'an upper-case email domain',
    target: minimalWith({ email: { projectSlug: 'talewill', domain: 'Talewill.example' } }),
    field: 'email.domain',
  },
  {
    name: 'an email domain over 253 characters',
    target: minimalWith({ email: { projectSlug: 'talewill', domain: TOO_LONG_HOSTNAME } }),
    field: 'email.domain',
  },
  {
    name: 'an email block with an extra key',
    target: minimalWith({
      email: { projectSlug: 'talewill', domain: 'talewill.example', region: 'eu' },
    }),
    field: 'email.region',
  },
  {
    name: 'an email block that is a class instance',
    target: minimalWith({ email: new Map() }),
    field: 'email',
  },
  {
    name: 'a sender address that is not in the sender list',
    target: minimalWith({
      email: {
        projectSlug: 'talewill',
        domain: 'talewill.example',
        send: {
          from: 'hello@talewill.example',
          allowedDestinationAddresses: ['ops@talewill.example'],
          allowedSenderAddresses: ['other@talewill.example'],
        },
      },
    }),
    field: 'email.send.allowedSenderAddresses',
  },
  {
    name: 'a from address with an invalid domain',
    target: minimalWith({
      email: {
        projectSlug: 'talewill',
        domain: 'talewill.example',
        send: {
          from: 'hello@-bad.example',
          allowedDestinationAddresses: ['ops@talewill.example'],
          allowedSenderAddresses: ['hello@-bad.example'],
        },
      },
    }),
    field: 'email.send.from',
  },
  {
    name: 'an empty destination address list',
    target: minimalWith({
      email: {
        projectSlug: 'talewill',
        domain: 'talewill.example',
        send: {
          from: 'hello@talewill.example',
          allowedDestinationAddresses: [],
          allowedSenderAddresses: ['hello@talewill.example'],
        },
      },
    }),
    field: 'email.send.allowedDestinationAddresses',
  },
  {
    name: 'more than 100 destination addresses',
    target: minimalWith({
      email: {
        projectSlug: 'talewill',
        domain: 'talewill.example',
        send: {
          from: 'hello@talewill.example',
          allowedDestinationAddresses: Array.from(
            { length: 101 },
            (_, index) => `user${index}@talewill.example`,
          ),
          allowedSenderAddresses: ['hello@talewill.example'],
        },
      },
    }),
    field: 'email.send.allowedDestinationAddresses',
  },
  {
    name: 'a repeated sender address',
    target: minimalWith({
      email: {
        projectSlug: 'talewill',
        domain: 'talewill.example',
        send: {
          from: 'hello@talewill.example',
          allowedDestinationAddresses: ['ops@talewill.example'],
          allowedSenderAddresses: ['hello@talewill.example', 'hello@talewill.example'],
        },
      },
    }),
    field: 'email.send.allowedSenderAddresses.1',
  },
  {
    name: 'a send block missing its destination list',
    target: minimalWith({
      email: {
        projectSlug: 'talewill',
        domain: 'talewill.example',
        send: {
          from: 'hello@talewill.example',
          allowedSenderAddresses: ['hello@talewill.example'],
        },
      },
    }),
    field: 'email.send.allowedDestinationAddresses',
  },
  {
    name: 'a send block with an extra key',
    target: minimalWith({
      email: {
        projectSlug: 'talewill',
        domain: 'talewill.example',
        send: {
          from: 'hello@talewill.example',
          allowedDestinationAddresses: ['ops@talewill.example'],
          allowedSenderAddresses: ['hello@talewill.example'],
          replyTo: 'ops@talewill.example',
        },
      },
    }),
    field: 'email.send.replyTo',
  },

  {
    name: 'more than 64 variables',
    target: minimalWith({ vars: record(65, (index) => [`V_${index}`, 'x']) }),
    field: 'vars',
  },
  {
    name: 'a variable with the reserved prefix',
    target: minimalWith({ vars: { __VOID_KEY: 'x' } }),
    field: 'vars.__VOID_KEY',
  },
  {
    name: 'a variable name starting with a digit',
    target: minimalWith({ vars: { '1X': 'x' } }),
    field: 'vars.1X',
  },
  {
    name: 'a variable name over 128 characters',
    target: minimalWith({ vars: { ['V'.repeat(129)]: 'x' } }),
    field: `vars.${'V'.repeat(129)}`,
  },
  {
    name: 'a variable value over 5120 bytes',
    target: minimalWith({ vars: { BIG: 'a'.repeat(5121) } }),
    field: 'vars.BIG',
  },
  {
    name: 'a variable value of 2561 two-byte characters (5122 bytes)',
    target: minimalWith({ vars: { BIG: 'é'.repeat(2561) } }),
    field: 'vars.BIG',
  },
  {
    name: 'a variable named __proto__',
    target: minimalWith({ vars: JSON.parse('{"__proto__": "x"}') }),
    field: 'vars.__proto__',
  },
  {
    name: 'a variable named constructor',
    target: minimalWith({ vars: { constructor: 'x' } }),
    field: 'vars.constructor',
  },
  {
    name: 'a non-string variable value',
    target: minimalWith({ vars: { PORT: 8080 } }),
    field: 'vars.PORT',
  },
  {
    name: 'a class instance instead of vars',
    target: minimalWith({ vars: new Map() }),
    field: 'vars',
  },

  {
    name: 'more than 128 secrets',
    target: minimalWith({ secrets: record(129, (index) => [`S_${index}`, 'x']) }),
    field: 'secrets',
  },
  {
    name: 'a secret with the reserved prefix',
    target: minimalWith({ secrets: { __VOID_KEY: SECRET } }),
    field: 'secrets.__VOID_KEY',
  },
  {
    name: 'a secret also set as a variable',
    target: minimalWith({ vars: { SHARED: 'public' }, secrets: { SHARED: SECRET } }),
    field: 'secrets.SHARED',
  },
  {
    name: 'an empty secret value',
    target: minimalWith({ secrets: { TOKEN: '' } }),
    field: 'secrets.TOKEN',
  },
  {
    name: 'a secret value over 5120 bytes',
    target: minimalWith({ secrets: { TOKEN: 'a'.repeat(5121) } }),
    field: 'secrets.TOKEN',
  },
  {
    name: 'a secret named constructor',
    target: minimalWith({ secrets: { constructor: SECRET } }),
    field: 'secrets.constructor',
  },
  {
    name: 'secrets given as an array',
    target: minimalWith({ secrets: [SECRET] }),
    field: 'secrets',
  },

  {
    name: 'more than 20 routes',
    target: minimalWith({
      routes: Array.from({ length: 21 }, (_, index) => ({
        pattern: `talewill.example/r${index}`,
        zoneName: 'talewill.example',
      })),
    }),
    field: 'routes',
  },
  {
    name: 'a route with an extra key',
    target: minimalWith({
      routes: [{ pattern: 'talewill.example/x', zoneName: 'talewill.example', method: 'GET' }],
    }),
    field: 'routes.0.method',
  },
  {
    name: 'a route on another zone',
    target: minimalWith({ routes: [{ pattern: 'other.example/x', zoneName: 'talewill.example' }] }),
    field: 'routes.0.pattern',
  },
  {
    name: 'a route whose host only ends with the zone name',
    target: minimalWith({
      routes: [{ pattern: 'eviltalewill.example/x', zoneName: 'talewill.example' }],
    }),
    field: 'routes.0.pattern',
  },
  {
    name: 'a route with a scheme',
    target: minimalWith({
      routes: [{ pattern: 'https://talewill.example/x', zoneName: 'talewill.example' }],
    }),
    field: 'routes.0.pattern',
  },
  {
    name: 'a route with a port',
    target: minimalWith({
      routes: [{ pattern: 'talewill.example:8443/x', zoneName: 'talewill.example' }],
    }),
    field: 'routes.0.pattern',
  },
  {
    name: 'a route with a query',
    target: minimalWith({
      routes: [{ pattern: 'talewill.example/x?y=1', zoneName: 'talewill.example' }],
    }),
    field: 'routes.0.pattern',
  },
  {
    name: 'a route with whitespace',
    target: minimalWith({
      routes: [{ pattern: 'talewill.example/a b', zoneName: 'talewill.example' }],
    }),
    field: 'routes.0.pattern',
  },
  {
    name: 'a route without a path separator',
    target: minimalWith({
      routes: [{ pattern: 'talewill.example', zoneName: 'talewill.example' }],
    }),
    field: 'routes.0.pattern',
  },
  {
    name: 'a route path over 200 characters',
    target: minimalWith({
      routes: [{ pattern: `talewill.example/${'a'.repeat(201)}`, zoneName: 'talewill.example' }],
    }),
    field: 'routes.0.pattern',
  },
  {
    name: 'a wildcard zone name',
    target: minimalWith({
      routes: [{ pattern: 'talewill.example/x', zoneName: '*.talewill.example' }],
    }),
    field: 'routes.0.zoneName',
  },
  {
    name: 'a route that is a string',
    target: minimalWith({ routes: ['talewill.example/x'] }),
    field: 'routes.0',
  },
  {
    name: 'a sparse routes array',
    target: minimalWith({ routes: new Array(1) }),
    field: 'routes.0',
  },
  { name: 'routes given as an object', target: minimalWith({ routes: {} }), field: 'routes' },

  {
    name: 'a non-boolean workersDev',
    target: minimalWith({ workersDev: 'yes' }),
    field: 'workersDev',
  },
  {
    name: 'a non-boolean previewUrls',
    target: minimalWith({ previewUrls: 1 }),
    field: 'previewUrls',
  },
  { name: 'a null seed flag', target: minimalWith({ seed: null }), field: 'seed' },
  {
    name: 'an upper-case workers.dev subdomain',
    target: minimalWith({ workersDevSubdomain: 'Talewill' }),
    field: 'workersDevSubdomain',
  },
];

const secretLeaks: Array<{ name: string; target: unknown; field: string; secret: string }> = [
  {
    name: 'an empty secret beside a secret that is set',
    target: minimalWith({ secrets: { TOKEN: '', OTHER: SECRET } }),
    field: 'secrets.TOKEN',
    secret: SECRET,
  },
  {
    name: 'a secret over 5120 bytes',
    target: minimalWith({ secrets: { TOKEN: OVERSIZED_SECRET, OTHER: SECRET } }),
    field: 'secrets.TOKEN',
    secret: OVERSIZED_SECRET,
  },
  {
    name: 'a secret that is an object',
    target: minimalWith({ secrets: { TOKEN: { value: SECRET }, OTHER: SECRET } }),
    field: 'secrets.TOKEN',
    secret: SECRET,
  },
  {
    name: 'secrets given as an array',
    target: minimalWith({ secrets: [SECRET] }),
    field: 'secrets',
    secret: SECRET,
  },
  {
    name: 'a bad account ID beside a secret',
    target: minimalWith({ accountId: 'not-hex', secrets: { TOKEN: SECRET } }),
    field: 'accountId',
    secret: SECRET,
  },
  {
    name: 'a secret name also set in vars',
    target: minimalWith({ vars: { TOKEN: 'public' }, secrets: { TOKEN: SECRET } }),
    field: 'secrets.TOKEN',
    secret: SECRET,
  },
  {
    name: 'a bad route beside a secret',
    target: minimalWith({
      routes: [{ pattern: 'other.example/x', zoneName: 'talewill.example' }],
      secrets: { TOKEN: SECRET },
    }),
    field: 'routes.0.pattern',
    secret: SECRET,
  },
  {
    name: 'a URL that carries the secret as its password',
    target: minimalWith({
      apiBaseUrl: `https://user:${SECRET}@api.example.com`,
      secrets: { TOKEN: SECRET },
    }),
    field: 'apiBaseUrl',
    secret: SECRET,
  },
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

it('parses a minimal target without optional fields', () => {
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
  });
});

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
  (apiBaseUrl) => {
    expect(parseCloudflareArtifactTarget(minimalWith({ apiBaseUrl })).apiBaseUrl).toBe(apiBaseUrl);
  },
);

it.each(rejections)('rejects $name', ({ target, field, message }) => {
  const error = expectRejection(target);

  expect(error).toBeInstanceOf(CloudflareArtifactTargetError);
  expect(error.field).toBe(field);
  expect(error.message).toContain(field);
  expect(error.message).not.toContain('\n');
  if (message !== undefined) {
    expect(error.message).toContain(message);
  }
});

it.each(secretLeaks)(
  'keeps secret values out of the error for $name',
  ({ target, field, secret }) => {
    const error = expectRejection(target);
    const serialized = JSON.stringify(error);

    expect(error.field).toBe(field);
    for (const fragment of fragmentsOf(secret)) {
      expect(error.message).not.toContain(fragment);
      expect(error.field).not.toContain(fragment);
      expect(serialized).not.toContain(fragment);
    }
  },
);

it('shows at most 80 characters of a bad non-secret value', () => {
  const error = expectRejection(minimalWith({ workerName: 'X'.repeat(200) }));

  expect(error.field).toBe('workerName');
  expect(error.message).toContain('X'.repeat(80));
  expect(error.message).not.toContain('X'.repeat(81));
});
