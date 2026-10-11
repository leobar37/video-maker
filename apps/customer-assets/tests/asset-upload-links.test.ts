import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  apiCall,
  createAgent,
  expectError,
  json,
  resetClientQuota,
  setupPortalFixture,
  sha256Hex,
  JPEG_BYTES,
  PNG_BYTES,
  tokenFromAssetLinkUrl,
  uploadViaAssetToken,
  type PortalFixture,
} from './portal-fixture';
import { assetUploadLink, auditEvent, material, portalProject } from '../src/server/db/schema';
import type {
  ApiError,
  AssetUploadLinkAdminView,
  AssetUploadLinkView,
  GuestAssetCompleteResult,
  GuestUploadSessionView,
} from '@videomaker/customer-assets';

/**
 * Asset upload links (operator order 2026-10-06; contratos aditivos §9 ·
 * customer-assets-requests): the operator mints a guest-direct link bound to
 * EXACTLY ONE Studio asset; the guest uploads with NO login and the material
 * lands attributed to that exact asset (material.asset_target). The suite
 * proves the mint ACL matrix (incl. the NEW `assets:write` scope — old
 * grants denied), per-asset token isolation, expiry/rotation/close (lazy),
 * hashed-only storage, the client-quota CAS, attribution and provenance,
 * zero other routes with the token as key, and audits that never carry the
 * URL or the raw token.
 */

let fixture: PortalFixture;
let projectAId: string;
let assetLinkAgent: { userId: string; keyId: string; apiKey: string };

async function auditCount(action: string): Promise<number> {
  const rows = await fixture.deps.db.select().from(auditEvent).where(eq(auditEvent.action, action));
  return rows.length;
}

async function mintLink(
  principal: { cookie?: string; apiKey?: string },
  body: Record<string, unknown>,
): Promise<Response> {
  return apiCall(fixture.deps, { method: 'POST', path: '/api/v1/asset-upload-links', body, ...principal });
}

async function mintForAsset(
  principal: { cookie?: string; apiKey?: string },
  studioAssetId: string,
): Promise<{ url: string; token: string; view: AssetUploadLinkView }> {
  const response = await mintLink(principal, {
    studioProjectId: 'proj-alpha-studio',
    studioAssetId,
    portalClientId: fixture.clientA.id,
    expiresIn: '24h',
  });
  expect(response.status).toBe(201);
  const view = await json<AssetUploadLinkView>(response);
  const token = tokenFromAssetLinkUrl(view.url);
  return { url: view.url, token, view };
}

async function seedPointer(clientId: string, studioProjectId: string, name: string): Promise<string> {
  const [row] = await fixture.deps.db
    .insert(portalProject)
    .values({
      id: crypto.randomUUID(),
      workspaceId: fixture.workspaceId,
      portalClientId: clientId,
      studioProjectId,
      name,
      createdMs: Date.now(),
    })
    .returning();
  return row!.id;
}

/** Second deterministic fixtures: same valid magics, different bytes (the
 * content-addressed dedupe would otherwise converge on earlier rows and keep
 * their ORIGINAL attribution — v1 immutability). */
const PNG_VARIANT_BYTES = (() => {
  const bytes = new Uint8Array(PNG_BYTES);
  bytes[bytes.length - 3] = bytes[bytes.length - 3]! ^ 0x5a;
  return bytes;
})();
const JPEG_VARIANT_BYTES = (() => {
  const bytes = new Uint8Array(JPEG_BYTES);
  bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 0x3c;
  return bytes;
})();

let seeded = false;

async function ensureSetup(): Promise<void> {
  if (seeded) return;
  fixture = await setupPortalFixture();
  projectAId = await seedPointer(fixture.clientA.id, 'proj-alpha-studio', 'Proyecto Alpha');
  await seedPointer(fixture.clientB.id, 'proj-beta-studio', 'Proyecto Beta');
  assetLinkAgent = await createAgent(fixture.deps.db, fixture.auth, {
    userId: fixture.integrator.userId,
    workspaceId: fixture.workspaceId,
    clientIds: null,
    scopes: ['clients:read', 'materials:read', 'assets:write'],
  });
  seeded = true;
}

describe('P-104 asset upload links — mint ACL matrix', () => {
  it('admin human mints; URL is returned once with the /asset-upload/ shape', async () => {
    await ensureSetup();
    const { url, token, view } = await mintForAsset({ cookie: fixture.adminCookie }, 'asset-alpha-1');
    expect(url.startsWith(`${fixture.deps.portalOrigin}/asset-upload/`)).toBe(true);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(view.linkId.length).toBeGreaterThan(0);
    expect(view.portalClientId).toBe(fixture.clientA.id);
    expect(view.portalProjectId).toBe(projectAId);
    expect(view.studioProjectId).toBe('proj-alpha-studio');
    expect(view.studioAssetId).toBe('asset-alpha-1');
    // URL returned once: the manage view never echoes it (checked below in
    // the hashed-storage test).
  });

  it('agent with the NEW assets:write scope mints', async () => {
    await ensureSetup();
    const response = await mintLink({ apiKey: assetLinkAgent.apiKey }, {
      studioProjectId: 'proj-alpha-studio',
      studioAssetId: 'asset-agent-1',
      expiresIn: '30m',
    });
    expect(response.status).toBe(201);
  });

  it('agent with an OLD grant (no assets:write) is denied with 403', async () => {
    await ensureSetup();
    await expectError(await mintLink({ apiKey: fixture.integrator.apiKey }, {
      studioProjectId: 'proj-alpha-studio',
      studioAssetId: 'asset-old-grant',
    }), 403, 'forbidden');
  });

  it('member of the client is denied (403); foreign member keeps 404', async () => {
    await ensureSetup();
    await expectError(await mintLink({ cookie: fixture.memberACookie }, {
      studioProjectId: 'proj-alpha-studio',
      studioAssetId: 'asset-member-1',
    }), 403, 'forbidden');
    await expectError(await mintLink({ cookie: fixture.memberBCookie }, {
      studioProjectId: 'proj-alpha-studio',
      studioAssetId: 'asset-member-2',
    }), 404, 'not_found');
  });

  it('unknown Studio project id is 404; bad expiresIn grammar is 400; ambiguity without --client is 409', async () => {
    await ensureSetup();
    await expectError(await mintLink({ cookie: fixture.adminCookie }, {
      studioProjectId: 'proj-missing',
      studioAssetId: 'asset-x',
    }), 404, 'not_found');
    await expectError(await mintLink({ cookie: fixture.adminCookie }, {
      studioProjectId: 'proj-alpha-studio',
      studioAssetId: 'asset-x',
      expiresIn: '20m',
    }), 400, 'bad_request');
    // A second pointer for clientB on the SAME Studio project id creates the
    // ambiguity (portal_project is UNIQUE per (client, project)); the
    // explicit portalClientId disambiguates back to 201.
    await seedPointer(fixture.clientB.id, 'proj-alpha-studio', 'Proyecto Alpha (beta)');
    await expectError(await mintLink({ cookie: fixture.adminCookie }, {
      studioProjectId: 'proj-alpha-studio',
      studioAssetId: 'asset-x',
    }), 409, 'conflict');
    const ok = await mintLink({ cookie: fixture.adminCookie }, {
      studioProjectId: 'proj-alpha-studio',
      studioAssetId: 'asset-x',
      portalClientId: fixture.clientA.id,
    });
    expect(ok.status).toBe(201);
  });
});

describe('P-104 asset upload links — hashed storage, rotation, close, expiry', () => {
  it('stores ONLY the SHA-256 hash; manage views and audits never carry the token or URL', async () => {
    await ensureSetup();
    const { token, view } = await mintForAsset({ cookie: fixture.adminCookie }, 'asset-hash-1');
    const [row] = await fixture.deps.db
      .select()
      .from(assetUploadLink)
      .where(eq(assetUploadLink.id, view.linkId))
      .limit(1);
    expect(row!.tokenHash).toBe(sha256Hex(new TextEncoder().encode(token)));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain('asset-upload/');

    const manage = await apiCall(fixture.deps, {
      method: 'GET',
      path: `/api/v1/asset-upload-links/${view.linkId}`,
      cookie: fixture.adminCookie,
    });
    expect(manage.status).toBe(200);
    const manageBody = await manage.text();
    expect(manageBody).not.toContain(token);
    expect(manageBody).not.toContain('/asset-upload/');

    const audits = await fixture.deps.db.select().from(auditEvent).where(eq(auditEvent.action, 'asset_link.minted'));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(audits)).not.toContain(token);
    expect(JSON.stringify(audits)).not.toContain('/asset-upload/');
  });

  it('re-mint ROTATES: the previous token dies immediately and the prior link closes as rotated', async () => {
    await ensureSetup();
    const first = await mintForAsset({ cookie: fixture.adminCookie }, 'asset-rotate-1');
    const second = await mintForAsset({ cookie: fixture.adminCookie }, 'asset-rotate-1');
    expect(first.view.linkId).not.toBe(second.view.linkId);
    expect(await fetchGuest(first.token)).toBe(404);
    expect(await fetchGuest(second.token)).toBe(200);
    const [oldRow] = await fixture.deps.db
      .select()
      .from(assetUploadLink)
      .where(eq(assetUploadLink.id, first.view.linkId))
      .limit(1);
    expect(oldRow!.state).toBe('closed');
    expect(oldRow!.closeReason).toBe('rotated');
    // Exactly ONE audit per revoked prior, plus the mint audit.
    expect(await auditCount('asset_link.revoked')).toBeGreaterThanOrEqual(1);
  });

  it('close (admin) freezes an open link; the guest family turns 404; re-close is 409', async () => {
    await ensureSetup();
    const { token, view } = await mintForAsset({ cookie: fixture.adminCookie }, 'asset-close-1');
    const memberClose = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/asset-upload-links/${view.linkId}/close`,
      body: { reason: 'no' },
      cookie: fixture.memberACookie,
    });
    expect(memberClose.status).toBe(403);
    const closed = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/asset-upload-links/${view.linkId}/close`,
      body: { reason: 'Cierre desde test' },
      cookie: fixture.adminCookie,
    });
    expect(closed.status).toBe(200);
    const closedView = await json<AssetUploadLinkAdminView>(closed);
    expect(closedView.state).toBe('closed');
    expect(closedView.closeReason).toBe('Cierre desde test');
    await expectError(await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/asset-upload-links/${view.linkId}/close`,
      body: {},
      cookie: fixture.adminCookie,
    }), 409, 'conflict');
    // A closed link is a REVOKED capability: the whole family answers the
    // same neutral 404 as an unknown token.
    expect(await fetchGuest(token)).toBe(404);
    const init = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/a/${token}/uploads`,
      body: { mediaType: 'image/jpeg', declaredBytes: JPEG_BYTES.byteLength },
    });
    expect(init.status).toBe(404);
  });

  it('lazy expiry: the first touch past the deadline flips expired with ONE audit; uploads refuse', async () => {
    await ensureSetup();
    const { token, view } = await mintForAsset({ cookie: fixture.adminCookie }, 'asset-expiry-1');
    const now = Date.now();
    await fixture.deps.db
      .update(assetUploadLink)
      .set({ expiresMs: now - 1_000 })
      .where(eq(assetUploadLink.id, view.linkId));
    // The view still resolves (like request tokens) and SHOWS the terminal
    // state; every upload refuses.
    const viewRes = await apiCall(fixture.deps, { method: 'GET', path: `/api/v1/a/${token}` });
    expect(viewRes.status).toBe(200);
    const viewBody = await json<{ state: string }>(viewRes);
    expect(viewBody.state).toBe('expired');
    const init = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/a/${token}/uploads`,
      body: { mediaType: 'image/jpeg', declaredBytes: JPEG_BYTES.byteLength },
    });
    expect(init.status).toBe(409);
    const [row] = await fixture.deps.db
      .select()
      .from(assetUploadLink)
      .where(eq(assetUploadLink.id, view.linkId))
      .limit(1);
    expect(row!.state).toBe('expired');
    expect(await auditCount('asset_link.expired')).toBe(1);
  });
});

/** Guest view status for a raw token (wrong/revoked/expired = same 404). */
async function fetchGuest(token: string): Promise<number> {
  const response = await apiCall(fixture.deps, { method: 'GET', path: `/api/v1/a/${token}` });
  return response.status;
}

describe('P-104 asset upload links — guest upload, quota, attribution, isolation', () => {
  it('guest uploads with NO credential: material carries asset_target + pointer id and NULL request id', async () => {
    await ensureSetup();
    const { token } = await mintForAsset({ cookie: fixture.adminCookie }, 'asset-up-1');
    const result = await uploadViaAssetToken(fixture.deps, { token, bytes: PNG_BYTES, mediaType: 'image/png', name: 'toma-1.png' });
    expect(result.initStatus).toBe(201);
    expect(result.putStatus).toBe(200);
    expect(result.completeStatus).toBe(201);
    const complete = result.complete as GuestAssetCompleteResult;
    expect(complete.material.sha256).toBe(sha256Hex(PNG_BYTES));
    expect(complete.link.state).toBe('used');

    const [row] = await fixture.deps.db.select().from(material).where(eq(material.id, complete.material.id)).limit(1);
    expect(row!.assetTarget).toBe('asset-up-1');
    expect(row!.portalProjectId).toBe(projectAId);
    expect(row!.uploadRequestId).toBeNull();
    expect(row!.uploadedBy.startsWith('user:guest:')).toBe(true);
    // Single-use: the link flipped used; a second init is 409.
    const second = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/a/${token}/uploads`,
      body: { mediaType: 'image/jpeg', declaredBytes: 10 },
    });
    expect(second.status).toBe(409);
    expect(await auditCount('asset_link.used')).toBe(1);
  });

  it('replays a ready session idempotently (200) without a second material', async () => {
    await ensureSetup();
    const { token } = await mintForAsset({ cookie: fixture.adminCookie }, 'asset-replay-1');
    const initRes = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/a/${token}/uploads`,
      body: { mediaType: 'image/jpeg', declaredBytes: JPEG_BYTES.byteLength },
      idempotencyKey: 'asset-replay-key-1',
    });
    expect(initRes.status).toBe(201);
    const session = await json<GuestUploadSessionView>(initRes);
    await apiCall(fixture.deps, { method: 'PUT', path: `/api/v1/a/${token}/uploads/${session.uploadId}/content`, rawBody: JPEG_BYTES });
    const first = await apiCall(fixture.deps, { method: 'POST', path: `/api/v1/a/${token}/uploads/${session.uploadId}/complete` });
    expect(first.status).toBe(201);
    const replay = await apiCall(fixture.deps, { method: 'POST', path: `/api/v1/a/${token}/uploads/${session.uploadId}/complete` });
    expect(replay.status).toBe(200);
    const rows = await fixture.deps.db.select().from(material).where(eq(material.assetTarget, 'asset-replay-1'));
    expect(rows.length).toBe(1);
  });

  it('quota CAS: over-quota init is 429 and per-type oversize is 413; failures release the arm', async () => {
    await ensureSetup();
    const { token } = await mintForAsset({ cookie: fixture.adminCookie }, 'asset-quota-1');
    await resetClientQuota(fixture.deps.db, fixture.clientA.id, 100);
    const over = await uploadViaAssetToken(fixture.deps, { token, declaredBytesOverride: 1_000, bytes: PNG_BYTES, mediaType: 'image/png' });
    expect(over.initStatus).toBe(429);
    await resetClientQuota(fixture.deps.db, fixture.clientA.id);
    const oversize = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/a/${token}/uploads`,
      body: { mediaType: 'image/png', declaredBytes: 25 * 1024 * 1024 },
    });
    expect(oversize.status).toBe(413);
    // Happy path again after the failures released nothing.
    const result = await uploadViaAssetToken(fixture.deps, { token, bytes: PNG_BYTES, mediaType: 'image/png' });
    expect(result.completeStatus).toBe(201);
  });

  it('token isolation: sessions bind to the minting token; foreign tokens and closed links stay 404/409', async () => {
    await ensureSetup();
    const first = await mintForAsset({ cookie: fixture.adminCookie }, 'asset-iso-1');
    const second = await mintForAsset({ cookie: fixture.adminCookie }, 'asset-iso-2');
    const initRes = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/a/${first.token}/uploads`,
      body: { mediaType: 'image/jpeg', declaredBytes: JPEG_BYTES.byteLength },
    });
    expect(initRes.status).toBe(201);
    const session = await json<GuestUploadSessionView>(initRes);
    // Another token — even for the same client — cannot touch that session.
    const foreignPut = await apiCall(fixture.deps, {
      method: 'PUT',
      path: `/api/v1/a/${second.token}/uploads/${session.uploadId}/content`,
      rawBody: JPEG_BYTES,
    });
    expect(foreignPut.status).toBe(404);
    const foreignComplete = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/a/${second.token}/uploads/${session.uploadId}/complete`,
    });
    expect(foreignComplete.status).toBe(404);
    // Completing the first link's upload uses it up; the second link (its own
    // asset) is unaffected — per-asset scope enforced server-side.
    const put = await apiCall(fixture.deps, {
      method: 'PUT',
      path: `/api/v1/a/${first.token}/uploads/${session.uploadId}/content`,
      rawBody: JPEG_BYTES,
    });
    expect(put.status).toBe(200);
    const complete = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/a/${first.token}/uploads/${session.uploadId}/complete`,
    });
    expect(complete.status).toBe(201);
    expect(second.view.studioAssetId).toBe('asset-iso-2');
    const rows2 = await fixture.deps.db.select().from(material).where(eq(material.assetTarget, 'asset-iso-2'));
    expect(rows2.length).toBe(0);
  });

  it('zero other routes: the token is NOT an API key (me/catalog/deliveries/posts all 401)', async () => {
    await ensureSetup();
    const { token } = await mintForAsset({ cookie: fixture.adminCookie }, 'asset-401-1');
    for (const path of ['/api/v1/me', '/api/v1/clients', '/api/v1/materials', '/api/v1/deliveries', '/api/v1/posts']) {
      const response = await apiCall(fixture.deps, { method: 'GET', path, apiKey: token });
      expect(response.status).toBe(401);
    }
    // Same neutrality with a wrong token on the guest family itself.
    const wrong = await apiCall(fixture.deps, { method: 'GET', path: `/api/v1/a/${'A'.repeat(43)}` });
    expect(wrong.status).toBe(404);
    const body = (await wrong.json()) as ApiError;
    expect(body.error.code).toBe('not_found');
  });

  it('guest view exposes titles + quota only; no ids of any resource', async () => {
    await ensureSetup();
    const { token } = await mintForAsset({ cookie: fixture.adminCookie }, 'asset-view-1');
    const response = await apiCall(fixture.deps, { method: 'GET', path: `/api/v1/a/${token}` });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.assetTitle).toBe('asset-view-1');
    expect(body.projectTitle).toBe('Proyecto Alpha');
    expect(body.state).toBe('open');
    expect((body.quota as Record<string, unknown>).limitBytes).toBeGreaterThan(0);
    for (const forbidden of ['id', 'linkId', 'clientId', 'portalClientId', 'portalProjectId', 'tokenHash', 'url']) {
      expect(forbidden in body).toBe(false);
    }
  });
});

describe('P-104 asset upload links — manage surface + materials by asset', () => {
  it('list/get/close are admin-human-only; agents (even assets:write) keep 403', async () => {
    await ensureSetup();
    const listAgent = await apiCall(fixture.deps, {
      method: 'GET',
      path: '/api/v1/asset-upload-links',
      apiKey: assetLinkAgent.apiKey,
    });
    expect(listAgent.status).toBe(403);
    const list = await apiCall(fixture.deps, {
      method: 'GET',
      path: '/api/v1/asset-upload-links',
      cookie: fixture.adminCookie,
    });
    expect(list.status).toBe(200);
    const page = await json<{ items: AssetUploadLinkAdminView[] }>(list);
    expect(page.items.length).toBeGreaterThanOrEqual(1);
    const filtered = await apiCall(fixture.deps, {
      method: 'GET',
      path: `/api/v1/asset-upload-links?client=${fixture.clientA.id}&asset=asset-hash-1`,
      cookie: fixture.adminCookie,
    });
    const filteredPage = await json<{ items: AssetUploadLinkAdminView[] }>(filtered);
    expect(filteredPage.items.every((item) => item.studioAssetId === 'asset-hash-1')).toBe(true);
    expect(JSON.stringify(filteredPage)).not.toContain('tokenHash');
  });

  it('materials?asset= returns ONLY ready materials of that exact asset with linkId provenance', async () => {
    await ensureSetup();
    const first = await mintForAsset({ cookie: fixture.adminCookie }, 'asset-pull-1');
    const firstUp = await uploadViaAssetToken(fixture.deps, { token: first.token, bytes: PNG_VARIANT_BYTES, mediaType: 'image/png', name: 'toma-a.png' });
    expect(firstUp.completeStatus).toBe(201);
    // A second (rotated) link for the SAME asset: its material must also be
    // found by asset target — the import set is per ASSET, not per link.
    const second = await mintForAsset({ cookie: fixture.adminCookie }, 'asset-pull-1');
    const secondUp = await uploadViaAssetToken(fixture.deps, { token: second.token, bytes: JPEG_VARIANT_BYTES, mediaType: 'image/jpeg', name: 'toma-b.jpg' });
    expect(secondUp.completeStatus).toBe(201);

    const asAgent = await apiCall(fixture.deps, {
      method: 'GET',
      path: '/api/v1/asset-upload-links/materials?asset=asset-pull-1',
      apiKey: fixture.integrator.apiKey,
    });
    expect(asAgent.status).toBe(200);
    const agentPage = await json<{ items: Array<{ id: string; assetTarget: string; linkId: string | null }> }>(asAgent);
    expect(agentPage.items.length).toBe(2); // old workspace-wide grant holds materials:read

    // assets:write WITHOUT materials:read stays 403 (insufficient scope on an
    // authorized client).
    const readLessAgent = await createAgent(fixture.deps.db, fixture.auth, {
      userId: fixture.integrator.userId,
      workspaceId: fixture.workspaceId,
      clientIds: null,
      scopes: ['assets:write'],
    });
    const readLess = await apiCall(fixture.deps, {
      method: 'GET',
      path: '/api/v1/asset-upload-links/materials?asset=asset-pull-1',
      apiKey: readLessAgent.apiKey,
    });
    expect(readLess.status).toBe(403);

    const response = await apiCall(fixture.deps, {
      method: 'GET',
      path: '/api/v1/asset-upload-links/materials?asset=asset-pull-1',
      apiKey: assetLinkAgent.apiKey,
    });
    expect(response.status).toBe(200);
    const page = await json<{ items: Array<{ id: string; assetTarget: string; linkId: string | null }> }>(response);
    expect(page.items.length).toBe(2);
    for (const item of page.items) {
      expect(item.assetTarget).toBe('asset-pull-1');
      expect(item.linkId).not.toBeNull();
    }
    // Missing --asset is a 400; a foreign asset id stays empty (no leak).
    await expectError(await apiCall(fixture.deps, {
      method: 'GET',
      path: '/api/v1/asset-upload-links/materials',
      cookie: fixture.adminCookie,
    }), 400, 'bad_request');
    const empty = await apiCall(fixture.deps, {
      method: 'GET',
      path: '/api/v1/asset-upload-links/materials?asset=asset-nobody',
      cookie: fixture.adminCookie,
    });
    expect((await json<{ items: unknown[] }>(empty)).items.length).toBe(0);
  });
});
