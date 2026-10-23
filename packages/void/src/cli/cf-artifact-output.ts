import { lstatSync, readdirSync } from 'node:fs';

/** Validate before project code runs and again before packaging writes anything. */
export function assertCloudflareArtifactOutputDirectory(outDir: string): boolean {
  const stats = lstatSync(outDir, { throwIfNoEntry: false });
  if (stats === undefined) {
    return false;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`The artifact output directory must not be a symlink: ${outDir}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`The artifact output path is not a directory: ${outDir}`);
  }
  if (readdirSync(outDir).length > 0) {
    throw new Error(`The artifact output directory must be empty: ${outDir}`);
  }
  return true;
}
