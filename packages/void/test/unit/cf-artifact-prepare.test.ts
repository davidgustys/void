import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import {
  deriveCloudflareArtifactRequirements,
  type CloudflareArtifactRequirementsInput,
  prepareCloudflareArtifact,
  type PrepareCloudflareArtifactOptions,
} from '../../src/cli/cf-artifact-prepare.ts';
import { createCloudflareWorkerBuildEnv } from '../../src/cli/deploy-cloudflare-build.ts';
import {
  CLOUDFLARE_DEPLOY_BUILD_ENV,
  CLOUDFLARE_QUEUE_NAMES_BUILD_ENV,
} from '../../src/shared/env.ts';
import { WRANGLER_AUTH_CREDENTIAL_ENV_VARS } from '../../src/shared/untrusted-env.ts';
import { CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV } from '../../src/shared/version-metadata.ts';

const isWindows = process.platform === 'win32';
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const roots: Array<string> = [];

function makeRoot(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'cf-artifact-prepare-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

async function expectRefusal(
  root: string,
  message: string,
  options: Partial<PrepareCloudflareArtifactOptions> = {},
): Promise<Error> {
  const runBuild = vi.fn();
  const error: unknown = await prepareCloudflareArtifact(root, {
    outDir: join(root, 'artifact'),
    ...options,
    runBuild,
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(message);
  expect(runBuild).not.toHaveBeenCalled();
  return error as Error;
}

beforeEach(() => {
  for (const name of WRANGLER_AUTH_CREDENTIAL_ENV_VARS) {
    vi.stubEnv(name, undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(WRANGLER_AUTH_CREDENTIAL_ENV_VARS)('refuses %s before project code runs', async (name) => {
  const root = makeRoot({ 'void.config.ts': "throw new Error('project code ran');\n" });
  vi.stubEnv(name, 'value-that-must-not-leak');
  const error = await expectRefusal(root, 'without Cloudflare credentials');
  expect(error.message).toContain(name);
  expect(error.message).not.toContain('value-that-must-not-leak');
  expect(error.message).not.toContain('project code ran');
  expect(existsSync(join(root, 'artifact'))).toBe(false);
});

it('scrubs build credentials and account selectors and pins production mode', () => {
  for (const [name, value] of Object.entries({
    CLOUDFLARE_API_TOKEN: 'token-value',
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    CF_ACCOUNT_ID: ACCOUNT_ID,
    DATABASE_URL: 'postgres://user:password@example.invalid/db',
    VOID_TOKEN: 'void-token-value',
    NODE_ENV: 'development',
  })) {
    vi.stubEnv(name, value);
  }
  const env = createCloudflareWorkerBuildEnv({
    accountId: undefined,
    apiBaseUrl: 'https://api.cloudflare.com/client/v4',
    preserveBindings: false,
  });
  for (const key of [
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_ACCOUNT_ID',
    'CF_ACCOUNT_ID',
    'DATABASE_URL',
    'VOID_TOKEN',
    CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV,
  ]) {
    expect(env[key], key).toBeUndefined();
  }
  expect(env[CLOUDFLARE_DEPLOY_BUILD_ENV]).toBe('1');
  expect(env.NODE_ENV).toBe('production');
  expect(env.CLOUDFLARE_API_BASE_URL).toBe('https://api.cloudflare.com/client/v4');
  const preserved = createCloudflareWorkerBuildEnv({
    accountId: ACCOUNT_ID,
    apiBaseUrl: 'https://api.cloudflare.com/client/v4',
    preserveBindings: true,
  });
  expect(preserved[CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV]).toBe('1');
  expect(preserved.CLOUDFLARE_ACCOUNT_ID).toBe(ACCOUNT_ID);
});

it('removes an ambient queue name map from the prepare build environment', async () => {
  vi.stubEnv(CLOUDFLARE_QUEUE_NAMES_BUILD_ENV, '{"jobs":"elsewhere-jobs"}');
  const root = makeRoot({
    'routes/index.ts': "export const GET = () => new Response('ok');",
    'queues/jobs.ts': 'export default {};',
  });
  const buildStopped = new Error('build stopped');
  const runBuild = vi.fn((_env: NodeJS.ProcessEnv) => {
    throw buildStopped;
  });

  await expect(
    prepareCloudflareArtifact(root, { outDir: join(root, 'artifact'), runBuild }),
  ).rejects.toBe(buildStopped);
  expect(runBuild).toHaveBeenCalledOnce();
  const env = runBuild.mock.calls[0]![0];
  expect(env[CLOUDFLARE_QUEUE_NAMES_BUILD_ENV]).toBeUndefined();
  expect(env[CLOUDFLARE_DEPLOY_BUILD_ENV]).toBe('1');
});

it.each(['', 'abc', 'ABCDEF1', 'g123456', 'a'.repeat(65)])(
  'refuses invalid commit %j',
  async (commit) => {
    await expectRefusal(makeRoot(), 'commit', { commit });
  },
);

it.each([
  ['nonempty output', { 'artifact/stale.txt': 'keep' }, 'must be empty'],
  ['file output', { artifact: 'not a directory' }, 'is not a directory'],
  ['Node target', { 'void.config.ts': "export default { target: 'node' };" }, 'targets node'],
  ['static output', { 'void.config.ts': "export default { output: 'static' };" }, 'static output'],
  ['framework', { 'package.json': '{"dependencies":{"astro":"^5.0.0"}}' }, 'only native Void apps'],
] as Array<[string, Record<string, string>, string]>)(
  'refuses %s before building',
  async (_name, files, message) => {
    await expectRefusal(makeRoot(files), message, { commit: 'abcdef0' });
  },
);

it.each(['../outside.sql', 'db/../../outside.sql'])('refuses seed escape %s', async (seed) => {
  await expectRefusal(makeRoot(), 'must be inside the app root', { seed });
});

it('refuses an absolute seed outside the project', async () => {
  const outside = makeRoot({ 'seed.sql': 'SELECT 1;' });
  await expectRefusal(makeRoot(), 'must be inside the app root', {
    seed: join(outside, 'seed.sql'),
  });
});

it.each([false, true])('refuses missing seed with existing parent: %s', async (parentExists) => {
  const root = makeRoot();
  if (parentExists) {
    mkdirSync(join(root, 'db'));
  }
  await expectRefusal(root, 'does not exist', { seed: 'db/seed.sql' });
});

it('refuses a directory as seed', async () => {
  const root = makeRoot();
  mkdirSync(join(root, 'db', 'seed.sql'), { recursive: true });
  await expectRefusal(root, 'is not a regular file', { seed: 'db/seed.sql' });
});

it.skipIf(isWindows)('refuses a linked seed or parent escaping the project', async () => {
  const root = makeRoot({ 'db/real.sql': 'SELECT 1;' });
  symlinkSync('real.sql', join(root, 'db', 'seed.sql'));
  await expectRefusal(root, 'symlinks are not permitted', { seed: 'db/seed.sql' });
  const outside = makeRoot({ 'seed.sql': 'SELECT 1;' });
  symlinkSync(outside, join(root, 'linked'), 'dir');
  await expectRefusal(root, 'must be inside the app root', { seed: 'linked/seed.sql' });
});

const base: CloudflareArtifactRequirementsInput = {
  d1: null,
  isrCache: false,
  email: { inbound: false, send: false },
  builtConfig: {},
  seed: false,
};

it('derives no database or secrets for an app that needs none', () => {
  expect(deriveCloudflareArtifactRequirements(base)).toEqual({
    d1: null,
    isrCache: false,
    email: base.email,
    secrets: [],
    seed: false,
  });
});

it.each([
  [undefined, ['0002_b.sql', '0001_a.sql'], true],
  ['custom_migrations', ['0001_init.sql'], false],
  [undefined, [], false],
] as const)(
  'derives D1 requirements with table %s and preserves order',
  (migrationsTable, migrations, journal) => {
    const requirements = deriveCloudflareArtifactRequirements({
      ...base,
      d1: { binding: 'DB', migrationsTable, migrations, journal },
    });
    expect(requirements.d1).toEqual({
      binding: 'DB',
      migrationsTable: migrationsTable ?? 'd1_migrations',
      migrations,
      journal,
    });
  },
);

it('derives ISR, email, seed and sorted unique secret requirements', () => {
  const requirements = deriveCloudflareArtifactRequirements({
    ...base,
    isrCache: true,
    email: { inbound: true, send: true },
    seed: true,
    builtConfig: { secrets: { required: ['Z_KEY', 'BETTER_AUTH_SECRET', 'Z_KEY', 'A_KEY'] } },
  });
  expect(requirements).toMatchObject({
    isrCache: true,
    email: { inbound: true, send: true },
    seed: true,
    secrets: ['A_KEY', 'BETTER_AUTH_SECRET', 'Z_KEY'],
  });
});

it.each([
  { required: 'BETTER_AUTH_SECRET' },
  { required: ['BETTER_AUTH_SECRET', 1] },
  { required: null },
  'BETTER_AUTH_SECRET',
])('refuses malformed secret declarations %j', (secrets) => {
  expect(() => deriveCloudflareArtifactRequirements({ ...base, builtConfig: { secrets } })).toThrow(
    /secrets/,
  );
});
