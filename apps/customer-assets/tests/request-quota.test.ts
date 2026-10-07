import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  apiCall,
  expectError,
  isSessionView,
  json,
  resetClientQuota,
  setupPortalFixture,
  setClientQuotaLimit,
  tokenFromLinkUrl,
  uploadViaToken,
  type PortalFixture,
} from './portal-fixture';
import { auditEvent, clientQuota, material, uploadRequest } from '../src/server/db/schema';
import type {
  ApiError,
  GuestUploadSessionView,
  UploadRequestView,
} from '@videomaker/customer-assets';

/**
 * Request budget under concurrency (P-102, R-2; contracts.md §4): the dual
 * reservation (client_quota CAS + request CAS) in ONE atomic D1 batch never
 * oversells maxFiles/maxBytes or the client quota; a lost arm releases ONLY
 * the arm(s) that applied (compensatory release); failures at complete
 * release both budgets; auto-close (fulfilled) and lazy expiry are exact.
 */

let fixture: PortalFixture;
let projectId: string;

function jpegPayload(size: number, seed = 1): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xe0;
  for (let i = 4; i < size; i += 1) bytes[i] = (i * seed + 7) % 251;
  return bytes;
}

function pngPayload(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

async function createOpenRequest(
  body: { maxFiles: number; maxBytes: number; title?: string },
): Promise<{ requestId: string; token: string }> {
  const res = await apiCall(fixture.deps, {
    method: 'POST',
    path: `/api/v1/projects/${projectId}/requests`,
    body: { title: body.title ?? 'Pedido de cuota', maxFiles: body.maxFiles, maxBytes: body.maxBytes },
    cookie: fixture.adminCookie,
  });
  expect(res.status).toBe(201);
  const created = await json<UploadRequestView>(res);
  const linkRes = await apiCall(fixture.deps, {
    method: 'POST',
    path: `/api/v1/requests/${created.id}/link`,
    body: {},
    cookie: fixture.adminCookie,
  });
  expect(linkRes.status).toBe(201);
  const link = await json<{ url: string }>(linkRes);
  return { requestId: created.id, token: tokenFromLinkUrl(link.url) };
}

async function requestRow(requestId: string) {
  const [row] = await fixture.db.select().from(uploadRequest).where(eq(uploadRequest.id, requestId));
  expect(row).toBeTruthy();
  return row!;
}

async function quotaRow(clientId: string) {
  const [row] = await fixture.db.select().from(clientQuota).where(eq(clientQuota.clientId, clientId));
  expect(row).toBeTruthy();
  return row!;
}

async function guestInit(token: string, declaredBytes: number, mediaType = 'image/jpeg'): Promise<Response> {
  return apiCall(fixture.deps, {
    method: 'POST',
    path: `/api/v1/r/${token}/uploads`,
    body: { mediaType, declaredBytes },
  });
}

async function materialCountFor(requestId: string): Promise<number> {
  const rows = await fixture.db.select().from(material).where(eq(material.uploadRequestId, requestId));
  return rows.length;
}

describe('P-102 request quota (dual CAS)', () => {
  it('sets up the fixture and project', async () => {
    fixture = await setupPortalFixture();
    const projectRes = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/clients/${fixture.clientA.id}/projects`,
      body: { studioProjectId: 'proj-quota-1', name: 'Proyecto Cuota' },
      cookie: fixture.adminCookie,
    });
    expect(projectRes.status).toBe(201);
    const project = await json<{ id: string }>(projectRes);
    projectId = project.id;
    await resetClientQuota(fixture.db, fixture.clientA.id, 1024 * 1024 * 1024);
  });

  it('N parallel inits cannot oversell maxFiles/maxBytes: losers get 429 with zero leak', async () => {
    const { requestId, token } = await createOpenRequest({ maxFiles: 2, maxBytes: 100 });
    const results = await Promise.all([guestInit(token, 24), guestInit(token, 24), guestInit(token, 24), guestInit(token, 24), guestInit(token, 24)]);
    const created = results.filter((res) => res.status === 201);
    const rejected = results.filter((res) => res.status !== 201);
    expect(created).toHaveLength(2);
    expect(rejected).toHaveLength(3);
    for (const res of rejected) await expectError(res, 429, 'rate_limited');

    const request = await requestRow(requestId);
    expect(request.usedFiles).toBe(2);
    expect(request.usedBytes).toBe(48);
    expect(request.state).toBe('open');
    const quota = await quotaRow(fixture.clientA.id);
    expect(quota.reservedBytes).toBe(48);
  });

  it('client quota and request budget compete: the losing arm releases ONLY itself', async () => {
    // The quota limit is lowered AFTER creation (limits change in real life):
    // it now admits ONE 24-byte reservation (24+24=48 > 40) while the request
    // budget (maxBytes 100_000) would admit all three — the selective
    // compensatory release must unwind exactly the over-applied arm.
    const { requestId, token } = await createOpenRequest({ maxFiles: 5, maxBytes: 100_000 });
    await resetClientQuota(fixture.db, fixture.clientA.id, 1024 * 1024 * 1024);
    await setClientQuotaLimit(fixture.db, fixture.clientA.id, 40);
    const results = await Promise.all([guestInit(token, 24), guestInit(token, 24), guestInit(token, 24)]);
    const created = results.filter((res) => res.status === 201);
    expect(created).toHaveLength(1);

    const request = await requestRow(requestId);
    expect(request.usedFiles).toBe(1);
    expect(request.usedBytes).toBe(24);
    const quota = await quotaRow(fixture.clientA.id);
    expect(quota.reservedBytes).toBe(24);
    expect(quota.usedBytes).toBe(0);
    await resetClientQuota(fixture.db, fixture.clientA.id, 1024 * 1024);
  });

  it('completing to the limit auto-closes fulfilled exactly once and rejects further uploads', async () => {
    await resetClientQuota(fixture.db, fixture.clientA.id, 1024 * 1024);
    const { requestId, token } = await createOpenRequest({ maxFiles: 2, maxBytes: 100_000 });
    const first = await uploadViaToken(fixture.deps, { token, bytes: jpegPayload(24), name: 'a.jpg' });
    const second = await uploadViaToken(fixture.deps, { token, bytes: jpegPayload(30), name: 'b.jpg' });
    expect(first.completeStatus).toBe(201);
    expect(second.completeStatus).toBe(201);

    const request = await requestRow(requestId);
    expect(request.state).toBe('fulfilled');
    expect(request.usedFiles).toBe(2);
    expect(request.usedBytes).toBe(54);
    expect(request.closeReason).toBe('fulfilled');
    const quota = await quotaRow(fixture.clientA.id);
    expect(quota.usedBytes).toBe(54);
    expect(quota.reservedBytes).toBe(0);
    expect(await materialCountFor(requestId)).toBe(2);

    const audits = await fixture.db.select().from(auditEvent).where(eq(auditEvent.action, 'request.fulfilled'));
    expect(audits.filter((row) => row.resourceId === requestId)).toHaveLength(1);

    const late = await guestInit(token, 24);
    await expectError(late, 409, 'conflict');
    const view = await json<{ state: string }>(
      await apiCall(fixture.deps, { method: 'GET', path: `/api/v1/r/${token}` }),
    );
    expect(view.state).toBe('fulfilled');
  });

  it('a 415 at complete releases BOTH budgets (session failed, no phantom reservation)', async () => {
    await resetClientQuota(fixture.db, fixture.clientA.id, 1024 * 1024);
    const { requestId, token } = await createOpenRequest({ maxFiles: 5, maxBytes: 100_000 });
    // Declared video/mp4, staged bytes are a valid PNG: the declaration is
    // the contract, so complete must 415 and unwind the whole reservation.
    const outcome = await uploadViaToken(fixture.deps, {
      token,
      bytes: pngPayload(20),
      mediaType: 'video/mp4',
      name: 'trampa.mp4',
    });
    expect(outcome.initStatus).toBe(201);
    expect(outcome.putStatus).toBe(200);
    expect(outcome.completeStatus).toBe(415);

    const request = await requestRow(requestId);
    expect(request.usedFiles).toBe(0);
    expect(request.usedBytes).toBe(0);
    expect(request.state).toBe('open');
    const quota = await quotaRow(fixture.clientA.id);
    expect(quota.reservedBytes).toBe(0);
    expect(quota.usedBytes).toBe(0);
    expect(await materialCountFor(requestId)).toBe(0);

    // The request still accepts a correct upload afterwards.
    const retry = await uploadViaToken(fixture.deps, { token, bytes: jpegPayload(24), name: 'ok.jpg' });
    expect(retry.completeStatus).toBe(201);
  });

  it('413 for per-file type limits and 429 for request budget, both before any write', async () => {
    await resetClientQuota(fixture.db, fixture.clientA.id, 1024 * 1024);
    const { requestId, token } = await createOpenRequest({ maxFiles: 5, maxBytes: 100 });
    const tooBigType = await guestInit(token, 51 * 1024 * 1024, 'video/mp4');
    await expectError(tooBigType, 413, 'payload_too_large');
    const overBudget = await guestInit(token, 101);
    await expectError(overBudget, 429, 'rate_limited');
    const request = await requestRow(requestId);
    expect(request.usedFiles).toBe(0);
    expect(request.usedBytes).toBe(0);
  });

  it('full parallel flows (init+put+complete) converge on exact counters and dedupe-safe materials', async () => {
    await resetClientQuota(fixture.db, fixture.clientA.id, 1024 * 1024);
    const { requestId, token } = await createOpenRequest({ maxFiles: 3, maxBytes: 100_000 });
    const flows = await Promise.all([
      uploadViaToken(fixture.deps, { token, bytes: jpegPayload(24, 11), name: 'f1.jpg' }),
      uploadViaToken(fixture.deps, { token, bytes: jpegPayload(24, 12), name: 'f2.jpg' }),
      uploadViaToken(fixture.deps, { token, bytes: jpegPayload(24, 13), name: 'f3.jpg' }),
      uploadViaToken(fixture.deps, { token, bytes: jpegPayload(24, 14), name: 'f4.jpg' }),
    ]);
    const completed = flows.filter((flow) => flow.completeStatus === 201);
    const rejected = flows.filter((flow) => flow.initStatus !== 201);
    expect(completed).toHaveLength(3);
    expect(rejected).toHaveLength(1);

    const request = await requestRow(requestId);
    expect(request.state).toBe('fulfilled');
    expect(request.usedFiles).toBe(3);
    expect(request.usedBytes).toBe(72);
    const quota = await quotaRow(fixture.clientA.id);
    expect(quota.usedBytes).toBe(72);
    expect(quota.reservedBytes).toBe(0);
    expect(await materialCountFor(requestId)).toBe(3);
    for (const flow of completed) {
      expect(flow.complete !== null && 'material' in flow.complete).toBe(true);
      if (flow.complete !== null && 'material' in flow.complete) {
        expect(flow.complete.request.remainingFiles).toBe(0);
      }
    }
  });

  it('lazy expiry between PUT and complete rejects with a clear state and audits once', async () => {
    await resetClientQuota(fixture.db, fixture.clientA.id, 1024 * 1024);
    const { requestId, token } = await createOpenRequest({ maxFiles: 5, maxBytes: 100_000 });
    const init = await guestInit(token, 24);
    expect(init.status).toBe(201);
    const parsed = await json<GuestUploadSessionView | ApiError>(init);
    expect(isSessionView(parsed)).toBe(true);
    if (!isSessionView(parsed)) throw new Error('session view missing');
    const put = await apiCall(fixture.deps, {
      method: 'PUT',
      path: `/api/v1/r/${token}/uploads/${parsed.uploadId}/content`,
      rawBody: jpegPayload(24),
    });
    expect(put.status).toBe(200);

    await fixture.db.update(uploadRequest).set({ expiresMs: Date.now() - 1 }).where(eq(uploadRequest.id, requestId));
    const before = (await fixture.db.select().from(auditEvent).where(eq(auditEvent.action, 'request.expired'))).length;
    const complete = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/r/${token}/uploads/${parsed.uploadId}/complete`,
    });
    expect(complete.status).toBe(409);
    const after = (await fixture.db.select().from(auditEvent).where(eq(auditEvent.action, 'request.expired'))).length;
    expect(after).toBe(before + 1);
    const request = await requestRow(requestId);
    expect(request.state).toBe('expired');
  });
});
