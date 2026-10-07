import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type {
  CreateUploadRequestRequest,
  GuestInitUploadRequest,
  GuestPutUploadResult,
  GuestRequestView,
  GuestUploadSessionView,
  MaterialView,
  Page,
  UploadRequestState,
  UploadRequestView,
  V1MediaType,
} from '@videomaker/customer-assets';
import type { PortalDb } from './db';
import {
  clientQuota,
  material,
  portalProject,
  uploadRequest,
  uploadRequestToken,
  uploadSession,
} from './db/schema';
import {
  PortalError,
  authorizeClient,
  badRequest,
  conflict,
  forbidden,
  notFound,
  parseExpiresIn,
  principalId,
  rawRun,
  recordAudit,
  sanitizeDisplayName,
  type Principal,
  type RequestDeps,
} from './access';
import {
  UPLOAD_SESSION_TTL_MS,
  V1_TYPE_LIMIT_BYTES,
  commitQuotaStatement,
  ensureQuotaRow,
  finalizeUpload,
  materialView,
  releaseQuota,
  releaseQuotaStatement,
  sha256Hex,
  stageUpload,
} from './uploads';
import { storageKeys } from './storage';

/**
 * Upload requests (P-102, R-2; contracts.md §2/§3/§4/§5 additive ·
 * customer-assets-requests):
 *
 * - An UploadRequest is a pedido de material per PortalProject with
 *   creator-fixed limits and a lazy state machine open → fulfilled | closed |
 *   expired. Expiry is materialized on FIRST touch (guarded single UPDATE +
 *   one `request.expired` audit) — no cron, no queues.
 * - The guest-direct capability token grants EXACTLY one operation family:
 *   view + upload to its own request. It is NOT a session, never touches auth
 *   tables, never sets a cookie, and never reaches any other route: only the
 *   SHA-256 hash is stored (UNIQUE), the raw token exists only inside the
 *   minted URL, shown once to the admin and delivered out-of-band (0 emails).
 *   Re-mint revokes the previous token (one ACTIVE token per request).
 * - Budget: the request competes for the SAME client_quota CAS as free v1
 *   uploads. Init reserves BOTH budgets in ONE atomic D1 batch (quota CAS +
 *   request CAS); if either arm loses, ONLY the arm(s) that applied are
 *   released (compensatory release, v1 pattern) and the caller gets 429.
 * - The upload pipeline is the v1 pipeline (stageUpload/finalizeUpload/
 *   storage keys): the guest context only adds validation and attribution —
 *   zero storage or header bifurcation.
 */

export type UploadRequestRow = typeof uploadRequest.$inferSelect;
export type UploadRequestTokenRow = typeof uploadRequestToken.$inferSelect;

/** Hard cap for maxFiles (defaults: 10 files / 2 GiB, decisions.json). */
export const REQUEST_MAX_FILES_CAP = 500;
export const REQUEST_DEFAULT_MAX_FILES = 10;
export const REQUEST_DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export function toRequestView(row: UploadRequestRow): UploadRequestView {
  return {
    id: row.id,
    portalProjectId: row.portalProjectId,
    portalClientId: row.portalClientId,
    title: row.title,
    instructions: row.instructions,
    maxFiles: row.maxFiles,
    maxBytes: row.maxBytes,
    usedFiles: row.usedFiles,
    usedBytes: row.usedBytes,
    remainingFiles: Math.max(0, row.maxFiles - row.usedFiles),
    remainingBytes: Math.max(0, row.maxBytes - row.usedBytes),
    state: row.state as UploadRequestState,
    expiresAt: row.expiresMs,
    createdAt: row.createdMs,
    closedAt: row.closedMs,
    closeReason: row.closeReason,
  };
}

/** Minimal guest view: display fields + budget ONLY, no ids of other resources. */
export function toGuestRequestView(row: UploadRequestRow): GuestRequestView {
  return {
    title: row.title,
    instructions: row.instructions,
    state: row.state as UploadRequestState,
    expiresAt: row.expiresMs,
    maxFiles: row.maxFiles,
    maxBytes: row.maxBytes,
    remainingFiles: Math.max(0, row.maxFiles - row.usedFiles),
    remainingBytes: Math.max(0, row.maxBytes - row.usedBytes),
  };
}

/* creation / listing / close ------------------------------------------------ */

function requireMaxFiles(value: unknown): number {
  if (value === undefined) return REQUEST_DEFAULT_MAX_FILES;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > REQUEST_MAX_FILES_CAP) {
    throw badRequest(`maxFiles must be an integer between 1 and ${REQUEST_MAX_FILES_CAP}.`);
  }
  return value;
}

function requireMaxBytes(value: unknown, quotaLimitBytes: number): number {
  if (value === undefined) return Math.min(REQUEST_DEFAULT_MAX_BYTES, quotaLimitBytes);
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw badRequest('maxBytes must be a positive integer.');
  }
  // A request never promises more than the client quota (decisions.json):
  // reservations still compete through the same CAS at init time.
  if (value > quotaLimitBytes) {
    throw badRequest('maxBytes exceeds the client storage quota limit.');
  }
  return value;
}

export interface CreatedRequest {
  request: UploadRequestView;
  workspaceId: string;
  replayed: boolean;
}

/**
 * POST /api/v1/projects/:projectId/requests — admin human OR agent with the
 * server-side `requests:write` scope (members NEVER: 403 on their own client,
 * 404 elsewhere — the v1 enumeration rule). Limits are validated against the
 * client quota at creation; expiry reuses the access-link grammar (30m..30d,
 * default 7d).
 */
export async function createUploadRequest(
  db: PortalDb,
  principal: Principal,
  projectId: string,
  input: CreateUploadRequestRequest,
): Promise<CreatedRequest> {
  const [project] = await db.select().from(portalProject).where(eq(portalProject.id, projectId)).limit(1);
  if (!project) throw notFound();
  await authorizeClient(db, principal, project.portalClientId, 'requests:write');
  if (principal.kind === 'member') {
    throw forbidden('Members cannot create upload requests.');
  }

  const title = sanitizeDisplayName(input.title);
  if (title === undefined) throw badRequest('title is required.');
  const instructions =
    input.instructions === undefined || input.instructions === null
      ? null
      : (sanitizeDisplayName(input.instructions, 2000) ?? null);
  if (input.instructions !== undefined && input.instructions !== null && instructions === null) {
    throw badRequest('instructions has an invalid format.');
  }
  const expiresInSeconds = parseExpiresIn(input.expiresIn);

  await ensureQuotaRow(db, project.portalClientId);
  const [quota] = await db
    .select({ limitBytes: clientQuota.limitBytes })
    .from(clientQuota)
    .where(eq(clientQuota.clientId, project.portalClientId))
    .limit(1);
  const quotaLimit = quota?.limitBytes ?? 0;
  const maxFiles = requireMaxFiles(input.maxFiles);
  const maxBytes = requireMaxBytes(input.maxBytes, quotaLimit);

  const [row] = await db
    .insert(uploadRequest)
    .values({
      id: crypto.randomUUID(),
      workspaceId: project.workspaceId,
      portalClientId: project.portalClientId,
      portalProjectId: project.id,
      title,
      instructions,
      maxFiles,
      maxBytes,
      usedFiles: 0,
      usedBytes: 0,
      state: 'open',
      expiresMs: Date.now() + expiresInSeconds * 1000,
      createdBy: principalId(principal),
      createdMs: Date.now(),
    })
    .returning();
  return { request: toRequestView(row!), workspaceId: project.workspaceId, replayed: false };
}

/** Resolves a request row or 404 (unknown ids reveal nothing). */
async function loadRequest(db: PortalDb, requestId: string): Promise<UploadRequestRow> {
  const [row] = await db.select().from(uploadRequest).where(eq(uploadRequest.id, requestId)).limit(1);
  if (!row) throw notFound();
  return row;
}

/**
 * Lazy expiry materialization (contracts.md §4): the FIRST touch past
 * `expires_ms` flips state `open` → `expired` through a guarded CAS UPDATE,
 * so concurrent touches converge and `request.expired` is audited EXACTLY
 * once. Any other state passes through unchanged.
 */
export async function expireIfPast(
  db: PortalDb,
  row: UploadRequestRow,
  actor: Principal,
  correlationId: string,
): Promise<UploadRequestRow> {
  const now = Date.now();
  if (row.state !== 'open' || row.expiresMs > now) return row;
  const result = await rawRun(
    db,
    sql`UPDATE upload_request SET state = 'expired', closed_ms = ${now}, close_reason = 'expired'
        WHERE id = ${row.id} AND state = 'open' AND expires_ms <= ${now}`,
  );
  if (result.meta.changes === 1) {
    await recordAudit(db, {
      principal: actor,
      workspaceId: row.workspaceId,
      clientId: row.portalClientId,
      action: 'request.expired',
      resourceType: 'upload_request',
      resourceId: row.id,
      requestId: correlationId,
    });
  }
  const [updated] = await db.select().from(uploadRequest).where(eq(uploadRequest.id, row.id)).limit(1);
  return updated ?? row;
}

/**
 * GET /api/v1/projects/:projectId/requests — admin humans, members of the
 * client and agents holding `requests:read`. Every open row past its expiry
 * is lazily materialized during the listing (audit once, guarded).
 */
export async function listRequestsForProject(
  db: PortalDb,
  principal: Principal,
  projectId: string,
  correlationId: string,
): Promise<Page<UploadRequestView>> {
  const [project] = await db.select().from(portalProject).where(eq(portalProject.id, projectId)).limit(1);
  if (!project) throw notFound();
  await authorizeClient(db, principal, project.portalClientId, 'requests:read');

  const rows = await db
    .select()
    .from(uploadRequest)
    .where(eq(uploadRequest.portalProjectId, projectId))
    .orderBy(desc(uploadRequest.createdMs))
    .limit(100);
  const settled: UploadRequestRow[] = [];
  for (const row of rows) {
    settled.push(await expireIfPast(db, row, principal, correlationId));
  }
  return { items: settled.map(toRequestView), nextCursor: null };
}

/** GET /api/v1/requests/:id — same visibility rules as the project listing. */
export async function getRequestForPrincipal(
  db: PortalDb,
  principal: Principal,
  requestId: string,
  correlationId: string,
): Promise<{ request: UploadRequestView; workspaceId: string }> {
  const row = await loadRequest(db, requestId);
  await authorizeClient(db, principal, row.portalClientId, 'requests:read');
  const settled = await expireIfPast(db, row, principal, correlationId);
  return { request: toRequestView(settled), workspaceId: row.workspaceId };
}

/**
 * POST /api/v1/requests/:id/close — admin human or `requests:write`. Closing
 * from `open`/`fulfilled` freezes the budget; an already `closed` or
 * `expired` request is a 409. Nothing is ever deleted.
 */
export async function closeUploadRequest(
  db: PortalDb,
  principal: Principal,
  requestId: string,
  reason?: string,
): Promise<{ request: UploadRequestView; workspaceId: string }> {
  const row = await loadRequest(db, requestId);
  await authorizeClient(db, principal, row.portalClientId, 'requests:write');
  if (principal.kind === 'member') {
    throw forbidden('Members cannot close upload requests.');
  }
  const cleaned = reason === undefined || reason === null ? null : (sanitizeDisplayName(reason, 200) ?? null);
  const now = Date.now();
  const result = await rawRun(
    db,
    sql`UPDATE upload_request SET state = 'closed', closed_ms = ${now}, close_reason = ${cleaned ?? 'closed_by_admin'}
        WHERE id = ${requestId} AND state IN ('open', 'fulfilled')`,
  );
  if (result.meta.changes !== 1) {
    const settled = await expireIfPast(db, row, principal, requestId);
    throw conflict(
      settled.state === 'expired'
        ? 'This request already expired and cannot be closed.'
        : 'This request is already closed.',
    );
  }
  const [updated] = await db.select().from(uploadRequest).where(eq(uploadRequest.id, requestId)).limit(1);
  return { request: toRequestView(updated!), workspaceId: row.workspaceId };
}

/* request materials (metadata) ---------------------------------------------- */

/**
 * GET /api/v1/requests/:id/materials — metadata only; bytes still flow
 * exclusively through the v1 content route (materials:read there).
 */
export async function listRequestMaterials(
  db: PortalDb,
  principal: Principal,
  requestId: string,
): Promise<Page<MaterialView>> {
  const row = await loadRequest(db, requestId);
  await authorizeClient(db, principal, row.portalClientId, 'requests:read');
  const rows = await db
    .select()
    .from(material)
    .where(eq(material.uploadRequestId, requestId))
    .orderBy(desc(material.createdMs))
    .limit(100);
  return { items: rows.map((m) => materialView(m)), nextCursor: null };
}

/* capability token ----------------------------------------------------------- */

const REQUEST_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** 256 bits of CSPRNG as base64url (43 chars): the raw capability. */
function generateRequestToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hashRequestToken(rawToken: string): string {
  return sha256Hex(new TextEncoder().encode(rawToken));
}

export interface MintedRequestLink {
  url: string;
  requestId: string;
  tokenId: string;
  expiresAt: number;
  limits: { maxFiles: number; maxBytes: number };
}

/**
 * POST /api/v1/requests/:id/link — mints (and ROTATES) the guest link:
 * the previous ACTIVE token is revoked (`request_token.revoked` audit), so
 * exactly one live capability exists per request (operator default). The raw
 * token exists ONLY in the returned URL — never stored, logged or audited.
 * Deliberately NOT idempotency-keyed, exactly like access-link minting
 * (replay storage would persist a minted URL).
 */
export async function mintRequestLink(
  deps: RequestDeps,
  principal: Principal,
  requestId: string,
  input: { expiresInSeconds: number; origin: string },
  correlationId: string,
): Promise<MintedRequestLink> {
  const db = deps.db;
  const row = await loadRequest(db, requestId);
  await authorizeClient(db, principal, row.portalClientId, 'requests:write');
  if (principal.kind === 'member') {
    throw forbidden('Members cannot mint request links.');
  }
  // Defense in depth: the API layer clamps origin to the approved one.
  if (deps.portalOrigin !== undefined && input.origin !== deps.portalOrigin) {
    throw badRequest('origin does not match the portal approved origin.');
  }
  const settled = await expireIfPast(db, row, principal, correlationId);
  if (settled.state !== 'open') {
    throw conflict('Request links are minted only for open requests.');
  }

  const now = Date.now();
  const expiresMs = now + input.expiresInSeconds * 1000;
  const prior = await db
    .select({ id: uploadRequestToken.id })
    .from(uploadRequestToken)
    .where(and(eq(uploadRequestToken.requestId, requestId), isNull(uploadRequestToken.revokedMs)));
  await rawRun(
    db,
    sql`UPDATE upload_request_token SET revoked_ms = ${now}
        WHERE request_id = ${requestId} AND revoked_ms IS NULL`,
  );
  const rawToken = generateRequestToken();
  const [tokenRow] = await db
    .insert(uploadRequestToken)
    .values({
      id: crypto.randomUUID(),
      requestId,
      tokenHash: hashRequestToken(rawToken),
      expiresMs,
      createdBy: principalId(principal),
      createdMs: now,
    })
    .returning();
  for (const old of prior) {
    await recordAudit(db, {
      principal,
      workspaceId: row.workspaceId,
      clientId: row.portalClientId,
      action: 'request_token.revoked',
      resourceType: 'upload_request_token',
      resourceId: old.id,
      requestId: correlationId,
    });
  }
  await recordAudit(db, {
    principal,
    workspaceId: row.workspaceId,
    clientId: row.portalClientId,
    action: 'request_token.minted',
    resourceType: 'upload_request_token',
    resourceId: tokenRow!.id,
    requestId: correlationId,
  });

  return {
    url: `${input.origin}/request/${rawToken}`,
    requestId,
    tokenId: tokenRow!.id,
    expiresAt: expiresMs,
    limits: { maxFiles: row.maxFiles, maxBytes: row.maxBytes },
  };
}

/* guest principal + resolution ----------------------------------------------- */

export interface GuestAccess {
  request: UploadRequestRow;
  token: UploadRequestTokenRow;
  tokenHash: string;
  /**
   * upload_session binding and audit actor: `user:guest:<tokenHash>`. Derived
   * ONLY from the stored hash — the raw token never appears server-side
   * beyond this function's argument.
   */
  principalToken: string;
  /** Synthesized principal for idempotency/audit reuse (NEVER a session). */
  principal: Principal;
}

function guestPrincipal(tokenHash: string): Principal {
  return { kind: 'member', userId: `guest:${tokenHash}`, role: 'member', grant: null };
}

/**
 * Resolves the guest principal from the raw capability token on EVERY guest
 * HTTP request (contracts.md §3): hash → token row (revocation/expiry
 * effective immediately) → request row (lazy expiry). No session, no cookie,
 * no auth table is touched; a wrong/revoked/expired token is the same 404.
 */
export async function resolveGuestAccess(
  db: PortalDb,
  rawToken: string,
  correlationId: string,
): Promise<GuestAccess> {
  if (typeof rawToken !== 'string' || !REQUEST_TOKEN_PATTERN.test(rawToken)) {
    throw notFound('Este enlace no es válido o ha vencido.');
  }
  const tokenHash = hashRequestToken(rawToken);
  const [token] = await db
    .select()
    .from(uploadRequestToken)
    .where(eq(uploadRequestToken.tokenHash, tokenHash))
    .limit(1);
  if (!token || token.revokedMs !== null || token.expiresMs <= Date.now()) {
    throw notFound('Este enlace no es válido o ha vencido.');
  }
  const row = await loadRequest(db, token.requestId);
  const request = await expireIfPast(db, row, guestPrincipal(tokenHash), correlationId);
  return {
    request,
    token,
    tokenHash,
    principalToken: principalId(guestPrincipal(tokenHash)),
    principal: guestPrincipal(tokenHash),
  };
}

function assertOpenForUpload(row: UploadRequestRow): void {
  if (row.state === 'open') return;
  if (row.state === 'fulfilled') throw conflict('This request is fulfilled and cannot accept more files.');
  if (row.state === 'expired') throw conflict('This request expired and no longer accepts uploads.');
  throw conflict('This request is closed and no longer accepts uploads.');
}

/* guest upload flow (same v1 pipeline, guest validations) -------------------- */

async function loadGuestSession(db: PortalDb, guest: GuestAccess, uploadId: string) {
  const [row] = await db.select().from(uploadSession).where(eq(uploadSession.id, uploadId)).limit(1);
  // Sessions are bound to the guest principal that created them: another
  // token — even for the SAME request — gets 404 (v1 binding rule).
  if (!row || row.principalId !== guest.principalToken) throw notFound();
  return row;
}

/** Compensatory release of the request arm (guarded; never goes negative). */
function releaseRequestStatement(db: PortalDb, requestId: string, bytes: number) {
  return db
    .update(uploadRequest)
    .set({
      usedBytes: sql`MAX(0, ${uploadRequest.usedBytes} - ${bytes})`,
      usedFiles: sql`MAX(0, ${uploadRequest.usedFiles} - 1)`,
    })
    .where(eq(uploadRequest.id, requestId));
}

/**
 * POST /api/v1/r/:token/uploads — guest init with the DUAL reservation in ONE
 * atomic D1 batch: (a) the existing client_quota CAS and (b) the request CAS
 * (state open, not expired, budget admits the file). A lost arm releases ONLY
 * the arm(s) that applied and answers 429; per-type oversize is 413.
 */
export async function guestInitUpload(
  db: PortalDb,
  guest: GuestAccess,
  input: GuestInitUploadRequest,
): Promise<GuestUploadSessionView> {
  const request = guest.request;
  assertOpenForUpload(request);
  if (!Number.isInteger(input.declaredBytes) || input.declaredBytes <= 0) {
    throw badRequest('declaredBytes must be a positive integer.');
  }
  const typeLimit = V1_TYPE_LIMIT_BYTES[input.mediaType];
  if (input.declaredBytes > typeLimit) {
    throw new PortalError(
      413,
      'payload_too_large',
      `declaredBytes exceeds the ${input.mediaType} limit of ${typeLimit} bytes.`,
    );
  }
  if (request.maxFiles - request.usedFiles < 1 || request.maxBytes - request.usedBytes < input.declaredBytes) {
    throw new PortalError(429, 'rate_limited', 'This request has no remaining budget for that file.');
  }

  await ensureQuotaRow(db, request.portalClientId);
  const now = Date.now();
  const results = await db.batch([
    db
      .update(clientQuota)
      .set({
        reservedBytes: sql`${clientQuota.reservedBytes} + ${input.declaredBytes}`,
        updatedMs: now,
      })
      .where(
        and(
          eq(clientQuota.clientId, request.portalClientId),
          sql`${clientQuota.reservedBytes} + ${input.declaredBytes} <= ${clientQuota.limitBytes}`,
        ),
      ),
    db
      .update(uploadRequest)
      .set({
        usedBytes: sql`${uploadRequest.usedBytes} + ${input.declaredBytes}`,
        usedFiles: sql`${uploadRequest.usedFiles} + 1`,
      })
      .where(
        and(
          eq(uploadRequest.id, request.id),
          eq(uploadRequest.state, 'open'),
          gt(uploadRequest.expiresMs, now),
          sql`${uploadRequest.usedBytes} + ${input.declaredBytes} <= ${uploadRequest.maxBytes}`,
          sql`${uploadRequest.usedFiles} + 1 <= ${uploadRequest.maxFiles}`,
        ),
      ),
  ]);
  const quotaReserved = results[0]!.meta.changes === 1;
  const requestReserved = results[1]!.meta.changes === 1;
  if (!quotaReserved || !requestReserved) {
    // Compensatory release: exactly the arms that applied (v1 MAX(0,…) guard).
    if (quotaReserved) await releaseQuota(db, request.portalClientId, input.declaredBytes);
    if (requestReserved) await releaseRequestStatement(db, request.id, input.declaredBytes);
    throw new PortalError(
      429,
      'rate_limited',
      quotaReserved
        ? 'This request has no remaining budget; ask the studio for a new request.'
        : 'Client storage quota exceeded for this upload; try again later.',
    );
  }

  try {
    const [row] = await db
      .insert(uploadSession)
      .values({
        id: crypto.randomUUID(),
        clientId: request.portalClientId,
        workspaceId: request.workspaceId,
        kind: 'material',
        stagingKey: storageKeys.staging(),
        declaredBytes: input.declaredBytes,
        declaredMediaType: input.mediaType,
        declaredSha256: null,
        deliveryId: null,
        outputName: null,
        originalName: input.name ?? null,
        principalId: guest.principalToken,
        status: 'pending',
        expiresMs: now + UPLOAD_SESSION_TTL_MS,
        createdMs: now,
      })
      .returning();
    return {
      uploadId: row!.id,
      mediaType: input.mediaType,
      declaredBytes: input.declaredBytes,
      status: 'pending',
      expiresAt: row!.expiresMs,
    };
  } catch (error) {
    // Session row failed after the reservations: release BOTH budgets.
    await releaseQuota(db, request.portalClientId, input.declaredBytes);
    await releaseRequestStatement(db, request.id, input.declaredBytes);
    throw error;
  }
}

/**
 * PUT /api/v1/r/:token/uploads/:sessionId/content — the SAME streaming
 * staging as v1 (real byte counter, fixed-length staging, magic signatures);
 * rejected bodies commit nothing.
 */
export async function guestPutUploadContent(
  db: PortalDb,
  bucket: R2Bucket,
  guest: GuestAccess,
  uploadId: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<GuestPutUploadResult> {
  const session = await loadGuestSession(db, guest, uploadId);

  if (session.status === 'staged') {
    throw conflict('Upload content was already received; call complete instead of re-uploading.');
  }
  if (session.status !== 'pending') {
    throw conflict(`Upload session is ${session.status} and cannot accept content.`);
  }
  if (session.expiresMs < Date.now()) {
    await db.update(uploadSession).set({ status: 'expired' }).where(eq(uploadSession.id, session.id));
    throw conflict('Upload session expired; reload the page and start a new upload.');
  }
  if (body === null) throw badRequest('A non-empty request body is required.');

  const outcome = await stageUpload(bucket, {
    stream: body,
    stagingKey: session.stagingKey,
    limits: { declaredBytes: session.declaredBytes, maxBytes: session.declaredBytes },
  });

  if (!outcome.ok) {
    const reason = outcome.failure.reason;
    if (reason === 'oversize' || reason === 'trailing_bytes') {
      throw new PortalError(413, 'payload_too_large', 'Body size does not match the declared byte count.');
    }
    if (reason === 'invalid_signature') {
      throw new PortalError(415, 'unsupported_media_type', 'Body does not match any accepted format.');
    }
    throw badRequest('Upload stream failed before completion; the session remains pending.');
  }

  await db
    .update(uploadSession)
    .set({
      status: 'staged',
      actualBytes: outcome.stats.bytes,
      actualSha256: outcome.stats.sha256Hex,
      actualMediaType: outcome.stats.mediaType,
    })
    .where(eq(uploadSession.id, session.id));

  return {
    uploadId: session.id,
    status: 'staged',
    bytes: outcome.stats.bytes,
    sha256: outcome.stats.sha256Hex,
    mediaType: outcome.stats.mediaType!,
  };
}

async function failGuestSession(
  db: PortalDb,
  session: typeof uploadSession.$inferSelect,
  requestId: string,
  clientId: string,
  declaredBytes: number,
): Promise<void> {
  await db.batch([
    db
      .update(uploadSession)
      .set({ status: 'failed', completedMs: Date.now() })
      .where(eq(uploadSession.id, session.id)),
    releaseQuotaStatement(db, clientId, declaredBytes),
    releaseRequestStatement(db, requestId, declaredBytes),
  ]);
}

/**
 * POST /api/v1/r/:token/uploads/:sessionId/complete — v1 server-side
 * verification, then the material row is created carrying BOTH attribution
 * columns (portal_project_id = the request's project, upload_request_id) and
 * the quota commit in the same atomic batch. Auto-close: when the committed
 * budget reaches the limits, the request flips to `fulfilled` exactly once
 * (guarded CAS + `request.fulfilled` audit).
 */
export async function guestCompleteUpload(
  db: PortalDb,
  bucket: R2Bucket,
  guest: GuestAccess,
  uploadId: string,
  correlationId: string,
): Promise<{ material: MaterialView; request: GuestRequestView; replayed: boolean }> {
  const session = await loadGuestSession(db, guest, uploadId);
  // Re-resolve the request: closure/expiry between PUT and complete must be
  // effective immediately (contracts.md §4 lazy evaluation on every use).
  const [current] = await db
    .select()
    .from(uploadRequest)
    .where(eq(uploadRequest.id, guest.request.id))
    .limit(1);
  const request = await expireIfPast(db, current ?? guest.request, guest.principal, correlationId);
  // Closure/expiry between PUT and complete is effective immediately: the
  // state is re-checked BEFORE any resource is created (the consumed
  // reservation stays frozen with the ended request, contracts.md §4).
  assertOpenForUpload(request);

  if (session.status === 'ready') {
    const [existing] = await db.select().from(material).where(eq(material.id, session.materialId ?? '')).limit(1);
    if (!existing) throw new PortalError(500, 'internal', 'ready session with missing material row');
    return { material: materialView(existing), request: toGuestRequestView(request), replayed: true };
  }
  if (session.status === 'pending') {
    throw conflict('Upload content has not been received yet.');
  }
  if (session.status !== 'staged') {
    throw conflict(`Upload session is ${session.status}; it cannot be completed.`);
  }
  if (session.expiresMs < Date.now()) {
    await db.update(uploadSession).set({ status: 'expired' }).where(eq(uploadSession.id, session.id));
    throw conflict('Upload session expired before completion; start a new upload.');
  }

  const bytes = session.actualBytes!;
  const sha256HexActual = session.actualSha256!;
  const mediaType = session.actualMediaType! as V1MediaType;

  // The init declaration is the contract (v1 rule); a mismatch releases the
  // reservation of BOTH budgets in the same atomic batch.
  if (session.actualMediaType !== session.declaredMediaType) {
    await failGuestSession(db, session, request.id, session.clientId, session.declaredBytes);
    throw new PortalError(415, 'unsupported_media_type', 'Content does not match the format declared at upload init.');
  }

  const finalKey = storageKeys.materialFinal(session.clientId, sha256HexActual);
  const finalized = await finalizeUpload(bucket, {
    stagingKey: session.stagingKey,
    finalKey,
    declared: { sha256Hex: sha256HexActual, bytes, mediaType },
  });

  if (!finalized.ok) {
    if (finalized.failure.reason === 'final_conflict') {
      // Orphan recovery (v1 rule): the final key is content-addressed and
      // only written after full verification, so an existing object with the
      // exact expected size IS this payload's prior successful write.
      const existing = await bucket.head(finalKey);
      if (existing === null || existing.size !== bytes) {
        throw conflict('A different object already occupies this content address.');
      }
    } else {
      await failGuestSession(db, session, request.id, session.clientId, session.declaredBytes);
      if (finalized.failure.reason === 'signature_mismatch') {
        throw new PortalError(415, 'unsupported_media_type', 'Staged bytes do not match the declared media type.');
      }
      throw conflict('Staged bytes failed server-side verification; upload rejected.');
    }
  }

  // Content-addressed dedupe within the client (v1 rule): identical bytes
  // converge on the SAME row; a dedupe-reused row keeps its original context.
  const [duplicate] = await db
    .select()
    .from(material)
    .where(and(eq(material.clientId, session.clientId), eq(material.sha256, sha256HexActual)))
    .limit(1);
  const materialId = duplicate?.id ?? crypto.randomUUID();

  const results = await db.batch([
    db
      .insert(material)
      .values({
        id: materialId,
        clientId: session.clientId,
        workspaceId: session.workspaceId,
        objectKey: finalKey,
        originalName: session.originalName,
        mediaType,
        bytes: session.actualBytes!,
        sha256: sha256HexActual,
        status: 'ready',
        uploadedBy: guest.principalToken,
        createdMs: Date.now(),
        portalProjectId: request.portalProjectId,
        uploadRequestId: duplicate === undefined ? request.id : null,
      })
      .onConflictDoNothing({ target: [material.clientId, material.sha256] }),
    db
      .update(uploadSession)
      .set({ status: 'ready', materialId, completedMs: Date.now() })
      .where(eq(uploadSession.id, session.id)),
    commitQuotaStatement(db, session.clientId, session.declaredBytes),
  ]);
  if (results[2]!.meta.changes !== 1) {
    throw new PortalError(500, 'internal', 'quota commit invariant violated');
  }

  const [row] = await db
    .select()
    .from(material)
    .where(and(eq(material.clientId, session.clientId), eq(material.sha256, sha256HexActual)))
    .limit(1);
  if (!row) throw new PortalError(500, 'internal', 'material row missing after commit');
  if (row.id !== materialId) {
    await db.update(uploadSession).set({ materialId: row.id }).where(eq(uploadSession.id, session.id));
  }

  // Auto-close at the limit (lazy, exactly once via the state guard).
  const now = Date.now();
  const fulfilled = await rawRun(
    db,
    sql`UPDATE upload_request SET state = 'fulfilled', closed_ms = ${now}, close_reason = 'fulfilled'
        WHERE id = ${request.id} AND state = 'open'
          AND (used_files >= max_files OR used_bytes >= max_bytes)`,
  );
  if (fulfilled.meta.changes === 1) {
    await recordAudit(db, {
      principal: guest.principal,
      workspaceId: request.workspaceId,
      clientId: request.portalClientId,
      action: 'request.fulfilled',
      resourceType: 'upload_request',
      resourceId: request.id,
      requestId: correlationId,
    });
  }
  await recordAudit(db, {
    principal: guest.principal,
    workspaceId: request.workspaceId,
    clientId: request.portalClientId,
    action: 'request.upload.completed',
    resourceType: 'material',
    resourceId: row.id,
    requestId: correlationId,
  });

  const [finalRequest] = await db
    .select()
    .from(uploadRequest)
    .where(eq(uploadRequest.id, request.id))
    .limit(1);
  return {
    material: materialView(row),
    request: toGuestRequestView(finalRequest ?? request),
    replayed: false,
  };
}
