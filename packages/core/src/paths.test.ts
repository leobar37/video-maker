import { afterAll, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { PathTraversalError, resolveInsideProject, resolveProjectPath } from './paths';

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const dir = await fsp.mkdtemp(join(import.meta.dir, '.tmp-'));
  tempDirs.push(dir);
  return dir;
}

describe('resolveProjectPath', () => {
  test('resolves nested segments under the root', async () => {
    const root = await makeRoot();
    const resolved = await resolveProjectPath(root, 'acme', '01-launch', 'video.json');
    expect(resolved).toBe(join(await fsp.realpath(root), 'acme/01-launch/video.json'));
  });

  test('accepts multi-part segments', async () => {
    const root = await makeRoot();
    const resolved = await resolveProjectPath(root, 'scenes/s1/capture.mp4');
    expect(resolved).toBe(join(await fsp.realpath(root), 'scenes/s1/capture.mp4'));
  });

  test('returns the canonical root when no segments are given', async () => {
    const root = await makeRoot();
    expect(await resolveProjectPath(root)).toBe(await fsp.realpath(root));
  });

  test('rejects absolute segments', async () => {
    const root = await makeRoot();
    for (const segment of ['/etc/passwd', '/tmp/escape']) {
      await expect(resolveProjectPath(root, segment)).rejects.toThrow(PathTraversalError);
    }
  });

  test('rejects dot segments', async () => {
    const root = await makeRoot();
    for (const segment of ['..', '.', 'a/../b', './a']) {
      await expect(resolveProjectPath(root, segment)).rejects.toThrow(PathTraversalError);
    }
  });

  test('rejects empty segments and backslashes', async () => {
    const root = await makeRoot();
    for (const segment of ['', 'a//b', 'a\\b']) {
      await expect(resolveProjectPath(root, segment)).rejects.toThrow(PathTraversalError);
    }
  });

  test('rejects symlink escapes', async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await fsp.writeFile(join(outside, 'secret.txt'), 'outside');
    await fsp.symlink(outside, join(root, 'link'));
    await expect(resolveProjectPath(root, 'link', 'secret.txt')).rejects.toThrow(PathTraversalError);
    await expect(resolveProjectPath(root, 'link')).rejects.toThrow(PathTraversalError);
  });

  test('rejects dangling symlinks it cannot verify', async () => {
    const root = await makeRoot();
    await fsp.symlink(join(root, 'never-created'), join(root, 'dangling'));
    await expect(resolveProjectPath(root, 'dangling')).rejects.toThrow(PathTraversalError);
  });

  test('follows symlinks that stay inside the root', async () => {
    const root = await makeRoot();
    await fsp.mkdir(join(root, 'real'));
    await fsp.symlink(join(root, 'real'), join(root, 'alias'));
    const resolved = await resolveProjectPath(root, 'alias', 'file.txt');
    expect(resolved).toBe(join(await fsp.realpath(root), 'real/file.txt'));
  });

  test('allows missing leaves under a verified ancestor', async () => {
    const root = await makeRoot();
    const resolved = await resolveProjectPath(root, 'missing', 'deep', 'file.txt');
    expect(resolved).toBe(join(await fsp.realpath(root), 'missing/deep/file.txt'));
  });

  test('rejects when the root does not exist', async () => {
    const root = await makeRoot();
    await expect(resolveProjectPath(join(root, 'nope'), 'a')).rejects.toThrow();
  });
});

describe('resolveInsideProject', () => {
  test('resolves project-relative artifacts', async () => {
    const projectDir = await makeRoot();
    const resolved = await resolveInsideProject(projectDir, 'qa', 'report.json');
    expect(resolved).toBe(join(await fsp.realpath(projectDir), 'qa/report.json'));
  });

  test('applies the same traversal rules', async () => {
    const projectDir = await makeRoot();
    const outside = await makeRoot();
    await fsp.symlink(outside, join(projectDir, 'link'));
    for (const segments of [['..', 'x'], ['link', 'x'], ['/etc']]) {
      await expect(resolveInsideProject(projectDir, ...segments)).rejects.toThrow(
        PathTraversalError,
      );
    }
  });
});
