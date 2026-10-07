import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:test';
import { expect } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  FIXTURE_ORIGIN,
  FIXTURE_SECRET,
  setupFixture,
  signInViaMagicLink,
  type Fixture,
} from './auth-fixture';
import { findUserByEmail, provisionUser, type PortalAuthHandler } from '../src/server/auth';
import { createDb, type PortalDb } from '../src/server/db';
import {
  agentGrant,
  auditEvent,
  clientAsset,
  clientGrid,
  clientQuota,
  deliveryOutput,
  deliveryRevision,
  idempotencyRecord,
  invitation,
  material,
  membership,
  portalClient,
  portalProject,
  portalWorkspace,
  post,
  postOutput,
  assetUploadLink,
  uploadRequest,
  uploadRequestToken,
  uploadSession,
} from '../src/server/db/schema';
import { apikey, user as userTable } from '../src/server/db/auth-schema';
import {
  createAgentGrant,
  createMembership,
  createWorkspace,
  issueAgentKey,
} from '../src/server/clients';
import { handlePortalApiV1, type RequestDeps } from '../src/server/api';
import { sha256Hex } from '../src/server/uploads';

/**
 * P-002 fixture on the emulated Workers runtime (real D1/R2 bindings):
 * two portal clients in one workspace, human members on each, an integrator
 * agent with a workspace-wide grant, and an API helper driving the SAME
 * dispatcher the /api/v1/$ route delegates to. Storage persists between
 * tests/files here, so every setup wipes portal state FK-safe first.
 */

export { FIXTURE_ORIGIN };

export interface AgentIdentity {
  userId: string;
  keyId: string;
  apiKey: string;
}

export interface PortalFixture extends Fixture {
  deps: RequestDeps;
  /** Workspace containing clientA and clientB (one multi-client project). */
  workspaceId: string;
  clientA: { id: string; studioClientId: string; name: string };
  clientB: { id: string; studioClientId: string; name: string };
  /** member@ is a member of clientA; other@ of clientB. */
  adminCookie: string;
  memberACookie: string;
  memberBCookie: string;
  integrator: AgentIdentity;
}

/** FK-safe wipe of every portal table (children before parents). */
async function wipePortalTables(db: PortalDb): Promise<void> {
  await db.delete(auditEvent);
  await db.delete(postOutput);
  await db.delete(post);
  await db.delete(clientGrid);
  await db.delete(clientAsset);
  await db.delete(deliveryOutput);
  await db.delete(deliveryRevision);
  await db.delete(material);
  await db.delete(uploadSession);
  await db.delete(idempotencyRecord);
  await db.delete(clientQuota);
  // R-1: project pointers are children of portal_client (and the attribution
  // parent of material rows, already deleted above).
  await db.delete(portalProject);
  // R-2: capability tokens reference their request (plain-text, FK-safe);
  // wipe both before the clients they point at. 0005: asset upload links
  // point at clients too (plain-text) — same drop order.
  await db.delete(uploadRequestToken);
  await db.delete(uploadRequest);
  await db.delete(assetUploadLink);
  await db.delete(agentGrant);
  await db.delete(invitation);
  await db.delete(membership);
  await db.delete(portalClient);
  await db.delete(portalWorkspace);
}

export interface ApiCallInit {
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH';
  path: string;
  body?: unknown;
  rawBody?: Uint8Array | ReadableStream<Uint8Array>;
  cookie?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  idempotencyKey?: string;
}

/** Drives the v1 dispatcher exactly like the deployed route does. */
export function apiCall(deps: RequestDeps, init: ApiCallInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('cookie', init.cookie);
  if (init.apiKey) headers.set('x-api-key', init.apiKey);
  if (init.idempotencyKey) headers.set('idempotency-key', init.idempotencyKey);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const request = new Request(`${FIXTURE_ORIGIN}${init.path}`, {
    method: init.method,
    headers,
    body: (init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body))) as BodyInit | undefined,
  });
  return handlePortalApiV1(request, deps);
}

export interface CreateAgentOptions {
  userId: string;
  workspaceId: string;
  /** null = workspace-wide (integrator); array = client-scoped grant. */
  clientIds: string[] | null;
  scopes: string[];
}

export async function createAgent(
  db: PortalDb,
  auth: Fixture['auth'],
  options: CreateAgentOptions,
): Promise<AgentIdentity> {
  const issued = await issueAgentKey(auth, {
    userId: options.userId,
    name: `fixture-agent-${crypto.randomUUID().slice(0, 8)}`,
  });
  await createAgentGrant(db, {
    keyId: issued.id,
    workspaceId: options.workspaceId,
    clientIds: options.clientIds,
    scopes: options.scopes,
  });
  return { userId: options.userId, keyId: issued.id, apiKey: issued.key };
}

/** Full portal fixture: users, workspace, two clients, memberships, agent. */
export async function setupPortalFixture(): Promise<PortalFixture> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const db = createDb(env.DB);
  await wipePortalTables(db);

  const base = await setupFixture();
  const integratorUser = await provisionUser(base.db, {
    email: 'integrator@portal.fixture',
    name: 'Studio Integrator',
    role: 'member',
  });

  const workspace = await createWorkspace(base.db, {
    label: 'Fixture Studio Workspace',
    integratorUserId: integratorUser!.id,
  });
  const clientA = await base.db
    .insert(portalClient)
    .values({
      id: crypto.randomUUID(),
      workspaceId: workspace.id,
      studioClientId: 'studio-client-alpha',
      name: 'Alpha Client',
      createdMs: Date.now(),
    })
    .returning();
  const clientB = await base.db
    .insert(portalClient)
    .values({
      id: crypto.randomUUID(),
      workspaceId: workspace.id,
      studioClientId: 'studio-client-beta',
      name: 'Beta Client',
      createdMs: Date.now(),
    })
    .returning();

  // P-001's FixtureUsers map collapses both member seeds into `member`;
  // resolve the humans by their provisioned emails instead.
  const adminRow = await findUserByEmail(base.db, 'admin@portal.fixture');
  const memberARow = await findUserByEmail(base.db, 'member@portal.fixture');
  const memberBRow = await findUserByEmail(base.db, 'other@portal.fixture');
  if (!adminRow || !memberARow || !memberBRow) throw new Error('fixture users missing');

  await createMembership(base.db, { userId: memberARow.id, portalClientId: clientA[0]!.id });
  await createMembership(base.db, { userId: memberBRow.id, portalClientId: clientB[0]!.id });

  const integrator = await createAgent(base.db, base.auth, {
    userId: integratorUser!.id,
    workspaceId: workspace.id,
    clientIds: null,
    scopes: ['clients:read', 'clients:write', 'materials:read', 'materials:write', 'deliveries:read', 'deliveries:write'],
  });

  const adminCookie = await loginAndGetCookie(base.handler, base.sink, adminRow.email);
  const memberACookie = await loginAndGetCookie(base.handler, base.sink, memberARow.email);
  const memberBCookie = await loginAndGetCookie(base.handler, base.sink, memberBRow.email);

  return {
    ...base,
    users: {
      admin: { id: adminRow.id, email: adminRow.email, role: adminRow.role },
      member: { id: memberARow.id, email: memberARow.email, role: memberARow.role },
      otherMember: { id: memberBRow.id, email: memberBRow.email, role: memberBRow.role },
    },
    deps: {
      env: { DB: env.DB, ASSETS: env.ASSETS },
      auth: base.auth,
      db: base.db,
      // Mint determinism: same values the fixture auth instance was built with.
      portalOrigin: FIXTURE_ORIGIN,
      portalSecret: FIXTURE_SECRET,
    },
    workspaceId: workspace.id,
    clientA: { id: clientA[0]!.id, studioClientId: clientA[0]!.studioClientId, name: clientA[0]!.name },
    clientB: { id: clientB[0]!.id, studioClientId: clientB[0]!.studioClientId, name: clientB[0]!.name },
    adminCookie,
    memberACookie,
    memberBCookie,
    integrator,
  };
}

async function loginAndGetCookie(handler: PortalAuthHandler, sink: Fixture['sink'], email: string): Promise<string> {
  return signInViaMagicLink(handler, sink, email);
}

/* media fixtures ------------------------------------------------------------ */

function bytesOf(...parts: number[][]): Uint8Array {
  return new Uint8Array(parts.flat());
}

export const JPEG_BYTES = bytesOf(
  [0xff, 0xd8, 0xff, 0xe0],
  [...'jpeg-portal-fixture'].map((c) => c.charCodeAt(0)),
);
export const PNG_BYTES = bytesOf(
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  [...'png-portal-fixture'].map((c) => c.charCodeAt(0)),
);
export const MP4_BYTES = bytesOf(
  [0x00, 0x00, 0x00, 0x18],
  [...'ftyp'].map((c) => c.charCodeAt(0)),
  [...'isom'].map((c) => c.charCodeAt(0)),
  [...'mp4-portal-fixture'].map((c) => c.charCodeAt(0)),
);

export { sha256Hex };

/** A lazily chunked stream (proves bodies are never buffered whole). */
export function chunkedStream(bytes: Uint8Array, chunkSize = 1024): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

/* composed portal operations -------------------------------------------------- */

export interface MaterialUploadOptions {
  principal: { cookie?: string; apiKey?: string };
  clientId: string;
  bytes?: Uint8Array;
  mediaType?: 'image/jpeg' | 'image/png' | 'video/mp4' | 'image/webp';
  name?: string;
  idempotencyKey?: string;
}

/** init → PUT → complete; returns the API material view. */
export async function uploadMaterial(
  deps: RequestDeps,
  options: MaterialUploadOptions,
): Promise<Response> {
  const bytes = options.bytes ?? JPEG_BYTES;
  const mediaType = options.mediaType ?? 'image/jpeg';
  const initRes = await apiCall(deps, {
    method: 'POST',
    path: `/api/v1/clients/${options.clientId}/uploads`,
    body: {
      kind: 'material',
      mediaType,
      declaredBytes: bytes.byteLength,
      name: options.name ?? 'photo.jpg',
    },
    idempotencyKey: options.idempotencyKey,
    cookie: options.principal.cookie,
    apiKey: options.principal.apiKey,
  });
  expect(initRes.status).toBe(201);
  const session = await json<{ uploadId: string }>(initRes);
  const putRes = await apiCall(deps, {
    method: 'PUT',
    path: `/api/v1/uploads/${session.uploadId}/content`,
    rawBody: bytes,
    cookie: options.principal.cookie,
    apiKey: options.principal.apiKey,
  });
  expect(putRes.status).toBe(200);
  return apiCall(deps, {
    method: 'POST',
    path: `/api/v1/uploads/${session.uploadId}/complete`,
    cookie: options.principal.cookie,
    apiKey: options.principal.apiKey,
  });
}

export interface StagedDelivery {
  deliveryId: string;
  assetId: string;
  outputs: { name: string; bytes: Uint8Array; mediaType: 'image/png' | 'video/mp4'; sha256: string }[];
}

/** Creates an internal delivery for a client and stages ALL its outputs. */
export async function stageDelivery(
  deps: RequestDeps,
  options: {
    principal: { cookie?: string; apiKey?: string };
    clientId: string;
    revisionId?: string;
    outputs?: StagedDelivery['outputs'];
    projectId?: string;
    assetId?: string;
  },
): Promise<StagedDelivery> {
  const outputs = options.outputs ?? [
    { name: 'cover.png', bytes: PNG_BYTES, mediaType: 'image/png' as const, sha256: sha256Hex(PNG_BYTES) },
    { name: 'clip.mp4', bytes: MP4_BYTES, mediaType: 'video/mp4' as const, sha256: sha256Hex(MP4_BYTES) },
  ];
  const createRes = await apiCall(deps, {
    method: 'POST',
    path: `/api/v1/clients/${options.clientId}/deliveries`,
    body: {
      projectId: options.projectId ?? 'proj-multi-1',
      assetId: options.assetId ?? 'asset-open-1',
      revisionId: options.revisionId ?? `rev-${crypto.randomUUID().slice(0, 8)}`,
      rootHash: sha256Hex(new TextEncoder().encode('sealed-manifest-root')),
      title: 'Delivered revision',
      kind: 'social',
      outputs: outputs.map((o) => ({ name: o.name, mediaType: o.mediaType, bytes: o.bytes.byteLength, sha256: o.sha256 })),
    },
    cookie: options.principal.cookie,
    apiKey: options.principal.apiKey,
  });
  expect(createRes.status).toBe(201);
  const delivery = await json<{ id: string }>(createRes);
  for (const output of outputs) {
    const initRes = await apiCall(deps, {
      method: 'POST',
      path: `/api/v1/clients/${options.clientId}/uploads`,
      body: {
        kind: 'delivery_output',
        mediaType: output.mediaType,
        declaredBytes: output.bytes.byteLength,
        sha256: output.sha256,
        deliveryId: delivery.id,
        outputName: output.name,
      },
      cookie: options.principal.cookie,
      apiKey: options.principal.apiKey,
    });
    expect(initRes.status).toBe(201);
    const session = await json<{ uploadId: string }>(initRes);
    const putRes = await apiCall(deps, {
      method: 'PUT',
      path: `/api/v1/uploads/${session.uploadId}/content`,
      rawBody: output.bytes,
      cookie: options.principal.cookie,
      apiKey: options.principal.apiKey,
    });
    expect(putRes.status).toBe(200);
    const completeRes = await apiCall(deps, {
      method: 'POST',
      path: `/api/v1/uploads/${session.uploadId}/complete`,
      cookie: options.principal.cookie,
      apiKey: options.principal.apiKey,
    });
    expect(completeRes.status).toBe(201);
  }
  const completeDeliveryRes = await apiCall(deps, {
    method: 'POST',
    path: `/api/v1/deliveries/${delivery.id}/complete`,
    cookie: options.principal.cookie,
    apiKey: options.principal.apiKey,
  });
  expect(completeDeliveryRes.status).toBe(200);
  const assetsRes = await apiCall(deps, {
    method: 'GET',
    path: `/api/v1/clients/${options.clientId}/assets`,
    cookie: options.principal.cookie,
    apiKey: options.principal.apiKey,
  });
  expect(assetsRes.status).toBe(200);
  const assets = await json<{ items: { id: string; deliveryId: string }[] }>(assetsRes);
  const asset = assets.items.find((a) => a.deliveryId === delivery.id);
  if (!asset) throw new Error('client asset for staged delivery not found');
  return { deliveryId: delivery.id, assetId: asset.id, outputs };
}

/** Sets a low, explicit quota for over-quota tests (fixture-only override). */
export async function setClientQuotaLimit(db: PortalDb, clientId: string, limitBytes: number): Promise<void> {
  await db
    .insert(clientQuota)
    .values({ clientId, usedBytes: 0, reservedBytes: 0, limitBytes, updatedMs: 0 })
    .onConflictDoUpdate({ target: clientQuota.clientId, set: { limitBytes } });
}

/** Zeroes a client's quota ledger between scenarios (fixture-only override). */
export async function resetClientQuota(db: PortalDb, clientId: string, limitBytes?: number): Promise<void> {
  await db
    .insert(clientQuota)
    .values({ clientId, usedBytes: 0, reservedBytes: 0, limitBytes: limitBytes ?? 1_073_741_824, updatedMs: 0 })
    .onConflictDoUpdate({
      target: clientQuota.clientId,
      set: { usedBytes: 0, reservedBytes: 0, ...(limitBytes === undefined ? {} : { limitBytes }) },
    });
}

/** Disables an agent key in Better Auth's table (revocation path). */
export async function disableAgentKey(db: PortalDb, keyId: string): Promise<void> {
  await db.update(apikey).set({ enabled: false }).where(eq(apikey.id, keyId));
}

export async function countRows(db: PortalDb, table: typeof portalWorkspace | typeof userTable): Promise<number> {
  const rows = await db.select().from(table);
  return rows.length;
}

/* shared assertions ---------------------------------------------------------- */

import type {
  ApiError,
  ErrorCode,
  GuestAssetCompleteResult,
  GuestCompleteResult,
  GuestPutUploadResult,
  GuestUploadSessionView,
} from '@videomaker/customer-assets';

/** Asserts the typed error envelope shape (code + requestId, no success flag). */
export async function expectError(
  response: Response,
  status: number,
  code: ErrorCode,
): Promise<ApiError> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as ApiError;
  expect(body.error.code).toBe(code);
  expect(body.error.requestId).toBeTruthy();
  expect(body.error.message.length).toBeGreaterThan(0);
  return body;
}

export async function json<T>(response: Response): Promise<T> {
  expect(response.status).toBeLessThan(500);
  return (await response.json()) as T;
}

/** Client-facing responses must never expose storage keys or staging paths. */
export async function expectNoInternalPaths(response: Response): Promise<void> {
  const text = await response.clone().text();
  expect(text).not.toContain('staging/');
  expect(text).not.toContain('"objectKey"');
  expect(text).not.toContain('"stagingKey"');
  expect(text).not.toContain('materials/');
  expect(text).not.toContain('deliveries/');
}

/* R-2 guest-direct helpers ---------------------------------------------------- */

/** Extracts the raw capability token from a minted link URL (test-only). */
export function tokenFromLinkUrl(url: string): string {
  const marker = '/request/';
  const index = url.indexOf(marker);
  if (index === -1) throw new Error('minted url has no /request/ path');
  return url.slice(index + marker.length);
}

export interface GuestTokenUploadOptions {
  token: string;
  bytes?: Uint8Array;
  mediaType?: 'image/jpeg' | 'image/png' | 'video/mp4' | 'image/webp';
  name?: string;
  idempotencyKey?: string;
  /** Overrides the init body's declaredBytes (mismatch tests). */
  declaredBytesOverride?: number;
}

export interface GuestTokenUploadResult {
  initStatus: number;
  putStatus: number;
  completeStatus: number;
  /** Parsed init view when init succeeded, else the error envelope. */
  init: GuestUploadSessionView | ApiError | null;
  put: GuestPutUploadResult | ApiError | null;
  complete: GuestCompleteResult | ApiError | null;
}

function isEnvelope(value: GuestUploadSessionView | GuestPutUploadResult | GuestCompleteResult | ApiError | null): value is ApiError {
  return value !== null && typeof value === 'object' && 'error' in value;
}

/** Test-side narrowing for a successful guest init payload. */
export function isSessionView(value: GuestUploadSessionView | ApiError | null): value is GuestUploadSessionView {
  return value !== null && 'uploadId' in value;
}

/** Full guest flow init → PUT → complete against /api/v1/r/:token. */
export async function uploadViaToken(
  deps: RequestDeps,
  options: GuestTokenUploadOptions,
): Promise<GuestTokenUploadResult> {
  const bytes = options.bytes ?? JPEG_BYTES;
  const mediaType = options.mediaType ?? 'image/jpeg';
  const initRes = await apiCall(deps, {
    method: 'POST',
    path: `/api/v1/r/${options.token}/uploads`,
    body: {
      mediaType,
      declaredBytes: options.declaredBytesOverride ?? bytes.byteLength,
      ...(options.name === undefined ? {} : { name: options.name }),
    },
    idempotencyKey: options.idempotencyKey,
  });
  const init = initRes.status < 500 ? await json<GuestUploadSessionView | ApiError>(initRes) : null;
  if (init === null || isEnvelope(init)) {
    return { initStatus: initRes.status, putStatus: 0, completeStatus: 0, init, put: null, complete: null };
  }
  const putRes = await apiCall(deps, {
    method: 'PUT',
    path: `/api/v1/r/${options.token}/uploads/${init.uploadId}/content`,
    rawBody: bytes,
  });
  const put = putRes.status < 500 ? await json<GuestPutUploadResult | ApiError>(putRes) : null;
  if (put === null || isEnvelope(put)) {
    return { initStatus: initRes.status, putStatus: putRes.status, completeStatus: 0, init, put, complete: null };
  }
  const completeRes = await apiCall(deps, {
    method: 'POST',
    path: `/api/v1/r/${options.token}/uploads/${init.uploadId}/complete`,
  });
  const complete = completeRes.status < 500 ? await json<GuestCompleteResult | ApiError>(completeRes) : null;
  return {
    initStatus: initRes.status,
    putStatus: putRes.status,
    completeStatus: completeRes.status,
    init,
    put,
    complete,
  };
}

/* asset upload link helpers (operator order 2026-10-06) ----------------------- */

/** Extracts the raw capability token from a minted ASSET link URL (test-only). */
export function tokenFromAssetLinkUrl(url: string): string {
  const marker = '/asset-upload/';
  const index = url.indexOf(marker);
  if (index === -1) throw new Error('minted url has no /asset-upload/ path');
  return url.slice(index + marker.length);
}

export interface GuestAssetUploadOptions {
  token: string;
  bytes?: Uint8Array;
  mediaType?: 'image/jpeg' | 'image/png' | 'video/mp4' | 'image/webp';
  name?: string;
  idempotencyKey?: string;
  /** Overrides the init body's declaredBytes (mismatch tests). */
  declaredBytesOverride?: number;
}

export interface GuestAssetUploadResult {
  initStatus: number;
  putStatus: number;
  completeStatus: number;
  init: GuestUploadSessionView | ApiError | null;
  put: GuestPutUploadResult | ApiError | null;
  complete: GuestAssetCompleteResult | ApiError | null;
}

/** Full guest flow init → PUT → complete against /api/v1/a/:token. */
export async function uploadViaAssetToken(
  deps: RequestDeps,
  options: GuestAssetUploadOptions,
): Promise<GuestAssetUploadResult> {
  const bytes = options.bytes ?? JPEG_BYTES;
  const mediaType = options.mediaType ?? 'image/jpeg';
  const initRes = await apiCall(deps, {
    method: 'POST',
    path: `/api/v1/a/${options.token}/uploads`,
    body: {
      mediaType,
      declaredBytes: options.declaredBytesOverride ?? bytes.byteLength,
      ...(options.name === undefined ? {} : { name: options.name }),
    },
    idempotencyKey: options.idempotencyKey,
  });
  const init = initRes.status < 500 ? await json<GuestUploadSessionView | ApiError>(initRes) : null;
  if (init === null || isEnvelope(init)) {
    return { initStatus: initRes.status, putStatus: 0, completeStatus: 0, init, put: null, complete: null };
  }
  const putRes = await apiCall(deps, {
    method: 'PUT',
    path: `/api/v1/a/${options.token}/uploads/${init.uploadId}/content`,
    rawBody: bytes,
  });
  const put = putRes.status < 500 ? await json<GuestPutUploadResult | ApiError>(putRes) : null;
  if (put === null || isEnvelope(put)) {
    return { initStatus: initRes.status, putStatus: putRes.status, completeStatus: 0, init, put, complete: null };
  }
  const completeRes = await apiCall(deps, {
    method: 'POST',
    path: `/api/v1/a/${options.token}/uploads/${init.uploadId}/complete`,
  });
  const complete = completeRes.status < 500 ? await json<GuestAssetCompleteResult | ApiError>(completeRes) : null;
  return {
    initStatus: initRes.status,
    putStatus: putRes.status,
    completeStatus: completeRes.status,
    init,
    put,
    complete,
  };
}
