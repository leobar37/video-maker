import { and, desc, eq, sql } from 'drizzle-orm';
import type {
  AssetTargetMaterialView,
  AssetUploadLinkAdminView,
  AssetUploadLinkState,
  AssetUploadLinkView,
  GuestAssetInitUploadRequest,
  GuestAssetLinkView,
  GuestPutUploadResult,
  MaterialView,
  Page,
  V1MediaType,
} from '@videomaker/customer-assets';
import type { PortalDb } from './db';
import {
  assetUploadLink,
  clientQuota,
  deliveryRevision,
  material,
  portalProject,
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
  requireAdmin,
  requireStudioId,
  sanitizeDisplayName,
  type Principal,
  type RequestDeps,
} from './access';
import {
  DEFAULT_CLIENT_QUOTA_BYTES,
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
 * Asset upload links (operator order 2026-10-06; contratos aditivos §9 ·
 * customer-assets-requests):
 *
 * - The operator (admin human OR an agent key holding the NEW `assets:write`
 *   scope — grants created before it never hold it) mints a guest-direct
 *   upload link bound to EXACTLY ONE Studio asset. The Studio project id is
 *   resolved server-side against the PortalProject pointer projection; the
 *   Studio asset id is stored opaquely (Studio stays canonical; D1 is a
 *   projection).
 * - The guest opens the URL from a phone with NO login: the capability token
 *   grants EXACTLY the upload family of its own asset. It is NOT a session,
 *   never touches auth tables, never sets a cookie and never reaches any
 *   other route — only the SHA-256 hash is stored (UNIQUE); the raw token
 *   exists only inside the minted URL, shown once to the operator and
 *   delivered out-of-band (0 emails).
 * - ONE ACTIVE link per (portal client, Studio asset): re-minting closes the
 *   previous link (`asset_link.revoked` audit). Lazy state machine
 *   open -> used | closed | expired evaluated on FIRST touch (guarded single
 *   UPDATE + one audit — no cron, no queues). `used` is terminal: the
 *   capability covers ONE upload (una toma); the operator mints a fresh link
 *   per take or after rotation.
 * - Quota: the link has NO budget of its own (request-quota semantics are
 *   N/A here by operator order) — uploads compete for the SAME client_quota
 *   CAS as free v1 and request uploads (per-type 413 caps unchanged). Init
 *   reserves; failure/expiry paths release; complete commits.
 * - Attribution: the completed material row carries portal_project_id (the
 *   link's pointer, when resolved), upload_request_id = NULL and
 *   asset_target = the link's Studio asset id — a value that NEVER comes
 *   from client input, so per-call scope is enforced server-side: a token is
 *   valid ONLY for its asset and there is no API shape that could redirect
 *   an upload elsewhere (attempting to operate on any other asset id is 404
 *   like every foreign resource).
 * - The upload pipeline is the v1 pipeline (stageUpload/finalizeUpload/
 *   storage keys): the guest context only adds validation and attribution —
 *   zero storage or header bifurcation.
 */

export type AssetUploadLinkRow = typeof assetUploadLink.$inferSelect;

/** Same capability grammar as request tokens: 256-bit CSPRNG, base64url. */
const ASSET_LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** `<prefix>:guest:<tokenHash>` — provenance marker on material.uploaded_by. */
const GUEST_UPLOADED_BY_PREFIX = 'user:guest:';

function generateAssetLinkToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function toAssetLinkAdminView(row: AssetUploadLinkRow): AssetUploadLinkAdminView {
  return {
    id: row.id,
    portalClientId: row.portalClientId,
    portalProjectId: row.portalProjectId,
    studioProjectId: row.studioProjectId,
    studioAssetId: row.studioAssetId,
    state: row.state as AssetUploadLinkState,
    expiresAt: row.expiresMs,
    createdAt: row.createdMs,
    closedAt: row.closedMs,
    closeReason: row.closeReason,
  };
}

/** Minimal guest view: display fields + quota ONLY, no ids of any resource. */
export async function guestAssetLinkView(db: PortalDb, row: AssetUploadLinkRow): Promise<GuestAssetLinkView> {
  // Display title: the latest delivered revision for THIS exact asset when
  // the operator already pushed one; otherwise the raw Studio asset id. The
  // lookup uses plain Studio ids (delivery_revision stores them verified).
  const [delivery] = await db
    .select({ title: deliveryRevision.title })
    .from(deliveryRevision)
    .where(
      and(
        eq(deliveryRevision.clientId, row.portalClientId),
        eq(deliveryRevision.projectId, row.studioProjectId),
        eq(deliveryRevision.assetId, row.studioAssetId),
      ),
    )
    .orderBy(desc(deliveryRevision.createdMs))
    .limit(1);
  let projectTitle = row.studioProjectId;
  if (row.portalProjectId !== null) {
    const [project] = await db
      .select({ name: portalProject.name })
      .from(portalProject)
      .where(eq(portalProject.id, row.portalProjectId))
      .limit(1);
    if (project) projectTitle = project.name;
  }
  const [quota] = await db
    .select({ usedBytes: clientQuota.usedBytes, reservedBytes: clientQuota.reservedBytes, limitBytes: clientQuota.limitBytes })
    .from(clientQuota)
    .where(eq(clientQuota.clientId, row.portalClientId))
    .limit(1);
  const limitBytes = quota?.limitBytes ?? DEFAULT_CLIENT_QUOTA_BYTES;
  const usedBytes = quota?.usedBytes ?? 0;
  const reservedBytes = quota?.reservedBytes ?? 0;
  return {
    assetTitle: delivery?.title ?? row.studioAssetId,
    projectTitle,
    state: row.state as AssetUploadLinkState,
    expiresAt: row.expiresMs,
    quota: {
      limitBytes,
      remainingBytes: Math.max(0, limitBytes - usedBytes - reservedBytes),
    },
  };
}

/* mint ----------------------------------------------------------------------- */

interface MintContext {
  pointer: typeof portalProject.$inferSelect;
}

/**
 * Resolves the PortalProject pointer for a mint request: an explicit
 * portalProjectId is cross-checked against the Studio project id; otherwise
 * the unique pointer row for the Studio project id is used (an explicit
 * portalClientId narrows and cross-checks). Zero rows = 404 (no
 * enumeration); ambiguity = 409 demanding the disambiguating field.
 */
async function resolveMintContext(
  db: PortalDb,
  input: { studioProjectId: string; studioAssetId: string; portalClientId?: string; portalProjectId?: string },
): Promise<MintContext> {
  if (input.portalProjectId !== undefined) {
    const [pointer] = await db
      .select()
      .from(portalProject)
      .where(eq(portalProject.id, input.portalProjectId))
      .limit(1);
    if (!pointer) throw notFound();
    if (pointer.studioProjectId !== input.studioProjectId) {
      throw badRequest('portalProjectId does not match the given Studio project id.');
    }
    if (input.portalClientId !== undefined && pointer.portalClientId !== input.portalClientId) {
      throw badRequest('portalClientId does not match the client of the given pointer.');
    }
    return { pointer };
  }
  const where =
    input.portalClientId !== undefined
      ? and(eq(portalProject.studioProjectId, input.studioProjectId), eq(portalProject.portalClientId, input.portalClientId))
      : eq(portalProject.studioProjectId, input.studioProjectId);
  const pointers = await db.select().from(portalProject).where(where).limit(2);
  if (pointers.length === 0) throw notFound('No portal project pointer exists for that Studio project id.');
  if (pointers.length > 1) {
    throw conflict('That Studio project id maps to several portal pointers; pass portalClientId (or portalProjectId) to disambiguate.');
  }
  return { pointer: pointers[0]! };
}

export interface MintedAssetLink {
  url: string;
  view: AssetUploadLinkView;
}

/**
 * POST /api/v1/asset-upload-links — mints (and ROTATES) the per-asset guest
 * link: every prior OPEN link for the same (portal client, Studio asset) is
 * closed (`asset_link.revoked` audit), so exactly one live capability exists
 * per asset. The raw token exists ONLY in the returned URL — never stored,
 * logged or audited. Deliberately NOT idempotency-keyed (like access-link
 * minting: replay storage would persist a minted URL).
 */
export async function mintAssetUploadLink(
  deps: RequestDeps,
  principal: Principal,
  input: {
    studioProjectId: string;
    studioAssetId: string;
    portalClientId?: string;
    portalProjectId?: string;
    expiresInSeconds: number;
    origin: string;
  },
  correlationId: string,
): Promise<MintedAssetLink> {
  const db = deps.db;
  const studioProjectId = requireStudioId(input.studioProjectId, 'studioProjectId');
  const studioAssetId = requireStudioId(input.studioAssetId, 'studioAssetId');
  const { pointer } = await resolveMintContext(db, {
    studioProjectId,
    studioAssetId,
    ...(input.portalClientId !== undefined ? { portalClientId: input.portalClientId } : {}),
    ...(input.portalProjectId !== undefined ? { portalProjectId: input.portalProjectId } : {}),
  });
  await authorizeClient(db, principal, pointer.portalClientId, 'assets:write');
  if (principal.kind === 'member') {
    throw forbidden('Members cannot mint asset upload links.');
  }
  // Defense in depth: the API layer clamps origin to the approved one.
  if (deps.portalOrigin !== undefined && input.origin !== deps.portalOrigin) {
    throw badRequest('origin does not match the portal approved origin.');
  }

  const now = Date.now();
  const expiresMs = now + input.expiresInSeconds * 1000;
  const prior = await db
    .select({ id: assetUploadLink.id })
    .from(assetUploadLink)
    .where(
      and(
        eq(assetUploadLink.portalClientId, pointer.portalClientId),
        eq(assetUploadLink.studioAssetId, studioAssetId),
        eq(assetUploadLink.state, 'open'),
      ),
    );
  await rawRun(
    db,
    sql`UPDATE asset_upload_link SET state = 'closed', closed_ms = ${now}, close_reason = 'rotated'
        WHERE portal_client_id = ${pointer.portalClientId} AND studio_asset_id = ${studioAssetId} AND state = 'open'`,
  );
  for (const old of prior) {
    await recordAudit(db, {
      principal,
      workspaceId: pointer.workspaceId,
      clientId: pointer.portalClientId,
      action: 'asset_link.revoked',
      resourceType: 'asset_upload_link',
      resourceId: old.id,
      requestId: correlationId,
    });
  }

  const rawToken = generateAssetLinkToken();
  const [row] = await db
    .insert(assetUploadLink)
    .values({
      id: crypto.randomUUID(),
      workspaceId: pointer.workspaceId,
      portalClientId: pointer.portalClientId,
      portalProjectId: pointer.id,
      studioProjectId,
      studioAssetId,
      tokenHash: sha256Hex(new TextEncoder().encode(rawToken)),
      expiresMs,
      state: 'open',
      createdBy: principalId(principal),
      createdMs: now,
    })
    .returning();
  await recordAudit(db, {
    principal,
    workspaceId: pointer.workspaceId,
    clientId: pointer.portalClientId,
    action: 'asset_link.minted',
    resourceType: 'asset_upload_link',
    resourceId: row!.id,
    requestId: correlationId,
  });

  return {
    url: `${input.origin}/asset-upload/${rawToken}`,
    view: {
      url: `${input.origin}/asset-upload/${rawToken}`,
      linkId: row!.id,
      portalClientId: row!.portalClientId,
      portalProjectId: row!.portalProjectId,
      studioProjectId: row!.studioProjectId,
      studioAssetId: row!.studioAssetId,
      expiresAt: row!.expiresMs,
    },
  };
}

/* manage (admin) -------------------------------------------------------------- */

/** Resolves a link row or 404 (unknown ids reveal nothing). */
async function loadLink(db: PortalDb, linkId: string): Promise<AssetUploadLinkRow> {
  const [row] = await db.select().from(assetUploadLink).where(eq(assetUploadLink.id, linkId)).limit(1);
  if (!row) throw notFound();
  return row;
}

/**
 * Lazy expiry materialization (contracts aditivos §9): the FIRST touch past
 * the deadline flips `open` -> `expired` with ONE guarded UPDATE and ONE
 * `asset_link.expired` audit. No cron, no queues.
 */
export async function expireLinkIfPast(
  db: PortalDb,
  row: AssetUploadLinkRow,
  actor: Principal,
  correlationId: string,
): Promise<AssetUploadLinkRow> {
  if (row.state !== 'open' || row.expiresMs > Date.now()) return row;
  const expired = await rawRun(
    db,
    sql`UPDATE asset_upload_link SET state = 'expired', closed_ms = ${Date.now()}, close_reason = 'expired'
        WHERE id = ${row.id} AND state = 'open' AND expires_ms <= ${Date.now()}`,
  );
  if (expired.meta.changes === 1) {
    await recordAudit(db, {
      principal: actor,
      workspaceId: row.workspaceId,
      clientId: row.portalClientId,
      action: 'asset_link.expired',
      resourceType: 'asset_upload_link',
      resourceId: row.id,
      requestId: correlationId,
    });
  }
  return { ...row, state: 'expired', closedMs: Date.now(), closeReason: 'expired' };
}

/**
 * GET /api/v1/asset-upload-links — admin-human manage listing (optionally
 * filtered by portal client and/or Studio asset). Open rows past their expiry
 * are lazily materialized during the listing (audit once, guarded).
 */
export async function listAssetUploadLinks(
  db: PortalDb,
  principal: Principal,
  filters: { portalClientId?: string; studioAssetId?: string },
  correlationId: string,
): Promise<Page<AssetUploadLinkAdminView>> {
  requireAdmin(principal);
  const conditions = [];
  if (filters.portalClientId !== undefined) conditions.push(eq(assetUploadLink.portalClientId, filters.portalClientId));
  if (filters.studioAssetId !== undefined) conditions.push(eq(assetUploadLink.studioAssetId, filters.studioAssetId));
  const rows = await db
    .select()
    .from(assetUploadLink)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(assetUploadLink.createdMs), desc(assetUploadLink.id))
    .limit(100);
  const items: AssetUploadLinkAdminView[] = [];
  for (const row of rows) {
    items.push(toAssetLinkAdminView(await expireLinkIfPast(db, row, principal, correlationId)));
  }
  return { items, nextCursor: null };
}

/** GET /api/v1/asset-upload-links/:id — admin-human manage view (no token). */
export async function getAssetUploadLink(
  db: PortalDb,
  principal: Principal,
  linkId: string,
  correlationId: string,
): Promise<{ link: AssetUploadLinkAdminView; workspaceId: string }> {
  requireAdmin(principal);
  const row = await expireLinkIfPast(db, await loadLink(db, linkId), principal, correlationId);
  return { link: toAssetLinkAdminView(row), workspaceId: row.workspaceId };
}

/**
 * POST /api/v1/asset-upload-links/:id/close — admin human. Closing from
 * `open` freezes the capability; an already used/closed/expired link is a
 * 409. Nothing is ever deleted.
 */
export async function closeAssetUploadLink(
  db: PortalDb,
  principal: Principal,
  linkId: string,
  reason?: string,
  correlationId = 'close',
): Promise<{ link: AssetUploadLinkAdminView; workspaceId: string }> {
  requireAdmin(principal);
  const row = await expireLinkIfPast(db, await loadLink(db, linkId), principal, correlationId);
  if (row.state !== 'open') {
    throw conflict(`This link is already ${row.state} and cannot be closed.`);
  }
  const closeReason = reason === undefined || reason.trim().length === 0 ? 'closed' : sanitizeDisplayName(reason, 200) ?? 'closed';
  const now = Date.now();
  await rawRun(
    db,
    sql`UPDATE asset_upload_link SET state = 'closed', closed_ms = ${now}, close_reason = ${closeReason}
        WHERE id = ${row.id} AND state = 'open'`,
  );
  await recordAudit(db, {
    principal,
    workspaceId: row.workspaceId,
    clientId: row.portalClientId,
    action: 'asset_link.closed',
    resourceType: 'asset_upload_link',
    resourceId: row.id,
    requestId: correlationId,
  });
  return {
    link: toAssetLinkAdminView({ ...row, state: 'closed', closedMs: now, closeReason }),
    workspaceId: row.workspaceId,
  };
}

/* materials by asset target ---------------------------------------------------- */

/**
 * GET /api/v1/asset-upload-links/materials?asset=<studioAssetId> — the exact
 * import set of `portal-asset-pull`: every ready material whose asset_target
 * is the given LOCAL Studio asset id. Admin human OR agent with
 * `materials:read` on the owning client (a grant that does not cover the
 * client keeps the v1 404 — nothing can be enumerated). Each item carries
 * linkId resolved from the upload's hashed guest principal via the UNIQUE
 * token_hash — no new material columns.
 */
export async function listMaterialsByAssetTarget(
  db: PortalDb,
  principal: Principal,
  studioAssetId: string,
  filters: { portalClientId?: string } = {},
): Promise<Page<AssetTargetMaterialView>> {
  requireStudioId(studioAssetId, 'asset');
  const conditions = [eq(material.assetTarget, studioAssetId), eq(material.status, 'ready')];
  if (filters.portalClientId !== undefined) conditions.push(eq(material.clientId, filters.portalClientId));
  const rows = await db
    .select()
    .from(material)
    .where(and(...conditions))
    .orderBy(desc(material.createdMs), desc(material.id))
    .limit(100);
  if (rows.length === 0) {
    // 404 keeps the enumeration rule even for a valid but foreign asset id.
    if (filters.portalClientId !== undefined) await authorizeClient(db, principal, filters.portalClientId, 'materials:read');
    return { items: [], nextCursor: null };
  }
  const authorizedClients: string[] = [];
  for (const clientId of [...new Set(rows.map((row) => row.clientId))]) {
    await authorizeClient(db, principal, clientId, 'materials:read');
    authorizedClients.push(clientId);
  }
  const visible = rows.filter((row) => authorizedClients.includes(row.clientId));
  // Resolve producing links: guest uploads stamp uploadedBy with the token
  // hash; UNIQUE(token_hash) gives an exact, cheap join without new columns.
  const hashes = visible
    .map((row) => (row.uploadedBy.startsWith(GUEST_UPLOADED_BY_PREFIX) ? row.uploadedBy.slice(GUEST_UPLOADED_BY_PREFIX.length) : null))
    .filter((hash): hash is string => hash !== null);
  const linkByHash = new Map<string, string>();
  for (const hash of [...new Set(hashes)]) {
    const [link] = await db
      .select({ id: assetUploadLink.id })
      .from(assetUploadLink)
      .where(eq(assetUploadLink.tokenHash, hash))
      .limit(1);
    if (link) linkByHash.set(hash, link.id);
  }
  const items: AssetTargetMaterialView[] = visible.map((row) => ({
    ...materialView(row),
    assetTarget: row.assetTarget ?? studioAssetId,
    linkId: row.uploadedBy.startsWith(GUEST_UPLOADED_BY_PREFIX)
      ? (linkByHash.get(row.uploadedBy.slice(GUEST_UPLOADED_BY_PREFIX.length)) ?? null)
      : null,
  }));
  return { items, nextCursor: null };
}

/* guest principal + resolution ------------------------------------------------ */

export interface GuestLinkAccess {
  link: AssetUploadLinkRow;
  tokenHash: string;
  /**
   * upload_session binding and audit actor: `user:guest:<tokenHash>`. Derived
   * ONLY from the stored hash — the raw token never appears server-side
   * beyond this function's argument.
   */
  principalToken: string;
  principal: Principal;
}

function guestLinkPrincipal(tokenHash: string): Principal {
  return { kind: 'member', userId: `guest:${tokenHash}`, role: 'member', grant: null };
}

/**
 * Resolves the guest principal from the raw capability token on EVERY guest
 * HTTP request: hash -> link row (state/expiry effective immediately). No
 * session, no cookie, no auth table is touched; a wrong/revoked/expired
 * token is the same 404.
 */
export async function resolveGuestLinkAccess(
  db: PortalDb,
  rawToken: string,
  correlationId: string,
): Promise<GuestLinkAccess> {
  if (typeof rawToken !== 'string' || !ASSET_LINK_TOKEN_PATTERN.test(rawToken)) {
    throw notFound('Este enlace no es válido o ha vencido.');
  }
  const tokenHash = sha256Hex(new TextEncoder().encode(rawToken));
  const [link] = await db
    .select()
    .from(assetUploadLink)
    .where(eq(assetUploadLink.tokenHash, tokenHash))
    .limit(1);
  if (!link) throw notFound('Este enlace no es válido o ha vencido.');
  const settled = await expireLinkIfPast(db, link, guestLinkPrincipal(tokenHash), correlationId);
  // A closed link (rotation or admin close) is a REVOKED capability: the same
  // neutral 404 as an unknown token, on every family route. `used`/`expired`
  // still resolve so the guest page can SHOW the terminal state; uploads are
  // refused by the state guard.
  if (settled.state === 'closed') throw notFound('Este enlace no es válido o ha vencido.');
  return {
    link: settled,
    tokenHash,
    principalToken: principalId(guestLinkPrincipal(tokenHash)),
    principal: guestLinkPrincipal(tokenHash),
  };
}

function assertLinkOpenForUpload(row: AssetUploadLinkRow): void {
  if (row.state === 'open') return;
  if (row.state === 'used') throw conflict('Este enlace ya fue usado; pedile uno nuevo al estudio.');
  if (row.state === 'expired') throw conflict('Este enlace venció y ya no acepta subidas.');
  throw conflict('Este enlace está cerrado y ya no acepta subidas.');
}

/* guest upload flow (same v1 pipeline, guest validations) ---------------------- */

async function loadGuestLinkSession(db: PortalDb, guest: GuestLinkAccess, uploadId: string) {
  const [row] = await db.select().from(uploadSession).where(eq(uploadSession.id, uploadId)).limit(1);
  // Sessions are bound to the guest principal that created them: another
  // token — even for the SAME asset — gets 404 (v1 binding rule).
  if (!row || row.principalId !== guest.principalToken) throw notFound();
  return row;
}

/**
 * POST /api/v1/a/:token/uploads — guest init with the SINGLE client_quota
 * CAS reservation (request-quota semantics are N/A for asset links by
 * operator order: the link has no file/byte budget of its own; per-type caps
 * and the client quota bound every upload). A lost reservation answers 429;
 * per-type oversize is 413.
 */
export async function guestLinkInitUpload(
  db: PortalDb,
  guest: GuestLinkAccess,
  input: GuestAssetInitUploadRequest,
): Promise<{ uploadId: string; mediaType: V1MediaType; declaredBytes: number; status: 'pending'; expiresAt: number }> {
  assertLinkOpenForUpload(guest.link);
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

  // The reservation CAS needs a live row (v1/R-2 pattern: insert-or-ignore
  // bootstrap right before the reservation).
  await ensureQuotaRow(db, guest.link.portalClientId);
  const reserved = await rawRun(
    db,
    sql`UPDATE client_quota SET reserved_bytes = reserved_bytes + ${input.declaredBytes}, updated_ms = ${Date.now()}
        WHERE client_id = ${guest.link.portalClientId} AND reserved_bytes + ${input.declaredBytes} <= limit_bytes`,
  );
  if (reserved.meta.changes !== 1) {
    throw new PortalError(429, 'rate_limited', 'La cuota de almacenamiento del cliente está agotada; probá más tarde.');
  }

  try {
    const now = Date.now();
    const [row] = await db
      .insert(uploadSession)
      .values({
        id: crypto.randomUUID(),
        clientId: guest.link.portalClientId,
        workspaceId: guest.link.workspaceId,
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
    // Session row failed after the reservation: release the only arm.
    await releaseQuota(db, guest.link.portalClientId, input.declaredBytes);
    throw error;
  }
}

/**
 * PUT /api/v1/a/:token/uploads/:sessionId/content — the SAME streaming
 * staging as v1 (real byte counter, fixed-length staging, magic signatures);
 * rejected bodies commit nothing.
 */
export async function guestLinkPutUploadContent(
  db: PortalDb,
  bucket: R2Bucket,
  guest: GuestLinkAccess,
  uploadId: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<GuestPutUploadResult> {
  const session = await loadGuestLinkSession(db, guest, uploadId);

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

/** Releases the single quota arm and ends the session (batched). */
async function failGuestLinkSession(
  db: PortalDb,
  session: typeof uploadSession.$inferSelect,
  declaredBytes: number,
): Promise<void> {
  await db.batch([
    db
      .update(uploadSession)
      .set({ status: 'failed', completedMs: Date.now() })
      .where(eq(uploadSession.id, session.id)),
    releaseQuotaStatement(db, session.clientId, declaredBytes),
  ]);
}

/**
 * POST /api/v1/a/:token/uploads/:sessionId/complete — v1 server-side
 * verification, then the material row is created with the link's attribution
 * (portal_project_id = the link's pointer, upload_request_id = NULL,
 * asset_target = the link's Studio asset id) and the quota commit in the
 * same atomic batch. The link flips open -> used exactly once via a guarded
 * CAS after the commit (`asset_link.used` audit).
 */
export async function guestLinkCompleteUpload(
  db: PortalDb,
  bucket: R2Bucket,
  guest: GuestLinkAccess,
  uploadId: string,
  correlationId: string,
): Promise<{ material: MaterialView; link: GuestAssetLinkView; replayed: boolean }> {
  const session = await loadGuestLinkSession(db, guest, uploadId);
  // Re-resolve the link: closure/expiry/usage between PUT and complete must
  // be effective immediately (lazy evaluation on every use).
  const [current] = await db
    .select()
    .from(assetUploadLink)
    .where(eq(assetUploadLink.id, guest.link.id))
    .limit(1);
  const link = await expireLinkIfPast(db, current ?? guest.link, guest.principal, correlationId);

  // Idempotent replay FIRST: a ready session replays its material even when
  // the link meanwhile ended (used/closed/expired) — the upload DID complete.
  if (session.status === 'ready') {
    const [existing] = await db.select().from(material).where(eq(material.id, session.materialId ?? '')).limit(1);
    if (!existing) throw new PortalError(500, 'internal', 'ready session with missing material row');
    return { material: materialView(existing), link: await guestAssetLinkView(db, link), replayed: true };
  }
  assertLinkOpenForUpload(link);

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
  // reservation in the same atomic batch.
  if (session.actualMediaType !== session.declaredMediaType) {
    await failGuestLinkSession(db, session, session.declaredBytes);
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
      await failGuestLinkSession(db, session, session.declaredBytes);
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
        portalProjectId: link.portalProjectId,
        uploadRequestId: null,
        assetTarget: link.studioAssetId,
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

  // Single-use: the FIRST completed upload flips the link to `used` exactly
  // once via the state guard (a concurrent second complete keeps its material
  // but leaves the state untouched — the capability was open at its check).
  const now = Date.now();
  const used = await rawRun(
    db,
    sql`UPDATE asset_upload_link SET state = 'used', closed_ms = ${now}, close_reason = 'used'
        WHERE id = ${link.id} AND state = 'open'`,
  );
  if (used.meta.changes === 1) {
    await recordAudit(db, {
      principal: guest.principal,
      workspaceId: link.workspaceId,
      clientId: link.portalClientId,
      action: 'asset_link.used',
      resourceType: 'asset_upload_link',
      resourceId: link.id,
      requestId: correlationId,
    });
  }
  await recordAudit(db, {
    principal: guest.principal,
    workspaceId: link.workspaceId,
    clientId: link.portalClientId,
    action: 'asset_link.upload.completed',
    resourceType: 'material',
    resourceId: row.id,
    requestId: correlationId,
  });

  const [finalLink] = await db
    .select()
    .from(assetUploadLink)
    .where(eq(assetUploadLink.id, link.id))
    .limit(1);
  return {
    material: materialView(row),
    link: await guestAssetLinkView(db, finalLink ?? link),
    replayed: false,
  };
}
