/**
 * Bridge acceptance tests (P-003) against an IN-PROCESS fake portal origin
 * (127.0.0.1:0 — zero real network, gate G-cap-live):
 *
 * - adopt: the same studioClientId under two workspaceIds never mixes clients.
 * - pull: verified import into an OPEN asset's inputs with a deterministic
 *   provenance sidecar and locked atomic asset.json update; retries converge
 *   to identical bytes/path/relation; corrupted hashes, symlink escapes and
 *   destination conflicts fail WITHOUT altering previous asset state.
 * - push: sealed-manifest rootHash re-computation (pure module), local byte
 *   verification, EXACT selected outputs only (no sources/recipe/manifests),
 *   r1 stays byte-identical through r2 work, and idempotent retries.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256Hex } from '@videomaker/schemas';
import {
  StudioServiceError,
  createStudioContext,
  getRevisionManifest,
  snapshotAsset,
} from '@videomaker/studio';
import { ApiClientError, createCustomerAssetsClient } from '@videomaker/customer-assets/client';

import { adoptPortalClient, pullMaterial, pushDelivery } from './bridge';
import { JPEG_BYTES, PNG_BYTES, makeWorkspace, startFakePortal, type FakePortal } from './testing';

const tempRoots: string[] = [];
const fakes: FakePortal[] = [];
const apiKeyStack: (string | undefined)[] = [];

async function makeWorkspaceTracked(prefix?: string) {
  const fixture = await makeWorkspace(prefix);
  tempRoots.push(fixture.root);
  return fixture;
}

async function startFakeTracked(options?: Parameters<typeof startFakePortal>[0]) {
  const fake = await startFakePortal(options);
  fakes.push(fake);
  return fake;
}

/** Injects the credential for the duration of `fn` (bridge reads process.env). */
async function withApiKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  apiKeyStack.push(process.env.CUSTOMER_ASSETS_API_KEY);
  process.env.CUSTOMER_ASSETS_API_KEY = key;
  try {
    return await fn();
  } finally {
    const previous = apiKeyStack.pop();
    if (previous === undefined) delete process.env.CUSTOMER_ASSETS_API_KEY;
    else process.env.CUSTOMER_ASSETS_API_KEY = previous;
  }
}

interface AssetDoc {
  schemaVersion: number;
  id: string;
  projectId: string;
  kind: string;
  title: string;
  presetRefs: unknown[];
  sources: string[];
  inputs: string[];
  outputs: Array<{ name: string; path: string; mediaType: string; role: string; visibility: string }>;
  recipe?: unknown;
}

async function readAssetJson(assetDir: string): Promise<AssetDoc> {
  return JSON.parse(await readFile(join(assetDir, 'asset.json'), 'utf8')) as AssetDoc;
}

async function writeAssetJson(assetDir: string, doc: AssetDoc): Promise<void> {
  await writeFile(join(assetDir, 'asset.json'), `${JSON.stringify(doc, null, 2)}\n`);
}

/** Declares an output spec + writes its bytes (the open-workshop way). */
async function declareOutput(assetDir: string, name: string, relPath: string, mediaType: string, bytes: Uint8Array): Promise<void> {
  const doc = await readAssetJson(assetDir);
  doc.outputs.push({ name, path: relPath, mediaType, role: 'deliverable', visibility: 'public' });
  await writeAssetJson(assetDir, doc);
  const abs = join(assetDir, relPath);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, bytes);
}

async function sealRevision(workspaceDir: string, projectId: string, assetId: string, note: string): Promise<string> {
  const { revision } = await snapshotAsset(createStudioContext(workspaceDir), { projectId, assetId, note });
  return revision.revisionId;
}

async function sealFileSha(workspaceDir: string, projectId: string, assetId: string, revisionId: string, relPath: string): Promise<string> {
  const bytes = await readFile(join(workspaceDir, 'revisions', projectId, assetId, revisionId, 'files', relPath));
  return sha256Hex(new Uint8Array(bytes));
}

/** Declares a source directory with a marker file that must NEVER travel. */
async function declareSecretSource(workspaceDir: string, projectId: string, assetId: string): Promise<void> {
  const assetDir = join(workspaceDir, 'projects', projectId, 'assets', assetId);
  await mkdir(join(assetDir, 'workroom', 'notes'), { recursive: true });
  await writeFile(join(assetDir, 'workroom', 'notes', 'ideas.txt'), 'SECRET-NOTES-MARKER internal brainstorm\n');
  const doc = await readAssetJson(assetDir);
  if (!doc.sources.includes('workroom')) doc.sources.push('workroom');
  await writeAssetJson(assetDir, doc);
}

/** Type-guard assertion: the error must be a StudioServiceError with `code`. */
function expectStudioCode(error: unknown, code: string): void {
  if (!(error instanceof StudioServiceError)) {
    throw new Error(`se esperaba StudioServiceError(${code}); llegó: ${String(error)}`);
  }
  if (error.code !== code) {
    throw new Error(`se esperaba código ${code}; llegó ${error.code}`);
  }
}

afterAll(async () => {
  await Promise.all(fakes.map((fake) => fake.stop()));
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------

describe('adoptPortalClient', () => {
  test('projects the same studioClientId into two workspaceIds WITHOUT mixing clients', async () => {
    const fake = await startFakeTracked();
    const ws = await makeWorkspaceTracked();
    await withApiKey(fake.apiKey, async () => {
      const first = await adoptPortalClient({ origin: fake.origin, workspaceDir: ws.workspaceDir, workspaceId: 'ws-one', studioClientId: ws.studioClientId });
      const second = await adoptPortalClient({ origin: fake.origin, workspaceDir: ws.workspaceDir, workspaceId: 'ws-two', studioClientId: ws.studioClientId });
      // Distinct projections per workspace; the (workspaceId, studioClientId)
      // pair — never the slug — identifies the client.
      expect(first.portalClient.id).not.toBe(second.portalClient.id);
      expect(first.portalClient.workspaceId).toBe('ws-one');
      expect(second.portalClient.workspaceId).toBe('ws-two');
      expect(first.portalClient.studioClientId).toBe(ws.studioClientId);
      // Replay under ws-one returns the SAME projection (idempotent adopt).
      const replay = await adoptPortalClient({ origin: fake.origin, workspaceDir: ws.workspaceDir, workspaceId: 'ws-one', studioClientId: ws.studioClientId });
      expect(replay.portalClient.id).toBe(first.portalClient.id);

      // Materials live under their own projection: lists never mix.
      const sdk = createCustomerAssetsClient({ baseUrl: fake.origin, apiKey: fake.apiKey });
      const matOne = await fake.seedMaterial({ clientId: first.portalClient.id, name: 'b-roll.mp4', mediaType: 'video/mp4', bytes: JPEG_BYTES });
      await fake.seedMaterial({ clientId: second.portalClient.id, name: 'b-roll.mp4', mediaType: 'video/mp4', bytes: PNG_BYTES });
      const pageOne = await sdk.listMaterials(first.portalClient.id);
      const pageTwo = await sdk.listMaterials(second.portalClient.id);
      expect(pageOne.items.map((item) => item.id)).toEqual([matOne.id]);
      expect(pageTwo.items.every((item) => item.clientId === second.portalClient.id)).toBe(true);
      expect(matOne.clientId).toBe(first.portalClient.id);
    });
  });

  test('requires the local studio client to exist (never invents one)', async () => {
    const fake = await startFakeTracked();
    const ws = await makeWorkspaceTracked();
    await withApiKey(fake.apiKey, async () => {
      expect(adoptPortalClient({ origin: fake.origin, workspaceDir: ws.workspaceDir, workspaceId: 'ws-one', studioClientId: 'ghost-client' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(fake.requests.length).toBe(0);
    });
  });
});

describe('pullMaterial', () => {
  test('imports a material into the open asset with sidecar and atomic relation', async () => {
    const fake = await startFakeTracked();
    const ws = await makeWorkspaceTracked();
    await withApiKey(fake.apiKey, async () => {
      const portal = await adoptPortalClient({ origin: fake.origin, workspaceDir: ws.workspaceDir, workspaceId: 'ws-one', studioClientId: ws.studioClientId });
      const material = await fake.seedMaterial({ clientId: portal.portalClient.id, name: 'foto cliente.png', mediaType: 'image/png', bytes: PNG_BYTES });

      const result = await pullMaterial({ origin: fake.origin, workspaceDir: ws.workspaceDir, projectId: ws.projectId, assetId: ws.assetId, materialId: material.id });

      expect(result.addedInputs).toEqual([result.inputPath, result.provenancePath]);
      expect(result.reusedBytes).toBe(false);
      expect(result.portalClient.studioClientId).toBe(ws.studioClientId);
      const inputBytes = new Uint8Array(await readFile(join(ws.assetDir, result.inputPath)));
      expect(await sha256Hex(inputBytes)).toBe(material.sha256);
      expect(inputBytes.length).toBe(material.bytes);

      const provenance = JSON.parse(await readFile(join(ws.assetDir, result.provenancePath), 'utf8')) as Record<string, unknown>;
      expect(provenance).toMatchObject({ source: 'portal', origin: fake.origin, materialId: material.id, portalClientId: portal.portalClient.id, sha256: material.sha256 });
      // No credentials in provenance — ever.
      expect(JSON.stringify(provenance).toLowerCase()).not.toContain('api-key');

      const doc = await readAssetJson(ws.assetDir);
      expect(doc.inputs).toEqual([result.inputPath, result.provenancePath]);

      // The confined temp area and the lock are cleaned up.
      await expect(readdir(join(ws.workspaceDir, '.vm', 'tmp'))).resolves.toEqual([]);
      await expect(readdir(join(ws.workspaceDir, '.vm', 'locks'))).resolves.toEqual([]);
    });
  });

  test('retry converges: identical bytes/path/relation, no duplicates, no rewrite', async () => {
    const fake = await startFakeTracked();
    const ws = await makeWorkspaceTracked();
    await withApiKey(fake.apiKey, async () => {
      const portal = await adoptPortalClient({ origin: fake.origin, workspaceDir: ws.workspaceDir, workspaceId: 'ws-one', studioClientId: ws.studioClientId });
      const material = await fake.seedMaterial({ clientId: portal.portalClient.id, name: 'foto.png', mediaType: 'image/png', bytes: PNG_BYTES });
      const first = await pullMaterial({ origin: fake.origin, workspaceDir: ws.workspaceDir, projectId: ws.projectId, assetId: ws.assetId, materialId: material.id });
      const assetJsonAfterFirst = await readFile(join(ws.assetDir, 'asset.json'), 'utf8');

      const second = await pullMaterial({ origin: fake.origin, workspaceDir: ws.workspaceDir, projectId: ws.projectId, assetId: ws.assetId, materialId: material.id });

      expect(second.inputPath).toBe(first.inputPath);
      expect(second.provenancePath).toBe(first.provenancePath);
      expect(second.reusedBytes).toBe(true);
      expect(second.addedInputs).toEqual([]);
      expect(await readFile(join(ws.assetDir, 'asset.json'), 'utf8')).toBe(assetJsonAfterFirst);
      const doc = await readAssetJson(ws.assetDir);
      expect(doc.inputs.filter((entry) => entry === first.inputPath).length).toBe(1);
    });
  });

  test('corrupted download fails HASH_MISMATCH without altering previous asset state', async () => {
    const fake = await startFakeTracked();
    const ws = await makeWorkspaceTracked();
    await withApiKey(fake.apiKey, async () => {
      const portal = await adoptPortalClient({ origin: fake.origin, workspaceDir: ws.workspaceDir, workspaceId: 'ws-one', studioClientId: ws.studioClientId });
      const material = await fake.seedMaterial({ clientId: portal.portalClient.id, name: 'a.png', mediaType: 'image/png', bytes: PNG_BYTES });
      const good = await pullMaterial({ origin: fake.origin, workspaceDir: ws.workspaceDir, projectId: ws.projectId, assetId: ws.assetId, materialId: material.id });
      const assetJsonBefore = await readFile(join(ws.assetDir, 'asset.json'), 'utf8');

      fake.swapMaterialBytes(material.id, JPEG_BYTES);
      try {
        await pullMaterial({ origin: fake.origin, workspaceDir: ws.workspaceDir, projectId: ws.projectId, assetId: ws.assetId, materialId: material.id });
        throw new Error('expected HASH_MISMATCH');
      } catch (error) {
        expectStudioCode(error, 'HASH_MISMATCH');
      }
      // Previous import untouched: same asset.json, same input bytes.
      expect(await readFile(join(ws.assetDir, 'asset.json'), 'utf8')).toBe(assetJsonBefore);
      const inputBytes = new Uint8Array(await readFile(join(ws.assetDir, good.inputPath)));
      expect(await sha256Hex(inputBytes)).toBe(material.sha256);
    });
  });

  test('symlinked input component is rejected; the symlink target is never touched', async () => {
    const fake = await startFakeTracked();
    const ws = await makeWorkspaceTracked();
    const escapeDir = join(ws.root, 'outside');
    await mkdir(escapeDir, { recursive: true });
    await symlink(escapeDir, join(ws.assetDir, 'inputs'));
    await withApiKey(fake.apiKey, async () => {
      const portal = await adoptPortalClient({ origin: fake.origin, workspaceDir: ws.workspaceDir, workspaceId: 'ws-one', studioClientId: ws.studioClientId });
      const material = await fake.seedMaterial({ clientId: portal.portalClient.id, name: 'a.png', mediaType: 'image/png', bytes: PNG_BYTES });
      try {
        await pullMaterial({ origin: fake.origin, workspaceDir: ws.workspaceDir, projectId: ws.projectId, assetId: ws.assetId, materialId: material.id });
        throw new Error('expected PATH_UNSAFE');
      } catch (error) {
        expectStudioCode(error, 'PATH_UNSAFE');
      }
      await expect(readdir(escapeDir)).resolves.toEqual([]);
      const doc = await readAssetJson(ws.assetDir);
      expect(doc.inputs).toEqual([]);
    });
  });

  test('a DIFFERENT file at the destination is a conflict and is never overwritten', async () => {
    const fake = await startFakeTracked();
    const ws = await makeWorkspaceTracked();
    await withApiKey(fake.apiKey, async () => {
      const portal = await adoptPortalClient({ origin: fake.origin, workspaceDir: ws.workspaceDir, workspaceId: 'ws-one', studioClientId: ws.studioClientId });
      const material = await fake.seedMaterial({ clientId: portal.portalClient.id, name: 'a.png', mediaType: 'image/png', bytes: PNG_BYTES });
      const first = await pullMaterial({ origin: fake.origin, workspaceDir: ws.workspaceDir, projectId: ws.projectId, assetId: ws.assetId, materialId: material.id });
      const tampered = Uint8Array.from([0x00, 0x01, 0x02, 0x03]);
      await writeFile(join(ws.assetDir, first.inputPath), tampered);

      try {
        await pullMaterial({ origin: fake.origin, workspaceDir: ws.workspaceDir, projectId: ws.projectId, assetId: ws.assetId, materialId: material.id });
        throw new Error('expected CONFLICT');
      } catch (error) {
        expectStudioCode(error, 'CONFLICT');
      }
      // The different file survives untouched; the relation is unchanged.
      expect(await sha256Hex(new Uint8Array(await readFile(join(ws.assetDir, first.inputPath))))).toBe(await sha256Hex(tampered));
      const doc = await readAssetJson(ws.assetDir);
      expect(doc.inputs).toContain(first.inputPath);
    });
  });
});

describe('pushDelivery', () => {
  async function scenarioWithRevision() {
    const fake = await startFakeTracked();
    const ws = await makeWorkspaceTracked();
    await declareOutput(ws.assetDir, 'cover', 'outputs/cover.png', 'image/png', PNG_BYTES);
    const revisionId = await sealRevision(ws.workspaceDir, ws.projectId, ws.assetId, 'r1');
    return { fake, ws, revisionId };
  }

  test('pushes ONLY the selected output of r1; sources/recipe/manifest never travel', async () => {
    const { fake, ws, revisionId } = await scenarioWithRevision();
    await declareSecretSource(ws.workspaceDir, ws.projectId, ws.assetId);
    await withApiKey(fake.apiKey, async () => {
      const result = await pushDelivery({
        origin: fake.origin,
        workspaceDir: ws.workspaceDir,
        portalClientId: (await adoptPortalClient({ origin: fake.origin, workspaceDir: ws.workspaceDir, workspaceId: 'ws-one', studioClientId: ws.studioClientId })).portalClient.id,
        projectId: ws.projectId,
        assetId: ws.assetId,
        revisionId,
        outputNames: ['cover'],
      });

      expect(result.delivery.status).toBe('ready');
      expect(result.rootHash).toBe((await getRevisionManifest(createStudioContext(ws.workspaceDir), { projectId: ws.projectId, assetId: ws.assetId, revisionId })).rootHash);
      const deliveries = fake.deliveries();
      expect(deliveries.length).toBe(1);
      expect([...deliveries[0]!.outputs.keys()]).toEqual(['cover']);
      const staged = deliveries[0]!.outputs.get('cover')!;
      expect(staged.bytes).not.toBeNull();
      expect(await sha256Hex(staged.bytes!)).toBe(await sha256Hex(PNG_BYTES));

      // Only the selected output travelled: one PUT; no manifest document,
      // recipe or source bytes in ANY request body. (The delivery JSON does
      // carry the rootHash + output refs by contract — provenance, not bytes.)
      const putRequests = fake.requests.filter((request) => request.method === 'PUT');
      expect(putRequests.length).toBe(1);
      for (const request of fake.requests) {
        expect(request.bodyText ?? '').not.toContain('SECRET-NOTES-MARKER');
        expect(request.bodyText ?? '').not.toContain('"schemaVersion"');
        expect(request.bodyText ?? '').not.toContain('"files"');
        expect(request.bodyText ?? '').not.toContain('"assetSnapshot"');
        expect(request.bodyText ?? '').not.toContain('"recipeSnapshot"');
      }
    });
  });

  test('r2 work keeps the portal r1 byte-identical and pushes only new declared output', async () => {
    const { fake, ws, revisionId } = await scenarioWithRevision();
    await withApiKey(fake.apiKey, async () => {
      const portal = (await adoptPortalClient({ origin: fake.origin, workspaceDir: ws.workspaceDir, workspaceId: 'ws-one', studioClientId: ws.studioClientId })).portalClient;
      const pushArgs = {
        origin: fake.origin,
        workspaceDir: ws.workspaceDir,
        portalClientId: portal.id,
        projectId: ws.projectId,
        assetId: ws.assetId,
      };
      const r1 = await pushDelivery({ ...pushArgs, revisionId, outputNames: ['cover'] });
      const r1CoverSha = await sealFileSha(ws.workspaceDir, ws.projectId, ws.assetId, revisionId, 'outputs/cover.png');

      // Simulate r2 work: a NEW output plus internal sources; r1 stays sealed.
      await declareOutput(ws.assetDir, 'card', 'outputs/card.jpg', 'image/jpeg', JPEG_BYTES);
      await declareSecretSource(ws.workspaceDir, ws.projectId, ws.assetId);
      const revision2Id = await sealRevision(ws.workspaceDir, ws.projectId, ws.assetId, 'r2');
      expect(revision2Id).not.toBe(revisionId);
      const requestsBeforeR2Push = fake.requests.length;

      const r2 = await pushDelivery({ ...pushArgs, revisionId: revision2Id, outputNames: ['card'] });

      expect(r2.delivery.id).not.toBe(r1.delivery.id);
      expect([...fake.deliveries().find((delivery) => delivery.id === r1.delivery.id)!.outputs.keys()]).toEqual(['cover']);
      const r2Delivery = fake.deliveries().find((delivery) => delivery.id === r2.delivery.id)!;
      expect([...r2Delivery.outputs.keys()]).toEqual(['card']);
      expect(await sha256Hex(r2Delivery.outputs.get('card')!.bytes!)).toBe(await sha256Hex(JPEG_BYTES));
      // Exactly one PUT for the r2 push (only the declared output).
      expect(fake.requests.slice(requestsBeforeR2Push).filter((request) => request.method === 'PUT').length).toBe(1);
      // The sealed r1 bytes are untouched on disk.
      expect(await sealFileSha(ws.workspaceDir, ws.projectId, ws.assetId, revisionId, 'outputs/cover.png')).toBe(r1CoverSha);
      // Re-pushing r1 after r2 work replays the SAME delivery (no duplicates).
      const replay = await pushDelivery({ ...pushArgs, revisionId, outputNames: ['cover'] });
      expect(replay.delivery.id).toBe(r1.delivery.id);
      expect(fake.deliveries().length).toBe(2);
    });
  });

  test('fails BEFORE any network when the manifest rootHash does not verify', async () => {
    const { fake, ws, revisionId } = await scenarioWithRevision();
    const manifestPath = join(ws.workspaceDir, 'revisions', ws.projectId, ws.assetId, revisionId, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, string>;
    manifest.rootHash = 'f'.repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await withApiKey(fake.apiKey, async () => {
      try {
        await pushDelivery({ origin: fake.origin, workspaceDir: ws.workspaceDir, portalClientId: 'pc-x', projectId: ws.projectId, assetId: ws.assetId, revisionId, outputNames: ['cover'] });
        throw new Error('expected HASH_MISMATCH');
      } catch (error) {
        expectStudioCode(error, 'HASH_MISMATCH');
      }
      expect(fake.requests.length).toBe(0);
    });
  });

  test('local output drift fails without any request', async () => {
    const { fake, ws, revisionId } = await scenarioWithRevision();
    await withApiKey(fake.apiKey, async () => {
      // Byte drift.
      await writeFile(join(ws.assetDir, 'outputs', 'cover.png'), Uint8Array.from([0x01, 0x02, 0x03]));
      try {
        await pushDelivery({ origin: fake.origin, workspaceDir: ws.workspaceDir, portalClientId: 'pc-x', projectId: ws.projectId, assetId: ws.assetId, revisionId, outputNames: ['cover'] });
        throw new Error('expected HASH_MISMATCH');
      } catch (error) {
        expectStudioCode(error, 'HASH_MISMATCH');
      }
      expect(fake.requests.length).toBe(0);

      // Missing file (explicit restore is the only recovery; never implicit).
      await rm(join(ws.assetDir, 'outputs', 'cover.png'));
      try {
        await pushDelivery({ origin: fake.origin, workspaceDir: ws.workspaceDir, portalClientId: 'pc-x', projectId: ws.projectId, assetId: ws.assetId, revisionId, outputNames: ['cover'] });
        throw new Error('expected OUTPUT_MISSING');
      } catch (error) {
        expectStudioCode(error, 'OUTPUT_MISSING');
      }
      expect(fake.requests.length).toBe(0);
    });
  });

  test('rejects outputs not declared in the sealed manifest', async () => {
    const { fake, ws, revisionId } = await scenarioWithRevision();
    await withApiKey(fake.apiKey, async () => {
      try {
        await pushDelivery({ origin: fake.origin, workspaceDir: ws.workspaceDir, portalClientId: 'pc-x', projectId: ws.projectId, assetId: ws.assetId, revisionId, outputNames: ['not-sealed'] });
        throw new Error('expected INVALID_INPUT');
      } catch (error) {
        expectStudioCode(error, 'INVALID_INPUT');
      }
      expect(fake.requests.length).toBe(0);
    });
  });

  test('mid-flight failure then retry: exactly one delivery, no duplicate upload', async () => {
    const fake = await startFakeTracked({
      failOnce: { path: '/api/v1/deliveries/', status: 500, code: 'internal', message: 'storage head failed' },
    });
    const ws = await makeWorkspaceTracked();
    await declareOutput(ws.assetDir, 'cover', 'outputs/cover.png', 'image/png', PNG_BYTES);
    const revisionId = await sealRevision(ws.workspaceDir, ws.projectId, ws.assetId, 'r1');
    await withApiKey(fake.apiKey, async () => {
      const portal = (await adoptPortalClient({ origin: fake.origin, workspaceDir: ws.workspaceDir, workspaceId: 'ws-one', studioClientId: ws.studioClientId })).portalClient;
      const pushArgs = { origin: fake.origin, workspaceDir: ws.workspaceDir, portalClientId: portal.id, projectId: ws.projectId, assetId: ws.assetId, revisionId, outputNames: ['cover'] };
      try {
        await pushDelivery(pushArgs);
        throw new Error('expected the injected failure');
      } catch (error) {
        if (!(error instanceof ApiClientError)) throw new Error(`se esperaba ApiClientError(500); llegó: ${String(error)}`);
        expect(error.status).toBe(500);
      }
      // The delivery stayed pending with its output staged.
      const pending = fake.deliveries()[0]!;
      expect(pending.status).toBe('pending');

      const retried = await pushDelivery(pushArgs);
      expect(retried.delivery.status).toBe('ready');
      expect(fake.deliveries().length).toBe(1);
      const staged = fake.deliveries()[0]!.outputs.get('cover')!;
      // Exactly one DELIVERY and one verified staged object: the retry's
      // re-PUT is REJECTED by the server (409 "already received"), so the
      // bytes are stored once — the idempotency contract, enforced remotely.
      expect(fake.requests.filter((request) => request.method === 'PUT').length).toBe(2);
      expect(await sha256Hex(staged.bytes!)).toBe(await sha256Hex(PNG_BYTES));
    });
  });
});
