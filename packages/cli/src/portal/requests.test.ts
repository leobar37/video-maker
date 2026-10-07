/**
 * Bridge-level tests for the R-3 portal request flow (contracts.md §6
 * additive · customer-assets-requests): create+mint, guest uploads against
 * the in-process fake (dual CAS simplified), and `pullRequestMaterials`
 * importing into the EXACT Studio project of the pointer with SHA + request
 * provenance — idempotent by (origin, materialId), never inventing a
 * destination. All against 127.0.0.1:0 (gate G-cap-live: no real network).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createCreativeProject, createStudioContext, isStudioServiceError } from '@videomaker/studio';

import { ApiClientError } from '@videomaker/customer-assets/client';
import { closePortalRequest, createPortalRequest, listPortalRequests, mintPortalRequestLink, pullRequestMaterials } from './requests';
import { PNG_BYTES, makeWorkspace, startFakePortal, type FakePortal, type WorkspaceFixture } from './testing';

// ---------------------------------------------------------------------------

const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function makeWorkspaceTracked(prefix = 'portal-requests'): Promise<WorkspaceFixture> {
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

/** Guest upload against the fake: init → PUT → complete (token = capability). */
async function guestUpload(origin: string, token: string, bytes: Uint8Array, mediaType: string, name: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const init = await fetch(`${origin}/api/v1/r/${token}/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mediaType, declaredBytes: bytes.length, name }),
  });
  const initBody = (await init.json()) as Record<string, unknown>;
  if (init.status !== 201) return { status: init.status, body: initBody };
  const put = await fetch(`${origin}/api/v1/r/${token}/uploads/${String(initBody.uploadId)}/content`, {
    method: 'PUT',
    headers: { 'content-type': mediaType },
    body: new Uint8Array(bytes),
  });
  if (put.status !== 200) return { status: put.status, body: (await put.json()) as Record<string, unknown> };
  const complete = await fetch(`${origin}/api/v1/r/${token}/uploads/${String(initBody.uploadId)}/complete`, { method: 'POST' });
  return { status: complete.status, body: (await complete.json()) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------

describe('portal request bridge (R-3) — create, guest upload, pull', () => {
  let fake: FakePortal;
  let ws: WorkspaceFixture;
  let clientId: string;
  let projectId: string;
  let requestId: string;
  let token: string;
  const origin = (): string => fake.origin;

  beforeAll(async () => {
    fake = await startFakePortal();
    ws = await makeWorkspaceTracked();
    // The bridge reads the injected credential from the environment at call
    // time (never a flag, never persisted).
    process.env.CUSTOMER_ASSETS_API_KEY = fake.apiKey;
    const client = fake.seedClient({ workspaceId: 'ws-r3', studioClientId: ws.studioClientId, name: 'Acme Inc.' });
    clientId = client.id;
    projectId = fake.seedProject({ clientId, studioProjectId: ws.projectId, name: 'Proyecto acme' }).id;
  });

  afterAll(async () => {
    delete process.env.CUSTOMER_ASSETS_API_KEY;
    await fake.stop();
  });

  test('createPortalRequest creates on the pointer and mints the first link', async () => {
    const result = await createPortalRequest({
      origin: origin(),
      portalProjectId: projectId,
      portalClientId: clientId,
      title: 'Fotos del evento',
      instructions: 'Entregar en JPG o PNG',
      maxFiles: 2,
      maxBytes: 4 * 1_048_576,
    });
    requestId = result.requestId;
    expect(result.request.state).toBe('open');
    expect(result.project).toEqual({ id: projectId, portalClientId: clientId });
    expect(result.url.startsWith(`${fake.origin}/request/`)).toBe(true);
    expect(result.limits).toEqual({ maxFiles: 2, maxBytes: 4 * 1_048_576 });
    const minted = result.url.split('/request/')[1] ?? '';
    expect(minted.length).toBeGreaterThan(8);
    token = minted;
  });

  test('createPortalRequest with an unknown pointer: NOT_FOUND; with a mismatched --client: INVALID_INPUT', async () => {
    let caught: unknown;
    try {
      await createPortalRequest({
        origin: origin(),
        portalProjectId: 'pp-missing',
        title: 'x',
        maxFiles: 1,
        maxBytes: 1_048_576,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof ApiClientError).toBe(true);
    expect((caught as ApiClientError).status).toBe(404);

    let mismatch: unknown;
    try {
      await createPortalRequest({
        origin: origin(),
        portalProjectId: projectId,
        portalClientId: 'pc-otro',
        title: 'x',
        maxFiles: 1,
        maxBytes: 1_048_576,
      });
    } catch (error) {
      mismatch = error;
    }
    expect(isStudioServiceError(mismatch)).toBe(true);
    expect((mismatch as { code: string }).code).toBe('INVALID_INPUT');
  });

  test('mintPortalRequestLink ROTATES: the previous token dies immediately', async () => {
    const rotated = await mintPortalRequestLink({ origin: origin(), requestId, expiresIn: '48h' });
    expect(rotated.url.startsWith(`${fake.origin}/request/`)).toBe(true);
    const oldView = await fetch(`${fake.origin}/api/v1/r/${token}`, { method: 'GET' });
    expect(oldView.status).toBe(404);
    const newView = await fetch(`${fake.origin}/api/v1/r/${(rotated.url.split('/request/')[1] ?? '')}`, { method: 'GET' });
    expect(newView.status).toBe(200);
    token = rotated.url.split('/request/')[1] ?? token;
  });

  test('guest uploads two fixtures through the minted link; auto-fulfils at the limit', async () => {
    const first = await guestUpload(fake.origin, token, PNG_BYTES, 'image/png', 'foto-uno.png');
    expect(first.status).toBe(201);
    const second = await guestUpload(fake.origin, token, PNG_VARIANT_BYTES, 'image/png', 'foto-dos.png');
    expect(second.status).toBe(201);
    const requestState = (second.body.request as Record<string, unknown>).state;
    expect(requestState).toBe('fulfilled');

    // Guest view exposes NO ids of any other resource.
    const view = await fetch(`${fake.origin}/api/v1/r/${token}`, { method: 'GET' });
    const viewBody = (await view.json()) as Record<string, unknown>;
    expect(view.status).toBe(200);
    expect('id' in viewBody).toBe(false);
    expect('clientId' in viewBody).toBe(false);
    expect('portalProjectId' in viewBody).toBe(false);
    expect(viewBody.state).toBe('fulfilled');
  });

  test('pullRequestMaterials imports ALL ready materials into the EXACT local project with request provenance', async () => {
    const result = await pullRequestMaterials({
      origin: origin(),
      workspaceDir: ws.workspaceDir,
      requestId,
      projectId: ws.projectId,
      assetId: ws.assetId,
    });
    expect(result.executed).toBe(true);
    expect(result.portalProject).toEqual({ id: projectId, portalClientId: clientId, studioProjectId: ws.projectId });
    expect(result.imported.length).toBe(2);
    const expectedShas = [sha256HexSync(PNG_BYTES), sha256HexSync(PNG_VARIANT_BYTES)];
    for (const material of result.imported) {
      expect(expectedShas).toContain(material.sha256);
      expect(material.inputPath.startsWith('inputs/portal/')).toBe(true);
      expect(material.addedInputs.length).toBe(2);
      const provenance = JSON.parse(await readFile(join(ws.assetDir, material.provenancePath), 'utf8')) as Record<string, unknown>;
      expect(provenance.requestId).toBe(requestId);
      expect(provenance.materialId).toBe(material.id);
      expect(provenance.origin).toBe(fake.origin);
      expect(JSON.stringify(provenance)).not.toContain(fake.apiKey);
    }
    const assetDoc = JSON.parse(await readFile(join(ws.assetDir, 'asset.json'), 'utf8')) as { inputs: string[] };
    expect(assetDoc.inputs.length).toBe(4);
  });

  test('re-pull is idempotent: zero added inputs, bytes reused, no duplicates on disk', async () => {
    const before = await readdir(join(ws.assetDir, 'inputs', 'portal'));
    const retry = await pullRequestMaterials({
      origin: origin(),
      workspaceDir: ws.workspaceDir,
      requestId,
      projectId: ws.projectId,
      assetId: ws.assetId,
    });
    expect(retry.addedInputs).toEqual([]);
    for (const material of retry.imported) expect(material.reusedBytes).toBe(true);
    const after = await readdir(join(ws.assetDir, 'inputs', 'portal'));
    expect(after.length).toBe(before.length);
  });

  test('pull into a missing local project: NOT_FOUND; into an UNRELATED project: INVALID_INPUT (no writes)', async () => {
    let missing: unknown;
    try {
      await pullRequestMaterials({
        origin: origin(),
        workspaceDir: ws.workspaceDir,
        requestId,
        projectId: 'otro-proyecto',
        assetId: ws.assetId,
      });
    } catch (error) {
      missing = error;
    }
    expect(isStudioServiceError(missing)).toBe(true);
    expect((missing as { code: string }).code).toBe('NOT_FOUND');

    // A locally EXISTING project without the portal client in clientIds is
    // refused by the pullMaterial relation guard (never a cross-import).
    await createCreativeProject(createStudioContext(ws.workspaceDir), {
      id: 'proj-unrelated',
      name: 'Sin relación',
      clientIds: [],
    });
    const unrelatedAssetDir = join(ws.workspaceDir, 'projects', 'proj-unrelated', 'assets', ws.assetId);
    await mkdir(unrelatedAssetDir, { recursive: true });
    await writeFile(
      join(unrelatedAssetDir, 'asset.json'),
      `${JSON.stringify({ schemaVersion: 1, id: ws.assetId, projectId: 'proj-unrelated', kind: 'video', title: 'Sin relación', presetRefs: [], sources: [], inputs: [], outputs: [] }, null, 2)}\n`,
    );
    let unrelated: unknown;
    try {
      await pullRequestMaterials({
        origin: origin(),
        workspaceDir: ws.workspaceDir,
        requestId,
        projectId: 'proj-unrelated',
        assetId: ws.assetId,
      });
    } catch (error) {
      unrelated = error;
    }
    expect(isStudioServiceError(unrelated)).toBe(true);
    expect((unrelated as { code: string }).code).toBe('INVALID_INPUT');
  });

  test('pull without the pointer project in the workspace: NOT_FOUND and NO destination created', async () => {
    const emptyWs = join(await mkdtemp(join(tmpdir(), 'portal-requests-empty-')), 'workspace');
    await mkdir(emptyWs, { recursive: true });
    tempRoots.push(dirname(emptyWs));
    let caught: unknown;
    try {
      await pullRequestMaterials({
        origin: origin(),
        workspaceDir: emptyWs,
        requestId,
        projectId: ws.projectId,
        assetId: ws.assetId,
      });
    } catch (error) {
      caught = error;
    }
    expect(isStudioServiceError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('NOT_FOUND');
    const entries = await readdir(emptyWs);
    expect(entries.includes('projects')).toBe(false);
  });

  test('pull of a request with zero materials: INVALID_INPUT', async () => {
    const empty = await createPortalRequest({
      origin: origin(),
      portalProjectId: projectId,
      portalClientId: clientId,
      title: 'Vacío',
      maxFiles: 1,
      maxBytes: 1_048_576,
    });
    let caught: unknown;
    try {
      await pullRequestMaterials({ origin: origin(), workspaceDir: ws.workspaceDir, requestId: empty.requestId, projectId: ws.projectId, assetId: ws.assetId });
    } catch (error) {
      caught = error;
    }
    expect(isStudioServiceError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe('INVALID_INPUT');
  });

  test('closePortalRequest closes; re-close and closed-request guest init are 409 CONFLICT', async () => {
    const closed = await closePortalRequest({ origin: origin(), requestId, reason: 'Ya llegó todo' });
    expect(closed.state).toBe('closed');
    expect(closed.closeReason).toBe('Ya llegó todo');

    let caught: unknown;
    try {
      await closePortalRequest({ origin: origin(), requestId });
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof ApiClientError).toBe(true);
    expect((caught as ApiClientError).status).toBe(409);
    expect((caught as ApiClientError).code).toBe('conflict');

    const guest = await guestUpload(fake.origin, token, PNG_BYTES, 'image/png', 'tarde.png');
    expect(guest.status).toBe(409);

    // The materials survive the closure (nothing is deleted).
    const items = await listPortalRequests({ origin: origin(), portalProjectId: projectId, portalClientId: clientId, state: 'closed' });
    expect(items.some((entry) => entry.request.id === requestId)).toBe(true);
  });
});

