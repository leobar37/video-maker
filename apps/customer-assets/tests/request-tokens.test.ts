import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  apiCall,
  createAgent,
  expectError,
  isSessionView,
  json,
  setClientQuotaLimit,
  setupPortalFixture,
  sha256Hex,
  tokenFromLinkUrl,
  uploadViaToken,
  type PortalFixture,
} from './portal-fixture';
import { auditEvent, material, uploadRequest, uploadRequestToken } from '../src/server/db/schema';
import type { GuestRequestView, UploadRequestLinkView, UploadRequestView } from '@videomaker/customer-assets';

/**
 * UploadRequest capability tokens (P-102, R-2; contracts.md §2/§3/§5 additive
 * · customer-assets-requests): the guest token grants EXACTLY its own request
 * (view + uploads), is stored hashed (never plaintext), is single-active per
 * request (re-mint revokes), expires/revokes effectively on every HTTP touch,
 * and NEVER authenticates any other route or creates a session/cookie.
 */

let fixture: PortalFixture;
let projectId: string;
let requestId: string;
let activeToken: string;

function createRequest(
  principal: { cookie?: string; apiKey?: string },
  targetProjectId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return apiCall(fixture.deps, {
    method: 'POST',
    path: `/api/v1/projects/${targetProjectId}/requests`,
    body,
    cookie: principal.cookie,
    apiKey: principal.apiKey,
  });
}

async function mintLink(
  principal: { cookie?: string; apiKey?: string },
  targetRequestId: string,
): Promise<{ url: string; token: string; body: UploadRequestLinkView }> {
  const res = await apiCall(fixture.deps, {
    method: 'POST',
    path: `/api/v1/requests/${targetRequestId}/link`,
    body: {},
    cookie: principal.cookie,
    apiKey: principal.apiKey,
  });
  expect(res.status).toBe(201);
  const body = await json<UploadRequestLinkView>(res);
  return { url: body.url, token: tokenFromLinkUrl(body.url), body };
}

async function auditCount(action: string): Promise<number> {
  const rows = await fixture.db.select().from(auditEvent).where(eq(auditEvent.action, action));
  return rows.length;
}

describe('P-102 request tokens', () => {
  it('sets up the fixture, a project and an open request with a minted link', async () => {
    fixture = await setupPortalFixture();
    const projectRes = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/clients/${fixture.clientA.id}/projects`,
      body: { studioProjectId: 'proj-req-1', name: 'Proyecto Pedidos' },
      cookie: fixture.adminCookie,
    });
    expect(projectRes.status).toBe(201);
    const project = await json<{ id: string }>(projectRes);
    projectId = project.id;

    const res = await createRequest({ cookie: fixture.adminCookie }, projectId, {
      title: 'Tomas del evento',
      instructions: 'Suban los videos crudos en MP4',
      maxFiles: 3,
      maxBytes: 1024 * 1024,
    });
    expect(res.status).toBe(201);
    const view = await json<UploadRequestView>(res);
    requestId = view.id;
    expect(view.portalProjectId).toBe(projectId);
    expect(view.portalClientId).toBe(fixture.clientA.id);
    expect(view.state).toBe('open');
    expect(view.maxFiles).toBe(3);
    expect(view.remainingFiles).toBe(3);
    expect(view.remainingBytes).toBe(1024 * 1024);
    expect(view.instructions).toBe('Suban los videos crudos en MP4');

    const [row] = await fixture.db.select().from(uploadRequest).where(eq(uploadRequest.id, requestId));
    expect(row!.createdBy).toBe(`user:${fixture.users.admin.id}`);
    expect(await auditCount('request.created')).toBe(1);

    const minted = await mintLink({ cookie: fixture.adminCookie }, requestId);
    activeToken = minted.token;
    expect(minted.body.limits).toEqual({ maxFiles: 3, maxBytes: 1024 * 1024 });
    expect(await auditCount('request_token.minted')).toBe(1);
  });

  it('stores ONLY the hash: no plaintext token anywhere in the token row', async () => {
    const [row] = await fixture.db.select().from(uploadRequestToken).where(eq(uploadRequestToken.requestId, requestId));
    expect(row).toBeTruthy();
    expect(row!.tokenHash).toBe(sha256Hex(new TextEncoder().encode(activeToken)));
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(activeToken);
  });

  it('guest view shows only its own request and sets no cookie (no-store)', async () => {
    const res = await apiCall(fixture.deps, { method: 'GET', path: `/api/v1/r/${activeToken}` });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
    const view = await json<GuestRequestView>(res);
    expect(Object.keys(view).sort()).toEqual([
      'expiresAt', 'instructions', 'maxBytes', 'maxFiles', 'remainingBytes', 'remainingFiles', 'state', 'title',
    ]);
    expect(view.title).toBe('Tomas del evento');
    expect(view.state).toBe('open');
    expect(view.remainingFiles).toBe(3);
  });

  it('guest uploads land on its request with BOTH attribution columns', async () => {
    const outcome = await uploadViaToken(fixture.deps, { token: activeToken, name: 'crudo.mp4' });
    expect(outcome.initStatus).toBe(201);
    expect(outcome.putStatus).toBe(200);
    expect(outcome.completeStatus).toBe(201);
    const complete = outcome.complete;
    if (complete === null || !('material' in complete)) throw new Error('complete result missing');
    expect(complete.request.remainingFiles).toBe(2);

    const [materialRow] = await fixture.db
      .select()
      .from(material)
      .where(eq(material.uploadRequestId, requestId));
    expect(materialRow).toBeTruthy();
    expect(materialRow!.portalProjectId).toBe(projectId);
    expect(await auditCount('request.upload.completed')).toBe(1);
    expect((await json<UploadRequestView>(
      await apiCall(fixture.deps, { method: 'GET', path: `/api/v1/requests/${requestId}`, cookie: fixture.adminCookie }),
    )).usedFiles).toBe(1);
  });

  it('the token grants ZERO other routes: no session, no catalog, no minting', async () => {
    for (const path of ['/api/v1/me', `/api/v1/clients`, `/api/v1/clients/${fixture.clientA.id}/materials`, `/api/v1/clients/${fixture.clientA.id}/assets`, `/api/v1/clients/${fixture.clientA.id}/posts`]) {
      await expectError(await apiCall(fixture.deps, { method: 'GET', path }), 401, 'unauthorized');
    }
    // The raw token is NOT an api key: presenting it as one fails verification.
    await expectError(
      await apiCall(fixture.deps, { method: 'GET', path: '/api/v1/me', apiKey: activeToken }),
      401,
      'unauthorized',
    );
    // Without credentials the admin request routes stay closed to the guest.
    await expectError(
      await apiCall(fixture.deps, { method: 'GET', path: `/api/v1/requests/${requestId}` }),
      401,
      'unauthorized',
    );
    await expectError(
      await apiCall(fixture.deps, { method: 'POST', path: `/api/v1/requests/${requestId}/close`, body: {} }),
      401,
      'unauthorized',
    );
  });

  it('wrong, malformed and unknown tokens are indistinguishable 404s', async () => {
    await expectError(await apiCall(fixture.deps, { method: 'GET', path: `/api/v1/r/${'A'.repeat(43)}` }), 404, 'not_found');
    await expectError(await apiCall(fixture.deps, { method: 'GET', path: '/api/v1/r/short-token' }), 404, 'not_found');
    await expectError(await apiCall(fixture.deps, { method: 'GET', path: '/api/v1/r/' }), 404, 'not_found');
  });

  it('re-mint rotates: the previous token dies immediately, one ACTIVE token remains', async () => {
    const second = await mintLink({ cookie: fixture.adminCookie }, requestId);
    expect(second.token).not.toBe(activeToken);

    // Old token: revoked on the very next touch (view + upload init).
    await expectError(await apiCall(fixture.deps, { method: 'GET', path: `/api/v1/r/${activeToken}` }), 404, 'not_found');
    const deadInit = await uploadViaToken(fixture.deps, { token: activeToken });
    expect(deadInit.initStatus).toBe(404);

    // New token works; exactly one active row for the request.
    const view = await json<GuestRequestView>(
      await apiCall(fixture.deps, { method: 'GET', path: `/api/v1/r/${second.token}` }),
    );
    expect(view.state).toBe('open');
    const actives = await fixture.db
      .select()
      .from(uploadRequestToken)
      .where(eq(uploadRequestToken.requestId, requestId));
    expect(actives.filter((row) => row.revokedMs === null)).toHaveLength(1);
    expect(actives.find((row) => row.revokedMs !== null)).toBeTruthy();
    expect(await auditCount('request_token.revoked')).toBe(1);
    activeToken = second.token;
  });

  it('members never mint or create; old grants without requests:* are refused; new-scope agents may', async () => {
    // Member of the SAME client: authorized resource, insufficient role → 403.
    await expectError(
      await createRequest({ cookie: fixture.memberACookie }, projectId, { title: 'X' }),
      403,
      'forbidden',
    );
    await expectError(
      await apiCall(fixture.deps, {
        method: 'POST',
        path: `/api/v1/requests/${requestId}/link`,
        body: {},
        cookie: fixture.memberACookie,
      }),
      403,
      'forbidden',
    );
    // Member of another client: not enumerable → 404.
    await expectError(
      await createRequest({ cookie: fixture.memberBCookie }, projectId, { title: 'X' }),
      404,
      'not_found',
    );
    // Integrator grant predates R-2 (v1 scopes only): 403, never mint/create.
    await expectError(
      await createRequest({ apiKey: fixture.integrator.apiKey }, projectId, { title: 'X' }),
      403,
      'forbidden',
    );
    await expectError(
      await apiCall(fixture.deps, {
        method: 'POST',
        path: `/api/v1/requests/${requestId}/link`,
        body: {},
        apiKey: fixture.integrator.apiKey,
      }),
      403,
      'forbidden',
    );

    // A NEW grant explicitly holding the R-2 scopes may create and mint.
    const scoped = await createAgent(
      fixture.db,
      fixture.auth,
      {
        userId: fixture.users.admin.id,
        workspaceId: fixture.workspaceId,
        clientIds: [fixture.clientA.id],
        scopes: ['requests:read', 'requests:write'],
      },
    );
    const res = await createRequest({ apiKey: scoped.apiKey }, projectId, {
      title: 'Pedido del agente',
      maxFiles: 2,
      maxBytes: 4096,
    });
    expect(res.status).toBe(201);
    const created = await json<UploadRequestView>(res);
    const minted = await mintLink({ apiKey: scoped.apiKey }, created.id);
    expect(minted.token).toHaveLength(43);
  });

  it('admin close freezes the request: view says closed, uploads 409, second close 409', async () => {
    // Fresh request so this scenario stays isolated.
    const res = await createRequest({ cookie: fixture.adminCookie }, projectId, { title: 'A cerrar', maxFiles: 5, maxBytes: 65536 });
    const created = await json<UploadRequestView>(res);
    const minted = await mintLink({ cookie: fixture.adminCookie }, created.id);

    const closeRes = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/requests/${created.id}/close`,
      body: { reason: 'Ya no hace falta' },
      cookie: fixture.adminCookie,
    });
    expect(closeRes.status).toBe(200);
    const closed = await json<UploadRequestView>(closeRes);
    expect(closed.state).toBe('closed');
    expect(closed.closeReason).toBe('Ya no hace falta');
    expect(await auditCount('request.closed')).toBe(1);

    await expectError(
      await apiCall(fixture.deps, {
        method: 'POST',
        path: `/api/v1/requests/${created.id}/close`,
        body: {},
        cookie: fixture.adminCookie,
      }),
      409,
      'conflict',
    );

    const view = await json<GuestRequestView>(
      await apiCall(fixture.deps, { method: 'GET', path: `/api/v1/r/${minted.token}` }),
    );
    expect(view.state).toBe('closed');
    const outcome = await uploadViaToken(fixture.deps, { token: minted.token });
    expect(outcome.initStatus).toBe(409);
    // Minting for a non-open request is a 409.
    await expectError(
      await apiCall(fixture.deps, {
        method: 'POST',
        path: `/api/v1/requests/${created.id}/link`,
        body: {},
        cookie: fixture.adminCookie,
      }),
      409,
      'conflict',
    );
  });

  it('lazy expiry materializes ONCE with a single audit, then rejects uploads', async () => {
    const res = await createRequest({ cookie: fixture.adminCookie }, projectId, { title: 'A vencer', maxFiles: 5, maxBytes: 65536 });
    const created = await json<UploadRequestView>(res);
    const minted = await mintLink({ cookie: fixture.adminCookie }, created.id);
    await fixture.db
      .update(uploadRequest)
      .set({ expiresMs: Date.now() - 1000 })
      .where(eq(uploadRequest.id, created.id));

    const before = await auditCount('request.expired');
    const view = await json<GuestRequestView>(
      await apiCall(fixture.deps, { method: 'GET', path: `/api/v1/r/${minted.token}` }),
    );
    expect(view.state).toBe('expired');
    expect(await auditCount('request.expired')).toBe(before + 1);

    // Second touch does NOT re-audit (idempotency guard on the CAS update).
    await apiCall(fixture.deps, { method: 'GET', path: `/api/v1/r/${minted.token}` });
    expect(await auditCount('request.expired')).toBe(before + 1);

    const outcome = await uploadViaToken(fixture.deps, { token: minted.token });
    expect(outcome.initStatus).toBe(409);
    // Admin listing also materializes expiry lazily.
    const list = await json<{ items: UploadRequestView[] }>(
      await apiCall(fixture.deps, { method: 'GET', path: `/api/v1/projects/${projectId}/requests`, cookie: fixture.adminCookie }),
    );
    expect(list.items.find((r) => r.id === created.id)?.state).toBe('expired');
    expect(await auditCount('request.expired')).toBe(before + 1);
  });

  it('an expired TOKEN (30m..30d window) is a 404 even while its request is open', async () => {
    const res = await createRequest({ cookie: fixture.adminCookie }, projectId, { title: 'Token corto', maxFiles: 5, maxBytes: 65536 });
    const created = await json<UploadRequestView>(res);
    const minted = await mintLink({ cookie: fixture.adminCookie }, created.id);
    await fixture.db
      .update(uploadRequestToken)
      .set({ expiresMs: Date.now() - 1 })
      .where(eq(uploadRequestToken.requestId, created.id));
    await expectError(
      await apiCall(fixture.deps, { method: 'GET', path: `/api/v1/r/${minted.token}` }),
      404,
      'not_found',
    );
  });

  it('rejects invalid limits and quotas at creation; expiry reuses the 30m..30d grammar', async () => {
    await expectError(
      await createRequest({ cookie: fixture.adminCookie }, projectId, { title: 'X', maxFiles: 0 }),
      400,
      'bad_request',
    );
    await expectError(
      await createRequest({ cookie: fixture.adminCookie }, projectId, { title: 'X', maxFiles: 501 }),
      400,
      'bad_request',
    );
    await expectError(
      await createRequest({ cookie: fixture.adminCookie }, projectId, { title: 'X', expiresIn: '10m' }),
      400,
      'bad_request',
    );
    await expectError(
      await createRequest({ cookie: fixture.adminCookie }, projectId, { title: 'X', expiresIn: '60d' }),
      400,
      'bad_request',
    );
    // Default quota is 1 GiB: promising 4 GiB would exceed the client budget.
    await expectError(
      await createRequest({ cookie: fixture.adminCookie }, projectId, { title: 'X', maxBytes: 4 * 1024 * 1024 * 1024 }),
      400,
      'bad_request',
    );
    await expectError(
      await createRequest({ cookie: fixture.adminCookie }, projectId, { title: '' }),
      400,
      'bad_request',
    );
  });

  it('guest init is idempotency-keyed: a retried init replays the SAME session', async () => {
    const res = await createRequest({ cookie: fixture.adminCookie }, projectId, { title: 'Idem', maxFiles: 5, maxBytes: 65536 });
    const created = await json<UploadRequestView>(res);
    const minted = await mintLink({ cookie: fixture.adminCookie }, created.id);
    const first = await uploadViaToken(fixture.deps, { token: minted.token, idempotencyKey: 'idem-guest-1', name: 'crudo.mp4' });
    expect(first.initStatus).toBe(201);
    expect(isSessionView(first.init)).toBe(true);
    const session = first.init;
    if (!isSessionView(session)) throw new Error('session view missing');
    const replayInit = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/r/${minted.token}/uploads`,
      body: { mediaType: 'image/jpeg', declaredBytes: session.declaredBytes, name: 'crudo.mp4' },
      idempotencyKey: 'idem-guest-1',
    });
    expect(replayInit.status).toBe(201);
    expect(replayInit.headers.get('idempotency-replayed')).toBe('true');
    const replayed = await json<{ uploadId: string }>(replayInit);
    expect(replayed.uploadId).toBe(session.uploadId);
  });
});
