import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  apiCall,
  chunkedStream,
  expectError,
  JPEG_BYTES,
  json,
  setupPortalFixture,
  type PortalFixture,
} from './portal-fixture';
import { clientQuota, material, uploadSession } from '../src/server/db/schema';
import type { MaterialView } from '@videomaker/customer-assets';

/**
 * Material ↔ project attribution (P-101, R-1; FR-104, contracts.md §2
 * additive): portal_project_id binds ONLY when a complete explicitly names a
 * project of the upload's client; foreign/unknown projects are rejected
 * BEFORE any resource is created; and the free v1 path (no field anywhere)
 * stays byte-identical — NULL attribution and the exact v1 response shape.
 */

let fixture: PortalFixture;
let projectAId: string;
let projectBId: string;

const V1_MATERIAL_KEYS = ['clientId', 'bytes', 'name', 'createdAt', 'sha256', 'id', 'mediaType', 'status'].sort();

interface InitResult {
  uploadId: string;
  status: string;
}

async function initMemberUpload(
  clientId: string,
  bytes: Uint8Array,
  options: { portalProjectId?: string } = {},
): Promise<Response> {
  return apiCall(fixture.deps, {
    method: 'POST',
    path: `/api/v1/clients/${clientId}/uploads`,
    body: {
      kind: 'material',
      mediaType: 'image/jpeg',
      declaredBytes: bytes.byteLength,
      name: 'photo.jpg',
      ...(options.portalProjectId === undefined ? {} : { portalProjectId: options.portalProjectId }),
    },
    cookie: fixture.memberACookie,
  });
}

async function putAndComplete(
  uploadId: string,
  bytes: Uint8Array,
  completeBody: Record<string, unknown> | undefined,
): Promise<Response> {
  const put = await apiCall(fixture.deps, {
    method: 'PUT',
    path: `/api/v1/uploads/${uploadId}/content`,
    rawBody: chunkedStream(bytes, 5),
    cookie: fixture.memberACookie,
  });
  expect(put.status).toBe(200);
  return apiCall(fixture.deps, {
    method: 'POST',
    path: `/api/v1/uploads/${uploadId}/complete`,
    ...(completeBody === undefined ? {} : { body: completeBody }),
    cookie: fixture.memberACookie,
  });
}

async function attributionOf(materialId: string): Promise<string | null> {
  const rows = await fixture.db.all<{ portal_project_id: string | null }>(
    sql`SELECT portal_project_id FROM material WHERE id = ${materialId}`,
  );
  return rows[0]!.portal_project_id;
}

describe('P-101 material attribution', () => {
  it('sets up the fixture and one project per client', async () => {
    fixture = await setupPortalFixture();
    const createA = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/clients/${fixture.clientA.id}/projects`,
      body: { studioProjectId: 'proj-alpha-film', name: 'Alpha Film' },
      cookie: fixture.adminCookie,
    });
    const createB = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/clients/${fixture.clientB.id}/projects`,
      body: { studioProjectId: 'proj-beta-film', name: 'Beta Film' },
      cookie: fixture.adminCookie,
    });
    expect(createA.status).toBe(201);
    expect(createB.status).toBe(201);
    projectAId = (await json<{ id: string }>(createA)).id;
    projectBId = (await json<{ id: string }>(createB)).id;
  });

  it('attributes a material when the member completes with a project of their client', async () => {
    const init = await initMemberUpload(fixture.clientA.id, JPEG_BYTES, { portalProjectId: projectAId });
    expect(init.status).toBe(201);
    const session = await json<InitResult>(init);
    const complete = await putAndComplete(session.uploadId, JPEG_BYTES, { portalProjectId: projectAId });
    expect(complete.status).toBe(201);
    const materialView = await json<MaterialView>(complete);
    // v1 wire shape is unchanged: no new keys leak into the material view.
    expect(Object.keys(materialView).sort()).toEqual(V1_MATERIAL_KEYS);
    expect(await attributionOf(materialView.id)).toBe(projectAId);

    // The project's material count is visible in the projects list.
    const list = await json<{ items: { id: string; materialCount: number }[] }>(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientA.id}/projects`,
        cookie: fixture.memberACookie,
      }),
    );
    expect(list.items.find((p) => p.id === projectAId)!.materialCount).toBe(1);
  });

  it('keeps the free upload path byte-identical: no field anywhere → NULL attribution', async () => {
    const bytes = new Uint8Array([...JPEG_BYTES, 0x01]);
    const init = await initMemberUpload(fixture.clientA.id, bytes);
    expect(init.status).toBe(201);
    const session = await json<InitResult>(init);
    const complete = await putAndComplete(session.uploadId, bytes, undefined);
    expect(complete.status).toBe(201);
    const materialView = await json<MaterialView>(complete);
    expect(Object.keys(materialView).sort()).toEqual(V1_MATERIAL_KEYS);
    expect(await attributionOf(materialView.id)).toBeNull();

    // An explicit EMPTY body is the same free path ({} → no attribution).
    const init2 = await initMemberUpload(fixture.clientA.id, new Uint8Array([...JPEG_BYTES, 0x02]));
    const session2 = await json<InitResult>(init2);
    const complete2 = await putAndComplete(session2.uploadId, new Uint8Array([...JPEG_BYTES, 0x02]), {});
    expect(complete2.status).toBe(201);
    expect(await attributionOf((await json<MaterialView>(complete2)).id)).toBeNull();
  });

  it('init rejects a foreign or unknown project with 404 BEFORE reserving quota', async () => {
    await expectError(
      await initMemberUpload(fixture.clientA.id, JPEG_BYTES, { portalProjectId: projectBId }),
      404,
      'not_found',
    );
    await expectError(
      await initMemberUpload(fixture.clientA.id, JPEG_BYTES, { portalProjectId: crypto.randomUUID() }),
      404,
      'not_found',
    );
    const [quota] = await fixture.db.select().from(clientQuota).where(eq(clientQuota.clientId, fixture.clientA.id));
    expect(quota!.reservedBytes).toBe(0);
    const sessions = await fixture.db.select().from(uploadSession);
    expect(sessions.filter((s) => s.status === 'pending')).toHaveLength(0);
  });

  it('complete rejects a foreign project BEFORE mutating anything; the session stays retryable', async () => {
    const bytes = new Uint8Array([...JPEG_BYTES, 0x03]);
    const init = await initMemberUpload(fixture.clientA.id, bytes);
    const session = await json<InitResult>(init);
    await expectError(
      await putAndComplete(session.uploadId, bytes, { portalProjectId: projectBId }),
      404,
      'not_found',
    );
    const [staged] = await fixture.db.select().from(uploadSession).where(eq(uploadSession.id, session.uploadId));
    expect(staged!.status).toBe('staged');
    expect(staged!.materialId).toBeNull();

    // Retry with a valid project converges WITHOUT re-PUT (v1: content was
    // already received): complete alone binds the corrected attribution.
    const retry = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/uploads/${session.uploadId}/complete`,
      body: { portalProjectId: projectAId },
      cookie: fixture.memberACookie,
    });
    expect(retry.status).toBe(201);
    const materialView = await json<MaterialView>(retry);
    expect(await attributionOf(materialView.id)).toBe(projectAId);
  });

  it('rejects portalProjectId on delivery_output uploads', async () => {
    const init = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/clients/${fixture.clientA.id}/uploads`,
      body: {
        kind: 'delivery_output',
        mediaType: 'image/png',
        declaredBytes: 10,
        sha256: 'a'.repeat(64),
        deliveryId: 'd-1',
        outputName: 'cover.png',
        portalProjectId: projectAId,
      },
      cookie: fixture.memberACookie,
    });
    await expectError(init, 400, 'bad_request');
  });

  it('keeps content dedupe immutable: a reused row never changes its project context', async () => {
    // Same bytes as the FIRST attributed upload → dedupe reuses that row.
    const init = await initMemberUpload(fixture.clientA.id, JPEG_BYTES, { portalProjectId: projectAId });
    const session = await json<InitResult>(init);
    const complete = await putAndComplete(session.uploadId, JPEG_BYTES, { portalProjectId: projectAId });
    expect(complete.status).toBe(201);
    const reused = await json<MaterialView>(complete);
    expect(await attributionOf(reused.id)).toBe(projectAId);

    const rows = await fixture.db
      .select({ id: material.id })
      .from(material)
      .where(eq(material.clientId, fixture.clientA.id));
    // 1 project-tagged + 2 free + 1 retry material from the earlier scenarios.
    expect(rows).toHaveLength(4);
  });
});
