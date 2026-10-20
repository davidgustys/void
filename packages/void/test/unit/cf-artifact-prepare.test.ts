import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  deriveCloudflareArtifactRequirements,
  type CloudflareArtifactRequirementsInput,
  prepareCloudflareArtifact,
} from '../../src/cli/cf-artifact-prepare.ts';
import { createCloudflareWorkerBuildEnv } from '../../src/cli/deploy-cloudflare-build.ts';
import { CLOUDFLARE_DEPLOY_BUILD_ENV } from '../../src/shared/env.ts';
import { WRANGLER_AUTH_CREDENTIAL_ENV_VARS } from '../../src/shared/untrusted-env.ts';
import { CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV } from '../../src/shared/version-metadata.ts';

const isWindows = process.platform === 'win32';
const API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';

const roots: Array<string> = [];
const savedEnv = new Map<string, string | undefined>();

/** Make a temporary directory, with the given files written relative to it. */
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

/** Set one environment variable for this test. `undefined` deletes it. `afterEach` restores it. */
function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) {
    savedEnv.set(name, process.env[name]);
  }
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

/** Run the call and return the error it rejects with, failing the test if it resolves. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

beforeEach(() => {
  // Start every test without Cloudflare credentials, whatever the shell or CI exported.
  for (const name of WRANGLER_AUTH_CREDENTIAL_ENV_VARS) {
    setEnv(name, undefined);
  }
});

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  savedEnv.clear();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('prepareCloudflareArtifact refuses credentials before project code runs', () => {
  it.each(WRANGLER_AUTH_CREDENTIAL_ENV_VARS)('refuses when %s is set', async (name) => {
    // The config throws if it is loaded. The refusal must win, so the message names the credential.
    const root = makeRoot({ 'void.config.ts': "throw new Error('project code ran');\n" });
    setEnv(name, 'value-that-must-not-leak');
    const runBuild = vi.fn();
    const outDir = join(root, 'artifact');

    const error = await rejection(prepareCloudflareArtifact(root, { outDir, runBuild }));

    expect(error.message).toContain('without Cloudflare credentials');
    expect(error.message).toContain(name);
    expect(error.message).not.toContain('value-that-must-not-leak');
    expect(error.message).not.toContain('project code ran');
    expect(runBuild).not.toHaveBeenCalled();
    expect(existsSync(outDir)).toBe(false);
  });
});

describe('createCloudflareWorkerBuildEnv', () => {
  it('scrubs credentials and pins the deploy-build mode with no account', () => {
    setEnv('CLOUDFLARE_API_TOKEN', 'token-value');
    setEnv('CLOUDFLARE_ACCOUNT_ID', ACCOUNT_ID);
    setEnv('CF_ACCOUNT_ID', ACCOUNT_ID);
    setEnv('DATABASE_URL', 'postgres://user:password@example.invalid/db');
    setEnv('VOID_TOKEN', 'void-token-value');
    setEnv('NODE_ENV', 'development');

    const env = createCloudflareWorkerBuildEnv({
      accountId: undefined,
      apiBaseUrl: API_BASE_URL,
      preserveBindings: false,
    });

    expect(env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(env.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
    expect(env.CF_ACCOUNT_ID).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.VOID_TOKEN).toBeUndefined();
    expect(env[CLOUDFLARE_DEPLOY_BUILD_ENV]).toBe('1');
    expect(env.NODE_ENV).toBe('production');
    expect(env[CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV]).toBeUndefined();
    expect(env.CLOUDFLARE_API_BASE_URL).toBe(API_BASE_URL);
  });

  it('sets the preserve-bindings flag only when asked', () => {
    const env = createCloudflareWorkerBuildEnv({
      accountId: ACCOUNT_ID,
      apiBaseUrl: API_BASE_URL,
      preserveBindings: true,
    });

    expect(env[CLOUDFLARE_PRESERVE_BINDINGS_BUILD_ENV]).toBe('1');
  });
});

describe('prepareCloudflareArtifact rejects bad inputs before the build', () => {
  it.each(['', 'abc', 'ABCDEF1', 'g123456', 'a'.repeat(65)])(
    'rejects the commit %j',
    async (commit) => {
      const root = makeRoot();
      const runBuild = vi.fn();

      const error = await rejection(
        prepareCloudflareArtifact(root, { outDir: join(root, 'artifact'), commit, runBuild }),
      );

      expect(error.message).toContain('commit');
      expect(runBuild).not.toHaveBeenCalled();
    },
  );

  it('accepts a lowercase hex commit before it fails for another reason', async () => {
    const root = makeRoot({ 'void.config.ts': "export default { target: 'node' };\n" });

    // A valid commit gets past validation, so the next check (the Node target) is what fails.
    const error = await rejection(
      prepareCloudflareArtifact(root, {
        outDir: join(root, 'artifact'),
        commit: 'abcdef0',
        runBuild: vi.fn(),
      }),
    );

    expect(error.message).toContain('targets node');
  });

  it('rejects an output directory that is not empty', async () => {
    const root = makeRoot({ 'artifact/stale.txt': 'left over' });
    const runBuild = vi.fn();

    const error = await rejection(
      prepareCloudflareArtifact(root, { outDir: join(root, 'artifact'), runBuild }),
    );

    expect(error.message).toContain('must be empty');
    expect(runBuild).not.toHaveBeenCalled();
  });

  it('rejects an output path that is a file', async () => {
    const root = makeRoot({ artifact: 'not a directory' });

    const error = await rejection(
      prepareCloudflareArtifact(root, { outDir: join(root, 'artifact'), runBuild: vi.fn() }),
    );

    expect(error.message).toContain('is not a directory');
  });

  it.each(['../outside.sql', 'db/../../outside.sql'])(
    'rejects a seed that escapes the root: %s',
    async (seed) => {
      const root = makeRoot();
      const runBuild = vi.fn();

      const error = await rejection(
        prepareCloudflareArtifact(root, { outDir: join(root, 'artifact'), seed, runBuild }),
      );

      expect(error.message).toContain('must be inside the app root');
      expect(runBuild).not.toHaveBeenCalled();
    },
  );

  it('rejects an absolute seed path outside the root', async () => {
    const root = makeRoot();
    const outside = makeRoot({ 'seed.sql': 'select 1;' });

    const error = await rejection(
      prepareCloudflareArtifact(root, {
        outDir: join(root, 'artifact'),
        seed: join(outside, 'seed.sql'),
        runBuild: vi.fn(),
      }),
    );

    expect(error.message).toContain('must be inside the app root');
  });

  it('rejects a seed that does not exist', async () => {
    const root = makeRoot();

    const error = await rejection(
      prepareCloudflareArtifact(root, {
        outDir: join(root, 'artifact'),
        seed: 'db/seed.sql',
        runBuild: vi.fn(),
      }),
    );

    expect(error.message).toContain('does not exist');
  });

  it('rejects a seed that is a directory', async () => {
    const root = makeRoot();
    mkdirSync(join(root, 'db', 'seed.sql'), { recursive: true });

    const error = await rejection(
      prepareCloudflareArtifact(root, {
        outDir: join(root, 'artifact'),
        seed: 'db/seed.sql',
        runBuild: vi.fn(),
      }),
    );

    expect(error.message).toContain('is not a regular file');
  });

  it.skipIf(isWindows)('rejects a seed that is a symlink', async () => {
    const root = makeRoot({ 'db/real-seed.sql': 'select 1;' });
    symlinkSync(join(root, 'db', 'real-seed.sql'), join(root, 'db', 'seed.sql'));

    const error = await rejection(
      prepareCloudflareArtifact(root, {
        outDir: join(root, 'artifact'),
        seed: 'db/seed.sql',
        runBuild: vi.fn(),
      }),
    );

    expect(error.message).toContain('symlinks are not permitted');
  });

  it.skipIf(isWindows)(
    'rejects a seed reached through a symlinked directory that leaves the root',
    async () => {
      const root = makeRoot();
      const outside = makeRoot({ 'seed.sql': 'select 1;' });
      symlinkSync(outside, join(root, 'linked'), 'dir');

      const error = await rejection(
        prepareCloudflareArtifact(root, {
          outDir: join(root, 'artifact'),
          seed: 'linked/seed.sql',
          runBuild: vi.fn(),
        }),
      );

      expect(error.message).toContain('must be inside the app root');
    },
  );

  it('rejects a Node target', async () => {
    const root = makeRoot({ 'void.config.ts': "export default { target: 'node' };\n" });

    const error = await rejection(
      prepareCloudflareArtifact(root, { outDir: join(root, 'artifact'), runBuild: vi.fn() }),
    );

    expect(error.message).toContain('targets node');
  });

  it('rejects static output', async () => {
    const root = makeRoot({ 'void.config.ts': "export default { output: 'static' };\n" });

    const error = await rejection(
      prepareCloudflareArtifact(root, { outDir: join(root, 'artifact'), runBuild: vi.fn() }),
    );

    expect(error.message).toContain('static output');
  });

  it('rejects a framework app', async () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ name: 'app', dependencies: { astro: '^5.0.0' } }),
    });

    const error = await rejection(
      prepareCloudflareArtifact(root, { outDir: join(root, 'artifact'), runBuild: vi.fn() }),
    );

    expect(error.message).toContain('only native Void apps');
  });
});

describe('deriveCloudflareArtifactRequirements', () => {
  const base: CloudflareArtifactRequirementsInput = {
    d1: null,
    isrCache: false,
    email: { inbound: false, send: false },
    builtConfig: {},
    seed: false,
  };

  it('needs no D1 when the app has none', () => {
    const requirements = deriveCloudflareArtifactRequirements({
      ...base,
      d1: null,
      seed: false,
    });

    expect(requirements).toEqual({
      d1: null,
      isrCache: false,
      email: { inbound: false, send: false },
      secrets: [],
      seed: false,
    });
  });

  it('records the D1 binding, the default migrations table, the journal and the migration order', () => {
    const requirements = deriveCloudflareArtifactRequirements({
      ...base,
      d1: {
        binding: 'DB',
        migrations: ['20260101000000_init.sql', '20260201000000_add_users.sql'],
        journal: true,
      },
    });

    expect(requirements.d1).toEqual({
      binding: 'DB',
      migrationsTable: 'd1_migrations',
      migrations: ['20260101000000_init.sql', '20260201000000_add_users.sql'],
      journal: true,
    });
  });

  it('keeps the migration order it is given, because that order is the apply order', () => {
    const requirements = deriveCloudflareArtifactRequirements({
      ...base,
      d1: { binding: 'DB', migrations: ['0002_b.sql', '0001_a.sql'], journal: false },
    });

    expect(requirements.d1?.migrations).toEqual(['0002_b.sql', '0001_a.sql']);
  });

  it('uses the configured migrations table, and records a missing journal as false', () => {
    const requirements = deriveCloudflareArtifactRequirements({
      ...base,
      d1: {
        binding: 'DB',
        migrationsTable: 'custom_migrations',
        migrations: ['0001_init.sql'],
        journal: false,
      },
    });

    expect(requirements.d1).toEqual({
      binding: 'DB',
      migrationsTable: 'custom_migrations',
      migrations: ['0001_init.sql'],
      journal: false,
    });
  });

  it('derives an empty migration list for a D1 app with no migrations folder', () => {
    const requirements = deriveCloudflareArtifactRequirements({
      ...base,
      d1: { binding: 'DB', migrations: [], journal: false },
    });

    expect(requirements.d1).toEqual({
      binding: 'DB',
      migrationsTable: 'd1_migrations',
      migrations: [],
      journal: false,
    });
  });

  it('passes the ISR cache flag through', () => {
    expect(deriveCloudflareArtifactRequirements({ ...base, isrCache: true }).isrCache).toBe(true);
  });

  it('marks inbound email only when the app has email handlers', () => {
    const requirements = deriveCloudflareArtifactRequirements({
      ...base,
      email: { inbound: true, send: false },
    });

    expect(requirements.email).toEqual({ inbound: true, send: false });
  });

  it('marks outbound email only when the app sends email', () => {
    const requirements = deriveCloudflareArtifactRequirements({
      ...base,
      email: { inbound: false, send: true },
    });

    expect(requirements.email).toEqual({ inbound: false, send: true });
  });

  it('sorts and de-duplicates the required secrets from the built config', () => {
    const requirements = deriveCloudflareArtifactRequirements({
      ...base,
      builtConfig: { secrets: { required: ['Z_KEY', 'BETTER_AUTH_SECRET', 'Z_KEY', 'A_KEY'] } },
    });

    expect(requirements.secrets).toEqual(['A_KEY', 'BETTER_AUTH_SECRET', 'Z_KEY']);
  });

  it('has no secrets when the built config declares none', () => {
    expect(deriveCloudflareArtifactRequirements({ ...base, builtConfig: {} }).secrets).toEqual([]);
  });

  it.each([
    ['a string', { required: 'BETTER_AUTH_SECRET' }],
    ['a non-string entry', { required: ['BETTER_AUTH_SECRET', 1] }],
    ['null', { required: null }],
    ['a non-object secrets field', 'BETTER_AUTH_SECRET'],
  ])('rejects malformed secrets.required: %s', (_label, secrets) => {
    expect(() =>
      deriveCloudflareArtifactRequirements({ ...base, builtConfig: { secrets } }),
    ).toThrow(/secrets/);
  });

  it('passes the seed flag through', () => {
    expect(deriveCloudflareArtifactRequirements({ ...base, seed: true }).seed).toBe(true);
  });
});
