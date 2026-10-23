import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'pathslash';

export type CloudflareArtifactFile = { path: string; size: number; sha256: string };

export type CloudflareArtifactLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxPathBytes: number;
  maxDepth: number;
};

export const DEFAULT_CLOUDFLARE_ARTIFACT_LIMITS: Readonly<CloudflareArtifactLimits> = {
  maxFiles: 50_000,
  maxFileBytes: 25 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxPathBytes: 1024,
  maxDepth: 64,
};

export type CloudflareArtifactErrorCode =
  | 'root'
  | 'path'
  | 'symlink'
  | 'hardlink'
  | 'special-file'
  | 'limit'
  | 'missing'
  | 'unexpected'
  | 'mismatch'
  | 'manifest'
  | 'layout'
  | 'worker-config'
  | 'digest';

/** A rejected artifact: `code` names the failed check, and `path` names the entry if any. */
export class CloudflareArtifactError extends Error {
  readonly code: CloudflareArtifactErrorCode;
  readonly path?: string;

  constructor(code: CloudflareArtifactErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'CloudflareArtifactError';
    this.code = code;
    this.path = path;
  }
}

export type CloudflareArtifactFileOptions = {
  limits?: Partial<CloudflareArtifactLimits>;
  /** Exact relative paths to leave out of the listing, such as the envelope file itself. */
  exclude?: ReadonlyArray<string>;
};

type VerifyProblem = { code: CloudflareArtifactErrorCode; path: string; message: string };

const encoder = new TextEncoder();
const DRIVE_PREFIX = /^[A-Za-z]:/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Compare by UTF-16 code unit, so the order does not depend on the locale. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether `path` resolves strictly inside `directory`. */
function isInside(directory: string, path: string): boolean {
  const child = relative(directory, path);
  return child !== '' && child !== '..' && !child.startsWith('../') && !isAbsolute(child);
}

/** Whether `path` is a real directory. A symlink to one, or a missing path, is not. */
function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function mergeLimits(limits: Partial<CloudflareArtifactLimits> = {}): CloudflareArtifactLimits {
  return {
    maxFiles: limits.maxFiles ?? DEFAULT_CLOUDFLARE_ARTIFACT_LIMITS.maxFiles,
    maxFileBytes: limits.maxFileBytes ?? DEFAULT_CLOUDFLARE_ARTIFACT_LIMITS.maxFileBytes,
    maxTotalBytes: limits.maxTotalBytes ?? DEFAULT_CLOUDFLARE_ARTIFACT_LIMITS.maxTotalBytes,
    maxPathBytes: limits.maxPathBytes ?? DEFAULT_CLOUDFLARE_ARTIFACT_LIMITS.maxPathBytes,
    maxDepth: limits.maxDepth ?? DEFAULT_CLOUDFLARE_ARTIFACT_LIMITS.maxDepth,
  };
}

/** Whether `path` contains a C0 control character or DEL. */
function hasControlCharacter(path: string): boolean {
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** Return why `path` is not a safe relative path, or `undefined` when it is one. */
function unsafePathReason(path: string, limits: CloudflareArtifactLimits): string | undefined {
  const segments = path.split('/');
  if (path === '') {
    return 'it is empty';
  }
  if (path.startsWith('/') || DRIVE_PREFIX.test(path)) {
    return 'it is absolute or starts with a drive letter';
  }
  if (path.includes('\\')) {
    return 'it contains a backslash';
  }
  if (hasControlCharacter(path)) {
    return 'it contains a control character';
  }
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'it has an empty, "." or ".." segment';
  }
  if (encoder.encode(path).byteLength > limits.maxPathBytes) {
    return `it is longer than ${limits.maxPathBytes} bytes`;
  }
  if (segments.length > limits.maxDepth) {
    return `it is nested more than ${limits.maxDepth} levels deep`;
  }
  return undefined;
}

function sha256Hex(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}

/** Throw unless `path` is a safe relative POSIX path. */
export function assertCloudflareArtifactPath(
  path: string,
  limits?: Partial<CloudflareArtifactLimits>,
): void {
  const reason = unsafePathReason(path, mergeLimits(limits));
  if (reason !== undefined) {
    throw new CloudflareArtifactError(
      'path',
      `The artifact path ${JSON.stringify(path)} is unsafe because ${reason}.`,
      path,
    );
  }
}

/** List every regular file under `root`, sorted by path, with size and SHA-256. */
export function listCloudflareArtifactFiles(
  root: string,
  options: CloudflareArtifactFileOptions = {},
): Array<CloudflareArtifactFile> {
  const base = resolve(root);
  if (!isRealDirectory(base)) {
    throw new CloudflareArtifactError(
      'root',
      `The artifact root must be a real directory: ${root}`,
    );
  }
  const limits = mergeLimits(options.limits);
  const excluded = new Set(options.exclude);
  const files: Array<CloudflareArtifactFile> = [];
  const lowercasePaths = new Set<string>();
  let totalBytes = 0;

  const visit = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort(compareCodeUnits)) {
      const path = prefix === '' ? name : `${prefix}/${name}`;
      assertCloudflareArtifactPath(path, limits);
      const absolute = join(directory, name);
      // lstat never follows a link, so a link is rejected rather than read through.
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink()) {
        throw new CloudflareArtifactError(
          'symlink',
          `The artifact contains a symlink: ${path}`,
          path,
        );
      }
      if (stats.isDirectory()) {
        visit(absolute, path);
        continue;
      }
      if (!stats.isFile()) {
        throw new CloudflareArtifactError(
          'special-file',
          `The artifact contains a special file: ${path}`,
          path,
        );
      }
      if (stats.nlink > 1) {
        throw new CloudflareArtifactError(
          'hardlink',
          `The artifact contains a hard link: ${path}`,
          path,
        );
      }
      if (excluded.has(path)) {
        continue;
      }
      const key = path.toLowerCase();
      if (lowercasePaths.has(key)) {
        throw new CloudflareArtifactError(
          'path',
          `The artifact contains paths that differ only by case: ${path}`,
          path,
        );
      }
      // Limits use the lstat size, so an oversized file is rejected before it is read.
      if (files.length >= limits.maxFiles) {
        throw new CloudflareArtifactError(
          'limit',
          `The artifact contains more than ${limits.maxFiles} files: ${path}`,
          path,
        );
      }
      if (stats.size > limits.maxFileBytes) {
        throw new CloudflareArtifactError(
          'limit',
          `The artifact file is larger than ${limits.maxFileBytes} bytes: ${path}`,
          path,
        );
      }
      if (totalBytes + stats.size > limits.maxTotalBytes) {
        throw new CloudflareArtifactError(
          'limit',
          `The artifact is larger than ${limits.maxTotalBytes} bytes in total: ${path}`,
          path,
        );
      }
      totalBytes += stats.size;
      lowercasePaths.add(key);
      files.push({ path, size: stats.size, sha256: sha256Hex(readFileSync(absolute)) });
    }
  };
  visit(base, '');
  // Walking sorts each directory separately, so a final sort of full paths is still needed.
  return files.sort((a, b) => compareCodeUnits(a.path, b.path));
}

/** Throw unless the files under `root` exactly match `expected`. */
export function verifyCloudflareArtifactFiles(
  root: string,
  expected: ReadonlyArray<CloudflareArtifactFile>,
  options: CloudflareArtifactFileOptions = {},
): void {
  const limits = mergeLimits(options.limits);
  // Path problems are reported before size or hash problems in `expected`.
  const seen = new Set<string>();
  for (const file of expected) {
    assertCloudflareArtifactPath(file.path, limits);
    const key = file.path.toLowerCase();
    if (seen.has(key)) {
      throw new CloudflareArtifactError(
        'path',
        `The expected artifact lists paths that differ only by case: ${file.path}`,
        file.path,
      );
    }
    seen.add(key);
  }
  for (const file of expected) {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || !SHA256_HEX.test(file.sha256)) {
      throw new CloudflareArtifactError(
        'mismatch',
        `The expected entry has a malformed size or SHA-256: ${file.path}`,
        file.path,
      );
    }
  }

  const actual = listCloudflareArtifactFiles(root, options);
  const actualByPath = new Map<string, CloudflareArtifactFile>(
    actual.map((file) => [file.path, file]),
  );
  const expectedPaths = new Set(expected.map((file) => file.path));
  const problems: Array<VerifyProblem> = [];
  for (const file of expected) {
    const found = actualByPath.get(file.path);
    if (!found) {
      problems.push({
        code: 'missing',
        path: file.path,
        message: `The artifact is missing: ${file.path}`,
      });
    } else if (found.size !== file.size || found.sha256 !== file.sha256) {
      problems.push({
        code: 'mismatch',
        path: file.path,
        message: `The artifact file does not match its expected size or SHA-256: ${file.path}`,
      });
    }
  }
  for (const file of actual) {
    if (!expectedPaths.has(file.path)) {
      problems.push({
        code: 'unexpected',
        path: file.path,
        message: `The artifact contains an unexpected file: ${file.path}`,
      });
    }
  }
  if (problems.length === 0) {
    return;
  }
  problems.sort((a, b) => compareCodeUnits(a.path, b.path));
  const [first] = problems;
  const others = problems.length - 1;
  const note =
    others === 0 ? '' : ` (${others} other ${others === 1 ? 'problem' : 'problems'} found)`;
  throw new CloudflareArtifactError(first.code, `${first.message}${note}.`, first.path);
}

/** Return the absolute path of `path` inside `root`, after validating it. */
export function resolveCloudflareArtifactPath(root: string, path: string): string {
  assertCloudflareArtifactPath(path);
  const base = resolve(root);
  const absolute = join(base, path);
  if (!isInside(base, absolute)) {
    throw new CloudflareArtifactError(
      'path',
      `The artifact path resolves outside its root: ${path}`,
      path,
    );
  }
  return absolute;
}
