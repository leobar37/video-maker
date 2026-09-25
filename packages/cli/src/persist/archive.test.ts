import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { sha256Hex } from '@videomaker/core';
import type { ObjectMeta, ProviderContext } from '@videomaker/providers';

import {
  archiveKeyFor,
  ARCHIVE_MANIFEST_REL,
  computeArchiveInventory,
  resetArchiveStorageSource,
  runArchive,
  setArchiveStorageSource,
} from './index';
import { archiveSpec } from '../specs/persist';
import {
  cleanupTempDirs,
  countingProviderContext,
  fakeRunContext,
  FakeObjectStore,
  makeTempDir,
} from './test-support';

afterAll(cleanupTempDirs);
afterEach(resetArchiveStorageSource);

async function seedMediaProject(root: string): Promise<void> {
  await fsp.mkdir(join(root, 'renders'), { recursive: true });
  await fsp.mkdir(join(root, 'assets'), { recursive: true });
  await fsp.mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await fsp.writeFile(join(root, 'renders', 'hero.mp4'), Buffer.from('FAKE-VIDEO-BYTES'));
  await fsp.writeFile(join(root, 'assets', 'cover.png'), Buffer.from('FAKE-PNG-BYTES'));
  await fsp.writeFile(join(root, 'assets', 'notes.md'), '# not a binary');
  await fsp.writeFile(join(root, 'video.json'), '{"id":"demo"}\n');
  await fsp.writeFile(join(root, 'node_modules', 'pkg', 'clip.mp4'), 'regenerable, never uploaded');
}

interface Wired {
  store: FakeObjectStore;
  ctx: ProviderContext;
  counts: { fetch: number; secrets: number };
}

/** Installs the in-memory store behind the seam and returns it for assertions. */
function wireFakeStore(): Wired {
  const store = new FakeObjectStore();
  const counted = countingProviderContext();
  setArchiveStorageSource(() => ({ store, ctx: counted.ctx }));
  return { store, ctx: counted.ctx, counts: counted.counts };
}

describe('archive: content-addressed upload + provenance', () => {
  test('uploads binaries under content-addressed keys and seals qa/archive.json', async () => {
    const base = await makeTempDir();
    const project = join(base, 'project');
    await seedMediaProject(project);
    const { store, ctx, counts } = wireFakeStore();

    const result = await runArchive(project, { store, ctx });
    expect(result.uploaded.length).toBe(2);
    expect(result.objects.map((object) => object.path).sort()).toEqual([
      'assets/cover.png',
      'renders/hero.mp4',
    ]);

    const hero = result.objects.find((object) => object.path === 'renders/hero.mp4')!;
    expect(hero.key).toBe(archiveKeyFor('objects', hero.sha256));
    expect(hero.key).toBe(`objects/${hero.sha256.slice(0, 2)}/${hero.sha256}`);
    expect(store.calls.filter((call) => call.op === 'put').map((call) => call.key).sort()).toEqual(
      result.uploaded.sort(),
    );

    const manifestRaw = await fsp.readFile(join(project, ARCHIVE_MANIFEST_REL), 'utf8');
    const manifest = JSON.parse(manifestRaw) as {
      schemaVersion: number;
      objects: Array<{ path: string; key: string; sha256: string; bytes: number }>;
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.objects).toEqual(result.objects);
    for (const object of manifest.objects) {
      expect(object.key).toBe(archiveKeyFor('objects', object.sha256));
    }

    // The store never saw fetch or secret resolution during the run.
    expect(counts).toEqual({ fetch: 0, secrets: 0 });
  });

  test('identical bytes at two paths share one object key', async () => {
    const base = await makeTempDir();
    const project = join(base, 'project');
    await fsp.mkdir(join(project, 'renders'), { recursive: true });
    await fsp.mkdir(join(project, 'assets'), { recursive: true });
    await fsp.writeFile(join(project, 'renders', 'a.mp4'), Buffer.from('SAME-BYTES'));
    await fsp.writeFile(join(project, 'assets', 'b.png'), Buffer.from('SAME-BYTES'));

    const store = new FakeObjectStore();
    const result = await runArchive(project, { store, ctx: countingProviderContext().ctx });
    const expectedKey = archiveKeyFor('objects', sha256Hex('SAME-BYTES'));
    expect(result.objects.map((object) => object.key)).toEqual([expectedKey, expectedKey]);
    expect(result.uploaded).toEqual([expectedKey]);
    expect(store.calls.filter((call) => call.op === 'put').length).toBe(1);
  });

  test('a second run is idempotent: nothing re-uploaded, manifest unchanged', async () => {
    const base = await makeTempDir();
    const project = join(base, 'project');
    await seedMediaProject(project);
    const { store, ctx } = wireFakeStore();

    const first = await runArchive(project, { store, ctx });
    const manifestPath = first.manifestPath;
    const sealed = await fsp.readFile(manifestPath, 'utf8');

    const second = await runArchive(project, { store, ctx });
    expect(second.uploaded).toEqual([]);
    expect(second.skipped.sort()).toEqual(first.uploaded.sort());
    expect(second.manifestWritten).toBe(false);
    expect(await fsp.readFile(manifestPath, 'utf8')).toBe(sealed);
  });

  test('inventory selection skips non-binaries and regenerables', async () => {
    const base = await makeTempDir();
    const project = join(base, 'project');
    await seedMediaProject(project);

    const inventory = await computeArchiveInventory(project);
    const paths = inventory.map((object) => object.path).sort();
    expect(paths).toEqual(['assets/cover.png', 'renders/hero.mp4']);
  });

  test('store metadata that contradicts the local bytes refuses the seal', async () => {
    const base = await makeTempDir();
    const project = join(base, 'project');
    await seedMediaProject(project);

    /** Put answers with a byte count that does not match the uploaded body. */
    class LyingPutStore extends FakeObjectStore {
      override async put(key: string, body: Uint8Array): Promise<ObjectMeta> {
        return { key, bytes: body.byteLength + 1 };
      }
    }

    await expect(
      runArchive(project, { store: new LyingPutStore(), ctx: countingProviderContext().ctx }),
    ).rejects.toThrow(/qa\/archive\.json was not sealed/);
    await expect(fsp.stat(join(project, ARCHIVE_MANIFEST_REL))).rejects.toThrow();
  });
});

describe('archive command spec', () => {
  test('plan() lists upload steps without touching the store, fetch, or secrets', async () => {
    const base = await makeTempDir();
    const project = join(base, 'project');
    await seedMediaProject(project);

    let factoryCalls = 0;
    const store = new FakeObjectStore();
    const counted = countingProviderContext();
    setArchiveStorageSource(() => {
      factoryCalls += 1;
      return { store, ctx: counted.ctx };
    });

    const steps = await archiveSpec.plan(fakeRunContext({ args: { project } }));
    expect(factoryCalls).toBe(0);
    expect(counted.counts).toEqual({ fetch: 0, secrets: 0 });
    expect(store.calls).toEqual([]);

    const uploadSteps = steps.filter((step) => step.writes === undefined);
    expect(uploadSteps.length).toBe(2);
    for (const step of uploadSteps) {
      expect(step.target).toMatch(/^objects\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
    }
    const sealStep = steps.find((step) => step.writes === ARCHIVE_MANIFEST_REL);
    expect(sealStep?.writes).toBe(ARCHIVE_MANIFEST_REL);
  });

  test('run() refuses in plan mode and resolves no storage', async () => {
    const base = await makeTempDir();
    const project = join(base, 'project');
    await seedMediaProject(project);

    let factoryCalls = 0;
    setArchiveStorageSource(() => {
      factoryCalls += 1;
      return { store: new FakeObjectStore(), ctx: countingProviderContext().ctx };
    });

    await expect(
      archiveSpec.run(fakeRunContext({ mode: 'plan', args: { project } })),
    ).rejects.toThrow(/plan mode/);
    expect(factoryCalls).toBe(0);
  });

  test('run() without a configured ObjectStore fails actionably; with one it seals', async () => {
    const base = await makeTempDir();
    const project = join(base, 'project');
    await seedMediaProject(project);

    await expect(archiveSpec.run(fakeRunContext({ args: { project } }))).rejects.toThrow(
      /ObjectStore but none is configured/,
    );

    const { store } = wireFakeStore();
    const ctx = fakeRunContext({ args: { project } });
    const result = await archiveSpec.run(ctx);
    expect(result.exitCode).toBe(0);
    expect(ctx.lines.join('\n')).toContain('qa/archive.json');
    expect(store.calls.some((call) => call.op === 'put')).toBe(true);
  });
});
