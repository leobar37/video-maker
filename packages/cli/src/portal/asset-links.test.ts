/**
 * Bridge-level tests for the per-asset upload-link flow (operator order
 * 2026-10-06; contratos aditivos §9 · customer-assets-requests): mint bound
 * to ONE Studio asset against the in-process fake (rotation + quota
 * simplified), guest uploads with NO credential, and `pullAssetMaterials`
 * importing the per-asset set into the EXACT Studio asset with SHA check and
 * linkId provenance — idempotent by (origin, materialId), never inventing a
 * destination. All against 127.0.0.1:0 (gate G-cap-live: no real network).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { isStudioServiceError } from '@videomaker/studio';

import { ApiClientError } from '@videomaker/customer-assets/client';
import { mintPortalAssetLink, pullAssetMaterials } from './asset-links';
import { PNG_BYTES, makeWorkspace, startFakePortal, type FakePortal, type WorkspaceFixture } from './testing';

// ---------------------------------------------------------------------------

const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function makeWorkspaceTracked(prefix = 'portal-asset-links'): Promise<WorkspaceFixture> {
  const fixture = await makeWorkspace(prefix);
  tempRoots.push(fixture.root);
  return fixture;
}

/** Second deterministic fixture: same valid PNG magic, different bytes. */
const PNG_VARIANT_BYTES = (() => {
  const bytes = new Uint8Array(PNG_BYTES);
  bytes[bytes.length - 3] = bytes[bytes.length - 3]! ^ 0x5a;
  return bytes;
})();

function sha256HexSync(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(bytes);
  return hasher.digest('hex');
}

/** Guest upload against the fake /a/ family: init → PUT → complete. */
async function guestAssetUpload(origin: string, token: string, bytes: Uint8Array, mediaType: string, name: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const init = await fetch(`${origin}/api/v1/a/${token}/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mediaType, declaredBytes: bytes.length, name }),
  });
  const initBody = (await init.json()) as Record<string, unknown>;
  if (init.status !== 201) return { status: init.status, body: initBody };
  const put = await fetch(`${origin}/api/v1/a/${token}/uploads/${String(initBody.uploadId)}/content`, {
    method: 'PUT',
    headers: { 'content-type': mediaType },
    body: new Uint8Array(bytes),
  });
  if (put.status !== 200) return { status: put.status, body: (await put.json()) as Record<string, unknown> };
  const complete = await fetch(`${origin}/api/v1/a/${token}/uploads/${String(initBody.uploadId)}/complete`, { method: 'POST' });
  return { status: complete.status, body: (await complete.json()) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------

describe('portal asset-link bridge — mint, guest upload, pull', () => {
  let fake: FakePortal;
  let ws: WorkspaceFixture;
  let clientId: string;
  const origin = (): string => fake.origin;

  beforeAll(async () => {
    fake = await startFakePortal();
    ws = await makeWorkspaceTracked();
    // The bridge reads the injected credential from the environment at call
    // time (never a flag, never persisted).
    process.env.CUSTOMER_ASSETS_API_KEY = fake.apiKey;
    const client = fake.seedClient({ workspaceId: 'ws-asset-links', studioClientId: ws.studioClientId, name: 'Acme Inc.' });
    clientId = client.id;
    fake.seedProject({ clientId, studioProjectId: ws.projectId, name: 'Proyecto acme' });
  });

  afterAll(async () => {
    delete process.env.CUSTOMER_ASSETS_API_KEY;
    await fake.stop();
  });

  test('mintPortalAssetLink checks the LOCAL asset first and returns the URL once', async () => {
    const result = await mintPortalAssetLink({
      origin: origin(),
      workspaceDir: ws.workspaceDir,
      studioProjectId: ws.projectId,
      studioAssetId: ws.assetId,
      expiresIn: '24h',
    });
    expect(result.url.startsWith(`${fake.origin}/asset-upload/`)).toBe(true);
    expect(result.studioAssetId).toBe(ws.assetId);
    expect(result.portalClientId).toBe(clientId);
    expect(result.portalProjectId).not.toBeNull();
    const token = result.url.split('/asset-upload/')[1] ?? '';
    expect(token.length).toBeGreaterThan(8);

    // A link for a non-existent LOCAL asset is refused BEFORE any network.
    const requestsBefore = fake.requests.length;
    let caught: unknown;
    try {
      await mintPortalAssetLink({
        origin: origin(),
        workspaceDir: ws.workspaceDir,
        studioProjectId: ws.projectId,
        studioAssetId: 'asset-fantasma',
      });
    } catch (error) {
      caught = error;
    }
    expect(isStudioServiceError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('NOT_FOUND');
    expect(fake.requests.length).toBe(requestsBefore);
  });

  test('rotation through the fake: the previous token dies, the new one works', async () => {
    const first = await mintPortalAssetLink({
      origin: origin(),
      workspaceDir: ws.workspaceDir,
      studioProjectId: ws.projectId,
      studioAssetId: ws.assetId,
    });
    const oldView = await fetch(`${fake.origin}/api/v1/a/${(first.url.split('/asset-upload/')[1] ?? '')}`, { method: 'GET' });
    expect(oldView.status).toBe(200);
    const second = await mintPortalAssetLink({
      origin: origin(),
      workspaceDir: ws.workspaceDir,
      studioProjectId: ws.projectId,
      studioAssetId: ws.assetId,
      portalClientId: clientId,
    });
    const oldAfter = await fetch(`${fake.origin}/api/v1/a/${(first.url.split('/asset-upload/')[1] ?? '')}`, { method: 'GET' });
    expect(oldAfter.status).toBe(404);
    const newView = await fetch(`${fake.origin}/api/v1/a/${(second.url.split('/asset-upload/')[1] ?? '')}`, { method: 'GET' });
    expect(newView.status).toBe(200);
  });

  test('guest uploads with NO credential; material lands attributed to the EXACT asset; link becomes used', async () => {
    const minted = await mintPortalAssetLink({
      origin: origin(),
      workspaceDir: ws.workspaceDir,
      studioProjectId: ws.projectId,
      studioAssetId: ws.assetId,
    });
    const token = minted.url.split('/asset-upload/')[1] ?? '';
    const first = await guestAssetUpload(fake.origin, token, PNG_BYTES, 'image/png', 'toma-uno.png');
    expect(first.status).toBe(201);
    // Single-use: the second upload init is 409 and the view shows used.
    const second = await guestAssetUpload(fake.origin, token, PNG_VARIANT_BYTES, 'image/png', 'toma-dos.png');
    expect(second.status).toBe(409);
    const view = await fetch(`${fake.origin}/api/v1/a/${token}`, { method: 'GET' });
    const viewBody = (await view.json()) as Record<string, unknown>;
    expect(viewBody.state).toBe('used');
    expect('id' in viewBody).toBe(false);
    expect('clientId' in viewBody).toBe(false);
    expect('linkId' in viewBody).toBe(false);
  });

  test('pullAssetMaterials imports the per-asset set with linkId provenance and upload==import SHA', async () => {
    const result = await pullAssetMaterials({
      origin: origin(),
      workspaceDir: ws.workspaceDir,
      studioProjectId: ws.projectId,
      studioAssetId: ws.assetId,
    });
    expect(result.executed).toBe(true);
    expect(result.imported.length).toBe(1);
    const imported = result.imported[0]!;
    expect(imported.sha256).toBe(sha256HexSync(PNG_BYTES));
    expect(imported.linkId).not.toBeNull();
    expect(imported.addedInputs.length).toBe(2);
    const provenance = JSON.parse(await readFile(join(ws.assetDir, imported.provenancePath), 'utf8')) as Record<string, unknown>;
    expect(provenance.linkId).toBe(imported.linkId);
    expect(provenance.materialId).toBe(imported.id);
    expect(provenance.origin).toBe(fake.origin);
    expect(JSON.stringify(provenance)).not.toContain(fake.apiKey);
    const assetDoc = JSON.parse(await readFile(join(ws.assetDir, 'asset.json'), 'utf8')) as { inputs: string[] };
    expect(assetDoc.inputs.length).toBe(2);
  });

  test('re-pull is idempotent: zero added inputs, bytes reused, no duplicates on disk', async () => {
    const result = await pullAssetMaterials({
      origin: origin(),
      workspaceDir: ws.workspaceDir,
      studioProjectId: ws.projectId,
      studioAssetId: ws.assetId,
    });
    expect(result.imported.length).toBe(1);
    expect(result.imported[0]!.reusedBytes).toBe(true);
    expect(result.addedInputs.length).toBe(0);
  });

  test('an asset without materials is a clear INVALID_INPUT; a workspace without the asset never pulls', async () => {
    let caught: unknown;
    try {
      await pullAssetMaterials({
        origin: origin(),
        workspaceDir: ws.workspaceDir,
        studioProjectId: ws.projectId,
        studioAssetId: 'asset-sin-material',
      });
    } catch (error) {
      caught = error;
    }
    expect(isStudioServiceError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('INVALID_INPUT');

    let missing: unknown;
    try {
      await pullAssetMaterials({
        origin: origin(),
        workspaceDir: ws.workspaceDir,
        studioProjectId: ws.projectId,
        studioAssetId: 'asset-que-no-existe',
      });
    } catch (error) {
      missing = error;
    }
    expect(isStudioServiceError(missing)).toBe(true);
  });

  test('old-scope agent (no assets:write) is denied by the fake with FORBIDDEN', async () => {
    const stripped = await startFakePortal({ scopes: ['clients:read', 'materials:read'] });
    try {
      process.env.CUSTOMER_ASSETS_API_KEY = stripped.apiKey;
      let caught: unknown;
      try {
        await mintPortalAssetLink({
          origin: stripped.origin,
          workspaceDir: ws.workspaceDir,
          studioProjectId: ws.projectId,
          studioAssetId: ws.assetId,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught instanceof ApiClientError).toBe(true);
      expect((caught as ApiClientError).status).toBe(403);
    } finally {
      process.env.CUSTOMER_ASSETS_API_KEY = fake.apiKey;
      await stripped.stop();
    }
  });
});
