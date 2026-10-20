import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  createIsolatedPlayground,
  type IsolatedPlayground,
} from '../../../../test/integration-helpers.ts';
import { prepareCloudflareArtifact } from '../../src/cli/cf-artifact-prepare.ts';
import {
  type CloudflareArtifactManifest,
  readCloudflareArtifact,
} from '../../src/cli/cf-artifact-schema.ts';

// A real build of kitchen-sink, with no Cloudflare credentials, through the artifact pipeline.
// The build itself runs `vp build`, so the first run is slow.

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SOURCE_PLAYGROUND = 'playground/kitchen-sink';
const BUILD_TIMEOUT_MS = 300_000;
const COMMIT = 'abcdef0123';
// The kitchen-sink build imports `@void/vue` from its `dist`, which `vp pack` in packages/vue creates.
const VUE_DIST = join(ROOT, 'packages', 'vue', 'dist', 'index.mjs');
const SKIP_REASON = existsSync(VUE_DIST)
  ? undefined
  : 'packages/vue has no dist, so kitchen-sink cannot build. Run `vp pack` in packages/vue, then rerun.';
// Sandbox is out of scope for an artifact, so its route, pages and helper leave the copy.
const SANDBOX_FILES = [
  'routes/api/sandbox.ts',
  'pages/sandbox.server.ts',
  'pages/sandbox.vue',
  'lib/sandbox-demo.ts',
];

if (SKIP_REASON) {
  console.warn(`cf-artifact-prepare integration test skipped: ${SKIP_REASON}`);
}

let playground: IsolatedPlayground;
let outDir: string;
let manifest: CloudflareArtifactManifest;
let fetchSpy: ReturnType<typeof vi.spyOn>;

/** Every file name under `directory`, recursively. Symlinks are not followed. */
function listNames(directory: string): Array<string> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? [entry.name, ...listNames(join(directory, entry.name)).map((n) => `${entry.name}/${n}`)]
      : [entry.name],
  );
}

describe.skipIf(SKIP_REASON !== undefined)(
  'prepareCloudflareArtifact on playground/kitchen-sink',
  () => {
    beforeAll(async () => {
      playground = createIsolatedPlayground(ROOT, SOURCE_PLAYGROUND);
      const pg = playground.root;
      for (const file of SANDBOX_FILES) {
        rmSync(join(pg, file), { force: true });
      }
      writeFileSync(join(pg, 'db', 'seed.sql'), '-- Idempotent seed for the preview.\nSELECT 1;\n');
      outDir = join(pg, 'artifact');
      // The artifact path must never reach Cloudflare, so a network call would show up here.
      fetchSpy = vi.spyOn(globalThis, 'fetch');

      manifest = await prepareCloudflareArtifact(pg, {
        outDir,
        seed: 'db/seed.sql',
        commit: COMMIT,
      });
    }, BUILD_TIMEOUT_MS);

    afterAll(() => {
      vi.restoreAllMocks();
      playground?.cleanup();
    });

    it('writes a manifest that verifies against the directory', () => {
      expect(readCloudflareArtifact(outDir)).toEqual(manifest);
    });

    it('makes no network request', () => {
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('lists the D1 migrations in apply order and records the journal', () => {
      const source = join(ROOT, SOURCE_PLAYGROUND, 'db', 'migrations');
      const fixtureMigrations = readdirSync(source)
        .filter((name) => name.endsWith('.sql'))
        .sort();

      expect(manifest.requirements.d1).toMatchObject({
        binding: 'DB',
        migrationsTable: 'd1_migrations',
        journal: true,
      });
      expect(manifest.requirements.d1?.migrations).toEqual(fixtureMigrations);
      expect(
        listNames(join(outDir, 'migrations'))
          .filter((n) => n.endsWith('.sql'))
          .sort(),
      ).toEqual(fixtureMigrations);
    });

    it('requires ISR_CACHE, because kitchen-sink uses ISR', () => {
      expect(manifest.requirements.isrCache).toBe(true);
    });

    it('requires email for inbound handlers and outbound sends', () => {
      expect(manifest.requirements.email).toEqual({ inbound: true, send: true });
    });

    it('lists the required secrets, sorted, including BETTER_AUTH_SECRET', () => {
      const { secrets } = manifest.requirements;
      expect(secrets).toContain('BETTER_AUTH_SECRET');
      expect(secrets).toEqual([...secrets].sort());
    });

    it('copies the seed and records it', () => {
      expect(manifest.requirements.seed).toBe(true);
      expect(readFileSync(join(outDir, 'seed.sql'), 'utf8')).toContain('SELECT 1;');
    });

    it('holds no local secret files', () => {
      const names = listNames(outDir);
      expect(names.filter((name) => /(^|\/)(\.dev\.vars|\.env)/.test(name))).toEqual([]);
    });

    it('keeps the placeholder IDs, because no account exists in this build', () => {
      const workerConfig = JSON.parse(
        readFileSync(
          join(outDir, '.cloudflare/output/v0/workers/default/worker.config.json'),
          'utf8',
        ),
      ) as { env: Record<string, { id?: string }> };

      expect(workerConfig.env.DB?.id).toBe('local');
      expect(workerConfig.env.KV?.id).toBe('local');
    });

    it('records the provenance: the Void version, the commit and a build time', () => {
      const voidPackage = JSON.parse(
        readFileSync(join(ROOT, 'packages', 'void', 'package.json'), 'utf8'),
      ) as { version: string };

      expect(manifest.provenance).toMatchObject({
        voidVersion: voidPackage.version,
        commit: COMMIT,
      });
      expect(manifest.provenance.builtAt).not.toBeNull();
    });

    it('refuses the Sandbox app before it builds', async () => {
      // This copy keeps its Sandbox files, so the scope check must refuse it before any build.
      const withSandbox = createIsolatedPlayground(ROOT, SOURCE_PLAYGROUND);
      try {
        const runBuild = vi.fn();

        await expect(
          prepareCloudflareArtifact(withSandbox.root, {
            outDir: join(withSandbox.root, 'artifact'),
            runBuild,
          }),
        ).rejects.toThrow('Sandbox');
        expect(runBuild).not.toHaveBeenCalled();
      } finally {
        withSandbox.cleanup();
      }
    });
  },
);
