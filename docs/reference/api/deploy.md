# Deployment artifacts

Use `void/deploy` from Node.js to prepare a built Void app, SPA, or static site for a managed platform deployment without platform credentials.

Build the app in managed mode inside its isolated environment:

```sh
VOID_DEPLOY_BUILD=1 VOID_DEPLOY_PROJECT_ID=artifact npm run build
```

These values select a platform-compatible build. The target project is selected during publish approval.

```ts
import { prepareDeployArtifact } from 'void/deploy';

const { artifact, assets } = await prepareDeployArtifact('/path/to/app');
```

`artifact` contains the deployment manifest, asset metadata, and any Worker modules. `assets` maps asset URL paths to base64 bytes. SPAs and static sites use the same output directory and routing configuration as `void deploy`. Keep the prepared result unchanged while requesting [publish approval](/guide/platform/administration/connected-apps).

Use this API for built Cloudflare Worker apps, SPAs, and static sites. For Node targets, Pages `output: 'static'`, remote data, deploy-time prerendering, Sandbox, or Live resources, use `void deploy`.

Run preparation inside the same isolated environment as the app build. App configuration and build plugins execute project code; keep platform credentials on the publishing server.

## Cloudflare Build Output

::: warning Experimental
`prepareCfBuildOutput` follows Cloudflare's draft Build Output format. Its options and the prepared directory can change between Void releases.
:::

Use `prepareCfBuildOutput` to prepare an existing Worker build for Cloudflare publication:

```ts
import { prepareCfBuildOutput } from 'void/deploy';

const prepared = await prepareCfBuildOutput('/path/to/app/dist/server', {
  projectRoot: '/path/to/app',
  mode: 'staging',
});
if (!prepared) {
  throw new Error('The Worker build could not be prepared.');
}

try {
  // Inspect or pass prepared.directory to your Cloudflare publication workflow.
} finally {
  await prepared.dispose();
}
```

Pass a Worker output directory containing a generated `wrangler.json`, such as `dist/ssr` or `dist/server`. For native Cloudflare Build Output, pass the project root containing `.cloudflare/output/v0`. The result is a temporary copy for your publication workflow. For Containers built from a local Dockerfile, publish from the same Docker environment used to build the image.

| Option        | Description                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accountId`   | Cloudflare account the build must target. A different account in the build returns `null`. When omitted, the build's account is kept or left unset.  |
| `mode`        | Vite build mode. Native output keeps the mode it was built with, and a different value returns `null`. For other output it defaults to `production`. |
| `projectRoot` | App directory containing `package.json` and its installed dependencies. Defaults to the input directory.                                             |

The result provides `directory`, an optional `assetsDirectory` pointing to the input assets, and an async `dispose()` method. Dispose the result after publication. Unsupported configurations return `null`; missing or invalid build files throw an error.

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
