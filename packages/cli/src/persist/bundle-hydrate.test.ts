import { afterAll, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import {
  buildBundle,
  computeBundleInventory,
  defaultBundleDir,
  hydrateBundle,
  isExcludedPath,
  PersistError,
  readBundleManifest,
  setArchiveStorageSource,
  resetArchiveStorageSource,
  MANIFEST_NAME,
  computeRootHash,
} from './index';
import { bundleSpec, hydrateSpec } from '../specs/persist';
import {
  cleanupTempDirs,
  countingProviderContext,
  FailSignal,
  fakeRunContext,
  FakeObjectStore,
  makeTempDir,
} from './test-support';

afterAll(cleanupTempDirs);

/** Seeds a small project: real content + regenerables that must stay out. */
async function seedProject(root: string): Promise<void> {
  await fsp.mkdir(join(root, 'script'), { recursive: true });
  await fsp.mkdir(join(root, 'renders'), { recursive: true });
  await fsp.mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await fsp.mkdir(join(root, '.cache', 'frames'), { recursive: true });
  await fsp.writeFile(join(root, 'video.json'), '{"id":"demo","product":"acme"}\n');
  await fsp.writeFile(join(root, 'script', '01-hook.md'), '# hook\n');
  await fsp.writeFile(join(root, 'renders', 'hero.mp4'), Buffer.from('FAKE-VIDEO-BYTES'));
  await fsp.writeFile(join(root, 'renders', 'partial.mp4.tmp'), 'temp junk');
  await fsp.writeFile(join(root, 'bun.lock'), '{}');
  await fsp.writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'regenerable');
  await fsp.writeFile(join(root, '.cache', 'frames', '001.png'), 'regenerable');
}

const SEALED_PATHS = ['renders/hero.mp4', 'script/01-hook.md', 'video.json'];

describe('bundle → hydrate round trip', () => {
  test('restores byte-for-byte with rootHash verified end to end', async () => {
    const base = await makeTempDir();
    const project = join(base, 'project');
    await seedProject(project);

    const built = await buildBundle(project);
    expect(built.manifest.files.map((file) => file.path)).toEqual(SEALED_PATHS);
    expect(computeRootHash(built.manifest.files)).toBe(built.manifest.rootHash);

    const target = join(base, 'restored');
    const result = await hydrateBundle(built.outDir, target);
    expect(result.fileCount).toBe(SEALED_PATHS.length);

    for (const rel of SEALED_PATHS) {
      const original = await fsp.readFile(join(project, rel));
      const restored = await fsp.readFile(join(target, rel));
      expect(restored.equals(original)).toBe(true);
    }

    // The restored tree re-bundles to the SAME rootHash: content proven equal.
    const reInventory = await computeBundleInventory(target);
    expect(reInventory.rootHash).toBe(built.manifest.rootHash);
  });

  test('default bundle dir is <project>/../bundles/<slug>-<rootHashPrefix>/', async () => {
    const base = await makeTempDir();
    const project = join(base, 'project');
    await seedProject(project);
    const inventory = await computeBundleInventory(project);
    const expected = join(
      base,
      'bundles',
      `project-${inventory.rootHash.slice(0, 12)}`,
    );
    expect(defaultBundleDir(project, inventory.rootHash)).toBe(expected);
    const built = await buildBundle(project);
    expect(built.outDir).toBe(expected);
    expect(
      (await fsp.readFile(join(built.outDir, MANIFEST_NAME), 'utf8')).endsWith('\n'),
    ).toBe(true);
  });

  test('restoring twice is idempotent (second run rewrites nothing)', async () => {
    const base = await makeTempDir();
    const project = join(base, 'project');
    await seedProject(project);
    const built = await buildBundle(project);
    const target = join(base, 'restored');

    const first = await hydrateBundle(built.outDir, target);
    const second = await hydrateBundle(built.outDir, target);
    expect(first.restored.sort()).toEqual(SEALED_PATHS);
    expect(second.restored).toEqual([]);
    expect(second.unchanged.sort()).toEqual(SEALED_PATHS);
  });

  test('re-bundling identical content is a no-op; changed content is refused at the same out', async () => {
    const base = await makeTempDir();
    const project = join(base, 'project');
    await seedProject(project);
    const first = await buildBundle(project);
    const again = await buildBundle(project);
    expect(again.reused).toBe(true);
    expect(again.written).toEqual([]);
    expect(again.manifest.rootHash).toBe(first.manifest.rootHash);

    await fsp.writeFile(join(project, 'script', '01-hook.md'), '# hook v2\n');
    await expect(buildBundle(project, { outDir: first.outDir })).rejects.toThrow(
      /already holds a different bundle/,
    );
  });
});

describe('verification failures refuse the restore', () => {
  test('a tampered bundle file is refused and named; the target stays intact', async () => {
    const base = await makeTempDir();
    const project = join(base, 'project');
    await seedProject(project);
    const built = await buildBundle(project);
    await fsp.writeFile(join(built.outDir, 'renders', 'hero.mp4'), 'TAMPERED');

    const target = join(base, 'restored');
    await expect(hydrateBundle(built.outDir, target)).rejects.toThrow(/renders\/hero\.mp4/);
    await expect(hydrateBundle(built.outDir, target)).rejects.toThrow(/sha256 mismatch/);
    await expect(fsp.stat(target)).rejects.toThrow();
  });

  test('a missing sealed file is refused and named', async () => {
    const base = await makeTempDir();
    const project = join(base, 'project');
    await seedProject(project);
    const built = await buildBundle(project);
    await fsp.rm(join(built.outDir, 'script', '01-hook.md'));

    await expect(hydrateBundle(built.outDir, join(base, 'restored'))).rejects.toThrow(
      /script\/01-hook\.md.*missing from the bundle/,
    );
  });

  test('an unsealed extra file in the bundle is refused and named', async () => {
    const base = await makeTempDir();
    const project = join(base, 'project');
    await seedProject(project);
    const built = await buildBundle(project);
    await fsp.writeFile(join(built.outDir, 'evil.txt'), 'not sealed');

    await expect(hydrateBundle(built.outDir, join(base, 'restored'))).rejects.toThrow(
      /evil\.txt.*not sealed by MANIFEST\.json/,
    );
  });

  test('an edited MANIFEST rootHash is refused', async () => {
    const base = await makeTempDir();
    const project = join(base, 'project');
    await seedProject(project);
    const built = await buildBundle(project);
    const sealPath = join(built.outDir, MANIFEST_NAME);
    const seal = JSON.parse(await fsp.readFile(sealPath, 'utf8')) as { rootHash: string };
    seal.rootHash = '0'.repeat(64);
    await fsp.writeFile(sealPath, `${JSON.stringify(seal, null, 2)}\n`);

    await expect(hydrateBundle(built.outDir, join(base, 'restored'))).rejects.toThrow(
      /rootHash mismatch/,
    );
    expect((await readBundleManifest(built.outDir).catch((error: unknown) => error)) instanceof PersistError).toBe(true);
  });

  test('a project with its own root MANIFEST.json is refused (reserved name)', async () => {
    const base = await makeTempDir();
    const project = join(base, 'project');
    await seedProject(project);
    await fsp.writeFile(join(project, MANIFEST_NAME), '{}');
    await expect(buildBundle(project)).rejects.toThrow(/reserved/);
  });
});

describe('exclusion policy', () => {
  test('regenerables never reach MANIFEST.json or the bundle dir', async () => {
    const base = await makeTempDir();
    const project = join(base, 'project');
    await seedProject(project);
    const built = await buildBundle(project);

    for (const file of built.manifest.files) {
      expect(isExcludedPath(file.path)).toBe(false);
    }
    const packed = await fsp.readdir(built.outDir);
    expect(packed).not.toContain('node_modules');
    expect(packed).not.toContain('.cache');
    expect(packed).not.toContain('bun.lock');
    await expect(fsp.stat(join(built.outDir, 'renders', 'partial.mp4.tmp'))).rejects.toThrow();
  });
});

describe('command specs: plan purity and plan-mode refusal', () => {
  test('plan() touches no store, fetch, or secret seam for any verb', async () => {
    const base = await makeTempDir();
    const project = join(base, 'project');
    await seedProject(project);
    const built = await buildBundle(project);

    let factoryCalls = 0;
    const counted = countingProviderContext();
    setArchiveStorageSource(() => {
      factoryCalls += 1;
      return { store: new FakeObjectStore(), ctx: counted.ctx };
    });
    try {
      await bundleSpec.plan(fakeRunContext({ args: { project } }));
      await bundleSpec.plan(fakeRunContext({ args: { project, out: join(base, 'out') } }));
      await hydrateSpec.plan(
        fakeRunContext({ args: { bundle: built.outDir, project: join(base, 'planned') } }),
      );
      expect(factoryCalls).toBe(0);
      expect(counted.counts).toEqual({ fetch: 0, secrets: 0 });
    } finally {
      resetArchiveStorageSource();
    }
  });

  test('bundle plan reports the manifest seal and refuses a missing project', async () => {
    const base = await makeTempDir();
    const project = join(base, 'project');
    await seedProject(project);
    const steps = await bundleSpec.plan(fakeRunContext({ args: { project } }));
    expect(steps.some((step) => step.writes === 'MANIFEST.json')).toBe(true);
    expect(steps.some((step) => step.action.includes('rootHash'))).toBe(true);

    const missing = fakeRunContext({ args: { project: join(base, 'nope') } });
    await expect(bundleSpec.plan(missing)).rejects.toThrow(FailSignal);
    await expect(bundleSpec.plan(missing)).rejects.toThrow(/does not exist/);
  });

  test('run() refuses in plan mode before doing anything', async () => {
    const base = await makeTempDir();
    const project = join(base, 'project');
    await seedProject(project);
    const built = await buildBundle(project);

    let factoryCalls = 0;
    setArchiveStorageSource(() => {
      factoryCalls += 1;
      return { store: new FakeObjectStore(), ctx: countingProviderContext().ctx };
    });
    try {
      await expect(
        bundleSpec.run(fakeRunContext({ mode: 'plan', args: { project } })),
      ).rejects.toThrow(/plan mode/);
      await expect(
        hydrateSpec.run(fakeRunContext({ mode: 'plan', args: { bundle: built.outDir, project } })),
      ).rejects.toThrow(/plan mode/);
      expect(factoryCalls).toBe(0);
    } finally {
      resetArchiveStorageSource();
    }
  });

  test('hydrate spec round-trips through the declarative surface', async () => {
    const base = await makeTempDir();
    const project = join(base, 'project');
    await seedProject(project);

    const bundleCtx = fakeRunContext({ args: { project } });
    const bundleResult = await bundleSpec.run(bundleCtx);
    expect(bundleResult.exitCode).toBe(0);
    expect(bundleCtx.lines.join('\n')).toContain('rootHash');

    const target = join(base, 'restored');
    const outDir = defaultBundleDir(project, (await computeBundleInventory(project)).rootHash);
    const hydrateCtx = fakeRunContext({ args: { bundle: outDir, project: target } });
    const hydrateResult = await hydrateSpec.run(hydrateCtx);
    expect(hydrateResult.exitCode).toBe(0);
    expect((await fsp.readFile(join(target, 'video.json'), 'utf8'))).toContain('"demo"');

    // Tamper the bundle, then hydrate again into a fresh target: named refusal.
    await fsp.writeFile(join(outDir, 'video.json'), '{"id":"evil"}');
    const tamperedCtx = fakeRunContext({ args: { bundle: outDir, project: join(base, 'fresh') } });
    await expect(hydrateSpec.run(tamperedCtx)).rejects.toThrow(/video\.json/);
  });
});
