/**
 * Workspace suites: clients, immutable preset versions, client-independent
 * projects and open assets, plus the inspector's real-path contract. The
 * creative editing itself happens in files — services only create/read.
 */
import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  createClient,
  createCreativeAsset,
  createCreativeProject,
  createPresetVersion,
  getClient,
  getCreativeProject,
  getPresetVersion,
  inspectCreativeAsset,
  listClients,
  listCreativeProjects,
  listPresetVersions,
} from './workspace';
import { assertServiceError, editAssetJson, makeTestWorkspace, writeAssetFile } from './test-support';

describe('clients', () => {
  test('create + get roundtrip writes the layout document', async () => {
    const ws = await makeTestWorkspace('vm-ws-clients');
    const client = await createClient(ws.ctx, { id: 'marca-a', name: 'Marca A', metadata: { region: 'latam' } });
    expect(client.schemaVersion).toBe(1);
    expect(client.id).toBe('marca-a');
    const raw = JSON.parse(await readFile(path.join(ws.root, 'clients', 'marca-a', 'client.json'), 'utf8'));
    expect(raw.id).toBe('marca-a');
    expect(await getClient(ws.ctx, { id: 'marca-a' })).toEqual(client);
    await ws.cleanup();
  });

  test('duplicate id, invalid id and empty name fail with stable codes', async () => {
    const ws = await makeTestWorkspace('vm-ws-clients');
    await createClient(ws.ctx, { id: 'marca-a', name: 'Marca A' });
    await assertServiceError('CONFLICT', () => createClient(ws.ctx, { id: 'marca-a', name: 'Otra' }));
    await assertServiceError('INVALID_INPUT', () => createClient(ws.ctx, { id: 'Bad_Id', name: 'X' }));
    await assertServiceError('INVALID_INPUT', () => createClient(ws.ctx, { id: 'marca-b', name: '' }));
    await ws.cleanup();
  });

  test('metadata must be pure JSON (NaN never leaks into the doc)', async () => {
    const ws = await makeTestWorkspace('vm-ws-clients');
    const metadata = { leak: Number.NaN } as unknown as Record<string, unknown>;
    await assertServiceError('INVALID_INPUT', () => createClient(ws.ctx, { id: 'marca-a', name: 'Marca A', metadata }));
    await ws.cleanup();
  });

  test('list is sorted and get of a missing client is NOT_FOUND', async () => {
    const ws = await makeTestWorkspace('vm-ws-clients');
    await createClient(ws.ctx, { id: 'marca-b', name: 'B' });
    await createClient(ws.ctx, { id: 'marca-a', name: 'A' });
    const clients = await listClients(ws.ctx);
    expect(clients.map((client) => client.id)).toEqual(['marca-a', 'marca-b']);
    await assertServiceError('NOT_FOUND', () => getClient(ws.ctx, { id: 'marca-z' }));
    await ws.cleanup();
  });

  test('presetRefs pointing at unknown versions are rejected', async () => {
    const ws = await makeTestWorkspace('vm-ws-clients');
    await assertServiceError('NOT_FOUND', () =>
      createClient(ws.ctx, { id: 'marca-a', name: 'A', presetRefs: [{ presetId: 'logo', versionId: 'v9' }] }),
    );
    await ws.cleanup();
  });
});

describe('preset versions', () => {
  test('creation assigns the versionId from ctx.newId and never edits sealed versions', async () => {
    const ws = await makeTestWorkspace('vm-ws-presets');
    await createClient(ws.ctx, { id: 'marca-a', name: 'Marca A' });
    const v1 = await createPresetVersion(ws.ctx, {
      presetId: 'logo',
      clientId: 'marca-a',
      name: 'Logo 2026',
      identity: { palette: ['#0a1f44'] },
      resources: [{ path: 'resources/logo.png', sha256: 'a'.repeat(64), mediaType: 'image/png' }],
    });
    expect(v1.versionId).toBe('t001');
    const v1Path = path.join(ws.root, 'presets', 'logo', 'versions', 't001', 'preset.json');
    const v1Raw = await readFile(v1Path, 'utf8');

    const v2 = await createPresetVersion(ws.ctx, {
      presetId: 'logo',
      clientId: 'marca-a',
      name: 'Logo 2027',
      identity: { palette: ['#ffffff'] },
    });
    expect(v2.versionId).toBe('t002');
    expect(await readFile(v1Path, 'utf8')).toBe(v1Raw); // sealed v1 untouched

    const listed = await listPresetVersions(ws.ctx, { presetId: 'logo' });
    expect(listed.map((preset) => preset.versionId)).toEqual(['t001', 't002']);
    expect(await getPresetVersion(ws.ctx, { presetId: 'logo', versionId: 't001' })).toEqual(v1);
    await ws.cleanup();
  });

  test('preset requires an existing client; exact version reads are NOT_FOUND-aware', async () => {
    const ws = await makeTestWorkspace('vm-ws-presets');
    await assertServiceError('NOT_FOUND', () => createPresetVersion(ws.ctx, { presetId: 'logo', clientId: 'fantasma', name: 'X' }));
    await createClient(ws.ctx, { id: 'marca-a', name: 'A' });
    await createPresetVersion(ws.ctx, { presetId: 'logo', clientId: 'marca-a', name: 'Logo' });
    await assertServiceError('NOT_FOUND', () => getPresetVersion(ws.ctx, { presetId: 'logo', versionId: 't999' }));
    await ws.cleanup();
  });
});

describe('creative projects', () => {
  test('project with zero clients is valid; two clients stay independent', async () => {
    const ws = await makeTestWorkspace('vm-ws-projects');
    const solo = await createCreativeProject(ws.ctx, { id: 'solo', name: 'Sin clientes' });
    expect(solo.clientIds).toEqual([]);
    await createClient(ws.ctx, { id: 'marca-a', name: 'A' });
    await createClient(ws.ctx, { id: 'marca-b', name: 'B' });
    const duo = await createCreativeProject(ws.ctx, { id: 'campana', name: 'Campaña', clientIds: ['marca-a', 'marca-b'] });
    expect(duo.clientIds).toEqual(['marca-a', 'marca-b']);
    const projects = await listCreativeProjects(ws.ctx);
    expect(projects.map((project) => project.id).sort()).toEqual(['campana', 'solo']);
    expect(await getCreativeProject(ws.ctx, { id: 'campana' })).toEqual(duo);
    await ws.cleanup();
  });

  test('unknown client, duplicated clients and duplicated project fail', async () => {
    const ws = await makeTestWorkspace('vm-ws-projects');
    await assertServiceError('NOT_FOUND', () => createCreativeProject(ws.ctx, { id: 'p1', name: 'P', clientIds: ['nadie'] }));
    await createClient(ws.ctx, { id: 'marca-a', name: 'A' });
    await assertServiceError('INVALID_INPUT', () =>
      createCreativeProject(ws.ctx, { id: 'p1', name: 'P', clientIds: ['marca-a', 'marca-a'] }),
    );
    await createCreativeProject(ws.ctx, { id: 'p1', name: 'P' });
    await assertServiceError('CONFLICT', () => createCreativeProject(ws.ctx, { id: 'p1', name: 'P otra vez' }));
    await ws.cleanup();
  });
});

describe('open assets', () => {
  test('creating an asset needs no outputs, no recipe and no renderer', async () => {
    const ws = await makeTestWorkspace('vm-ws-assets');
    await createClient(ws.ctx, { id: 'marca-a', name: 'A' });
    const v1 = await createPresetVersion(ws.ctx, { presetId: 'logo', clientId: 'marca-a', name: 'Logo' });
    await createCreativeProject(ws.ctx, { id: 'campana', name: 'Campaña' });
    const asset = await createCreativeAsset(ws.ctx, {
      id: 'cover-feed',
      projectId: 'campana',
      kind: 'image',
      presetRefs: [{ presetId: 'logo', versionId: v1.versionId }],
    });
    expect(asset.title).toBe('cover-feed'); // title defaults to id
    expect(asset.outputs).toEqual([]);
    expect(asset.sources).toEqual([]);
    expect(asset.recipe).toBeUndefined();
    const raw = JSON.parse(await readFile(path.join(ws.root, 'projects', 'campana', 'assets', 'cover-feed', 'asset.json'), 'utf8'));
    expect(raw.presetRefs).toEqual([{ presetId: 'logo', versionId: 't001' }]);
    await ws.cleanup();
  });

  test('unknown project, unknown preset version, bad kind and duplicates fail', async () => {
    const ws = await makeTestWorkspace('vm-ws-assets');
    await createCreativeProject(ws.ctx, { id: 'campana', name: 'Campaña' });
    await assertServiceError('NOT_FOUND', () => createCreativeAsset(ws.ctx, { id: 'a1', projectId: 'otro', kind: 'image' }));
    await assertServiceError('NOT_FOUND', () =>
      createCreativeAsset(ws.ctx, { id: 'a1', projectId: 'campana', kind: 'image', presetRefs: [{ presetId: 'logo', versionId: 'v9' }] }),
    );
    await assertServiceError('INVALID_INPUT', () => createCreativeAsset(ws.ctx, { id: 'a1', projectId: 'campana', kind: 'meme' as 'image' }));
    await createCreativeAsset(ws.ctx, { id: 'a1', projectId: 'campana', kind: 'image' });
    await assertServiceError('CONFLICT', () => createCreativeAsset(ws.ctx, { id: 'a1', projectId: 'campana', kind: 'image' }));
    await ws.cleanup();
  });

  test('inspect reports real paths, presence, exact presets and empty history for a fresh asset', async () => {
    const ws = await makeTestWorkspace('vm-ws-inspect');
    await createClient(ws.ctx, { id: 'marca-a', name: 'A' });
    const v1 = await createPresetVersion(ws.ctx, { presetId: 'logo', clientId: 'marca-a', name: 'Logo' });
    await createCreativeProject(ws.ctx, { id: 'campana', name: 'Campaña' });
    await createCreativeAsset(ws.ctx, {
      id: 'cover-feed',
      projectId: 'campana',
      kind: 'image',
      presetRefs: [{ presetId: 'logo', versionId: v1.versionId }],
    });
    await writeAssetFile(ws.root, 'campana', 'cover-feed', 'workroom/cover.html', '<h1>hola</h1>');
    await editAssetJson(ws.root, 'campana', 'cover-feed', (asset) => {
      asset.sources = ['workroom/cover.html', 'workroom/missing.css'];
      asset.inputs = ['inputs/brief.md'];
      asset.outputs = [{ name: 'cover-feed-v1', path: 'outputs/cover.png', mediaType: 'image/png', role: 'deliverable' }];
    });

    const inspection = await inspectCreativeAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed' });
    expect(inspection.assetDir).toBe(path.join(ws.root, 'projects', 'campana', 'assets', 'cover-feed'));
    expect(inspection.sources).toEqual([
      { path: 'workroom/cover.html', present: true },
      { path: 'workroom/missing.css', present: false },
    ]);
    expect(inspection.inputs).toEqual([{ path: 'inputs/brief.md', present: false }]);
    expect(inspection.presets).toHaveLength(1);
    expect(inspection.presets[0]?.preset?.versionId).toBe(v1.versionId);
    expect(inspection.outputs).toEqual([
      { name: 'cover-feed-v1', path: 'outputs/cover.png', mediaType: 'image/png', role: 'deliverable', visibility: 'private', present: false },
    ]);
    expect('recipe' in inspection).toBe(false);

    expect(inspection.sync).toEqual([]);
    await ws.cleanup();
  });

  test('inspect resolves a missing preset version to preset: null (exact, never latest)', async () => {
    const ws = await makeTestWorkspace('vm-ws-inspect');
    await createCreativeProject(ws.ctx, { id: 'campana', name: 'Campaña' });
    await createCreativeAsset(ws.ctx, { id: 'libre', projectId: 'campana', kind: 'svg' });
    await editAssetJson(ws.root, 'campana', 'libre', (asset) => {
      asset.presetRefs = [{ presetId: 'logo', versionId: 'v404' }];
    });
    const inspection = await inspectCreativeAsset(ws.ctx, { projectId: 'campana', assetId: 'libre' });
    expect(inspection.presets).toEqual([{ presetId: 'logo', versionId: 'v404', preset: null }]);
    await ws.cleanup();
  });
});


