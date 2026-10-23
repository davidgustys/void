# Deployment artifacts

Use `void/deploy` from Node.js to prepare a built Void app, SPA, or static site for a managed platform deployment without platform credentials.

Build the app in managed mode inside its isolated environment:

```sh
VOID_DEPLOY_BUILD=1 VOID_DEPLOY_PROJECT_ID=artifact npm run build
```

These values select a platform-compatible build. `artifact` is a build marker, not an existing project ID or a credential; the target project is selected during publish approval.

```ts
import { prepareDeployArtifact } from 'void/deploy';

const { artifact, assets } = await prepareDeployArtifact('/path/to/app');
```

`artifact` contains the deployment manifest, content-addressed asset metadata, and base64 Worker modules when the app needs a Worker. SPAs and static sites contain only assets, using the same app detection, output directory and routing configuration as `void deploy`. `assets` maps asset URL paths to base64 bytes. Keep this result immutable while requesting [publish approval](/guide/platform/administration/connected-apps).

Preparation packages existing build output; it does not build, contact a platform, provision resources, or deploy. It supports Void Cloudflare Worker builds, SPAs, and static sites. Node targets, Pages `output: 'static'`, remote data, deploy-time prerendering, Sandbox, and Live resources require the normal `void deploy` workflow instead.

Run preparation inside the same isolated environment as the app build. App configuration and build plugins execute project code; keep platform credentials on the publishing server.

## Cloudflare Build Output

::: warning Experimental
`prepareCfBuildOutput` follows Cloudflare's draft Build Output format. Its options and the prepared directory can change between Void releases.
:::

Use `prepareCfBuildOutput` to convert an existing Cloudflare Worker build into a disposable Cloudflare Build Output directory:

```ts
import { prepareCfBuildOutput } from 'void/deploy';

const prepared = await prepareCfBuildOutput('/path/to/app/dist/server', { mode: 'staging' });
if (!prepared) {
  throw new Error('The Worker build could not be prepared.');
}

try {
  // Inspect or pass prepared.directory to your Cloudflare publication workflow.
} finally {
  await prepared.dispose();
}
```

Pass the Worker output directory that contains a generated `wrangler.json`, such as `dist/ssr`, `dist/rsc`, or `dist/server`. When Cloudflare's build tooling built the app, pass the project root that contains its native Build Output at `.cloudflare/output/v0` instead. Preparation copies modules and assets without changing that input. Native output keeps its module types, auxiliary Workers, Container declarations, and build metadata. Preparation does not provision resources, upload a Worker, or activate a deployment. Container images built from a local Dockerfile exist only in the Docker environment that built them, so publish from that environment.

| Option      | Description                                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accountId` | Cloudflare account the build must target. A different account in the build returns `null`. When omitted, the build's account is kept or left unset.  |
| `mode`      | Vite build mode. Native output keeps the mode it was built with, and a different value returns `null`. For other output it defaults to `production`. |

The result contains `directory`, an optional `assetsDirectory` pointing to the input assets, and an asynchronous `dispose()` method. Always dispose the result after use. Unsupported build configuration returns `null`. A directory without a Worker build, a missing or invalid Worker module, or an asset symlink outside the asset directory throws an error.

## Cloudflare artifacts

::: warning Experimental
The Cloudflare artifact functions are experimental. Their options, the artifact layout and the target shape can change between Void releases.
:::

Cloudflare artifacts let a build job run the app without Cloudflare credentials and write an artifact directory for a separate trusted publish job.

### Prepare an artifact

Run preparation in the build job:

```ts
import { prepareCloudflareArtifact } from 'void/deploy';

await prepareCloudflareArtifact('/path/to/app', {
  outDir: '/path/to/artifact',
  seed: 'db/seed.sql',
  commit: process.env.GITHUB_SHA,
});
```

Preparation builds the app, runs Void's build checks, and writes the artifact to `outDir`. It resolves with the artifact manifest.

| Option   | Description                                                                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outDir` | Directory to write. It must be missing or empty.                                                                                                          |
| `seed`   | SQL file relative to the app root, inside the root and not a symlink. It runs after the migrations on every publish, so write it to be safe to run again. |
| `commit` | Source commit, 7 to 64 lowercase hex characters. It is recorded for information only.                                                                     |

Preparation refuses an app it cannot package: a PostgreSQL or MySQL database, a Node, Bun or Deno target, static output, a framework, Sandbox, Live, or a `seed` without a D1 database. It also refuses to run while Cloudflare credentials, such as `CLOUDFLARE_API_TOKEN`, are set, because the build runs project code.

Pass the artifact directory to the publish job unchanged.

### Publish an artifact

Run publish in the trusted job with `CLOUDFLARE_API_TOKEN` in the environment:

```ts
import { publishCloudflareArtifact } from 'void/deploy';

const published = await publishCloudflareArtifact('/path/to/artifact', {
  accountId: '0123456789abcdef0123456789abcdef',
  workerName: 'my-app-pr-42',
  bindings: {
    DB: { type: 'd1', id: '0b1f8c2e-1111-4222-8333-944455556666', name: 'my-app-pr-42-db' },
  },
  queues: {},
  secrets: { API_KEY: process.env.PREVIEW_API_KEY ?? '' },
  routes: [],
  workersDev: true,
  previewUrls: true,
  workersDevSubdomain: 'my-team',
  seed: true,
});
```

The target describes where the Worker goes:

| Field                 | Description                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `accountId`           | Cloudflare account ID.                                                                                              |
| `workerName`          | Worker to publish: lowercase letters, digits and hyphens, up to 63 characters.                                      |
| `apiBaseUrl`          | Optional Cloudflare API base URL. When set, it must equal `CLOUDFLARE_API_BASE_URL` in the environment.             |
| `bindings`            | Resources by binding name: every D1, KV and R2 binding the app declares, and nothing else.                          |
| `queues`              | Physical queue name for each logical queue. A physical name equals the logical name or ends with `-<logical name>`. |
| `isrCache`            | ISR cache KV namespace, `{ id }`. Required when the app needs an ISR cache.                                         |
| `email`               | Required when the app handles or sends email: `projectSlug`, `domain`, and optional `send` settings.                |
| `vars`                | Plain-text variables.                                                                                               |
| `secrets`             | Secret values by name. The names must match the app's required secrets exactly.                                     |
| `routes`              | `{ pattern, zoneName }` pairs, such as `pr-42.example.com/*` in its zone.                                           |
| `workersDev`          | Whether the Worker is served on workers.dev.                                                                        |
| `previewUrls`         | Whether version preview URLs are enabled.                                                                           |
| `workersDevSubdomain` | Your account's workers.dev subdomain. Needed to check readiness when `routes` is empty.                             |
| `seed`                | Whether to run the seed after the migrations.                                                                       |

Publish verifies the artifact against its manifest and checks the target before it contacts Cloudflare. It then:

1. Checks the Cloudflare session.
2. Applies the D1 migrations in build order. It saves a D1 restore point first, and prints the command that undoes the migrations.
3. Runs the seed, when `seed` is true.
4. Uploads a new Worker version, checks readiness on that exact version, moves traffic to it, and syncs triggers.

Publish creates no resources, so every binding must already exist. Routes, custom domains, workers.dev settings, email routing and log destinations from the app's configuration are ignored; the target decides them. A `seed.sql` larger than 100 KiB is refused.

A first publish of a new Worker sends traffic to it before the readiness check runs, so a failed check leaves that Worker serving. Keep preview Workers to test data.

Publish resolves with the Worker name, the new and previous version IDs, the URL that readiness checked, the applied migration names and whether the seed ran.

### Safety

- Run publish on a directory that no other process can write to. Publish verifies the artifact against its manifest, but it cannot guard against a writer that runs alongside it.
- Never give the build job Cloudflare credentials. Preparation refuses to run with them, and the build runs your project code.
- Give previews test-mode secrets only.

### Errors

| Error                            | Thrown when                                                                                         | Fields                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CloudflareArtifactError`        | The artifact fails a check, such as a file that differs from the manifest or a bad migration order. | `code` names the failed check, such as `mismatch` or `layout`; `path` names the entry.                                                                  |
| `CloudflareArtifactTargetError`  | The target is invalid or does not match the artifact.                                               | `field` is the dotted path of the bad field, such as `bindings.DB.id`.                                                                                  |
| `CloudflareArtifactPublishError` | A publish step fails after the target is accepted.                                                  | `reason` is `connect`, `auth`, `migrations` or `seed`, or an activation failure reason; `versionId` and `rollback` are set when a version was uploaded. |
