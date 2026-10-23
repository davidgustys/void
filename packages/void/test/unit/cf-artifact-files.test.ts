import { spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vite-plus/test';
import {
  assertCloudflareArtifactPath,
  listCloudflareArtifactFiles,
  resolveCloudflareArtifactPath,
  verifyCloudflareArtifactFiles,
} from '../../src/cli/cf-artifact-files.ts';
import {
  fileEntry,
  sha256,
  catchArtifactError,
  expectArtifactError,
} from '../helpers/cf-artifact.ts';

const roots: Array<string> = [];
const isWindows = process.platform === 'win32';
const fifoSupported = !isWindows && spawnSync('mkfifo', ['--version']).error === undefined;

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Create a temp root that the next `afterEach` removes. */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-artifact-files-'));
  roots.push(root);
  return root;
}

/** Whether the temp filesystem resolves `a` to the same entry as `A`. */
function tempDirIsCaseInsensitive(): boolean {
  const root = mkdtempSync(join(tmpdir(), 'void-cf-artifact-case-'));
  try {
    writeFileSync(join(root, 'A'), '');
    return existsSync(join(root, 'a'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const caseInsensitiveTmp = tempDirIsCaseInsensitive();

it('lists nested files sorted by path with their size and SHA-256', () => {
  const root = tempRoot();
  mkdirSync(join(root, 'a'));
  mkdirSync(join(root, 'a-b'));
  mkdirSync(join(root, 'b', 'deep'), { recursive: true });
  mkdirSync(join(root, 'empty'));
  writeFileSync(join(root, 'a', 'x.txt'), 'one');
  writeFileSync(join(root, 'a-b', 'x.txt'), 'two!');
  writeFileSync(join(root, 'b', 'deep', 'c.txt'), '三');
  writeFileSync(join(root, 'top.txt'), 'top');

  // Full-path order puts "a-b/x.txt" first ("-" < "/"); per-directory order would not.
  expect(listCloudflareArtifactFiles(root)).toEqual([
    fileEntry('a-b/x.txt', 'two!'),
    fileEntry('a/x.txt', 'one'),
    fileEntry('b/deep/c.txt', '三'),
    fileEntry('top.txt', 'top'),
  ]);
});

it('leaves out excluded files without counting them toward limits', () => {
  const root = tempRoot();
  writeFileSync(join(root, 'artifact.txt'), 'ok');
  writeFileSync(join(root, 'envelope.json'), 'x'.repeat(100));
  const limits = { maxFiles: 1, maxFileBytes: 10, maxTotalBytes: 10 };

  expect(listCloudflareArtifactFiles(root, { exclude: ['envelope.json'], limits })).toEqual([
    fileEntry('artifact.txt', 'ok'),
  ]);
  expectArtifactError(
    () => listCloudflareArtifactFiles(root, { limits }),
    'limit',
    'envelope.json',
  );
});

it.skipIf(isWindows).each(['inside file', 'outside file', 'directory'])(
  'rejects linked %s',
  (kind) => {
    const root = tempRoot();
    const target = join(kind === 'outside file' ? tempRoot() : root, 'target');
    if (kind === 'directory') {
      mkdirSync(target);
    } else {
      writeFileSync(target, 'secret');
    }
    symlinkSync(target, join(root, 'link'), kind === 'directory' ? 'dir' : 'file');
    expectArtifactError(() => listCloudflareArtifactFiles(root), 'symlink', 'link');
  },
);

it.skipIf(isWindows)('accepts a root reached through a symlinked parent', () => {
  const real = tempRoot();
  const artifact = join(real, 'artifact');
  mkdirSync(artifact);
  writeFileSync(join(artifact, 'index.html'), '<h1>ok</h1>');
  const parent = tempRoot();
  symlinkSync(real, join(parent, 'alias'));
  expect(listCloudflareArtifactFiles(join(parent, 'alias', 'artifact'))).toEqual([
    fileEntry('index.html', '<h1>ok</h1>'),
  ]);
});

it('rejects a hard-linked file', () => {
  const root = tempRoot();
  writeFileSync(join(root, 'a.txt'), 'shared');
  linkSync(join(root, 'a.txt'), join(root, 'b.txt'));
  expectArtifactError(() => listCloudflareArtifactFiles(root), 'hardlink', 'a.txt');
});

it.skipIf(!fifoSupported)('rejects a FIFO without opening it', () => {
  const root = tempRoot();
  const made = spawnSync('mkfifo', [join(root, 'pipe')], { encoding: 'utf8' });
  expect(made.status, made.stderr).toBe(0);
  expectArtifactError(() => listCloudflareArtifactFiles(root), 'special-file', 'pipe');
});

it('rejects a root that is missing or is a regular file', () => {
  const parent = tempRoot();
  const file = join(parent, 'file.txt');
  writeFileSync(file, 'x');
  expectArtifactError(() => listCloudflareArtifactFiles(join(parent, 'missing')), 'root');
  expectArtifactError(() => listCloudflareArtifactFiles(file), 'root');
});

it.skipIf(isWindows)('rejects a root that is a symlink', () => {
  const real = tempRoot();
  writeFileSync(join(real, 'index.html'), '<h1>ok</h1>');
  const link = join(tempRoot(), 'link');
  symlinkSync(real, link);
  expectArtifactError(() => listCloudflareArtifactFiles(link), 'root');
});

it.each([
  ['maxFiles', 2, 1, 'b.txt'],
  ['maxFileBytes', 3, 2, 'a.txt'],
  ['maxTotalBytes', 6, 5, 'b.txt'],
] as const)('enforces %s at its boundary', (key, allowed, rejected, path) => {
  const root = tempRoot();
  writeFileSync(join(root, 'a.txt'), 'aaa');
  writeFileSync(join(root, 'b.txt'), 'bbb');
  expect(listCloudflareArtifactFiles(root, { limits: { [key]: allowed } })).toHaveLength(2);
  expectArtifactError(
    () => listCloudflareArtifactFiles(root, { limits: { [key]: rejected } }),
    'limit',
    path,
  );
});

it('enforces the depth limit with a path error', () => {
  const root = tempRoot();
  mkdirSync(join(root, 'a', 'b'), { recursive: true });
  writeFileSync(join(root, 'a', 'b', 'c.txt'), 'c');
  expect(listCloudflareArtifactFiles(root, { limits: { maxDepth: 3 } })).toHaveLength(1);
  expectArtifactError(
    () => listCloudflareArtifactFiles(root, { limits: { maxDepth: 2 } }),
    'path',
    'a/b/c.txt',
  );
});

it('enforces the path length limit with a path error', () => {
  const root = tempRoot();
  const name = `${'a'.repeat(12)}.txt`;
  writeFileSync(join(root, name), 'x');
  expect(listCloudflareArtifactFiles(root, { limits: { maxPathBytes: name.length } })).toHaveLength(
    1,
  );
  expectArtifactError(
    () => listCloudflareArtifactFiles(root, { limits: { maxPathBytes: 10 } }),
    'path',
    name,
  );
});

it.each(['', '/a', 'a/../b', './a', 'a//b', 'a/', 'a\\b', 'C:/x', 'a\u0000b', 'a\nb', 'a\u007fb'])(
  'rejects the unsafe path %j',
  (path) => expectArtifactError(() => assertCloudflareArtifactPath(path), 'path', path),
);

it.each(['a/b.txt', 'ünï/çødé.txt'])('accepts the safe path %s', (path) =>
  expect(() => assertCloudflareArtifactPath(path)).not.toThrow(),
);

it('counts path length in UTF-8 bytes, not characters', () => {
  // Four characters but twelve UTF-8 bytes: within a 12-byte limit, over an 11-byte one.
  const path = 'üüüü.txt';
  expect(() => assertCloudflareArtifactPath(path, { maxPathBytes: 12 })).not.toThrow();
  expectArtifactError(() => assertCloudflareArtifactPath(path, { maxPathBytes: 11 }), 'path', path);
});

it.skipIf(isWindows)('rejects an on-disk file whose name contains a backslash', () => {
  const root = tempRoot();
  writeFileSync(join(root, 'a\\b.txt'), 'x');
  expectArtifactError(() => listCloudflareArtifactFiles(root), 'path', 'a\\b.txt');
});

it('rejects expected paths that differ only by case', () =>
  expectArtifactError(
    () =>
      verifyCloudflareArtifactFiles(tempRoot(), [
        fileEntry('Readme.md', ''),
        fileEntry('readme.md', ''),
      ]),
    'path',
    'readme.md',
  ));

it.skipIf(caseInsensitiveTmp)('rejects files on disk whose paths differ only by case', () => {
  const root = tempRoot();
  writeFileSync(join(root, 'Readme.md'), 'upper');
  writeFileSync(join(root, 'readme.md'), 'lower');
  expectArtifactError(() => listCloudflareArtifactFiles(root), 'path', 'readme.md');
});

it('accepts a directory that exactly matches the expected files', () => {
  const root = tempRoot();
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'app.js'), 'export {};');
  writeFileSync(join(root, 'index.html'), '<h1>ok</h1>');
  writeFileSync(join(root, 'envelope.json'), '{}');
  const expected = [
    fileEntry('assets/app.js', 'export {};'),
    fileEntry('index.html', '<h1>ok</h1>'),
  ];

  expect(() =>
    verifyCloudflareArtifactFiles(root, expected, { exclude: ['envelope.json'] }),
  ).not.toThrow();
});

it('rejects an expected file that is not on disk', () => {
  const root = tempRoot();
  writeFileSync(join(root, 'a.txt'), 'a');
  expectArtifactError(
    () => verifyCloudflareArtifactFiles(root, [fileEntry('a.txt', 'a'), fileEntry('b.txt', 'b')]),
    'missing',
    'b.txt',
  );
});

it('rejects a file on disk that is not expected', () => {
  const root = tempRoot();
  writeFileSync(join(root, 'a.txt'), 'a');
  writeFileSync(join(root, 'b.txt'), 'b');
  expectArtifactError(
    () => verifyCloudflareArtifactFiles(root, [fileEntry('a.txt', 'a')]),
    'unexpected',
    'b.txt',
  );
});

it.each([
  [4, 'abc'],
  [3, 'xyz'],
] as const)('rejects size %s or hash mismatch', (size, content) => {
  const root = tempRoot();
  writeFileSync(join(root, 'a.txt'), 'abc');
  expectArtifactError(
    () => verifyCloudflareArtifactFiles(root, [{ path: 'a.txt', size, sha256: sha256(content) }]),
    'mismatch',
    'a.txt',
  );
});

it('reports the first problem in sorted order and counts the others', () => {
  const root = tempRoot();
  writeFileSync(join(root, 'extra.txt'), 'extra');
  const error = catchArtifactError(() =>
    verifyCloudflareArtifactFiles(root, [fileEntry('z.txt', 'z')]),
  );
  expect(error.code).toBe('unexpected');
  expect(error.path).toBe('extra.txt');
  expect(error.message).toBe(
    'The artifact contains an unexpected file: extra.txt (1 other problem found).',
  );
});

it.each([
  { name: 'a short hash', file: { path: 'a.txt', size: 1, sha256: 'abc' } },
  {
    name: 'an uppercase hash',
    file: { path: 'a.txt', size: 1, sha256: sha256('a').toUpperCase() },
  },
  { name: 'a negative size', file: { path: 'a.txt', size: -1, sha256: sha256('a') } },
  { name: 'a fractional size', file: { path: 'a.txt', size: 1.5, sha256: sha256('a') } },
])('rejects a malformed expected entry with $name', ({ file }) => {
  const root = tempRoot();
  writeFileSync(join(root, 'a.txt'), 'a');
  expectArtifactError(() => verifyCloudflareArtifactFiles(root, [file]), 'mismatch', 'a.txt');
});

it('resolves a safe relative path to an absolute path inside the root', () => {
  const root = tempRoot();
  expect(resolveCloudflareArtifactPath(root, 'a/b.txt')).toBe(join(root, 'a', 'b.txt'));
});

it.each(['../outside.txt', 'a/../../outside.txt', '/etc/passwd', 'C:/outside.txt'])(
  'rejects the path %j when resolving inside a root',
  (path) => {
    const root = tempRoot();
    expectArtifactError(() => resolveCloudflareArtifactPath(root, path), 'path', path);
  },
);
