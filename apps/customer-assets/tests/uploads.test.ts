import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:test';
import {
  apiCall,
  chunkedStream,
  expectError,
  json,
  resetClientQuota,
  setClientQuotaLimit,
  setupPortalFixture,
  uploadMaterial,
  JPEG_BYTES,
  MP4_BYTES,
  PNG_BYTES,
  sha256Hex,
  type PortalFixture,
} from './portal-fixture';
import { DEFAULT_CLIENT_QUOTA_BYTES } from '../src/server/uploads';
import { clientQuota, material, uploadSession } from '../src/server/db/schema';

/**
 * Upload protocol (contracts.md §4): idempotent init, exact-length streaming
 * PUT, server-verified complete, concurrent-safe quota, and the R2/D1
 * failure-recovery contract (no false ready, consistent retry).
 */

let fixture: PortalFixture;

interface InitResult {
  uploadId: string;
  status: string;
}

async function initMaterialUpload(
  principal: { cookie?: string; apiKey?: string },
  declaredBytes: number,
  mediaType: 'image/jpeg' | 'image/png' | 'video/mp4' = 'image/jpeg',
  idempotencyKey?: string,
): Promise<Response> {
  return apiCall(fixture.deps, {
    method: 'POST',
    path: `/api/v1/clients/${fixture.clientA.id}/uploads`,
    body: { kind: 'material', mediaType, declaredBytes, name: 'test-upload' },
    idempotencyKey,
    cookie: principal.cookie,
    apiKey: principal.apiKey,
  });
}

describe('P-002 uploads', () => {
  it('sets up the fixture with a bounded quota', async () => {
    fixture = await setupPortalFixture();
    await setClientQuotaLimit(fixture.db, fixture.clientA.id, DEFAULT_CLIENT_QUOTA_BYTES);
  });

  it('runs the happy path init → PUT → complete with server-verified ready', async () => {
    const init = await initMaterialUpload({ cookie: fixture.adminCookie }, JPEG_BYTES.byteLength);
    expect(init.status).toBe(201);
    const session = await json<InitResult>(init);
    expect(session.status).toBe('pending');
    // The staging key NEVER appears in API responses.
    expect(JSON.stringify(session)).not.toContain('staging');

    const put = await apiCall(fixture.deps, {
      method: 'PUT',
      path: `/api/v1/uploads/${session.uploadId}/content`,
      rawBody: chunkedStream(JPEG_BYTES, 3),
      cookie: fixture.adminCookie,
    });
    expect(put.status).toBe(200);
    const staged = await json<{ bytes: number; sha256: string }>(put);
    expect(staged.bytes).toBe(JPEG_BYTES.byteLength);
    expect(staged.sha256).toBe(sha256Hex(JPEG_BYTES));

    const complete = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/uploads/${session.uploadId}/complete`,
      cookie: fixture.adminCookie,
    });
    expect(complete.status).toBe(201);
    const view = await json<{ id: string; sha256: string; bytes: number; mediaType: string; status: string }>(complete);
    expect(view.sha256).toBe(sha256Hex(JPEG_BYTES));
    expect(view.bytes).toBe(JPEG_BYTES.byteLength);
    expect(view.mediaType).toBe('image/jpeg');
    expect(view.status).toBe('ready');

    // Quota moved from reserved to used exactly once.
    const [quota] = await fixture.db
      .select({ used: clientQuota.usedBytes, reserved: clientQuota.reservedBytes })
      .from(clientQuota)
      .where(eq(clientQuota.clientId, fixture.clientA.id))
      .limit(1);
    expect(quota?.used).toBe(JPEG_BYTES.byteLength);
    expect(quota?.reserved).toBe(0);

    // Replaying complete returns the same resource without duplicating.
    const replay = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/uploads/${session.uploadId}/complete`,
      cookie: fixture.adminCookie,
    });
    expect(replay.status).toBe(200);
    expect((await json<{ id: string }>(replay)).id).toBe(view.id);
  });

  it('serves content with GET/HEAD and single Range requests', async () => {
    const materialRes = await uploadMaterial(fixture.deps, {
      principal: { cookie: fixture.memberACookie },
      clientId: fixture.clientA.id,
      bytes: MP4_BYTES,
      mediaType: 'video/mp4',
      name: 'clip.mp4',
    });
    const view = await json<{ id: string }>(materialRes);

    const head = await apiCall(fixture.deps, {
      method: 'HEAD',
      path: `/api/v1/materials/${view.id}/content`,
      cookie: fixture.memberACookie,
    });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(MP4_BYTES.byteLength));
    expect(head.headers.get('content-type')).toBe('video/mp4');
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    const full = await apiCall(fixture.deps, {
      method: 'GET',
      path: `/api/v1/materials/${view.id}/content`,
      cookie: fixture.memberACookie,
    });
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(MP4_BYTES);

    const range = await apiCall(fixture.deps, {
      method: 'GET',
      path: `/api/v1/materials/${view.id}/content`,
      headers: { range: 'bytes=2-5' },
      cookie: fixture.memberACookie,
    });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe(`bytes 2-5/${MP4_BYTES.byteLength}`);
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(MP4_BYTES.slice(2, 6));

    const suffix = await apiCall(fixture.deps, {
      method: 'GET',
      path: `/api/v1/materials/${view.id}/content`,
      headers: { range: 'bytes=-4' },
      cookie: fixture.memberACookie,
    });
    expect(suffix.status).toBe(206);
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(MP4_BYTES.slice(-4));

    const unsatisfiable = await apiCall(fixture.deps, {
      method: 'GET',
      path: `/api/v1/materials/${view.id}/content`,
      headers: { range: `bytes=${MP4_BYTES.byteLength + 10}-` },
      cookie: fixture.memberACookie,
    });
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('content-range')).toBe(`bytes */${MP4_BYTES.byteLength}`);
  });

  it('binds Idempotency-Key to payload fingerprint: replay vs 409', async () => {
    const key = `idem-${crypto.randomUUID()}`;
    const first = await initMaterialUpload({ cookie: fixture.adminCookie }, JPEG_BYTES.byteLength, 'image/jpeg', key);
    expect(first.status).toBe(201);
    const firstSession = await json<InitResult>(first);

    const second = await initMaterialUpload({ cookie: fixture.adminCookie }, JPEG_BYTES.byteLength, 'image/jpeg', key);
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotency-replayed')).toBe('true');
    expect((await json<InitResult>(second)).uploadId).toBe(firstSession.uploadId);

    // Same key, different payload → conflict.
    const different = await initMaterialUpload({ cookie: fixture.adminCookie }, JPEG_BYTES.byteLength + 1, 'image/jpeg', key);
    await expectError(different, 409, 'conflict');
  });

  it('deduplicates concurrent same-key inits into ONE session and ONE reservation', async () => {
    await resetClientQuota(fixture.db, fixture.clientA.id);
    const key = `race-${crypto.randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        initMaterialUpload({ cookie: fixture.adminCookie }, JPEG_BYTES.byteLength, 'image/jpeg', key),
      ),
    );
    for (const res of results) expect(res.status).toBe(201);
    const uploadIds = new Set<string>();
    for (const res of results) {
      const body = await json<InitResult>(res);
      uploadIds.add(body.uploadId);
    }
    expect(uploadIds.size).toBe(1);

    const [quota] = await fixture.db
      .select({ reserved: clientQuota.reservedBytes })
      .from(clientQuota)
      .where(eq(clientQuota.clientId, fixture.clientA.id))
      .limit(1);
    expect(quota?.reserved).toBe(JPEG_BYTES.byteLength);
  });

  it('rejects over-quota init with 429 and keeps the ledger exact', async () => {
    await resetClientQuota(fixture.db, fixture.clientA.id, JPEG_BYTES.byteLength * 2);
    const ok1 = await initMaterialUpload({ cookie: fixture.adminCookie }, JPEG_BYTES.byteLength);
    const ok2 = await initMaterialUpload({ cookie: fixture.adminCookie }, JPEG_BYTES.byteLength);
    expect(ok1.status).toBe(201);
    expect(ok2.status).toBe(201);

    const over = await initMaterialUpload({ cookie: fixture.adminCookie }, JPEG_BYTES.byteLength);
    await expectError(over, 429, 'rate_limited');

    // Concurrent over-quota: exactly `remaining` slots can be reserved.
    const results = await Promise.all(
      Array.from({ length: 4 }, () => initMaterialUpload({ cookie: fixture.adminCookie }, JPEG_BYTES.byteLength)),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(0);
    expect(statuses.filter((s) => s === 429)).toHaveLength(4);

    const [quota] = await fixture.db
      .select({ reserved: clientQuota.reservedBytes })
      .from(clientQuota)
      .where(eq(clientQuota.clientId, fixture.clientA.id))
      .limit(1);
    expect(quota?.reserved).toBe(JPEG_BYTES.byteLength * 2);
  });

  it('never marks oversized bodies ready (413 mid-stream, nothing staged)', async () => {
    await resetClientQuota(fixture.db, fixture.clientA.id);
    const init = await initMaterialUpload({ cookie: fixture.adminCookie }, 5);
    const session = await json<InitResult>(init);
    const put = await apiCall(fixture.deps, {
      method: 'PUT',
      path: `/api/v1/uploads/${session.uploadId}/content`,
      rawBody: JPEG_BYTES, // 5 declared, more sent
      cookie: fixture.adminCookie,
    });
    await expectError(put, 413, 'payload_too_large');

    const complete = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/uploads/${session.uploadId}/complete`,
      cookie: fixture.adminCookie,
    });
    await expectError(complete, 409, 'conflict');
  });

  it('rejects lying content types: declared png over jpeg bytes never goes ready', async () => {
    await resetClientQuota(fixture.db, fixture.clientA.id);
    const countBefore = await json<{ items: unknown[] }>(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientA.id}/materials`,
        cookie: fixture.adminCookie,
      }),
    );
    const init = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/clients/${fixture.clientA.id}/uploads`,
      body: { kind: 'material', mediaType: 'image/png', declaredBytes: JPEG_BYTES.byteLength },
      cookie: fixture.adminCookie,
    });
    const session = await json<InitResult>(init);
    const put = await apiCall(fixture.deps, {
      method: 'PUT',
      path: `/api/v1/uploads/${session.uploadId}/content`,
      rawBody: JPEG_BYTES,
      headers: { 'content-type': 'image/png' }, // lies; the server sniffs bytes
      cookie: fixture.adminCookie,
    });
    expect(put.status).toBe(200); // staging accepts v1 bytes; complete decides

    const complete = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/uploads/${session.uploadId}/complete`,
      cookie: fixture.adminCookie,
    });
    await expectError(complete, 415, 'unsupported_media_type');

    const list = await json<{ items: unknown[] }>(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientA.id}/materials`,
        cookie: fixture.adminCookie,
      }),
    );
    expect(list.items).toHaveLength(countBefore.items.length);
  });

  it('rejects short/corrupt bodies without commit and keeps the session retryable-pending', async () => {
    await resetClientQuota(fixture.db, fixture.clientA.id);
    const init = await initMaterialUpload({ cookie: fixture.adminCookie }, JPEG_BYTES.byteLength);
    const session = await json<InitResult>(init);
    const put = await apiCall(fixture.deps, {
      method: 'PUT',
      path: `/api/v1/uploads/${session.uploadId}/content`,
      rawBody: chunkedStream(JPEG_BYTES.slice(0, 6), 3), // undershoot
      cookie: fixture.adminCookie,
    });
    expect(put.status).toBe(400);

    const complete = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/uploads/${session.uploadId}/complete`,
      cookie: fixture.adminCookie,
    });
    await expectError(complete, 409, 'conflict');
  });

  it('refuses re-PUT after staged and expired sessions', async () => {
    await resetClientQuota(fixture.db, fixture.clientA.id);
    const init = await initMaterialUpload({ cookie: fixture.adminCookie }, JPEG_BYTES.byteLength);
    const session = await json<InitResult>(init);
    const put1 = await apiCall(fixture.deps, {
      method: 'PUT',
      path: `/api/v1/uploads/${session.uploadId}/content`,
      rawBody: JPEG_BYTES,
      cookie: fixture.adminCookie,
    });
    expect(put1.status).toBe(200);

    const put2 = await apiCall(fixture.deps, {
      method: 'PUT',
      path: `/api/v1/uploads/${session.uploadId}/content`,
      rawBody: JPEG_BYTES,
      cookie: fixture.adminCookie,
    });
    await expectError(put2, 409, 'conflict');

    // Expiry: pending session in the past cannot accept content.
    const fresh = await initMaterialUpload({ cookie: fixture.adminCookie }, JPEG_BYTES.byteLength);
    const freshSession = await json<InitResult>(fresh);
    await fixture.db
      .update(uploadSession)
      .set({ expiresMs: Date.now() - 1000 })
      .where(eq(uploadSession.id, freshSession.uploadId));
    const expiredPut = await apiCall(fixture.deps, {
      method: 'PUT',
      path: `/api/v1/uploads/${freshSession.uploadId}/content`,
      rawBody: JPEG_BYTES,
      cookie: fixture.adminCookie,
    });
    await expectError(expiredPut, 409, 'conflict');
  });

  it('stays consistent when staging disappears before complete (no false ready)', async () => {
    await resetClientQuota(fixture.db, fixture.clientA.id);
    const countBefore = await json<{ items: unknown[] }>(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientA.id}/materials`,
        cookie: fixture.adminCookie,
      }),
    );
    const init = await initMaterialUpload({ cookie: fixture.adminCookie }, JPEG_BYTES.byteLength);
    const session = await json<InitResult>(init);
    await apiCall(fixture.deps, {
      method: 'PUT',
      path: `/api/v1/uploads/${session.uploadId}/content`,
      rawBody: JPEG_BYTES,
      cookie: fixture.adminCookie,
    });
    const [row] = await fixture.db
      .select({ stagingKey: uploadSession.stagingKey })
      .from(uploadSession)
      .where(eq(uploadSession.id, session.uploadId))
      .limit(1);
    await env.ASSETS.delete(row!.stagingKey);

    const complete = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/uploads/${session.uploadId}/complete`,
      cookie: fixture.adminCookie,
    });
    await expectError(complete, 409, 'conflict');
    const list = await json<{ items: unknown[] }>(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientA.id}/materials`,
        cookie: fixture.adminCookie,
      }),
    );
    expect(list.items).toHaveLength(countBefore.items.length);
  });

  it('recovers from an R2-then-D1 orphan: retry converges without duplication', async () => {
    await resetClientQuota(fixture.db, fixture.clientA.id);
    // Simulate a crashed prior attempt: the final object exists, D1 does not.
    const finalKey = `materials/${fixture.clientA.id}/${sha256Hex(JPEG_BYTES)}`;
    await env.ASSETS.put(finalKey, JPEG_BYTES, { httpMetadata: { contentType: 'image/jpeg' } });

    const before = await env.ASSETS.head(finalKey);
    expect(before?.size).toBe(JPEG_BYTES.byteLength);

    const materialRes = await uploadMaterial(fixture.deps, {
      principal: { cookie: fixture.adminCookie },
      clientId: fixture.clientA.id,
      name: 'orphan-recovery.jpg',
    });
    expect(materialRes.status).toBe(201);
    const view = await json<{ id: string; sha256: string }>(materialRes);

    // Exactly one object at the content address; the D1 row exists; ready.
    const head = await env.ASSETS.head(finalKey);
    expect(head?.size).toBe(JPEG_BYTES.byteLength);
    const [row] = await fixture.db
      .select({ status: material.status })
      .from(material)
      .where(eq(material.id, view.id))
      .limit(1);
    expect(row?.status).toBe('ready');
  });

  it('paginates the material list with opaque cursors', async () => {
    await resetClientQuota(fixture.db, fixture.clientB.id);
    await uploadMaterial(fixture.deps, {
      principal: { cookie: fixture.adminCookie },
      clientId: fixture.clientB.id,
      name: 'page-a.jpg',
    });
    await uploadMaterial(fixture.deps, {
      principal: { cookie: fixture.adminCookie },
      clientId: fixture.clientB.id,
      bytes: PNG_BYTES,
      mediaType: 'image/png',
      name: 'page-b.png',
    });
    const page1 = await json<{ items: { name: string }[]; nextCursor: string | null }>(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientB.id}/materials?limit=1`,
        cookie: fixture.memberBCookie,
      }),
    );
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await json<{ items: { name: string }[]; nextCursor: string | null }>(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientB.id}/materials?limit=1&cursor=${encodeURIComponent(page1.nextCursor!)}`,
        cookie: fixture.memberBCookie,
      }),
    );
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]!.name).not.toBe(page1.items[0]!.name);
  });
});
