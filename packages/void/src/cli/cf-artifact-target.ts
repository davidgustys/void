export type CloudflareArtifactTargetBinding =
  | { type: 'd1'; id: string; name: string }
  | { type: 'kv'; id: string }
  | { type: 'r2'; bucket: string; jurisdiction?: 'eu' | 'fedramp' };

export type CloudflareArtifactTarget = {
  /** Cloudflare account ID. */
  accountId: string;
  /** The Worker to publish. */
  workerName: string;
  /** Cloudflare API base URL; defaults to Cloudflare's own when omitted. */
  apiBaseUrl?: string;
  /** Resources by binding name. Must cover every D1, KV and R2 binding in the artifact, and nothing else. */
  bindings: Record<string, CloudflareArtifactTargetBinding>;
  /** Physical queue name for each logical queue name the artifact uses. */
  queues: Record<string, string>;
  /** Required when the artifact requires an ISR cache. */
  isrCache?: { id: string };
  /** Required when the artifact handles or sends email. */
  email?: {
    projectSlug: string;
    domain: string;
    send?: {
      from: string;
      allowedDestinationAddresses: Array<string>;
      allowedSenderAddresses: Array<string>;
    };
  };
  /** Extra plain-text variables. */
  vars?: Record<string, string>;
  /** Secret values by name. */
  secrets: Record<string, string>;
  routes: Array<{ pattern: string; zoneName: string }>;
  workersDev: boolean;
  previewUrls: boolean;
  /** The account's workers.dev subdomain, used to probe readiness without routes. */
  workersDevSubdomain?: string;
  /** Run the artifact's seed after migrations. */
  seed: boolean;
};

export class CloudflareArtifactTargetError extends Error {
  /** Dotted path of the offending field, such as `bindings.DB.id`. */
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'CloudflareArtifactTargetError';
    this.field = field;
  }
}

type TargetEmail = NonNullable<CloudflareArtifactTarget['email']>;
type TargetRoute = CloudflareArtifactTarget['routes'][number];
type FieldShape = { required: ReadonlyArray<string>; optional?: ReadonlyArray<string> };

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
// Worker names, physical queue names and workers.dev subdomains share one label rule.
const LOWERCASE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOWERCASE_NAME_PROBLEM =
  'must be 1 to 63 lowercase letters, digits or hyphens, not starting or ending with a hyphen';
const LOGICAL_QUEUE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const D1_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const D1_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const KV_ID = /^[0-9a-f]{32}$/;
const R2_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const PROJECT_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,54}[a-z0-9])?$/;
const EMAIL_ADDRESS = /^[A-Za-z0-9._%+-]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
// The same rule as LITERAL_HOSTNAME_REGEX in packages/deploy-core/src/validate.ts.
const LITERAL_HOSTNAME = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const ROUTE_PATH = /^[A-Za-z0-9._~/*-]{0,200}$/;

const MAX_BINDINGS = 64;
const MAX_QUEUES = 64;
const MAX_VARIABLES = 64;
const MAX_SECRETS = 128;
const MAX_ROUTES = 20;
const MAX_ADDRESSES = 100;
const MAX_VALUE_BYTES = 5120;
const MAX_HOSTNAME_LENGTH = 253;
const MAX_PREVIEW_LENGTH = 80;
const RESERVED_PREFIX = '__VOID_';
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const encoder = new TextEncoder();

const TARGET_SHAPE: FieldShape = {
  required: [
    'accountId',
    'workerName',
    'bindings',
    'queues',
    'secrets',
    'routes',
    'workersDev',
    'previewUrls',
    'seed',
  ],
  optional: ['apiBaseUrl', 'isrCache', 'email', 'vars', 'workersDevSubdomain'],
};

/** Strictly validate a publish target. Returns a fresh object with only known keys. */
export function parseCloudflareArtifactTarget(value: unknown): CloudflareArtifactTarget {
  const target = exactFields(value, '', TARGET_SHAPE);
  const accountId = stringMatching(
    target.accountId,
    'accountId',
    ACCOUNT_ID,
    'must be 32 lowercase hexadecimal characters',
  );
  const workerName = stringMatching(
    target.workerName,
    'workerName',
    LOWERCASE_NAME,
    LOWERCASE_NAME_PROBLEM,
  );
  const apiBaseUrl =
    target.apiBaseUrl === undefined ? undefined : parseApiBaseUrl(target.apiBaseUrl);
  const bindings = parseBindings(target.bindings);
  const queues = parseQueues(target.queues);
  const isrCache = target.isrCache === undefined ? undefined : parseIsrCache(target.isrCache);
  const email = target.email === undefined ? undefined : parseEmail(target.email);
  const vars = target.vars === undefined ? undefined : parseVars(target.vars);
  // Secrets are checked against the variable names, so `vars` is parsed first.
  const secrets = parseSecrets(target.secrets, vars ?? {});
  const routes = parseRoutes(target.routes);
  const workersDev = booleanValue(target.workersDev, 'workersDev');
  const previewUrls = booleanValue(target.previewUrls, 'previewUrls');
  const workersDevSubdomain =
    target.workersDevSubdomain === undefined
      ? undefined
      : stringMatching(
          target.workersDevSubdomain,
          'workersDevSubdomain',
          LOWERCASE_NAME,
          LOWERCASE_NAME_PROBLEM,
        );
  const seed = booleanValue(target.seed, 'seed');

  const result: CloudflareArtifactTarget = {
    accountId,
    workerName,
    bindings,
    queues,
    secrets,
    routes,
    workersDev,
    previewUrls,
    seed,
  };
  if (apiBaseUrl !== undefined) {
    result.apiBaseUrl = apiBaseUrl;
  }
  if (isrCache !== undefined) {
    result.isrCache = isrCache;
  }
  if (email !== undefined) {
    result.email = email;
  }
  if (vars !== undefined) {
    result.vars = vars;
  }
  if (workersDevSubdomain !== undefined) {
    result.workersDevSubdomain = workersDevSubdomain;
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The path of `key` under `parent`; root keys have no prefix. */
function childField(parent: string, key: string | number): string {
  return parent === '' ? String(key) : `${parent}.${key}`;
}

/** Whether `value` has an own key that is a symbol or not enumerable, which JSON input never has. */
function hasHiddenKeys(value: Record<string, unknown>): boolean {
  return Reflect.ownKeys(value).length !== Object.keys(value).length;
}

function isSecretField(field: string): boolean {
  return field === 'secrets' || field.startsWith('secrets.');
}

/** Up to 80 characters of `value`, JSON-quoted so control characters stay on one line. */
function preview(value: string): string {
  const head = JSON.stringify(value.slice(0, MAX_PREVIEW_LENGTH));
  return value.length > MAX_PREVIEW_LENGTH ? `${head}...` : head;
}

/**
 * The error for `field`. A string `value` is shown only for non-secret fields; callers pass
 * no value for secrets, and for URLs, which can carry credentials.
 */
function invalid(field: string, problem: string, value?: unknown): CloudflareArtifactTargetError {
  const path = field === '' ? 'target' : field;
  const shown = typeof value === 'string' && !isSecretField(path) ? ` (got ${preview(value)})` : '';
  return new CloudflareArtifactTargetError(path, `${path} ${problem}${shown}.`);
}

function placeholderId(field: string, value: string): CloudflareArtifactTargetError {
  return new CloudflareArtifactTargetError(
    field,
    `A placeholder ID was supplied for ${field}: "${value}" is a Void build placeholder, not a real resource.`,
  );
}

/** Require a plain object whose own keys are exactly the declared ones. */
function exactFields(value: unknown, field: string, shape: FieldShape): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw invalid(field, 'must be a plain object');
  }
  if (hasHiddenKeys(value)) {
    throw invalid(field, 'must not have symbol or non-enumerable keys');
  }
  const optional = shape.optional ?? [];
  const declared = [...shape.required, ...optional];
  for (const key of Object.keys(value)) {
    if (!declared.includes(key)) {
      throw invalid(childField(field, key), 'is not a known field');
    }
  }
  for (const key of shape.required) {
    if (!Object.hasOwn(value, key)) {
      throw invalid(childField(field, key), 'is required');
    }
  }
  for (const key of optional) {
    if (Object.hasOwn(value, key) && value[key] === undefined) {
      throw invalid(childField(field, key), 'must be omitted instead of set to undefined');
    }
  }
  return value;
}

/** The own entries of a plain-object record, after checking its size and key names. */
function recordEntries(
  value: unknown,
  field: string,
  max: number,
  keyPattern: RegExp,
  keyProblem: string,
): Array<[string, unknown]> {
  if (!isPlainObject(value)) {
    throw invalid(field, 'must be a plain object');
  }
  if (hasHiddenKeys(value)) {
    throw invalid(field, 'must not have symbol or non-enumerable keys');
  }
  const entries = Object.entries(value);
  if (entries.length > max) {
    throw invalid(field, `must have at most ${max} entries`);
  }
  for (const [key] of entries) {
    if (RESERVED_KEYS.has(key)) {
      throw invalid(childField(field, key), 'uses a reserved key name');
    }
    if (!keyPattern.test(key)) {
      throw invalid(childField(field, key), keyProblem);
    }
  }
  return entries;
}

/** Entries of a `vars` or `secrets` record: names follow the variable rule and avoid the reserved prefix. */
function variableEntries(value: unknown, field: string, max: number): Array<[string, unknown]> {
  const entries = recordEntries(
    value,
    field,
    max,
    VARIABLE_NAME,
    'must be a letter or underscore followed by up to 127 letters, digits or underscores',
  );
  for (const [name] of entries) {
    if (name.startsWith(RESERVED_PREFIX)) {
      throw invalid(
        childField(field, name),
        `must not start with ${RESERVED_PREFIX}, which Void reserves`,
      );
    }
  }
  return entries;
}

function arrayEntries(value: unknown, field: string, max: number): Array<unknown> {
  if (!Array.isArray(value)) {
    throw invalid(field, 'must be an array');
  }
  if (value.length > max) {
    throw invalid(field, `must have at most ${max} entries`);
  }
  const items: Array<unknown> = [];
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) {
      throw invalid(childField(field, index), 'must not be a sparse hole');
    }
    items.push(value[index]);
  }
  return items;
}

/** A string that matches `pattern`. `placeholder` names the one Void build value to reject first. */
function stringMatching(
  value: unknown,
  field: string,
  pattern: RegExp,
  problem: string,
  placeholder?: string,
): string {
  if (typeof value !== 'string') {
    throw invalid(field, 'must be a string');
  }
  if (value === placeholder) {
    throw placeholderId(field, value);
  }
  if (!pattern.test(value)) {
    throw invalid(field, problem, value);
  }
  return value;
}

function isLiteralHostname(value: string): boolean {
  return value.length <= MAX_HOSTNAME_LENGTH && LITERAL_HOSTNAME.test(value);
}

function literalHostname(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw invalid(field, 'must be a string');
  }
  if (!isLiteralHostname(value)) {
    throw invalid(
      field,
      'must be a lowercase literal hostname of at most 253 characters, such as "example.com"',
      value,
    );
  }
  return value;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw invalid(field, 'must be a boolean');
  }
  return value;
}

/** A string of at most 5120 UTF-8 bytes; a non-empty one when `nonEmpty` is set. Never shows the value. */
function textValue(value: unknown, field: string, nonEmpty: boolean): string {
  if (typeof value !== 'string' || (nonEmpty && value === '')) {
    throw invalid(field, nonEmpty ? 'must be a non-empty string' : 'must be a string');
  }
  if (encoder.encode(value).byteLength > MAX_VALUE_BYTES) {
    throw invalid(field, `must be at most ${MAX_VALUE_BYTES} UTF-8 bytes`);
  }
  return value;
}

// A URL can carry credentials, so none of these problems show the value.
function parseApiBaseUrl(value: unknown): string {
  const field = 'apiBaseUrl';
  if (typeof value !== 'string') {
    throw invalid(field, 'must be a string');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid(field, 'must be an absolute URL');
  }
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw invalid(field, 'must use https, or http only for 127.0.0.1, localhost or [::1]');
  }
  if (url.username !== '' || url.password !== '') {
    throw invalid(field, 'must not include a username or password');
  }
  // `URL` drops an empty query or fragment, so check the raw string as well.
  if (value.includes('?') || value.includes('#')) {
    throw invalid(field, 'must not include a query or fragment');
  }
  return value;
}

function parseBindings(value: unknown): Record<string, CloudflareArtifactTargetBinding> {
  const bindings: Record<string, CloudflareArtifactTargetBinding> = {};
  for (const [name, binding] of recordEntries(
    value,
    'bindings',
    MAX_BINDINGS,
    BINDING_NAME,
    'must be a letter or underscore followed by up to 63 letters, digits or underscores',
  )) {
    bindings[name] = parseBinding(binding, childField('bindings', name));
  }
  return bindings;
}

function parseBinding(value: unknown, field: string): CloudflareArtifactTargetBinding {
  if (!isPlainObject(value)) {
    throw invalid(field, 'must be a plain object');
  }
  switch (value.type) {
    case 'd1': {
      const binding = exactFields(value, field, { required: ['type', 'id', 'name'] });
      return {
        type: 'd1',
        id: stringMatching(
          binding.id,
          childField(field, 'id'),
          D1_ID,
          'must be a lowercase D1 database UUID',
          'local',
        ),
        name: stringMatching(
          binding.name,
          childField(field, 'name'),
          D1_NAME,
          'must be 1 to 64 letters, digits, hyphens or underscores, starting with a letter or digit',
          'default',
        ),
      };
    }
    case 'kv': {
      const binding = exactFields(value, field, { required: ['type', 'id'] });
      return {
        type: 'kv',
        id: stringMatching(
          binding.id,
          childField(field, 'id'),
          KV_ID,
          'must be 32 lowercase hexadecimal characters',
          'local',
        ),
      };
    }
    case 'r2': {
      const binding = exactFields(value, field, {
        required: ['type', 'bucket'],
        optional: ['jurisdiction'],
      });
      const bucket = stringMatching(
        binding.bucket,
        childField(field, 'bucket'),
        R2_BUCKET,
        'must be 3 to 63 lowercase letters, digits or hyphens, not starting or ending with a hyphen',
        'default',
      );
      const jurisdiction = binding.jurisdiction;
      if (jurisdiction === undefined) {
        return { type: 'r2', bucket };
      }
      if (jurisdiction !== 'eu' && jurisdiction !== 'fedramp') {
        throw invalid(childField(field, 'jurisdiction'), "must be 'eu' or 'fedramp'", jurisdiction);
      }
      return { type: 'r2', bucket, jurisdiction };
    }
    default:
      throw invalid(childField(field, 'type'), 'must be one of d1, kv or r2', value.type);
  }
}

function parseQueues(value: unknown): Record<string, string> {
  const queues: Record<string, string> = {};
  // Physical name -> the logical name that claimed it.
  const owners = new Map<string, string>();
  for (const [logical, physical] of recordEntries(
    value,
    'queues',
    MAX_QUEUES,
    LOGICAL_QUEUE,
    'must be 1 to 63 letters, digits, hyphens or underscores, starting with a letter or digit',
  )) {
    const field = childField('queues', logical);
    const name = stringMatching(physical, field, LOWERCASE_NAME, LOWERCASE_NAME_PROBLEM);
    // The runtime dispatches a queue by its suffix, so the physical name must end with the logical one.
    if (name !== logical && !name.endsWith(`-${logical}`)) {
      throw invalid(
        field,
        `must equal "${logical}" or end with "-${logical}", the runtime's queue-dispatch rule`,
        name,
      );
    }
    const owner = owners.get(name);
    if (owner !== undefined) {
      throw invalid(
        field,
        `repeats the physical queue name "${name}" already used by queues.${owner}`,
      );
    }
    owners.set(name, logical);
    queues[logical] = name;
  }
  return queues;
}

function parseIsrCache(value: unknown): { id: string } {
  const cache = exactFields(value, 'isrCache', { required: ['id'] });
  return {
    id: stringMatching(
      cache.id,
      'isrCache.id',
      KV_ID,
      'must be 32 lowercase hexadecimal characters',
      'local',
    ),
  };
}

function parseEmail(value: unknown): TargetEmail {
  const email = exactFields(value, 'email', {
    required: ['projectSlug', 'domain'],
    optional: ['send'],
  });
  const parsed: TargetEmail = {
    projectSlug: stringMatching(
      email.projectSlug,
      'email.projectSlug',
      PROJECT_SLUG,
      'must be 1 to 56 lowercase letters, digits or hyphens, not starting or ending with a hyphen',
    ),
    domain: literalHostname(email.domain, 'email.domain'),
  };
  if (email.send !== undefined) {
    parsed.send = parseEmailSend(email.send);
  }
  return parsed;
}

function parseEmailSend(value: unknown): NonNullable<TargetEmail['send']> {
  const send = exactFields(value, 'email.send', {
    required: ['from', 'allowedDestinationAddresses', 'allowedSenderAddresses'],
  });
  const from = emailAddress(send.from, 'email.send.from');
  const allowedDestinationAddresses = addressList(
    send.allowedDestinationAddresses,
    'email.send.allowedDestinationAddresses',
  );
  const allowedSenderAddresses = addressList(
    send.allowedSenderAddresses,
    'email.send.allowedSenderAddresses',
  );
  if (!allowedSenderAddresses.includes(from)) {
    throw invalid(
      'email.send.allowedSenderAddresses',
      'must include the address given in email.send.from',
    );
  }
  return { from, allowedDestinationAddresses, allowedSenderAddresses };
}

function emailAddress(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw invalid(field, 'must be a string');
  }
  if (!EMAIL_ADDRESS.test(value)) {
    throw invalid(field, 'must be an email address with a lowercase hostname after @', value);
  }
  const host = value.slice(value.indexOf('@') + 1);
  if (!isLiteralHostname(host)) {
    throw invalid(field, 'must be an email address with a valid hostname after @', value);
  }
  return value;
}

/** Between 1 and 100 unique email addresses. */
function addressList(value: unknown, field: string): Array<string> {
  const items = arrayEntries(value, field, MAX_ADDRESSES);
  if (items.length === 0) {
    throw invalid(field, 'must list at least one address');
  }
  const addresses: Array<string> = [];
  for (const [index, item] of items.entries()) {
    const address = emailAddress(item, childField(field, index));
    if (addresses.includes(address)) {
      throw invalid(childField(field, index), 'repeats an address already listed', address);
    }
    addresses.push(address);
  }
  return addresses;
}

function parseVars(value: unknown): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, text] of variableEntries(value, 'vars', MAX_VARIABLES)) {
    vars[name] = textValue(text, childField('vars', name), false);
  }
  return vars;
}

function parseSecrets(value: unknown, vars: Record<string, string>): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const [name, secret] of variableEntries(value, 'secrets', MAX_SECRETS)) {
    const field = childField('secrets', name);
    if (Object.hasOwn(vars, name)) {
      throw invalid(field, 'is also set in vars; a name may appear in only one of them');
    }
    secrets[name] = textValue(secret, field, true);
  }
  return secrets;
}

function parseRoutes(value: unknown): Array<TargetRoute> {
  return arrayEntries(value, 'routes', MAX_ROUTES).map((route, index) =>
    parseRoute(route, childField('routes', index)),
  );
}

function parseRoute(value: unknown, field: string): TargetRoute {
  const route = exactFields(value, field, { required: ['pattern', 'zoneName'] });
  const zoneName = literalHostname(route.zoneName, childField(field, 'zoneName'));
  const patternField = childField(field, 'pattern');
  if (typeof route.pattern !== 'string') {
    throw invalid(patternField, 'must be a string');
  }
  const pattern = route.pattern;
  const slash = pattern.indexOf('/');
  if (slash === -1) {
    throw invalid(patternField, 'must be a host, then "/" and a path', pattern);
  }
  const host = pattern.slice(0, slash);
  if (!isLiteralHostname(host)) {
    throw invalid(
      patternField,
      'must be a literal host, then "/" and a path, with no scheme, port, query or whitespace',
      pattern,
    );
  }
  if (host !== zoneName && !host.endsWith(`.${zoneName}`)) {
    throw invalid(patternField, `host must be ${zoneName} or a subdomain of it`, pattern);
  }
  if (!ROUTE_PATH.test(pattern.slice(slash + 1))) {
    throw invalid(
      patternField,
      'path must be at most 200 characters of letters, digits and ._~/*-',
      pattern,
    );
  }
  return { pattern, zoneName };
}
