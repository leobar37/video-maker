/**
 * Backup protocol suites (contracts.md §7) over a fake `StudioStorage`:
 * idempotent sync with an immutable manifest commit, failures that never
 * produce a confirmed receipt, shallow/deep verification, cursor pagination
 * and remote-only recovery into a fresh directory. No network, no renders.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { computeRevisionRootHash, sha256Hex } from '@videomaker/schemas';

import type { ObjectMeta, StudioStorage } from './contracts';
import { evaluateRevisionBackup, storageCheckpointKey, storageManifestKey } from './receipts';
import { createProjectCheckpoint, snapshotAsset } from './snapshot';
import { listAllKeys, recoverProjectFromStorage, syncProject, verifyProjectBackup } from './sync';
import {
  assertServiceError,
  editAssetJson,
  makeTestContext,
  makeTestWorkspace,
  writeAssetFile,
  writePresetResource,
  type TestWorkspace,
} from './test-support';
import { createClient, createCreativeAsset, createCreativeProject, createPresetVersion, getPresetVersion, inspectCreativeAsset } from './workspace';

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const LOGO_V1 = new Uint8Array([...PNG_SIGNATURE, 1, 1, 1, 1]);
const LOGO_V2 = new Uint8Array([...PNG_SIGNATURE, 2, 2, 2, 2, 2, 2]);
const COVER_R1 = new Uint8Array([...PNG_SIGNATURE, 9, 9]);
const COVER_R2 = new Uint8Array([...PNG_SIGNATURE, 9, 9, 9, 9]);

interface FakeEntry {
  bytes: Uint8Array;
  mediaType: string;
  /** sha256 recorded at PUT time: HEAD keeps reporting it even if `bytes` is corrupted later. */
  shaAtPut: string;
}

/**
 * In-memory fake of the storage port. Fault injection:
 * - `failPutKeys`: throw BEFORE storing (failure before the commit point).
 * - `loseResponseKeys`: store, THEN throw (response lost after the commit).
 * - `corruptObject`: serve different bytes while HEAD keeps the PUT-time sha
 *   (only a deep GET+SHA verify can detect it).
 */
class FakeStudioStorage implements StudioStorage {
  objects = new Map<string, FakeEntry>();
  listPageSize = 1000;
  reverseListing = false;
  putCalls: string[] = [];
  getCalls: string[] = [];
  listCalls = 0;
  failPutKeys = new Set<string>();
  loseResponseKeys = new Set<string>();

  async head(key: string): Promise<ObjectMeta | null> {
    const entry = this.objects.get(key);
    if (entry === undefined) return null;
    return { key, bytes: entry.bytes.byteLength, sha256: entry.shaAtPut };
  }

  async get(key: string): Promise<Uint8Array> {
    this.getCalls.push(key);
    const entry = this.objects.get(key);
    if (entry === undefined) throw new Error(`fake storage: missing object ${key}`);
    return entry.bytes;
  }

  async putImmutable(key: string, bytes: Uint8Array, mediaType: string): Promise<ObjectMeta> {
    this.putCalls.push(key);
    if (this.failPutKeys.has(key)) {
      throw new Error(`fake storage: injected failure BEFORE commit for ${key}`);
    }
    this.objects.set(key, { bytes, mediaType, shaAtPut: await sha256Hex(bytes) });
    if (this.loseResponseKeys.has(key)) {
      throw new Error(`fake storage: injected LOST RESPONSE after commit for ${key}`);
    }
    return { key, bytes: bytes.byteLength, sha256: await sha256Hex(bytes) };
  }

  async list(prefix: string, cursor?: string): Promise<{ keys: string[]; nextCursor?: string }> {
    this.listCalls += 1;
    const matched = [...this.objects.keys()].filter((key) => key.startsWith(prefix));
    if (this.reverseListing) matched.reverse();
    const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
    const keys = matched.slice(offset, offset + this.listPageSize);
    const nextOffset = offset + this.listPageSize;
    return { keys, ...(nextOffset < matched.length ? { nextCursor: String(nextOffset) } : {}) };
  }

  /** Corrupts served bytes while HEAD keeps trusting the PUT-time sha. */
  corruptObject(key: string, bytes: Uint8Array): void {
    const entry = this.objects.get(key);
    if (entry === undefined) throw new Error(`fake storage: nothing to corrupt at ${key}`);
    entry.bytes = bytes;
  }

  objectGetCalls(): number {
    return this.getCalls.filter((key) => key.startsWith('objects/')).length;
  }
}

/** Image fixture with two revisions (logo/output changed between them). */
async function seedTwoRevisionProject(
  prefix: string,
): Promise<{ ws: TestWorkspace; presetV1: string; presetV2: string; r1: string; r2: string }> {
  const ws = await makeTestWorkspace(prefix);
  await createClient(ws.ctx, { id: 'marca-a', name: 'Marca A' });
  const presetV1 = await createPresetVersion(ws.ctx, {
    presetId: 'logo-brand',
    clientId: 'marca-a',
    name: 'Marca A 2026',
    identity: { palette: ['#0a1f44'], fonts: ['Inter'] },
    resources: [{ path: 'resources/logo.png', sha256: await sha256Hex(LOGO_V1), mediaType: 'image/png' }],
  });
  await writePresetResource(ws.root, 'logo-brand', presetV1.versionId, 'resources/logo.png', LOGO_V1);
  await createCreativeProject(ws.ctx, { id: 'campana', name: 'Campaña Verano', clientIds: ['marca-a'] });
  await createCreativeAsset(ws.ctx, {
    id: 'cover-feed',
    projectId: 'campana',
    kind: 'image',
    title: 'Cover feed',
    presetRefs: [{ presetId: 'logo-brand', versionId: presetV1.versionId }],
  });
  await writeAssetFile(ws.root, 'campana', 'cover-feed', 'workroom/cover.html', '<html><body><h1>Verano</h1></body></html>');
  await writeAssetFile(ws.root, 'campana', 'cover-feed', 'inputs/brief.md', 'brief inicial');
  await writeAssetFile(ws.root, 'campana', 'cover-feed', 'presets/custom.txt', 'notas locales del asset (source)');
  await writeAssetFile(ws.root, 'campana', 'cover-feed', 'outputs/cover.png', COVER_R1);
  await editAssetJson(ws.root, 'campana', 'cover-feed', (asset) => {
    asset.sources = ['workroom/cover.html', 'presets/custom.txt'];
    asset.inputs = ['inputs/brief.md'];
    asset.outputs = [{ name: 'cover-feed', path: 'outputs/cover.png', mediaType: 'image/png', role: 'deliverable' }];
  });
  const first = await snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'r1' });

  // The agent keeps working: a NEW immutable preset version, the asset now
  // referencing it, new output bytes and edited project metadata.
  const presetV2 = await createPresetVersion(ws.ctx, {
    presetId: 'logo-brand',
    clientId: 'marca-a',
    name: 'Marca A 2026 Refresh',
    identity: { palette: ['#ffffff'], fonts: ['Archivo'] },
    resources: [{ path: 'resources/logo.png', sha256: await sha256Hex(LOGO_V2), mediaType: 'image/png' }],
  });
  await writePresetResource(ws.root, 'logo-brand', presetV2.versionId, 'resources/logo.png', LOGO_V2);
  await editAssetJson(ws.root, 'campana', 'cover-feed', (asset) => {
    asset.presetRefs = [{ presetId: 'logo-brand', versionId: presetV2.versionId }];
  });
  await writeAssetFile(ws.root, 'campana', 'cover-feed', 'outputs/cover.png', COVER_R2);
  const projectFile = path.join(ws.root, 'projects', 'campana', 'project.json');
  const project = JSON.parse(await readFile(projectFile, 'utf8')) as Record<string, unknown>;
  project.name = 'Campaña Verano Edición 2';
  await writeFile(projectFile, `${JSON.stringify(project, null, 2)}\n`);
  const second = await snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'r2' });
  return {
    ws,
    presetV1: presetV1.versionId,
    presetV2: presetV2.versionId,
    r1: first.revision.revisionId,
    r2: second.revision.revisionId,
  };
}

async function readReceipt(root: string, projectId: string, assetId: string, revisionId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(root, '.vm', 'receipts', projectId, assetId, `${revisionId}.json`), 'utf8')) as Record<string, unknown>;
}

describe('sync: commit inmutable y receipts', () => {
  test('confirma ambas revisiones: receipt confirmed solo con manifest y todos los objetos confirmados', async () => {
    const { ws, r1, r2 } = await seedTwoRevisionProject('vm-sync-happy');
    const storage = new FakeStudioStorage();
    const { receipts } = await syncProject(ws.ctx, { projectId: 'campana', storage });

    expect(receipts.map((receipt) => receipt.status)).toEqual(['confirmed', 'confirmed']);
    for (const revisionId of [r1, r2]) {
      const receipt = await readReceipt(ws.root, 'campana', 'cover-feed', revisionId);
      expect(receipt.status).toBe('confirmed');
      const manifest = JSON.parse(await readFile(path.join(ws.root, 'revisions', 'campana', 'cover-feed', revisionId, 'manifest.json'), 'utf8')) as {
        files: Array<{ sha256: string }>;
      };
      const expectedKeys = [...new Set(manifest.files.map((file) => `objects/${file.sha256.slice(0, 2)}/${file.sha256}`))];
      for (const key of expectedKeys) {
        expect(receipt.confirmedObjects).toContain(key);
      }
      expect(receipt.confirmedObjects).toContain(storageManifestKey('campana', 'cover-feed', revisionId));
      expect(receipt.error).toBeUndefined();
    }
    // The local structural evidence accepts the receipts (P-002 contract).
    for (const revisionId of [r1, r2]) {
      const manifestPath = path.join(ws.root, 'revisions', 'campana', 'cover-feed', revisionId, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Parameters<typeof evaluateRevisionBackup>[2];
      const evidence = await evaluateRevisionBackup(ws.root, { projectId: 'campana', assetId: 'cover-feed', revisionId }, manifest);
      expect(evidence).toEqual({ status: 'confirmed', receiptVerified: true });
    }
    await ws.cleanup();
  });

  test('retry idempotente: no vuelve a subir ningún objeto ni manifest', async () => {
    const { ws } = await seedTwoRevisionProject('vm-sync-retry');
    const storage = new FakeStudioStorage();
    await syncProject(ws.ctx, { projectId: 'campana', storage });
    const putsBefore = storage.putCalls.length;
    const { receipts } = await syncProject(ws.ctx, { projectId: 'campana', storage });
    expect(storage.putCalls.length).toBe(putsBefore);
    expect(receipts.every((receipt) => receipt.status === 'confirmed')).toBe(true);
    await ws.cleanup();
  });

  test('falla ANTES del commit del manifest ⇒ receipt failed, sin confirmed; el retry deduplica objetos', async () => {
    const { ws, r1 } = await seedTwoRevisionProject('vm-sync-failpre');
    const storage = new FakeStudioStorage();
    const manifestKey = storageManifestKey('campana', 'cover-feed', r1);
    storage.failPutKeys.add(manifestKey);
    const first = await syncProject(ws.ctx, { projectId: 'campana', storage });
    const failedReceipt = first.receipts.find((receipt) => receipt.revisionId === r1)!;
    expect(failedReceipt.status).toBe('failed');
    expect((failedReceipt.error as { code: string }).code).toBe('STORAGE_UNAVAILABLE');
    // Orphan objects are tolerable, but the manifest (commit point) is absent.
    expect(storage.objects.has(manifestKey)).toBe(false);
    expect(storage.objects.size).toBeGreaterThan(0);

    storage.failPutKeys.clear();
    const objectPutsBefore = storage.putCalls.filter((key) => key.startsWith('objects/')).length;
    const second = await syncProject(ws.ctx, { projectId: 'campana', storage });
    expect(storage.putCalls.filter((key) => key.startsWith('objects/')).length).toBe(objectPutsBefore);
    expect(second.receipts.find((receipt) => receipt.revisionId === r1)?.status).toBe('confirmed');
    await ws.cleanup();
  });

  test('respuesta perdida DESPUÉS del commit ⇒ el protocolo la resuelve comparando bytes y confirma sin re-subir', async () => {
    const { ws, r1 } = await seedTwoRevisionProject('vm-sync-lostresp');
    const storage = new FakeStudioStorage();
    const manifestKey = storageManifestKey('campana', 'cover-feed', r1);
    storage.loseResponseKeys.add(manifestKey);
    const first = await syncProject(ws.ctx, { projectId: 'campana', storage });
    // The PUT threw AFTER committing: the failure is resolved by GET + byte
    // comparison, so the receipt is confirmed (never a phantom failed state,
    // never a re-upload).
    expect(first.receipts.find((receipt) => receipt.revisionId === r1)?.status).toBe('confirmed');
    expect(storage.objects.has(manifestKey)).toBe(true);
    expect(storage.putCalls).toContain(manifestKey);

    const putsBefore = storage.putCalls.length;
    const second = await syncProject(ws.ctx, { projectId: 'campana', storage });
    expect(storage.putCalls.length).toBe(putsBefore); // nothing re-uploaded
    expect(second.receipts.find((receipt) => receipt.revisionId === r1)?.status).toBe('confirmed');
    await ws.cleanup();
  });

  test('misma key de objeto con otros bytes ⇒ receipt failed CONFLICT', async () => {
    const { ws, r2 } = await seedTwoRevisionProject('vm-sync-objconflict');
    const storage = new FakeStudioStorage();
    await syncProject(ws.ctx, { projectId: 'campana', storage });
    const manifest = JSON.parse(await readFile(path.join(ws.root, 'revisions', 'campana', 'cover-feed', r2, 'manifest.json'), 'utf8')) as {
      files: Array<{ path: string; sha256: string }>;
    };
    const outputSha = manifest.files.find((file) => file.path === 'outputs/cover.png')!.sha256;
    storage.objects.get(`objects/${outputSha.slice(0, 2)}/${outputSha}`)!.shaAtPut = 'f'.repeat(64);
    const { receipts } = await syncProject(ws.ctx, { projectId: 'campana', storage });
    const receipt = receipts.find((entry) => entry.revisionId === r2)!;
    expect(receipt.status).toBe('failed');
    expect((receipt.error as { code: string }).code).toBe('CONFLICT');
    await ws.cleanup();
  });

  test('manifest remoto con otros bytes para el mismo id ⇒ receipt failed CONFLICT', async () => {
    const { ws, r1 } = await seedTwoRevisionProject('vm-sync-maniconflict');
    const storage = new FakeStudioStorage();
    await syncProject(ws.ctx, { projectId: 'campana', storage });
    const manifestKey = storageManifestKey('campana', 'cover-feed', r1);
    const altered = new TextEncoder().encode('{"schemaVersion":1,"tampered":true}\n');
    storage.objects.get(manifestKey)!.bytes = altered;
    const { receipts } = await syncProject(ws.ctx, { projectId: 'campana', storage });
    const receipt = receipts.find((entry) => entry.revisionId === r1)!;
    expect(receipt.status).toBe('failed');
    expect((receipt.error as { code: string }).code).toBe('CONFLICT');
    await ws.cleanup();
  });

  test('manifest local con rootHash roto ⇒ HASH_MISMATCH y ninguna revisión confirmada', async () => {
    const { ws, r1 } = await seedTwoRevisionProject('vm-sync-localseal');
    const manifestPath = path.join(ws.root, 'revisions', 'campana', 'cover-feed', r1, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.rootHash = 'a'.repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assertServiceError('HASH_MISMATCH', () => syncProject(ws.ctx, { projectId: 'campana', storage: new FakeStudioStorage() }));
    await ws.cleanup();
  });

  test('archivo sellado local corrupto ⇒ receipt failed HASH_MISMATCH (nunca sube bytes que no verifican)', async () => {
    const { ws, r1 } = await seedTwoRevisionProject('vm-sync-sealedcorrupt');
    const sealedOutput = path.join(ws.root, 'revisions', 'campana', 'cover-feed', r1, 'files', 'outputs', 'cover.png');
    await writeFile(sealedOutput, new Uint8Array([...PNG_SIGNATURE, 7, 7, 7]));
    const storage = new FakeStudioStorage();
    const { receipts } = await syncProject(ws.ctx, { projectId: 'campana', storage });
    expect(receipts.find((receipt) => receipt.revisionId === r1)?.status).toBe('failed');
    expect(receipts.every((receipt) => receipt.status !== 'confirmed' || receipt.revisionId !== r1)).toBe(true);
    await ws.cleanup();
  });

  test('checkpoints se suben inmutables con el mismo protocolo', async () => {
    const { ws, r1 } = await seedTwoRevisionProject('vm-sync-cp');
    const checkpoint = await createProjectCheckpoint(ws.ctx, { projectId: 'campana', entries: [{ assetId: 'cover-feed', revisionId: r1 }] });
    const storage = new FakeStudioStorage();
    await syncProject(ws.ctx, { projectId: 'campana', storage });
    const key = storageCheckpointKey('campana', checkpoint.checkpointId);
    expect(storage.objects.has(key)).toBe(true);
    const localBytes = new Uint8Array(await readFile(path.join(ws.root, 'checkpoints', 'campana', `${checkpoint.checkpointId}.json`)));
    expect(storage.objects.get(key)!.bytes).toEqual(localBytes);
    await ws.cleanup();
  });

  test('checkpoint NO se publica si una revisión referenciada quedó sin manifest; el retry lo commitea', async () => {
    const { ws, r1 } = await seedTwoRevisionProject('vm-sync-cpgate');
    const checkpoint = await createProjectCheckpoint(ws.ctx, { projectId: 'campana', entries: [{ assetId: 'cover-feed', revisionId: r1 }] });
    const storage = new FakeStudioStorage();
    storage.failPutKeys.add(storageManifestKey('campana', 'cover-feed', r1));
    const error = await assertServiceError('NOT_FOUND', () => syncProject(ws.ctx, { projectId: 'campana', storage }));
    expect((error.details as { checkpointId?: string }).checkpointId).toBe(checkpoint.checkpointId);
    expect((error.details as { revisionId?: string }).revisionId).toBe(r1);
    // The checkpoint key was NOT published while its reference is missing.
    expect(storage.objects.has(storageCheckpointKey('campana', checkpoint.checkpointId))).toBe(false);
    // After the referenced revision commits, the retry publishes the checkpoint.
    storage.failPutKeys.clear();
    await syncProject(ws.ctx, { projectId: 'campana', storage });
    expect(storage.objects.has(storageCheckpointKey('campana', checkpoint.checkpointId))).toBe(true);
    await ws.cleanup();
  });
});

describe('sync: verificación shallow/deep y catálogo remoto', () => {
  test('verify shallow aprueba un respaldo sano sin GET de objetos', async () => {
    const { ws } = await seedTwoRevisionProject('vm-verify-shallow');
    const storage = new FakeStudioStorage();
    await syncProject(ws.ctx, { projectId: 'campana', storage });
    storage.getCalls.length = 0;
    const result = await verifyProjectBackup(ws.ctx, { projectId: 'campana', storage, deep: false });
    expect(result.failures).toEqual([]);
    expect(result.verified).toHaveLength(2);
    expect(storage.objectGetCalls()).toBe(0);
    await ws.cleanup();
  });

  test('deep verify realmente hace GET+SHA: detecta bytes alterados que el HEAD no ve', async () => {
    const { ws, r2 } = await seedTwoRevisionProject('vm-verify-deep');
    const storage = new FakeStudioStorage();
    await syncProject(ws.ctx, { projectId: 'campana', storage });
    const manifest = JSON.parse(await readFile(path.join(ws.root, 'revisions', 'campana', 'cover-feed', r2, 'manifest.json'), 'utf8')) as {
      files: Array<{ path: string; sha256: string }>;
    };
    const outputSha = manifest.files.find((file) => file.path === 'outputs/cover.png')!.sha256;
    storage.corruptObject(`objects/${outputSha.slice(0, 2)}/${outputSha}`, new Uint8Array([...PNG_SIGNATURE, 5, 5, 5, 5]));

    const shallow = await verifyProjectBackup(ws.ctx, { projectId: 'campana', storage, deep: false });
    expect(shallow.failures).toEqual([]); // HEAD trusts the PUT-time sha: only GET can prove the bytes

    storage.getCalls.length = 0;
    const deep = await verifyProjectBackup(ws.ctx, { projectId: 'campana', storage, deep: true });
    expect(storage.objectGetCalls()).toBeGreaterThan(0);
    expect(deep.failures.length).toBeGreaterThan(0);
    expect(deep.failures.some((failure) => failure.code === 'HASH_MISMATCH')).toBe(true);
    expect(deep.verified.every((ref) => ref.revisionId !== r2)).toBe(true);
    await ws.cleanup();
  });

  test('objeto ausente ⇒ failure NOT_FOUND; revisión local sin manifest remoto ⇒ NOT_FOUND', async () => {
    const { ws, r2 } = await seedTwoRevisionProject('vm-verify-missing');
    const storage = new FakeStudioStorage();
    await syncProject(ws.ctx, { projectId: 'campana', storage });
    const manifest = JSON.parse(await readFile(path.join(ws.root, 'revisions', 'campana', 'cover-feed', r2, 'manifest.json'), 'utf8')) as {
      files: Array<{ path: string; sha256: string }>;
    };
    const briefSha = manifest.files.find((file) => file.path === 'inputs/brief.md')!.sha256;
    storage.objects.delete(`objects/${briefSha.slice(0, 2)}/${briefSha}`);
    const first = await verifyProjectBackup(ws.ctx, { projectId: 'campana', storage, deep: false });
    expect(first.failures.some((failure) => failure.code === 'NOT_FOUND')).toBe(true);

    // A brand-new local revision that was never synced: incomplete backup.
    await writeAssetFile(ws.root, 'campana', 'cover-feed', 'outputs/cover.png', new Uint8Array([...PNG_SIGNATURE, 3, 3, 3]));
    const third = await snapshotAsset(ws.ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'r3 sin sync' });
    const second = await verifyProjectBackup(ws.ctx, { projectId: 'campana', storage, deep: false });
    expect(
      second.failures.some(
        (failure) => failure.code === 'NOT_FOUND' && (failure.details as { revisionId?: string } | undefined)?.revisionId === third.revision.revisionId,
      ),
    ).toBe(true);
    await ws.cleanup();
  });

  test('manifest remoto con mismo id pero otro contenido ⇒ failure HASH_MISMATCH', async () => {
    const { ws, r1 } = await seedTwoRevisionProject('vm-verify-diverge');
    const storage = new FakeStudioStorage();
    await syncProject(ws.ctx, { projectId: 'campana', storage });
    const key = storageManifestKey('campana', 'cover-feed', r1);
    const manifest = JSON.parse(await readFile(path.join(ws.root, 'revisions', 'campana', 'cover-feed', r1, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    manifest.note = 'otra cosa';
    storage.objects.get(key)!.bytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
    const result = await verifyProjectBackup(ws.ctx, { projectId: 'campana', storage, deep: false });
    expect(result.failures.some((failure) => failure.code === 'HASH_MISMATCH')).toBe(true);
    await ws.cleanup();
  });

  test('namespace remoto vacío y workspace sin revisiones ⇒ failure NOT_FOUND (no éxito vacuo)', async () => {
    const ws = await makeTestWorkspace('vm-verify-emptyns');
    const result = await verifyProjectBackup(ws.ctx, { projectId: 'proyecto-sin-backup', storage: new FakeStudioStorage(), deep: false });
    expect(result.verified).toEqual([]);
    expect(result.failures.some((failure) => failure.code === 'NOT_FOUND')).toBe(true);
    await ws.cleanup();
  });
});

describe('recover: remote-only en directorio nuevo', () => {
  test('reconstruye revisiones, proyecto, clientes, presets y assets SIN registry local, con bytes exactos', async () => {
    const { ws, presetV1, presetV2, r1, r2 } = await seedTwoRevisionProject('vm-recover-full');
    const checkpoint = await createProjectCheckpoint(ws.ctx, { projectId: 'campana', entries: [{ assetId: 'cover-feed', revisionId: r2 }] });
    const storage = new FakeStudioStorage();
    await syncProject(ws.ctx, { projectId: 'campana', storage });

    // "Remote-only": a context whose workspace is an EMPTY temp dir.
    const emptyRoot = await mkdtemp(path.join(os.tmpdir(), 'vm-recover-empty-'));
    const remoteCtx = makeTestContext(emptyRoot);
    const outDir = path.join(os.tmpdir(), `vm-recover-out-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    const result = await recoverProjectFromStorage(remoteCtx, { projectId: 'campana', storage, outDir });
    try {
      expect(result.restored.map((ref) => ref.revisionId).sort()).toEqual([r1, r2].sort());

      // Sealed manifest bytes are preserved EXACTLY (receipt binding stays intact).
      for (const revisionId of [r1, r2]) {
        const original = await readFile(path.join(ws.root, 'revisions', 'campana', 'cover-feed', revisionId, 'manifest.json'));
        const recovered = await readFile(path.join(result.outDir, 'revisions', 'campana', 'cover-feed', revisionId, 'manifest.json'));
        expect(new Uint8Array(recovered)).toEqual(new Uint8Array(original));
        const manifest = JSON.parse(recovered.toString()) as unknown as Parameters<typeof computeRevisionRootHash>[0];
        expect(await computeRevisionRootHash(manifest)).toBe(manifest.rootHash);
      }
      // Sealed files: r1 keeps the r1 output bytes, r2 the r2 bytes.
      const r1Output = new Uint8Array(await readFile(path.join(result.outDir, 'revisions', 'campana', 'cover-feed', r1, 'files', 'outputs', 'cover.png')));
      const r2Output = new Uint8Array(await readFile(path.join(result.outDir, 'revisions', 'campana', 'cover-feed', r2, 'files', 'outputs', 'cover.png')));
      expect(r1Output).toEqual(COVER_R1);
      expect(r2Output).toEqual(COVER_R2);

      // Active registry rebuilt from the embedded metadata of the head (r2).
      const project = JSON.parse(await readFile(path.join(result.outDir, 'projects', 'campana', 'project.json'), 'utf8')) as {
        schemaVersion: number;
        id: string;
        name: string;
        clientIds: string[];
      };
      expect(project).toEqual({ schemaVersion: 1, id: 'campana', name: 'Campaña Verano Edición 2', clientIds: ['marca-a'] });
      const client = JSON.parse(await readFile(path.join(result.outDir, 'clients', 'marca-a', 'client.json'), 'utf8')) as { id: string };
      expect(client.id).toBe('marca-a');
      // Registry layout: presets/<id>/versions/<version>/... (role-based
      // routing), with EVERY immutable preset version materialized from all
      // restored revisions — the asset references v2, r1 still embeds v1.
      const preset1 = await readFile(path.join(result.outDir, 'presets', 'logo-brand', 'versions', presetV1, 'preset.json'));
      expect(preset1.toString()).toContain('Marca A 2026');
      const logo1 = new Uint8Array(await readFile(path.join(result.outDir, 'presets', 'logo-brand', 'versions', presetV1, 'resources', 'logo.png')));
      expect(logo1).toEqual(LOGO_V1);
      const preset2 = await readFile(path.join(result.outDir, 'presets', 'logo-brand', 'versions', presetV2, 'preset.json'));
      expect(preset2.toString()).toContain('Marca A 2026 Refresh');
      const logo2 = new Uint8Array(await readFile(path.join(result.outDir, 'presets', 'logo-brand', 'versions', presetV2, 'resources', 'logo.png')));
      expect(logo2).toEqual(LOGO_V2);
      // The recovered registry is USABLE with a fresh context rooted there:
      // preset versions resolve and the asset inspects against real paths.
      const recoveredCtx = makeTestContext(result.outDir);
      const resolvedV1 = await getPresetVersion(recoveredCtx, { presetId: 'logo-brand', versionId: presetV1 });
      expect(resolvedV1.name).toBe('Marca A 2026');
      const resolvedV2 = await getPresetVersion(recoveredCtx, { presetId: 'logo-brand', versionId: presetV2 });
      expect(resolvedV2.name).toBe('Marca A 2026 Refresh');
      const inspection = await inspectCreativeAsset(recoveredCtx, { projectId: 'campana', assetId: 'cover-feed' });
      expect(inspection.assetDir).toBe(path.join(result.outDir, 'projects', 'campana', 'assets', 'cover-feed'));
      expect(inspection.presets).toBeDefined();
      const resolvedPreset = inspection.presets[0]?.preset;
      expect(resolvedPreset?.versionId).toBe(presetV2);
      expect(resolvedPreset?.name).toBe('Marca A 2026 Refresh');
      // An asset-local source directory named presets/ is ordinary asset
      // content: it stays inside the asset, never becomes registry.
      const localPresets = await readFile(path.join(result.outDir, 'projects', 'campana', 'assets', 'cover-feed', 'presets', 'custom.txt'));
      expect(localPresets.toString()).toContain('notas locales del asset');
      expect(await pathExistsQuiet(path.join(result.outDir, 'presets', 'custom.txt'))).toBe(false);
      // Active working copies of the selected revision.
      const assetJson = JSON.parse(await readFile(path.join(result.outDir, 'projects', 'campana', 'assets', 'cover-feed', 'asset.json'), 'utf8')) as { id: string };
      expect(assetJson.id).toBe('cover-feed');
      const activeOutput = new Uint8Array(await readFile(path.join(result.outDir, 'projects', 'campana', 'assets', 'cover-feed', 'outputs', 'cover.png')));
      expect(activeOutput).toEqual(COVER_R2);
      const html = await readFile(path.join(result.outDir, 'projects', 'campana', 'assets', 'cover-feed', 'workroom', 'cover.html'));
      expect(html.toString()).toContain('Verano');
      // Checkpoints travel with the same protocol (raw bytes).
      const recoveredCheckpoint = await readFile(path.join(result.outDir, 'checkpoints', 'campana', `${checkpoint.checkpointId}.json`));
      const originalCheckpoint = await readFile(path.join(ws.root, 'checkpoints', 'campana', `${checkpoint.checkpointId}.json`));
      expect(recoveredCheckpoint.equals(originalCheckpoint)).toBe(true);
    } finally {
      await rm(result.outDir, { recursive: true, force: true });
      await rm(emptyRoot, { recursive: true, force: true });
      await ws.cleanup();
    }
  });

  test('checkpoint selector restaura la metadata activa de r1 aunque r2 sea la cabeza', async () => {
    const { ws, r1 } = await seedTwoRevisionProject('vm-recover-cp');
    const checkpoint = await createProjectCheckpoint(ws.ctx, { projectId: 'campana', entries: [{ assetId: 'cover-feed', revisionId: r1 }] });
    const storage = new FakeStudioStorage();
    await syncProject(ws.ctx, { projectId: 'campana', storage });
    const emptyRoot = await mkdtemp(path.join(os.tmpdir(), 'vm-recover-cp-'));
    const remoteCtx = makeTestContext(emptyRoot);
    const outDir = path.join(os.tmpdir(), `vm-recover-cp-out-${Date.now()}`);
    const result = await recoverProjectFromStorage(remoteCtx, {
      projectId: 'campana',
      storage,
      outDir,
      checkpointId: checkpoint.checkpointId,
    });
    try {
      const project = JSON.parse(await readFile(path.join(result.outDir, 'projects', 'campana', 'project.json'), 'utf8')) as { name: string };
      expect(project.name).toBe('Campaña Verano'); // r1 metadata, not the r2 head
      const activeOutput = new Uint8Array(await readFile(path.join(result.outDir, 'projects', 'campana', 'assets', 'cover-feed', 'outputs', 'cover.png')));
      expect(activeOutput).toEqual(COVER_R1);
    } finally {
      await rm(result.outDir, { recursive: true, force: true });
      await rm(emptyRoot, { recursive: true, force: true });
      await ws.cleanup();
    }
  });

  test('recover por defecto: checkpoint con entrada colgante ⇒ NOT_FOUND y no se materializa', async () => {
    const { ws, r1 } = await seedTwoRevisionProject('vm-recover-cpdangling');
    const checkpoint = await createProjectCheckpoint(ws.ctx, { projectId: 'campana', entries: [{ assetId: 'cover-feed', revisionId: r1 }] });
    const storage = new FakeStudioStorage();
    await syncProject(ws.ctx, { projectId: 'campana', storage });
    const key = storageCheckpointKey('campana', checkpoint.checkpointId);
    const document = JSON.parse(new TextDecoder().decode(storage.objects.get(key)!.bytes)) as Record<string, unknown>;
    (document.entries as Array<Record<string, unknown>>)[0]!.revisionId = 'revision-fantasma';
    storage.objects.get(key)!.bytes = new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);

    const emptyRoot = await mkdtemp(path.join(os.tmpdir(), 'vm-recover-dangling-'));
    const remoteCtx = makeTestContext(emptyRoot);
    const outDir = path.join(os.tmpdir(), `vm-recover-dangling-out-${Date.now()}`);
    const error = await assertServiceError('NOT_FOUND', () => recoverProjectFromStorage(remoteCtx, { projectId: 'campana', storage, outDir }));
    expect((error.details as { revisionId?: string }).revisionId).toBe('revision-fantasma');
    expect(await pathExistsQuiet(path.join(outDir, 'checkpoints', 'campana', `${checkpoint.checkpointId}.json`))).toBe(false);
    await rm(emptyRoot, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
    await ws.cleanup();
  });

  test('recover por defecto: rootHash del checkpoint divergente ⇒ HASH_MISMATCH y no se materializa', async () => {
    const { ws, r1 } = await seedTwoRevisionProject('vm-recover-cproot');
    const checkpoint = await createProjectCheckpoint(ws.ctx, { projectId: 'campana', entries: [{ assetId: 'cover-feed', revisionId: r1 }] });
    const storage = new FakeStudioStorage();
    await syncProject(ws.ctx, { projectId: 'campana', storage });
    const key = storageCheckpointKey('campana', checkpoint.checkpointId);
    const document = JSON.parse(new TextDecoder().decode(storage.objects.get(key)!.bytes)) as Record<string, unknown>;
    (document.entries as Array<Record<string, unknown>>)[0]!.rootHash = 'b'.repeat(64);
    storage.objects.get(key)!.bytes = new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);

    const emptyRoot = await mkdtemp(path.join(os.tmpdir(), 'vm-recover-cproot-'));
    const remoteCtx = makeTestContext(emptyRoot);
    const outDir = path.join(os.tmpdir(), `vm-recover-cproot-out-${Date.now()}`);
    await assertServiceError('HASH_MISMATCH', () => recoverProjectFromStorage(remoteCtx, { projectId: 'campana', storage, outDir }));
    expect(await pathExistsQuiet(path.join(outDir, 'checkpoints', 'campana', `${checkpoint.checkpointId}.json`))).toBe(false);
    await rm(emptyRoot, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
    await ws.cleanup();
  });

  test('recover por defecto: checkpointId de la key ≠ documento ⇒ INVALID_INPUT y no se materializa', async () => {
    const { ws, r1 } = await seedTwoRevisionProject('vm-recover-cpkey');
    const checkpoint = await createProjectCheckpoint(ws.ctx, { projectId: 'campana', entries: [{ assetId: 'cover-feed', revisionId: r1 }] });
    const storage = new FakeStudioStorage();
    await syncProject(ws.ctx, { projectId: 'campana', storage });
    // The SAME valid document stored under a DIFFERENT key basename.
    storage.objects.set('studio/v1/projects/campana/checkpoints/otro-id.json', storage.objects.get(storageCheckpointKey('campana', checkpoint.checkpointId))!);

    const emptyRoot = await mkdtemp(path.join(os.tmpdir(), 'vm-recover-cpkey-'));
    const remoteCtx = makeTestContext(emptyRoot);
    const outDir = path.join(os.tmpdir(), `vm-recover-cpkey-out-${Date.now()}`);
    await assertServiceError('INVALID_INPUT', () => recoverProjectFromStorage(remoteCtx, { projectId: 'campana', storage, outDir }));
    expect(await pathExistsQuiet(path.join(outDir, 'checkpoints', 'campana', 'otro-id.json'))).toBe(false);
    await rm(emptyRoot, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
    await ws.cleanup();
  });
  test('revisionRefs explícitos eligen la metadata activa; ambas revisiones se preservan', async () => {
    const { ws, r1, r2 } = await seedTwoRevisionProject('vm-recover-refs');
    const storage = new FakeStudioStorage();
    await syncProject(ws.ctx, { projectId: 'campana', storage });
    const emptyRoot = await mkdtemp(path.join(os.tmpdir(), 'vm-recover-refs-'));
    const remoteCtx = makeTestContext(emptyRoot);
    const outDir = path.join(os.tmpdir(), `vm-recover-refs-out-${Date.now()}`);
    const result = await recoverProjectFromStorage(remoteCtx, {
      projectId: 'campana',
      storage,
      outDir,
      revisionRefs: [{ projectId: 'campana', assetId: 'cover-feed', revisionId: r1 }],
    });
    try {
      const project = JSON.parse(await readFile(path.join(result.outDir, 'projects', 'campana', 'project.json'), 'utf8')) as { name: string };
      expect(project.name).toBe('Campaña Verano');
      expect(result.restored.map((ref) => ref.revisionId).sort()).toEqual([r1, r2].sort()); // nothing dropped
    } finally {
      await rm(result.outDir, { recursive: true, force: true });
      await rm(emptyRoot, { recursive: true, force: true });
      await ws.cleanup();
    }
  });

  test('varias cabezas ⇒ CONFLICT pidiendo selector, sin escribir nada en el destino', async () => {
    const { ws, r1, r2 } = await seedTwoRevisionProject('vm-recover-heads');
    const storage = new FakeStudioStorage();
    await syncProject(ws.ctx, { projectId: 'campana', storage });
    // parentRevisionId is EXCLUDED from the seal: removing it keeps rootHash
    // valid. The branch is crafted DIRECTLY in the remote state (re-syncing
    // would be a CONFLICT: same key, different bytes — exactly the protocol).
    const r2ManifestPath = path.join(ws.root, 'revisions', 'campana', 'cover-feed', r2, 'manifest.json');
    const r2Manifest = JSON.parse(await readFile(r2ManifestPath, 'utf8')) as Record<string, unknown>;
    delete r2Manifest.parentRevisionId;
    const remoteKey = storageManifestKey('campana', 'cover-feed', r2);
    storage.objects.get(remoteKey)!.bytes = new TextEncoder().encode(`${JSON.stringify(r2Manifest, null, 2)}\n`);

    const emptyRoot = await mkdtemp(path.join(os.tmpdir(), 'vm-recover-heads-'));
    const remoteCtx = makeTestContext(emptyRoot);
    const outDir = path.join(os.tmpdir(), `vm-recover-heads-out-${Date.now()}`);
    const error = await assertServiceError('CONFLICT', () => recoverProjectFromStorage(remoteCtx, { projectId: 'campana', storage, outDir }));
    expect((error.details as { heads?: string[] }).heads).toEqual([r1, r2].sort());
    expect(await pathExistsQuiet(outDir)).toBe(false); // conflict BEFORE any write
    await rm(emptyRoot, { recursive: true, force: true });
    await ws.cleanup();
  });

  test('destino no vacío ⇒ CONFLICT; destino solapado con el workspace ⇒ PATH_UNSAFE', async () => {
    const { ws } = await seedTwoRevisionProject('vm-recover-guard');
    const storage = new FakeStudioStorage();
    await syncProject(ws.ctx, { projectId: 'campana', storage });

    const nonEmpty = await mkdtemp(path.join(os.tmpdir(), 'vm-recover-nonempty-'));
    await writeFile(path.join(nonEmpty, 'algo.txt'), 'x');
    await assertServiceError('CONFLICT', () => recoverProjectFromStorage(ws.ctx, { projectId: 'campana', storage, outDir: nonEmpty }));

    await assertServiceError('PATH_UNSAFE', () =>
      recoverProjectFromStorage(ws.ctx, { projectId: 'campana', storage, outDir: path.join(ws.root, 'recovered') }),
    );
    await rm(nonEmpty, { recursive: true, force: true });
    await ws.cleanup();
  });

  test('el orden del listado remoto jamás decide la metadata activa', async () => {
    const { ws } = await seedTwoRevisionProject('vm-recover-order');
    const storage = new FakeStudioStorage();
    storage.reverseListing = true;
    await syncProject(ws.ctx, { projectId: 'campana', storage });
    const emptyRoot = await mkdtemp(path.join(os.tmpdir(), 'vm-recover-order-'));
    const remoteCtx = makeTestContext(emptyRoot);
    const outDir = path.join(os.tmpdir(), `vm-recover-order-out-${Date.now()}`);
    const result = await recoverProjectFromStorage(remoteCtx, { projectId: 'campana', storage, outDir });
    try {
      const project = JSON.parse(await readFile(path.join(result.outDir, 'projects', 'campana', 'project.json'), 'utf8')) as { name: string };
      expect(project.name).toBe('Campaña Verano Edición 2'); // the head, not the first listed
    } finally {
      await rm(result.outDir, { recursive: true, force: true });
      await rm(emptyRoot, { recursive: true, force: true });
      await ws.cleanup();
    }
  });
});

describe('paginación y cursores', () => {
  test('listAllKeys recorre TODAS las páginas siguiendo cursores', async () => {
    const { ws, r1, r2 } = await seedTwoRevisionProject('vm-pages');
    const storage = new FakeStudioStorage();
    storage.listPageSize = 1;
    await syncProject(ws.ctx, { projectId: 'campana', storage });
    const expectedKeys = [...storage.objects.keys()].sort();
    storage.listCalls = 0;
    const keys = await listAllKeys(storage, 'studio/v1/projects/campana/assets/');
    expect(keys).toContain(storageManifestKey('campana', 'cover-feed', r1));
    expect(keys).toContain(storageManifestKey('campana', 'cover-feed', r2));
    expect(keys.length).toBe(expectedKeys.filter((key) => key.startsWith('studio/v1/projects/campana/assets/')).length);
    expect(storage.listCalls).toBe(2); // one page per manifest key, cursors followed
    await ws.cleanup();
  });

  test('la recuperación lista hasta el fin aunque el storage page de a 1', async () => {
    const { ws, r1, r2 } = await seedTwoRevisionProject('vm-pages-recover');
    const storage = new FakeStudioStorage();
    storage.listPageSize = 1;
    await syncProject(ws.ctx, { projectId: 'campana', storage });
    const emptyRoot = await mkdtemp(path.join(os.tmpdir(), 'vm-pages-recover-'));
    const remoteCtx = makeTestContext(emptyRoot);
    const outDir = path.join(os.tmpdir(), `vm-pages-recover-out-${Date.now()}`);
    const result = await recoverProjectFromStorage(remoteCtx, { projectId: 'campana', storage, outDir });
    try {
      expect(result.restored.map((ref) => ref.revisionId).sort()).toEqual([r1, r2].sort());
      expect(storage.listCalls).toBeGreaterThan(2);
    } finally {
      await rm(result.outDir, { recursive: true, force: true });
      await rm(emptyRoot, { recursive: true, force: true });
      await ws.cleanup();
    }
  });
});

async function pathExistsQuiet(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  );
}
