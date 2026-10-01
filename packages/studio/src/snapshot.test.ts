/**
 * Snapshot suites (contracts.md §3–§5): immutable staging + lock + atomic
 * publish, safe selection (secrets/symlinks/caches), content-addressed
 * verification, deterministic history/diff, checkpoints, restore without
 * regeneration (zero fetch/spawn) and the read-only catalog states.
 */
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { computeRevisionRootHash, sha256Hex, type StudioErrorCode } from '@videomaker/schemas';

import { buildStudioCatalog } from './catalog';
import { createClient, createCreativeAsset, createCreativeProject, createPresetVersion, inspectCreativeAsset } from './workspace';
import { storageManifestKey, storageObjectKeyForSha } from './receipts';
import {
  assertServiceError,
  editAssetJson,
  makeTestWorkspace,
  writeAssetFile,
  writePresetResource,
  type TestWorkspace,
} from './test-support';
import { sealEntries, verifySealedMetadata, type SealEntry } from './sealing';
import { createProjectCheckpoint, diffAssetRevisions, getRevisionManifest, listAssetRevisions, restoreAssetRevision, snapshotAsset } from './snapshot';

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const MP4_TINY = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x00, 0x00]);

const LOGO_V1 = new Uint8Array([...PNG_SIGNATURE, 1, 1, 1, 1]);
const LOGO_V2 = new Uint8Array([...PNG_SIGNATURE, 2, 2, 2, 2, 2, 2]);

interface ImageFixture {
  ws: TestWorkspace;
  presetV1: string;
  coverHtml: string;
}

async function seedImageFixture(prefix: string): Promise<ImageFixture> {
  const ws = await makeTestWorkspace(prefix);
  await createClient(ws.ctx, { id: 'marca-a', name: 'Marca A' });
  const preset = await createPresetVersion(ws.ctx, {
    presetId: 'logo-brand',
    clientId: 'marca-a',
    name: 'Marca A 2026',
    identity: { palette: ['#0a1f44'], fonts: ['Inter'] },
    resources: [{ path: 'resources/logo.png', sha256: await sha256Hex(LOGO_V1), mediaType: 'image/png' }],
  });
  await writePresetResource(ws.root, 'logo-brand', preset.versionId, 'resources/logo.png', LOGO_V1);
  await createCreativeProject(ws.ctx, { id: 'campana', name: 'Campaña Verano', clientIds: ['marca-a'] });
  await createCreativeAsset(ws.ctx, {
    id: 'cover-feed',
    projectId: 'campana',
    kind: 'image',
    title: 'Cover feed',
    presetRefs: [{ presetId: 'logo-brand', versionId: preset.versionId }],
  });
  const coverHtml = '<html><body><h1>Verano</h1></body></html>';
  await writeAssetFile(ws.root, 'campana', 'cover-feed', 'workroom/cover.html', coverHtml);
  await writeAssetFile(ws.root, 'campana', 'cover-feed', 'workroom/assets/logo.png', LOGO_V1);
  await writeAssetFile(ws.root, 'campana', 'cover-feed', 'outputs/cover.png', new Uint8Array([...PNG_SIGNATURE, 9, 9]));
  await editAssetJson(ws.root, 'campana', 'cover-feed', (asset) => {
    asset.sources = ['workroom/cover.html', 'workroom/assets/'];
    asset.inputs = ['inputs/brief.md'];
    asset.outputs = [{ name: 'cover-feed', path: 'outputs/cover.png', mediaType: 'image/png', role: 'deliverable' }];
  });
  await writeAssetFile(ws.root, 'campana', 'cover-feed', 'inputs/brief.md', 'brief inicial');
  return { ws, presetV1: preset.versionId, coverHtml };
}

describe('snapshot: happy path and selection policy', () => {
  test('seals asset.json, sources, inputs, outputs and the exact preset with its resources', async () => {
    const { ws, presetV1 } = await seedImageFixture('vm-snap-happy');
    const { revision, manifestPath } = await snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'primera' });

    expect(revision.editorialStatus).toBe('draft');
    expect(revision.parentRevisionId).toBeUndefined();
    expect(revision.presetSnapshots[0]?.versionId).toBe(presetV1);
    expect(manifestPath).toBe(path.join(ws.root, 'revisions', 'campana', 'cover-feed', revision.revisionId, 'manifest.json'));

    const roleOf = (target: string): string | undefined => revision.files.find((file) => file.path === target)?.role;
    expect(roleOf('asset.json')).toBe('metadata');
    expect(roleOf('workroom/cover.html')).toBe('source');
    expect(roleOf('inputs/brief.md')).toBe('input');
    expect(roleOf('outputs/cover.png')).toBe('output');
    expect(roleOf(`presets/logo-brand/${presetV1}/preset.json`)).toBe('preset');
    expect(roleOf(`presets/logo-brand/${presetV1}/resources/logo.png`)).toBe('preset');
    expect(roleOf('workroom/assets/logo.png')).toBe('source');

    const fileRoles = revision.files.map((file) => [file.path, file.role] as const);
    expect(fileRoles).toContainEqual(['workroom/assets/logo.png', 'source']); // directory expanded
    expect(revision.outputs).toEqual([{ name: 'cover-feed', path: 'outputs/cover.png' }]);
    // Files sealed on disk are verified copies under the revision dir.
    const sealedLogo = await readFile(path.join(path.dirname(manifestPath), 'files', `presets/logo-brand/${presetV1}/resources/logo.png`));
    expect(new Uint8Array(sealedLogo)).toEqual(LOGO_V1);
    // The stored rootHash matches the recomputed §3 seal.
    expect(await computeRevisionRootHash(revision)).toBe(revision.rootHash);
    await ws.cleanup();
  });

  test('dedup: the same file declared as input and inside a source dir is sealed once', async () => {
    const { ws } = await seedImageFixture('vm-snap-dedup');
    await editAssetJson(ws.root, 'campana', 'cover-feed', (asset) => {
      asset.inputs = ['workroom/cover.html'];
    });
    const { revision } = await snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'dedup' });
    const htmlEntries = revision.files.filter((file) => file.path === 'workroom/cover.html');
    expect(htmlEntries).toHaveLength(1);
    expect(htmlEntries[0]?.role).toBe('input'); // inputs take precedence over sources
    await ws.cleanup();
  });

  test('missing declared sources/inputs fail NOT_FOUND and leave no staged revision', async () => {
    const { ws } = await seedImageFixture('vm-snap-missing');
    await editAssetJson(ws.root, 'campana', 'cover-feed', (asset) => {
      asset.sources = ['workroom/cover.html', 'workroom/ausente.css'];
    });
    const sourceError = await assertServiceError('NOT_FOUND', () =>
      snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'x' }),
    );
    expect(sourceError.details).toEqual({ path: 'workroom/ausente.css' });

    await editAssetJson(ws.root, 'campana', 'cover-feed', (asset) => {
      asset.sources = ['workroom/cover.html', 'workroom/carpeta-idle/'];
    });
    await assertServiceError('NOT_FOUND', () => snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'x' }));

    await editAssetJson(ws.root, 'campana', 'cover-feed', (asset) => {
      asset.sources = ['workroom/cover.html'];
      asset.inputs = ['inputs/never-written.md'];
    });
    await assertServiceError('NOT_FOUND', () => snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'x' }));

    expect(await readdir(path.join(ws.root, 'revisions', 'campana', 'cover-feed'))).toEqual([]);
    await ws.cleanup();
  });

  test('two different files colliding on one snapshot path fail CONFLICT (same file dedup stays fine)', async () => {
    const { ws } = await seedImageFixture('vm-snap-collision');
    // A folder named `presets/` inside the asset shadows the brand preset's
    // portable snapshot path with DIFFERENT bytes: never silently discard one.
    await writeAssetFile(ws.root, 'campana', 'cover-feed', 'presets/logo-brand/t001/preset.json', 'contenido distinto');
    await editAssetJson(ws.root, 'campana', 'cover-feed', (asset) => {
      asset.sources = ['workroom/cover.html', 'workroom/assets/', 'presets/'];
    });
    const error = await assertServiceError('CONFLICT', () =>
      snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'x' }),
    );
    expect(error.details).toMatchObject({ snapshotPath: 'presets/logo-brand/t001/preset.json' });
    expect(await readdir(path.join(ws.root, 'revisions', 'campana', 'cover-feed'))).toEqual([]);
    await ws.cleanup();
  });

  test('zero existing outputs is OUTPUT_MISSING and leaves no partial sealed revision', async () => {
    const { ws } = await seedImageFixture('vm-snap-nooutput');
    await rm(path.join(ws.root, 'projects', 'campana', 'assets', 'cover-feed', 'outputs', 'cover.png'));
    const error = await assertServiceError('OUTPUT_MISSING', () => snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'x' }));
    expect(error.details).toEqual({ declaredOutputs: ['outputs/cover.png'] });
    expect(await readdir(path.join(ws.root, 'revisions', 'campana', 'cover-feed'))).toEqual([]);
    await ws.cleanup();
  });

  test('declared secrets are rejected explicitly with SECRET_PATH', async () => {
    const { ws } = await seedImageFixture('vm-snap-secret');
    await writeAssetFile(ws.root, 'campana', 'cover-feed', 'workroom/.env', 'TOKEN=1');
    await editAssetJson(ws.root, 'campana', 'cover-feed', (asset) => {
      asset.sources = ['workroom/cover.html', 'workroom/.env'];
    });
    await assertServiceError('SECRET_PATH', () => snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'x' }));

    await writeAssetFile(ws.root, 'campana', 'cover-feed', 'workroom/keys/id_rsa', '-----BEGIN');
    await editAssetJson(ws.root, 'campana', 'cover-feed', (asset) => {
      asset.sources = ['workroom/cover.html', 'workroom/keys/'];
    });
    await assertServiceError('SECRET_PATH', () => snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'x' }));
    await ws.cleanup();
  });

  test('symlinks are rejected, even as intermediate components', async () => {
    const { ws } = await seedImageFixture('vm-snap-symlink');
    const assetDir = path.join(ws.root, 'projects', 'campana', 'assets', 'cover-feed');
    await writeAssetFile(ws.root, 'campana', 'cover-feed', 'workroom/real/cover-real.html', '<p>real</p>');
    await symlink('real', path.join(assetDir, 'workroom', 'linked-dir'));
    await editAssetJson(ws.root, 'campana', 'cover-feed', (asset) => {
      asset.sources = ['workroom/cover.html', 'workroom/linked-dir/'];
    });
    await assertServiceError('PATH_UNSAFE', () => snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'x' }));

    await symlink('cover.html', path.join(assetDir, 'workroom', 'link.html'));
    await editAssetJson(ws.root, 'campana', 'cover-feed', (asset) => {
      asset.sources = ['workroom/link.html'];
    });
    await assertServiceError('PATH_UNSAFE', () => snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'x' }));
    await ws.cleanup();
  });

  test('node_modules/.git are pruned from directory expansion but package/lock files are kept', async () => {
    const { ws } = await seedImageFixture('vm-snap-caches');
    await editAssetJson(ws.root, 'campana', 'cover-feed', (asset) => {
      asset.sources = ['workroom/'];
    });
    await writeAssetFile(ws.root, 'campana', 'cover-feed', 'workroom/tools/render.ts', 'console.log(1);');
    await writeAssetFile(ws.root, 'campana', 'cover-feed', 'workroom/.git/config', '[core]');
    await writeAssetFile(ws.root, 'campana', 'cover-feed', 'workroom/package.json', '{"name":"cover"}');
    await writeAssetFile(ws.root, 'campana', 'cover-feed', 'workroom/package-lock.json', '{"lockfileVersion":3}');
    const { revision } = await snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'caches' });
    const paths = revision.files.map((file) => file.path);
    expect(paths).toContain('workroom/tools/render.ts');
    expect(paths).toContain('workroom/package.json');
    expect(paths).toContain('workroom/package-lock.json');
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.includes('.git/'))).toBe(false);
    const packageLock = revision.files.find((file) => file.path === 'workroom/package-lock.json');
    expect(packageLock?.mediaType).toBe('application/json');
    await ws.cleanup();
  });

  test('preset resource missing or hash-divergent fails the seal (NOT_FOUND / HASH_MISMATCH)', async () => {
    const missing = await seedImageFixture('vm-snap-res-missing');
    await rm(path.join(missing.ws.root, 'presets', 'logo-brand', 'versions', missing.presetV1, 'resources', 'logo.png'));
    await assertServiceError('NOT_FOUND', () => snapshotAsset(missing.ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'x' }));
    await missing.ws.cleanup();

    const edited = await seedImageFixture('vm-snap-res-edit');
    // Agent edits the resource in place under the SAME (sealed) version.
    await writePresetResource(edited.ws.root, 'logo-brand', edited.presetV1, 'resources/logo.png', LOGO_V2);
    await assertServiceError('HASH_MISMATCH', () => snapshotAsset(edited.ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'x' }));
    await edited.ws.cleanup();
  });

  test('output signature mismatch (declared png, text bytes) is INVALID_INPUT', async () => {
    const { ws } = await seedImageFixture('vm-snap-sig');
    await writeAssetFile(ws.root, 'campana', 'cover-feed', 'outputs/cover.png', 'no soy un png');
    await assertServiceError('INVALID_INPUT', () => snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'x' }));
    await ws.cleanup();
  });

  test('a source that changes while sealing is detected (CONFLICT) via the read seam', async () => {
    const filesDir = await mkdtemp(path.join(os.tmpdir(), 'vm-seal-'));
    const source = path.join(filesDir, 'volatile.txt');
    await writeFile(source, 'versión-a');
    const entry: SealEntry = { snapshotPath: 'workroom/volatile.txt', absolutePath: source, role: 'source' };
    let reads = 0;
    await assertServiceError('CONFLICT', () =>
      sealEntries([entry], path.join(filesDir, 'staged'), {
        read: async (absolutePath) => {
          reads += 1;
          return new TextEncoder().encode(reads === 1 ? 'versión-a' : 'versión-b');
        },
      }),
    );
    await rm(filesDir, { recursive: true, force: true });
  });

  test('kebab-invalid generated revisionId is INVALID_INPUT; a held lock is CONFLICT and released after success', async () => {
    const { ws } = await seedImageFixture('vm-snap-lock');
    const badIdCtx = { ...ws.ctx, newId: () => 'NO_KEBAB' };
    await assertServiceError('INVALID_INPUT', () => snapshotAsset(badIdCtx, { projectId: 'campana', assetId: 'cover-feed', note: 'x' }));

    const lockPath = path.join(ws.root, '.vm', 'locks', 'campana--cover-feed.lock');
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, 'held\n');
    await assertServiceError('CONFLICT', () => snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'x' }));

    await rm(lockPath);
    await snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'ok' });
    expect(await readFile(lockPath, 'utf8').catch(() => 'gone')).toBe('gone'); // lock cleaned up
    await ws.cleanup();
  });

  test('multiple history heads block the next snapshot with CONFLICT', async () => {
    const { ws } = await seedImageFixture('vm-snap-heads');
    const r1 = (await snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'r1' })).revision;
    // Manually graft an orphan revision (simulating a divergent edit).
    const revisionsDir = path.join(ws.root, 'revisions', 'campana', 'cover-feed');
    const orphanDir = path.join(revisionsDir, 'r-orphan');
    await mkdir(path.join(orphanDir, 'files'), { recursive: true });
    const orphan = { ...r1, revisionId: 'r-orphan' };
    delete (orphan as Partial<typeof orphan>).parentRevisionId;
    await writeFile(path.join(orphanDir, 'manifest.json'), JSON.stringify(orphan, null, 2));

    const error = await assertServiceError('CONFLICT', () => snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'x' }));
    const heads = error.details !== undefined && 'heads' in error.details && Array.isArray(error.details.heads) ? error.details.heads : [];
    expect(heads.map(String).sort()).toEqual([r1.revisionId, 'r-orphan'].sort());
    await ws.cleanup();
  });
});

describe('snapshot: two revisions around a logo change', () => {
  test('r1 stays byte-identical after the logo changes and a second revision is sealed', async () => {
    const { ws, presetV1 } = await seedImageFixture('vm-snap-two');
    const r1 = (await snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'r1' })).revision;
    const r1ManifestRaw = await readFile(
      path.join(ws.root, 'revisions', 'campana', 'cover-feed', r1.revisionId, 'manifest.json'),
      'utf8',
    );

    // New brand version (logo change) + new render done OUTSIDE the CLI.
    const presetV2Doc = await createPresetVersion(ws.ctx, {
      presetId: 'logo-brand',
      clientId: 'marca-a',
      name: 'Marca A 2027',
      identity: { palette: ['#111111'] },
      resources: [{ path: 'resources/logo.png', sha256: await sha256Hex(LOGO_V2), mediaType: 'image/png' }],
    });
    await writePresetResource(ws.root, 'logo-brand', presetV2Doc.versionId, 'resources/logo.png', LOGO_V2);
    await writeAssetFile(ws.root, 'campana', 'cover-feed', 'outputs/cover.png', new Uint8Array([...PNG_SIGNATURE, 7, 7, 7]));
    await editAssetJson(ws.root, 'campana', 'cover-feed', (asset) => {
      asset.presetRefs = [{ presetId: 'logo-brand', versionId: presetV2Doc.versionId }];
    });

    const r2 = (await snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'logo nuevo' })).revision;
    expect(r2.parentRevisionId).toBe(r1.revisionId);
    expect(r2.rootHash).not.toBe(r1.rootHash);

    // r1 is immutable: manifest bytes unchanged, sealed logo still v1.
    expect(
      await readFile(path.join(ws.root, 'revisions', 'campana', 'cover-feed', r1.revisionId, 'manifest.json'), 'utf8'),
    ).toBe(r1ManifestRaw);
    const r1Reread = await getRevisionManifest(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', revisionId: r1.revisionId });
    expect(r1Reread.presetSnapshots[0]?.versionId).toBe(presetV1);
    const sealed = await readFile(
      path.join(ws.root, 'revisions', 'campana', 'cover-feed', r1.revisionId, 'files', `presets/logo-brand/${presetV1}/resources/logo.png`),
    );
    expect(new Uint8Array(sealed)).toEqual(LOGO_V1);

    // Same content sealed twice yields the same rootHash (ids excluded).
    const r1again = { ...r1, revisionId: 'otro-id', createdAt: '2026-09-30T00:00:00.000Z' };
    expect(await computeRevisionRootHash(r1again)).toBe(r1.rootHash);

    // History and diff are deterministic.
    const history = await listAssetRevisions(ws.ctx, { projectId: 'campana', assetId: 'cover-feed' });
    expect(history.map((h) => h.revisionId)).toEqual([r1.revisionId, r2.revisionId]);
    expect(history[1]?.parentRevisionId).toBe(r1.revisionId);

    const diff = await diffAssetRevisions(ws.ctx, {
      projectId: 'campana',
      assetId: 'cover-feed',
      fromRevisionId: r1.revisionId,
      toRevisionId: r2.revisionId,
    });
    expect(diff.files.modified).toContain('outputs/cover.png');
    expect(diff.files.added).toContain(`presets/logo-brand/${presetV2Doc.versionId}/preset.json`);
    expect(diff.presets.modified).toEqual(['logo-brand']); // same brand, new exact version
    expect(diff.outputs.modified).toEqual(['cover-feed']); // same name, new bytes
    expect(diff.recipe).toBe('unchanged');
    const diffAgain = await diffAssetRevisions(ws.ctx, {
      projectId: 'campana',
      assetId: 'cover-feed',
      fromRevisionId: r1.revisionId,
      toRevisionId: r2.revisionId,
    });
    expect(diffAgain).toEqual(diff);
    await ws.cleanup();
  });

  test('recipe changes are reported by the diff (added/modified)', async () => {
    const { ws } = await seedImageFixture('vm-snap-recipe');
    const r1 = (await snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'r1' })).revision;
    expect(r1.recipeSnapshot).toBeUndefined();
    await editAssetJson(ws.root, 'campana', 'cover-feed', (asset) => {
      asset.recipe = { argv: ['bun', 'run', 'workroom/render.ts'], cwd: '.', outputs: ['outputs/cover.png'] };
    });
    const r2 = (await snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'r2' })).revision;
    expect(r2.recipeSnapshot?.argv).toEqual(['bun', 'run', 'workroom/render.ts']);
    const diff = await diffAssetRevisions(ws.ctx, {
      projectId: 'campana',
      assetId: 'cover-feed',
      fromRevisionId: r1.revisionId,
      toRevisionId: r2.revisionId,
    });
    expect(diff.recipe).toBe('added');
    await ws.cleanup();
  });
});

describe('restore', () => {
  test('restores into an empty dir with verified hashes and ZERO fetch/spawn calls', async () => {
    const { ws, presetV1 } = await seedImageFixture('vm-restore-happy');
    const r1 = (await snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'r1' })).revision;

    let fetchCalls = 0;
    let spawnCalls = 0;
    const originalFetch = globalThis.fetch;
    const originalSpawn = Bun.spawn;
    // Reassigning globals requires an unchecked cast; kept in one named binding.
    const bunGlobal = Bun as unknown as { spawn: typeof Bun.spawn };
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response('');
    }) as unknown as typeof fetch;
    bunGlobal.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
      spawnCalls += 1;
      return originalSpawn(...args);
    }) as typeof Bun.spawn;
    let outDir: string;
    let restored: Awaited<ReturnType<typeof restoreAssetRevision>>;
    try {
      outDir = await mkdtemp(path.join(os.tmpdir(), 'vm-restore-out-'));
      restored = await restoreAssetRevision(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', revisionId: r1.revisionId, outDir });
    } finally {
      globalThis.fetch = originalFetch;
      bunGlobal.spawn = originalSpawn;
    }
    expect(fetchCalls).toBe(0);
    expect(spawnCalls).toBe(0);
  });

  test('non-empty destination and workspace-internal destinations are rejected', async () => {
    const { ws } = await seedImageFixture('vm-restore-conflict');
    const r1 = (await snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'r1' })).revision;
    const occupied = await mkdtemp(path.join(os.tmpdir(), 'vm-restore-busy-'));
    await writeFile(path.join(occupied, 'previo.txt'), 'x');
    await assertServiceError('CONFLICT', () =>
      restoreAssetRevision(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', revisionId: r1.revisionId, outDir: occupied }),
    );
    await assertServiceError('PATH_UNSAFE', () =>
      restoreAssetRevision(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', revisionId: r1.revisionId, outDir: path.join(ws.root, 'restaurado') }),
    );
    await rm(occupied, { recursive: true, force: true });
    await ws.cleanup();
  });

  test('tampered manifest or tampered sealed file is HASH_MISMATCH', async () => {
    const { ws } = await seedImageFixture('vm-restore-tamper');
    const r1 = (await snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'r1' })).revision;
    const revisionDir = path.join(ws.root, 'revisions', 'campana', 'cover-feed', r1.revisionId);

    const manifestPath = path.join(revisionDir, 'manifest.json');
    const originalManifest = await readFile(manifestPath, 'utf8');
    const tampered = JSON.parse(originalManifest) as { files: Array<{ path: string; sha256: string }> };
    tampered.files = tampered.files.map((file) => (file.path === 'outputs/cover.png' ? { ...file, sha256: 'f'.repeat(64) } : file));
    await writeFile(manifestPath, JSON.stringify(tampered, null, 2));
    const outOne = await mkdtemp(path.join(os.tmpdir(), 'vm-t1-'));
    await assertServiceError('HASH_MISMATCH', () =>
      restoreAssetRevision(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', revisionId: r1.revisionId, outDir: outOne }),
    );

    await writeFile(manifestPath, originalManifest);
    const sealedOutput = path.join(revisionDir, 'files', 'outputs', 'cover.png');
    await writeFile(sealedOutput, 'bytes alterados');
    const outTwo = await mkdtemp(path.join(os.tmpdir(), 'vm-t2-'));
    await assertServiceError('HASH_MISMATCH', () =>
      restoreAssetRevision(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', revisionId: r1.revisionId, outDir: outTwo }),
    );
    await rm(outOne, { recursive: true, force: true });
    await rm(outTwo, { recursive: true, force: true });
    await ws.cleanup();
  });
});

describe('video fixture: editable Remotion folder + existing MP4, no render', () => {
  test('snapshot keeps the project sources/lockfiles and restores the exact MP4 bytes', async () => {
    const ws = await makeTestWorkspace('vm-snap-video');
    await createClient(ws.ctx, { id: 'marca-v', name: 'Marca V' });
    await createCreativeProject(ws.ctx, { id: 'p-video', name: 'Video proyecto', clientIds: ['marca-v'] });
    await createCreativeAsset(ws.ctx, { id: 'promo-reel', projectId: 'p-video', kind: 'video', title: 'Promo reel' });
    await writeAssetFile(ws.root, 'p-video', 'promo-reel', 'remotion/package.json', '{"name":"promo","dependencies":{"remotion":"4.0.0"}}');
    await writeAssetFile(ws.root, 'p-video', 'promo-reel', 'remotion/bun.lock', 'lockfileContent = true');
    await writeAssetFile(ws.root, 'p-video', 'promo-reel', 'remotion/src/Main.tsx', 'export const Repo = null;');
    await writeAssetFile(ws.root, 'p-video', 'promo-reel', 'remotion/node_modules/remotion/index.js', 'regenerable');
    await writeAssetFile(ws.root, 'p-video', 'promo-reel', 'inputs/guion.md', 'guion');
    await writeAssetFile(ws.root, 'p-video', 'promo-reel', 'outputs/promo.mp4', MP4_TINY);
    await editAssetJson(ws.root, 'p-video', 'promo-reel', (asset) => {
      asset.sources = ['remotion/'];
      asset.inputs = ['inputs/guion.md'];
      asset.outputs = [{ name: 'promo-mp4', path: 'outputs/promo.mp4', mediaType: 'video/mp4', role: 'deliverable' }];
    });

    const { revision } = await snapshotAsset(ws.ctx, { projectId: 'p-video', assetId: 'promo-reel', note: 'backup sin render' });
    const paths = revision.files.map((file) => file.path);
    expect(paths).toContain('remotion/package.json');
    expect(paths).toContain('remotion/bun.lock');
    expect(paths).toContain('remotion/src/Main.tsx');
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    const mp4 = revision.files.find((file) => file.path === 'outputs/promo.mp4');
    expect(mp4?.mediaType).toBe('video/mp4');
    expect(mp4?.bytes).toBe(MP4_TINY.byteLength);

    const outDir = await mkdtemp(path.join(os.tmpdir(), 'vm-video-out-'));
    await restoreAssetRevision(ws.ctx, { projectId: 'p-video', assetId: 'promo-reel', revisionId: revision.revisionId, outDir });
    const restoredMp4 = new Uint8Array(await readFile(path.join(outDir, 'outputs', 'promo.mp4')));
    expect(restoredMp4).toEqual(MP4_TINY);
    await rm(outDir, { recursive: true, force: true });
    await ws.cleanup();
  });
});

describe('checkpoints and catalog', () => {
  test('checkpoint of two assets references exact revisions and rejects unknown ones', async () => {
    const ws = await makeTestWorkspace('vm-checkpoint');
    await createClient(ws.ctx, { id: 'marca-a', name: 'A' });
    await createCreativeProject(ws.ctx, { id: 'campana', name: 'Campaña', clientIds: ['marca-a'] });
    for (const assetId of ['cover-feed', 'cover-story']) {
      await createCreativeAsset(ws.ctx, { id: assetId, projectId: 'campana', kind: 'image', title: assetId });
      await writeAssetFile(ws.root, 'campana', assetId, `outputs/${assetId}.png`, new Uint8Array([...PNG_SIGNATURE, 1]));
      await editAssetJson(ws.root, 'campana', assetId, (asset) => {
        asset.outputs = [{ name: assetId, path: `outputs/${assetId}.png`, mediaType: 'image/png', role: 'deliverable' }];
      });
    }
    const r1 = (await snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'r1' })).revision;
    const r2 = (await snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-story', note: 'r1' })).revision;

    const checkpoint = await createProjectCheckpoint(ws.ctx, {
      projectId: 'campana',
      entries: [
        { assetId: 'cover-feed', revisionId: r1.revisionId },
        { assetId: 'cover-story', revisionId: r2.revisionId },
      ],
    });
    expect(checkpoint.entries.map((entry) => entry.rootHash)).toEqual([r1.rootHash, r2.rootHash]);
    expect(
      JSON.parse(await readFile(path.join(ws.root, 'checkpoints', 'campana', `${checkpoint.checkpointId}.json`), 'utf8')).entries,
    ).toHaveLength(2);

    await assertServiceError('NOT_FOUND', () =>
      createProjectCheckpoint(ws.ctx, { projectId: 'campana', entries: [{ assetId: 'cover-feed', revisionId: 't999' }] }),
    );
    await assertServiceError('INVALID_INPUT', () =>
      createProjectCheckpoint(ws.ctx, {
        projectId: 'campana',
        entries: [
          { assetId: 'cover-feed', revisionId: r1.revisionId },
          { assetId: 'cover-feed', revisionId: r1.revisionId },
        ],
      }),
    );
    await ws.cleanup();
  });

  test('catalog lists revisions with separated editorial/production/backup states and filters', async () => {
    const { ws } = await seedImageFixture('vm-catalog');
    // A second, client-less asset in the same project.
    await createCreativeAsset(ws.ctx, { id: 'cover-story', projectId: 'campana', kind: 'svg', title: 'Story' });
    await writeAssetFile(ws.root, 'campana', 'cover-story', 'outputs/story.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await editAssetJson(ws.root, 'campana', 'cover-story', (asset) => {
      asset.outputs = [{ name: 'story', path: 'outputs/story.svg', mediaType: 'image/svg+xml', role: 'deliverable' }];
    });
    const r1 = (await snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'r1' })).revision;
    await writeAssetFile(ws.root, 'campana', 'cover-feed', 'outputs/cover.png', new Uint8Array([...PNG_SIGNATURE, 8, 8]));
    const r2 = (await snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'r2' })).revision;
    await snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-story', note: 'story r1' });
    // Production drift: the deliverable disappears from disk after sealing.
    await rm(path.join(ws.root, 'projects', 'campana', 'assets', 'cover-feed', 'outputs', 'cover.png'));

    const catalog = await buildStudioCatalog(ws.ctx);
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.entries).toHaveLength(3);
    const coverR1 = catalog.entries.find((entry) => entry.assetId === 'cover-feed' && entry.revisionId === r1.revisionId);
    const coverR2 = catalog.entries.find((entry) => entry.assetId === 'cover-feed' && entry.revisionId === r2.revisionId);
    const story = catalog.entries.find((entry) => entry.assetId === 'cover-story');
    expect(coverR1?.editorialStatus).toBe('draft');
    expect(coverR1?.backup).toEqual({ status: 'local', receiptVerified: false });
    // P-006 (out-of-ownership correction, test-only): production presence is
    // decided against the SEALED copy (contracts.md §8; dashboard suites),
    // so deleting the working file after sealing is NOT production drift.
    expect(coverR1?.production).toEqual({ presentOutputs: ['cover-feed'], missingOutputs: [] });
    expect(coverR1?.clients).toEqual([{ id: 'marca-a', name: 'Marca A' }]);
    expect(coverR1?.outputs).toEqual([
      {
        name: 'cover-feed',
        mediaType: 'image/png',
        role: 'deliverable',
        visibility: 'private',
        servicePath: `files/campana/cover-feed/${r1.revisionId}/cover-feed`,
      },
    ]);
    expect(coverR2?.rootHash).not.toBe(coverR1?.rootHash);
    expect(story?.asset.kind).toBe('svg');
    expect(story?.clients).toEqual([{ id: 'marca-a', name: 'Marca A' }]); // the project's clients travel with every revision
    expect(story?.production.presentOutputs).toEqual(['story']);

    const images = await buildStudioCatalog(ws.ctx, { kind: 'image' });
    expect(images.entries.every((entry) => entry.asset.kind === 'image')).toBe(true);
    const byClient = await buildStudioCatalog(ws.ctx, { clientId: 'marca-a' });
    expect(byClient.entries.map((entry) => entry.assetId).sort()).toEqual(['cover-feed', 'cover-feed', 'cover-story'].sort());
    const byProject = await buildStudioCatalog(ws.ctx, { projectId: 'otro' });
    expect(byProject.entries).toEqual([]);
    await assertServiceError('INVALID_INPUT', () => buildStudioCatalog(ws.ctx, { kind: 'meme' }));
    await ws.cleanup();
  });
});

describe('backup receipt evidence (local structural binding)', () => {
  interface ReceiptOverrides {
    rootHash?: string;
    manifestKey?: string;
    manifestSha256?: string;
    confirmedObjects?: string[];
    status?: 'local' | 'syncing' | 'confirmed' | 'failed';
    error?: { code: string; message: string };
    revisionId?: string;
  }

  async function writeReceiptFor(wsRoot: string, ref: { projectId: string; assetId: string; revisionId: string }, manifestRootHash: string, overrides: ReceiptOverrides = {}): Promise<void> {
    const manifestPath = path.join(wsRoot, 'revisions', ref.projectId, ref.assetId, ref.revisionId, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { files: Array<{ sha256: string }> };
    const receipt = {
      schemaVersion: 1,
      projectId: ref.projectId,
      assetId: ref.assetId,
      revisionId: overrides.revisionId ?? ref.revisionId,
      rootHash: overrides.rootHash ?? manifestRootHash,
      manifestKey: overrides.manifestKey ?? storageManifestKey(ref.projectId, ref.assetId, ref.revisionId),
      manifestSha256: overrides.manifestSha256 ?? (await sha256Hex(new Uint8Array(await readFile(manifestPath)))),
      status: overrides.status ?? 'confirmed',
      confirmedObjects: overrides.confirmedObjects ?? [...new Set(manifest.files.map((file) => storageObjectKeyForSha(file.sha256)))],
      ...(overrides.error !== undefined ? { error: overrides.error } : {}),
    };
    const receiptPath = path.join(wsRoot, '.vm', 'receipts', ref.projectId, ref.assetId, `${ref.revisionId}.json`);
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  }

  test('a structurally consistent receipt yields confirmed + receiptVerified; inspect mirrors it', async () => {
    const { ws } = await seedImageFixture('vm-receipt-ok');
    const r1 = (await snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'r1' })).revision;
    await writeReceiptFor(ws.root, { projectId: 'campana', assetId: 'cover-feed', revisionId: r1.revisionId }, r1.rootHash);

    const catalog = await buildStudioCatalog(ws.ctx);
    const entry = catalog.entries.find((candidate) => candidate.revisionId === r1.revisionId);
    expect(entry?.backup).toEqual({ status: 'confirmed', receiptVerified: true });
    expect(entry?.errors).toEqual([]);

    const inspection = await inspectCreativeAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed' });
    expect(inspection.sync).toEqual([{ revisionId: r1.revisionId, status: 'confirmed' }]);
    await ws.cleanup();
  });

  test('forged or unbound receipts degrade to failed with actionable errors, never confirmed', async () => {
    const { ws } = await seedImageFixture('vm-receipt-bad');
    const r1 = (await snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'r1' })).revision;
    const ref = { projectId: 'campana', assetId: 'cover-feed', revisionId: r1.revisionId };

    const cases: Array<{ name: string; overrides: ReceiptOverrides; code: StudioErrorCode }> = [
      { name: 'rootHash de otra revisión', overrides: { rootHash: 'a'.repeat(64) }, code: 'HASH_MISMATCH' },
      { name: 'manifestKey de otro namespace', overrides: { manifestKey: 'studio/v1/projects/otro/assets/x/revisions/y/manifest.json' }, code: 'HASH_MISMATCH' },
      { name: 'manifestSha256 que no firma los bytes', overrides: { manifestSha256: 'b'.repeat(64) }, code: 'HASH_MISMATCH' },
      { name: 'objetos incompletos', overrides: { confirmedObjects: [] }, code: 'HASH_MISMATCH' },
      { name: 'receipt de otra revisión', overrides: { revisionId: 't999' }, code: 'HASH_MISMATCH' },
      { name: 'confirmed con error contradictorio', overrides: { error: { code: 'STORAGE_UNAVAILABLE', message: 'x' } }, code: 'INVALID_INPUT' },
    ];
    for (const testCase of cases) {
      await writeReceiptFor(ws.root, ref, r1.rootHash, testCase.overrides);
      const catalog = await buildStudioCatalog(ws.ctx);
      const entry = catalog.entries.find((candidate) => candidate.revisionId === ref.revisionId);
      expect(entry?.backup).toEqual({ status: 'failed', receiptVerified: false });
      expect(entry?.errors[0]?.code).toBe(testCase.code);
      const inspection = await inspectCreativeAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed' });
      expect(inspection.sync[0]?.status).toBe('failed');
    }

    // Malformed JSON receipt also fails closed.
    await writeFile(path.join(ws.root, '.vm', 'receipts', 'campana', 'cover-feed', `${r1.revisionId}.json`), '{no-json');
    const catalogBroken = await buildStudioCatalog(ws.ctx);
    const brokenEntry = catalogBroken.entries.find((candidate) => candidate.revisionId === ref.revisionId);
    expect(brokenEntry?.backup).toEqual({ status: 'failed', receiptVerified: false });
    expect(brokenEntry?.errors[0]?.code).toBe('INVALID_INPUT');
    await ws.cleanup();
  });

  test('non-confirmed receipt statuses pass through without receiptVerified', async () => {
    const { ws } = await seedImageFixture('vm-receipt-syncing');
    const r1 = (await snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'r1' })).revision;
    await writeReceiptFor(ws.root, { projectId: 'campana', assetId: 'cover-feed', revisionId: r1.revisionId }, r1.rootHash, { status: 'syncing' });
    const catalog = await buildStudioCatalog(ws.ctx);
    const entry = catalog.entries.find((candidate) => candidate.revisionId === r1.revisionId);
    expect(entry?.backup).toEqual({ status: 'syncing', receiptVerified: false });
    await ws.cleanup();
  });
});

describe('frozen metadata vs staged JSON bytes', () => {
  test('verifySealedMetadata fails CONFLICT when the staged document diverges from the parsed snapshot', async () => {
    const filesDir = await mkdtemp(path.join(os.tmpdir(), 'vm-frozen-'));
    await mkdir(path.join(filesDir, 'presets', 'p', 'v'), { recursive: true });
    const asset = {
      schemaVersion: 1 as const,
      id: 'a',
      projectId: 'p',
      kind: 'image' as const,
      title: 'A',
      presetRefs: [],
      sources: [],
      inputs: [],
      outputs: [{ name: 'o', path: 'outputs/o.png', mediaType: 'image/png', role: 'deliverable' as const, visibility: 'private' as const }],
    };
    const preset = { schemaVersion: 1 as const, presetId: 'p', versionId: 'v', clientId: 'c', name: 'P' };

    // Matching content with different formatting/key order still passes.
    await writeFile(path.join(filesDir, 'asset.json'), JSON.stringify({ ...asset, outputs: [...asset.outputs] }, null, 4));
    await writeFile(path.join(filesDir, 'presets', 'p', 'v', 'preset.json'), JSON.stringify(preset));
    await verifySealedMetadata(filesDir, asset, [preset]);

    await writeFile(
      path.join(filesDir, 'asset.json'),
      JSON.stringify({ ...asset, title: 'Cambiado durante el sellado' }),
    );
    await assertServiceError('CONFLICT', () => verifySealedMetadata(filesDir, asset, [preset]));

    await writeFile(path.join(filesDir, 'asset.json'), JSON.stringify(asset));
    await writeFile(path.join(filesDir, 'presets', 'p', 'v', 'preset.json'), JSON.stringify({ ...preset, name: 'Otro' }));
    await assertServiceError('CONFLICT', () => verifySealedMetadata(filesDir, asset, [preset]));
    await rm(filesDir, { recursive: true, force: true });
  });
});
