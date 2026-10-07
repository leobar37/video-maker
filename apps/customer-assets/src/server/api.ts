import type {
  ApiError,
  CompleteUploadRequest,
  CreateUploadRequestRequest,
  GuestInitUploadRequest,
  InitUploadRequest,
  MeInfo,
  Page,
  PortalClientView,
} from '@videomaker/customer-assets';
import type { PortalDb } from './db';

/** Re-exported for the thin route file and test fixtures. */
export type { RequestDeps, PortalEnv, Principal } from './access';
import {
  PortalError,
  authorizeClient,
  badRequest,
  beginIdempotency,
  completeIdempotency,
  failIdempotency,
  fingerprintOf,
  isFreshKeyed,
  notFound,
  parseExpiresIn,
  parseListOptions,
  recordAudit,
  requireAdmin,
  requireEmail,
  requireOutputName,
  requireVisibility,
  resolvePrincipal,
  sanitizeDisplayName,
  unauthorized,
  type Principal,
  type RequestDeps,
} from './access';
import { StagingKeyRefusalError } from './storage';
import {
  completeUploadSession,
  initUploadSession,
  isV1MediaType,
  putUploadContent,
} from './uploads';
import { adoptClient, listAuthorizedClients, mintAccessLink } from './clients';
import { listProjectsForClient, registerProjectPointer, renameProject } from './projects';
import {
  closeUploadRequest,
  createUploadRequest,
  getRequestForPrincipal,
  guestCompleteUpload,
  guestInitUpload,
  guestPutUploadContent,
  listRequestMaterials,
  listRequestsForProject,
  mintRequestLink,
  resolveGuestAccess,
  toGuestRequestView,
} from './requests';
import {
  closeAssetUploadLink,
  getAssetUploadLink,
  guestLinkCompleteUpload,
  guestLinkInitUpload,
  guestLinkPutUploadContent,
  guestAssetLinkView,
  listAssetUploadLinks,
  listMaterialsByAssetTarget,
  mintAssetUploadLink,
  resolveGuestLinkAccess,
} from './asset-links';
import { getMaterialForPrincipal, listMaterialsForClient, serveMaterialContent } from './materials';
import { completeDelivery, createDelivery, listAssetsForClient, serveDeliveryOutput } from './deliveries';
import {
  createPost,
  getGridState,
  listPostsForClient,
  patchGrid,
  setAssetVisibility,
  updatePost,
} from './posts';

/**
 * HTTP v1 surface (contracts.md §6). One dispatcher owns envelope shape,
 * status codes, idempotency wiring and audit so the thin TanStack route file
 * (`/api/v1/$`) only delegates. Envelope rules:
 * - success pages are `{ items, nextCursor }`; resources are bare JSON;
 * - errors are `{ error: { code, message, requestId } }`, no `success` flag;
 * - 401 missing/invalid identity, 403 authorized resource + insufficient
 *   scope/role, 404 unknown or cross-client resource (no enumeration),
 *   409 version/idempotency/state conflict, 413 size, 415 type, 429 quota.
 */

const MAX_JSON_BYTES = 1024 * 1024;

function jsonResponse(body: unknown, status: number, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

function errorEnvelope(error: PortalError, requestId: string): ApiError {
  return { error: { code: error.code, message: error.message, requestId } };
}

function errorToResponse(error: unknown, requestId: string): Response {
  if (error instanceof PortalError) {
    return jsonResponse(errorEnvelope(error, requestId), error.status);
  }
  if (error instanceof StagingKeyRefusalError) {
    // Defensive: staging keys are never servable; answer like any other
    // unknown resource without echoing the key.
    return jsonResponse(
      errorEnvelope(new PortalError(404, 'not_found', 'Resource not found.'), requestId),
      404,
    );
  }
  if (error instanceof SyntaxError) {
    return jsonResponse(
      errorEnvelope(new PortalError(400, 'bad_request', 'Malformed JSON body.'), requestId),
      400,
    );
  }
  // 5xx without secrets: log shape stays generic.
  return jsonResponse(
    errorEnvelope(new PortalError(500, 'internal', 'Internal error.'), requestId),
    500,
  );
}

async function parseJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) {
    throw new PortalError(413, 'payload_too_large', 'Request body exceeds the JSON limit.');
  }
  if (text.length === 0) return {};
  return JSON.parse(text) as unknown;
}

function idempotencyKeyOf(request: Request): string | null {
  const raw = request.headers.get('idempotency-key');
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 200) throw badRequest('Idempotency-Key is too long.');
  return trimmed;
}

interface IdempotencyScope {
  principal: Principal;
  /** Client scope of the operation (workspace token for adopt). */
  clientId: string;
  operation: string;
  payload: unknown;
  rawKey: string | null;
}

/**
 * Runs a mutating handler under the idempotency ledger: same key + same
 * payload fingerprint replays the stored response; a different payload is a
 * 409. The recorded response is the handler's JSON result.
 */
async function runIdempotent(
  db: PortalDb,
  scope: IdempotencyScope,
  successStatus: number,
  run: () => Promise<unknown>,
): Promise<Response> {
  const outcome = await beginIdempotency(db, {
    principal: scope.principal,
    clientId: scope.clientId,
    operation: scope.operation,
    rawKey: scope.rawKey,
    fingerprint: fingerprintOf(scope.payload),
  });
  if (outcome.mode === 'replay') {
    return new Response(outcome.body, {
      status: outcome.status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'idempotency-replayed': 'true' },
    });
  }
  try {
    const result = await run();
    const body = JSON.stringify(result);
    if (isFreshKeyed(outcome)) {
      await completeIdempotency(
        db,
        { principal: scope.principal, clientId: scope.clientId, operation: scope.operation },
        outcome.keyHash,
        successStatus,
        body,
      );
    }
    return jsonResponse(result, successStatus);
  } catch (error) {
    if (isFreshKeyed(outcome)) {
      await failIdempotency(
        db,
        { principal: scope.principal, clientId: scope.clientId, operation: scope.operation },
        outcome.keyHash,
      );
    }
    throw error;
  }
}

async function audit(
  deps: RequestDeps,
  principal: Principal,
  workspaceId: string | null,
  clientId: string | null,
  action: string,
  resourceType: string,
  resourceId: string,
  requestId: string,
): Promise<void> {
  await recordAudit(deps.db, {
    principal,
    workspaceId,
    clientId,
    action,
    resourceType,
    resourceId,
    requestId,
  });
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest('A JSON object body is required.');
  }
  return value as Record<string, unknown>;
}

function meInfo(principal: Principal): MeInfo {
  const info: MeInfo['me'] = {
    kind: principal.kind,
    userId: principal.userId,
  };
  if (principal.kind !== 'agent') {
    info.role = principal.role;
    info.email = principal.email;
  } else {
    info.scopes = principal.grant?.scopes ?? [];
  }
  return { me: info };
}

function validateInitUploadBody(raw: unknown): InitUploadRequest {
  const body = requireObject(raw);
  const kind = body.kind;
  if (kind !== 'material' && kind !== 'delivery_output') {
    throw badRequest("kind must be 'material' or 'delivery_output'.");
  }
  if (!isV1MediaType(body.mediaType)) throw badRequest('mediaType is not a v1 media type.');
  if (typeof body.declaredBytes !== 'number' || !Number.isInteger(body.declaredBytes)) {
    throw badRequest('declaredBytes must be an integer.');
  }
  const request: InitUploadRequest = {
    kind,
    mediaType: body.mediaType,
    declaredBytes: body.declaredBytes,
  };
  if (body.sha256 !== undefined) {
    if (typeof body.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(body.sha256)) {
      throw badRequest('sha256 must be a lowercase hex sha256 digest.');
    }
    request.sha256 = body.sha256;
  }
  const name = sanitizeDisplayName(body.name);
  if (name !== undefined) request.name = name;
  if (body.deliveryId !== undefined) {
    if (typeof body.deliveryId !== 'string' || body.deliveryId.length === 0 || body.deliveryId.length > 64) {
      throw badRequest('deliveryId has an invalid format.');
    }
    request.deliveryId = body.deliveryId;
  }
  if (body.outputName !== undefined) request.outputName = requireOutputName(body.outputName);
  if (body.portalProjectId !== undefined) {
    if (typeof body.portalProjectId !== 'string' || body.portalProjectId.length === 0 || body.portalProjectId.length > 64) {
      throw badRequest('portalProjectId has an invalid format.');
    }
    request.portalProjectId = body.portalProjectId;
  }
  return request;
}

interface RouteContext {
  request: Request;
  deps: RequestDeps;
  principal: Principal;
  requestId: string;
  url: URL;
}

/* ---------------------------------------------------------------------------
 * Guest-direct routes (P-102, R-2; contracts.md §5 additive). Resolved by the
 * capability token in the path — NO session, NO cookie, NO api key is read
 * here, so these routes run BEFORE the v1 principal resolution. The token
 * grants exactly: its own request view, uploads init/put/complete. Anything
 * else is a 404; every response is no-store (NFR-104).
 * ------------------------------------------------------------------------- */

function validateGuestInitBody(raw: unknown): GuestInitUploadRequest {
  const body = requireObject(raw);
  if (!isV1MediaType(body.mediaType)) throw badRequest('mediaType is not a v1 media type.');
  if (typeof body.declaredBytes !== 'number' || !Number.isInteger(body.declaredBytes)) {
    throw badRequest('declaredBytes must be an integer.');
  }
  const input: GuestInitUploadRequest = { mediaType: body.mediaType, declaredBytes: body.declaredBytes };
  const name = sanitizeDisplayName(body.name);
  if (name !== undefined) input.name = name;
  return input;
}

async function withNoStore(response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, headers });
}

/* eslint-disable @typescript-eslint/no-non-null-assertion */
async function handleGuestRoute(
  request: Request,
  deps: RequestDeps,
  segments: string[],
  requestId: string,
): Promise<Response> {
  const db = deps.db;
  const bucket = deps.env.ASSETS;
  try {
    const guest = await resolveGuestAccess(db, segments[0] ?? '', requestId);
    const rest = segments.slice(1);

    // GET /api/v1/r/:token — minimal view (title/instructions/budget/state).
    if (rest.length === 0 && request.method === 'GET') {
      return jsonResponse(toGuestRequestView(guest.request), 200, { 'cache-control': 'no-store' });
    }

    // POST /api/v1/r/:token/uploads — init with the dual reservation.
    if (rest.length === 1 && rest[0] === 'uploads' && request.method === 'POST') {
      const payload = await parseJsonBody(request);
      const input = validateGuestInitBody(payload);
      const result = await runIdempotent(db, {
        principal: guest.principal,
        clientId: guest.request.portalClientId,
        operation: 'request.uploads.init',
        payload,
        rawKey: idempotencyKeyOf(request),
      }, 201, async () => guestInitUpload(db, guest, input));
      return withNoStore(result);
    }

    // PUT /api/v1/r/:token/uploads/:sessionId/content
    if (rest.length === 3 && rest[0] === 'uploads' && rest[2] === 'content' && request.method === 'PUT') {
      const result = await guestPutUploadContent(db, bucket, guest, rest[1]!, request.body);
      return jsonResponse(result, 200, { 'cache-control': 'no-store' });
    }

    // POST /api/v1/r/:token/uploads/:sessionId/complete
    if (rest.length === 3 && rest[0] === 'uploads' && rest[2] === 'complete' && request.method === 'POST') {
      const result = await guestCompleteUpload(db, bucket, guest, rest[1]!, requestId);
      return jsonResponse(result, result.replayed ? 200 : 201, { 'cache-control': 'no-store' });
    }

    throw notFound('Unknown API route.');
  } catch (error) {
    return errorToResponse(error, requestId);
  }
}
/* eslint-enable @typescript-eslint/no-non-null-assertion */

/**
 * Guest-direct asset-link family (operator order 2026-10-06): /api/v1/a/:token
 * — EXACTLY the upload family of its own asset (view + init/content/complete).
 * Upload-only by construction: there is no catalog, delivery, post or me
 * subroute; any other path is the neutral 404, and the token never
 * authenticates anywhere else (it is not a session or an API key).
 */
async function handleGuestAssetRoute(
  request: Request,
  deps: RequestDeps,
  segments: string[],
  requestId: string,
): Promise<Response> {
  const db = deps.db;
  const bucket = deps.env.ASSETS;
  try {
    const guest = await resolveGuestLinkAccess(db, segments[0] ?? '', requestId);
    const rest = segments.slice(1);

    // GET /api/v1/a/:token — minimal view (titles/state/expiry/quota).
    if (rest.length === 0 && request.method === 'GET') {
      return jsonResponse(await guestAssetLinkView(db, guest.link), 200, { 'cache-control': 'no-store' });
    }

    // POST /api/v1/a/:token/uploads — init with the client-quota reservation.
    if (rest.length === 1 && rest[0] === 'uploads' && request.method === 'POST') {
      const payload = await parseJsonBody(request);
      const input = validateGuestInitBody(payload);
      const result = await runIdempotent(db, {
        principal: guest.principal,
        clientId: guest.link.portalClientId,
        operation: 'asset_link.uploads.init',
        payload,
        rawKey: idempotencyKeyOf(request),
      }, 201, async () => guestLinkInitUpload(db, guest, input));
      return withNoStore(result);
    }

    // PUT /api/v1/a/:token/uploads/:sessionId/content
    if (rest.length === 3 && rest[0] === 'uploads' && rest[2] === 'content' && request.method === 'PUT') {
      const result = await guestLinkPutUploadContent(db, bucket, guest, rest[1]!, request.body);
      return jsonResponse(result, 200, { 'cache-control': 'no-store' });
    }

    // POST /api/v1/a/:token/uploads/:sessionId/complete
    if (rest.length === 3 && rest[0] === 'uploads' && rest[2] === 'complete' && request.method === 'POST') {
      const result = await guestLinkCompleteUpload(db, bucket, guest, rest[1]!, requestId);
      return jsonResponse(result, result.replayed ? 200 : 201, { 'cache-control': 'no-store' });
    }

    throw notFound('Unknown API route.');
  } catch (error) {
    return errorToResponse(error, requestId);
  }
}

/** Parsed body of POST /api/v1/asset-upload-links (mint). */
interface MintAssetLinkBody {
  studioProjectId: string;
  studioAssetId: string;
  portalClientId?: string;
  portalProjectId?: string;
  expiresIn?: string;
  origin?: string;
}

/** Body of POST /api/v1/asset-upload-links (mint). */
function validateMintAssetLinkBody(raw: unknown): MintAssetLinkBody {
  const body = requireObject(raw);
  const input: MintAssetLinkBody = {
    studioProjectId: typeof body.studioProjectId === 'string' ? body.studioProjectId : '',
    studioAssetId: typeof body.studioAssetId === 'string' ? body.studioAssetId : '',
  };
  if (body.portalClientId !== undefined && body.portalClientId !== null) {
    if (typeof body.portalClientId !== 'string') throw badRequest('portalClientId must be a string.');
    input.portalClientId = body.portalClientId;
  }
  if (body.portalProjectId !== undefined && body.portalProjectId !== null) {
    if (typeof body.portalProjectId !== 'string') throw badRequest('portalProjectId must be a string.');
    input.portalProjectId = body.portalProjectId;
  }
  if (body.expiresIn !== undefined) {
    if (typeof body.expiresIn !== 'string') throw badRequest('expiresIn must be a string.');
    input.expiresIn = body.expiresIn;
  }
  if (body.origin !== undefined) {
    if (typeof body.origin !== 'string') throw badRequest('origin must be a string.');
    input.origin = body.origin;
  }
  return input;
}

function validateCreateRequestBody(raw: unknown): CreateUploadRequestRequest {
  const body = requireObject(raw);
  const input: CreateUploadRequestRequest = {
    title: typeof body.title === 'string' ? body.title : '',
  };
  if (body.instructions !== undefined && body.instructions !== null) {
    if (typeof body.instructions !== 'string') throw badRequest('instructions must be a string.');
    input.instructions = body.instructions;
  }
  if (body.maxFiles !== undefined) {
    if (typeof body.maxFiles !== 'number' || !Number.isInteger(body.maxFiles)) {
      throw badRequest('maxFiles must be an integer.');
    }
    input.maxFiles = body.maxFiles;
  }
  if (body.maxBytes !== undefined) {
    if (typeof body.maxBytes !== 'number' || !Number.isInteger(body.maxBytes)) {
      throw badRequest('maxBytes must be an integer.');
    }
    input.maxBytes = body.maxBytes;
  }
  if (body.expiresIn !== undefined) {
    if (typeof body.expiresIn !== 'string') throw badRequest('expiresIn must be a string.');
    input.expiresIn = body.expiresIn;
  }
  return input;
}

/* eslint-disable @typescript-eslint/no-non-null-assertion */
async function route(
  method: string,
  segments: string[],
  ctx: RouteContext,
): Promise<Response> {
  const { request, deps, principal, requestId, url } = ctx;
  const db = deps.db;
  const bucket = deps.env.ASSETS;

  // /api/v1/me
  if (segments.length === 1 && segments[0] === 'me' && method === 'GET') {
    return jsonResponse(meInfo(principal), 200);
  }

  // /api/v1/clients
  if (segments.length === 1 && segments[0] === 'clients') {
    if (method === 'GET') {
      const page: Page<PortalClientView> = await listAuthorizedClients(db, principal, 'clients:read');
      return jsonResponse(page, 200);
    }
    throw notFound('Unknown API route.');
  }

  // /api/v1/clients/adopt
  if (segments.length === 2 && segments[0] === 'clients' && segments[1] === 'adopt' && method === 'POST') {
    const payload = await parseJsonBody(request);
    const body = requireObject(payload);
    const input = {
      workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : '',
      studioClientId: typeof body.studioClientId === 'string' ? body.studioClientId : '',
      name: typeof body.name === 'string' ? body.name : '',
    };
    const result = await runIdempotent(db, {
      principal,
      clientId: `workspace:${input.workspaceId}`,
      operation: 'clients.adopt',
      payload,
      rawKey: idempotencyKeyOf(request),
    }, 201, async () => {
      const adopted = await adoptClient(db, principal, input);
      await audit(deps, principal, input.workspaceId, adopted.client.id, 'client.adopt', 'portal_client', adopted.client.id, requestId);
      return adopted.client;
    });
    return result;
  }

  // /api/v1/clients/:clientId/...
  if (segments.length >= 3 && segments[0] === 'clients') {
    const clientId = segments[1]!;
    const sub = segments.slice(2);

    // GET materials list
    if (sub.length === 1 && sub[0] === 'materials' && method === 'GET') {
      const page = await listMaterialsForClient(db, principal, clientId, parseListOptions(url));
      return jsonResponse(page, 200);
    }

    // GET|POST projects — P-101 (R-1): list is admin + members of the client;
    // creation is admin-human-only (agents have no project operation,
    // contracts.md §5 additive). Creation is idempotent per
    // (client, studioProjectId): identical retries return the same pointer.
    if (sub.length === 1 && sub[0] === 'projects') {
      if (method === 'GET') {
        const page = await listProjectsForClient(db, principal, clientId);
        return jsonResponse(page, 200);
      }
      if (method === 'POST') {
        const payload = await parseJsonBody(request);
        const body = requireObject(payload);
        const input = {
          studioProjectId: typeof body.studioProjectId === 'string' ? body.studioProjectId : '',
          name: typeof body.name === 'string' ? body.name : '',
        };
        const result = await runIdempotent(db, {
          principal,
          clientId,
          operation: 'projects.create',
          payload,
          rawKey: idempotencyKeyOf(request),
        }, 201, async () => {
          const registered = await registerProjectPointer(db, principal, clientId, input);
          await audit(deps, principal, registered.project.workspaceId, clientId, 'project.created', 'portal_project', registered.project.id, requestId);
          return registered.project;
        });
        return result;
      }
      throw notFound('Unknown API route.');
    }

    // POST uploads init
    if (sub.length === 1 && sub[0] === 'uploads' && method === 'POST') {
      const payload = await parseJsonBody(request);
      const input = validateInitUploadBody(payload);
      const result = await runIdempotent(db, {
        principal,
        clientId,
        operation: 'uploads.init',
        payload,
        rawKey: idempotencyKeyOf(request),
      }, 201, async () => {
        const authorized = await authorizeClient(db, principal, clientId);
        const session = await initUploadSession(db, principal, clientId, authorized.client.workspaceId, input);
        await audit(deps, principal, authorized.client.workspaceId, clientId, 'upload.init', 'upload_session', session.uploadId, requestId);
        return session;
      });
      return result;
    }

    // POST deliveries create
    if (sub.length === 1 && sub[0] === 'deliveries' && method === 'POST') {
      const payload = await parseJsonBody(request);
      const result = await runIdempotent(db, {
        principal,
        clientId,
        operation: 'deliveries.create',
        payload,
        rawKey: idempotencyKeyOf(request),
      }, 201, async () => {
        const created = await createDelivery(db, principal, clientId, payload);
        await audit(deps, principal, created.delivery.workspaceId, clientId, 'delivery.create', 'delivery_revision', created.delivery.id, requestId);
        return created.delivery;
      });
      return result;
    }

    // GET assets list
    if (sub.length === 1 && sub[0] === 'assets' && method === 'GET') {
      const page = await listAssetsForClient(db, principal, clientId);
      return jsonResponse(page, 200);
    }

    // GET|POST posts
    if (sub.length === 1 && sub[0] === 'posts') {
      if (method === 'GET') {
        const page = await listPostsForClient(db, principal, clientId);
        return jsonResponse(page, 200);
      }
      if (method === 'POST') {
        const payload = await parseJsonBody(request);
        const result = await runIdempotent(db, {
          principal,
          clientId,
          operation: 'posts.create',
          payload,
          rawKey: idempotencyKeyOf(request),
        }, 201, async () => {
          const post = await createPost(db, principal, clientId, payload);
          await audit(deps, principal, null, clientId, 'post.create', 'post', post.id, requestId);
          return post;
        });
        return result;
      }
      throw notFound('Unknown API route.');
    }

    // GET grid (admin-only read; PATCH below mutates behind the CAS)
    if (sub.length === 1 && sub[0] === 'grid' && method === 'GET') {
      const state = await getGridState(db, principal, clientId);
      return jsonResponse(state, 200);
    }

    // POST access-links — admin human or agent key with `access:write` mints
    // a single-use Better Auth login URL for a client member (operator-
    // ordered, 2026-10-05). The URL exists only in this response body: it is
    // never logged or audited, and the mutation is deliberately NOT
    // idempotency-keyed (replay storage would persist minted URLs).
    if (sub.length === 1 && sub[0] === 'access-links' && method === 'POST') {
      const payload = await parseJsonBody(request);
      const body = requireObject(payload);
      const email = requireEmail(body.email);
      const expiresInSeconds = parseExpiresIn(body.expiresIn);
      const approvedOrigin = deps.portalOrigin ?? url.origin;
      let origin = approvedOrigin;
      if (typeof body.origin === 'string' && body.origin.trim().length > 0) {
        try {
          origin = new URL(body.origin.trim()).origin;
        } catch {
          throw badRequest('origin must be an absolute origin.');
        }
        if (origin !== approvedOrigin) {
          throw badRequest('origin does not match the portal approved origin.');
        }
      }
      const minted = await mintAccessLink(deps, principal, clientId, { email, expiresInSeconds, origin });
      await audit(deps, principal, minted.workspaceId, clientId, 'access-link.mint', 'membership', minted.membershipId, requestId);
      return jsonResponse(
        { url: minted.url, email: minted.email, expiresAt: minted.expiresAt, singleUse: true },
        201,
      );
    }

    // PATCH grid
    if (sub.length === 1 && sub[0] === 'grid' && method === 'PATCH') {
      const payload = requireObject(await parseJsonBody(request));
      const order = Array.isArray(payload.order) ? payload.order.map(String) : undefined;
      if (order === undefined) throw badRequest('order is required.');
      const versionFromBody = typeof payload.version === 'number' ? payload.version : undefined;
      if (versionFromBody === undefined && request.headers.get('if-match') === null) {
        throw badRequest('version (body) or If-Match is required.');
      }
      const state = await patchGrid(db, principal, clientId, { version: versionFromBody ?? 0, order }, request.headers.get('if-match'));
      await audit(deps, principal, null, clientId, 'grid.reorder', 'client_grid', clientId, requestId);
      return jsonResponse(state, 200);
    }

    throw notFound('Unknown API route.');
  }

  // /api/v1/materials/:id[/content] — P-005 correction: the outer guard was
  // `length >= 3`, which made the `length === 2` show branch dead code and
  // 404'd every `GET /api/v1/materials/:id` (contracts.md §6 route).
  if (segments.length >= 2 && segments[0] === 'materials') {
    const materialId = segments[1]!;
    if (segments.length === 3 && segments[2] === 'content' && (method === 'GET' || method === 'HEAD')) {
      const outcome = await serveMaterialContent(db, bucket, principal, materialId, request);
      if (!outcome.ok) throw notFound();
      return outcome.response;
    }
    if (segments.length === 2 && method === 'GET') {
      const row = await getMaterialForPrincipal(db, principal, materialId, 'materials:read');
      return jsonResponse(
        {
          id: row.id,
          clientId: row.clientId,
          name: row.originalName ?? row.id,
          mediaType: row.mediaType,
          bytes: row.bytes,
          sha256: row.sha256,
          status: 'ready',
          createdAt: row.createdMs,
        },
        200,
      );
    }
    throw notFound('Unknown API route.');
  }

  // /api/v1/uploads/:id/(content|complete)
  if (segments.length === 3 && segments[0] === 'uploads') {
    const uploadId = segments[1]!;
    if (segments[2] === 'content' && method === 'PUT') {
      const result = await putUploadContent(db, bucket, principal, uploadId, request.body);
      return jsonResponse({ uploadId, status: 'staged', ...result }, 200);
    }
    if (segments[2] === 'complete' && method === 'POST') {
      // P-101 (R-1): an empty body keeps the free v1 path byte-identical; a
      // body may carry portalProjectId for material attribution.
      const completeBody = requireObject(await parseJsonBody(request));
      const attribution: CompleteUploadRequest | undefined =
        completeBody.portalProjectId === undefined ? undefined : { portalProjectId: completeBody.portalProjectId as string };
      const completed = await completeUploadSession(db, bucket, principal, uploadId, attribution);
      if (completed.kind === 'material') {
        await audit(deps, principal, null, completed.material.clientId, 'upload.complete', 'material', completed.material.id, requestId);
        return jsonResponse(completed.material, completed.replayed ? 200 : 201);
      }
      await audit(deps, principal, null, completed.output.deliveryId, 'upload.complete', 'delivery_output', completed.output.id, requestId);
      return jsonResponse(
        {
          deliveryId: completed.deliveryId,
          output: {
            name: completed.output.name,
            mediaType: completed.output.mediaType,
            bytes: completed.output.bytes,
            sha256: completed.output.sha256,
            ready: completed.output.objectKey !== null,
          },
        },
        completed.replayed ? 200 : 201,
      );
    }
    throw notFound('Unknown API route.');
  }

  // /api/v1/deliveries/:id/(complete|outputs/:name)
  if (segments.length >= 3 && segments[0] === 'deliveries') {
    const deliveryId = segments[1]!;
    if (segments.length === 3 && segments[2] === 'complete' && method === 'POST') {
      const view = await completeDelivery(db, bucket, principal, deliveryId);
      await audit(deps, principal, view.workspaceId, view.clientId, 'delivery.complete', 'delivery_revision', view.id, requestId);
      return jsonResponse(view, 200);
    }
    if (
      segments.length === 4 &&
      segments[2] === 'outputs' &&
      (method === 'GET' || method === 'HEAD')
    ) {
      const outputName = segments[3]!;
      const outcome = await serveDeliveryOutput(db, bucket, principal, deliveryId, outputName, request);
      if (!outcome.ok) throw notFound();
      return outcome.response;
    }
    throw notFound('Unknown API route.');
  }

  // /api/v1/projects/:projectId — P-101 (R-1) display-title rename; the
  // service enforces admin-human-only AFTER resource/client resolution so
  // foreign principals keep the v1 404 and authorized members get 403.
  if (segments.length === 2 && segments[0] === 'projects' && method === 'PATCH') {
    const payload = requireObject(await parseJsonBody(request));
    const name = typeof payload.name === 'string' ? payload.name : '';
    const view = await renameProject(db, principal, segments[1]!, name);
    await audit(deps, principal, view.workspaceId, view.portalClientId, 'project.renamed', 'portal_project', view.id, requestId);
    return jsonResponse(view, 200);
  }

  // /api/v1/projects/:projectId/requests — P-102 (R-2): list (admin + client
  // members + agents with `requests:read`) and create (admin human or
  // `requests:write`; the service enforces after project resolution, so
  // foreign principals keep the v1 404).
  if (segments.length === 3 && segments[0] === 'projects' && segments[2] === 'requests') {
    const projectId = segments[1]!;
    if (method === 'GET') {
      const page = await listRequestsForProject(db, principal, projectId, requestId);
      return jsonResponse(page, 200);
    }
    if (method === 'POST') {
      const payload = await parseJsonBody(request);
      const input = validateCreateRequestBody(payload);
      const result = await runIdempotent(db, {
        principal,
        clientId: `project:${projectId}`,
        operation: 'requests.create',
        payload,
        rawKey: idempotencyKeyOf(request),
      }, 201, async () => {
        const created = await createUploadRequest(db, principal, projectId, input);
        await audit(deps, principal, created.workspaceId, created.request.portalClientId, 'request.created', 'upload_request', created.request.id, requestId);
        return created.request;
      });
      return result;
    }
    throw notFound('Unknown API route.');
  }

  // /api/v1/requests/:id[/link|/close|/materials] — P-102 (R-2). Visibility
  // and scope rules live in the service AFTER resource resolution (unknown or
  // foreign request ids stay the v1 404; authorized members get 403).
  if (segments.length >= 2 && segments[0] === 'requests') {
    const reqId = segments[1]!;
    if (segments.length === 2 && method === 'GET') {
      const result = await getRequestForPrincipal(db, principal, reqId, requestId);
      return jsonResponse(result.request, 200);
    }
    if (segments.length === 3 && segments[2] === 'materials' && method === 'GET') {
      const page = await listRequestMaterials(db, principal, reqId);
      return jsonResponse(page, 200);
    }
    if (segments.length === 3 && segments[2] === 'close' && method === 'POST') {
      const payload = requireObject(await parseJsonBody(request));
      const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
      const result = await closeUploadRequest(db, principal, reqId, reason);
      await audit(deps, principal, result.workspaceId, result.request.portalClientId, 'request.closed', 'upload_request', result.request.id, requestId);
      return jsonResponse(result.request, 200);
    }
    // POST /api/v1/requests/:id/link — mint/rotate the guest link. NOT
    // idempotency-keyed (like access-links): replay storage would persist a
    // minted URL. The URL exists only in this response body.
    if (segments.length === 3 && segments[2] === 'link' && method === 'POST') {
      const payload = await parseJsonBody(request);
      const body = requireObject(payload);
      const expiresInSeconds = parseExpiresIn(body.expiresIn);
      const approvedOrigin = deps.portalOrigin ?? url.origin;
      let origin = approvedOrigin;
      if (typeof body.origin === 'string' && body.origin.trim().length > 0) {
        try {
          origin = new URL(body.origin.trim()).origin;
        } catch {
          throw badRequest('origin must be an absolute origin.');
        }
        if (origin !== approvedOrigin) {
          throw badRequest('origin does not match the portal approved origin.');
        }
      }
      const minted = await mintRequestLink(deps, principal, reqId, { expiresInSeconds, origin }, requestId);
      return jsonResponse(
        { url: minted.url, requestId: minted.requestId, tokenId: minted.tokenId, expiresAt: minted.expiresAt, limits: minted.limits },
        201,
      );
    }
    throw notFound('Unknown API route.');
  }

  // /api/v1/asset-upload-links — operator order 2026-10-06 (contratos
  // aditivos §9). POST mints (admin human or agent `assets:write`; NOT
  // idempotency-keyed: replay storage would persist a minted URL); GET lists
  // (admin); GET /materials?asset= resolves the per-asset import set (admin
  // or agent `materials:read`); GET /:id and POST /:id/close are admin.
  if (segments.length >= 1 && segments[0] === 'asset-upload-links') {
    if (segments.length === 1 && method === 'POST') {
      const payload = await parseJsonBody(request);
      const body = validateMintAssetLinkBody(payload);
      const expiresInSeconds = parseExpiresIn(body.expiresIn);
      const approvedOrigin = deps.portalOrigin ?? url.origin;
      let origin = approvedOrigin;
      if (typeof body.origin === 'string' && body.origin.trim().length > 0) {
        try {
          origin = new URL(body.origin.trim()).origin;
        } catch {
          throw badRequest('origin must be an absolute origin.');
        }
        if (origin !== approvedOrigin) {
          throw badRequest('origin does not match the portal approved origin.');
        }
      }
      const minted = await mintAssetUploadLink(deps, principal, {
        studioProjectId: body.studioProjectId,
        studioAssetId: body.studioAssetId,
        ...(body.portalClientId !== undefined ? { portalClientId: body.portalClientId } : {}),
        ...(body.portalProjectId !== undefined ? { portalProjectId: body.portalProjectId } : {}),
        expiresInSeconds,
        origin,
      }, requestId);
      return jsonResponse(minted.view, 201);
    }
    if (segments.length === 1 && method === 'GET') {
      const clientFilter = url.searchParams.get('client') ?? undefined;
      const assetFilter = url.searchParams.get('asset') ?? undefined;
      const page = await listAssetUploadLinks(db, principal, {
        ...(clientFilter !== undefined ? { portalClientId: clientFilter } : {}),
        ...(assetFilter !== undefined ? { studioAssetId: assetFilter } : {}),
      }, requestId);
      return jsonResponse(page, 200);
    }
    // Exact-segment check BEFORE the :id routes (ids are UUIDs, but order
    // makes the reserved word unambiguous).
    if (segments.length === 2 && segments[1] === 'materials' && method === 'GET') {
      const asset = url.searchParams.get('asset');
      if (asset === null || asset.length === 0) throw badRequest('asset query parameter is required.');
      const clientFilter = url.searchParams.get('client') ?? undefined;
      const page = await listMaterialsByAssetTarget(db, principal, asset, {
        ...(clientFilter !== undefined ? { portalClientId: clientFilter } : {}),
      });
      return jsonResponse(page, 200);
    }
    if (segments.length === 2 && method === 'GET') {
      const result = await getAssetUploadLink(db, principal, segments[1]!, requestId);
      return jsonResponse(result.link, 200);
    }
    if (segments.length === 3 && segments[1] !== 'materials' && segments[2] === 'close' && method === 'POST') {
      const payload = requireObject(await parseJsonBody(request));
      const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
      const result = await closeAssetUploadLink(db, principal, segments[1]!, reason, requestId);
      return jsonResponse(result.link, 200);
    }
    throw notFound('Unknown API route.');
  }

  // /api/v1/posts/:id
  if (segments.length === 2 && segments[0] === 'posts' && method === 'PATCH') {
    const payload = await parseJsonBody(request);
    const view = await updatePost(db, principal, segments[1]!, payload, request.headers.get('if-match'));
    await audit(deps, principal, null, view.clientId, 'post.update', 'post', view.id, requestId);
    return jsonResponse(view, 200);
  }

  // /api/v1/client-assets/:id/visibility
  if (segments.length === 3 && segments[0] === 'client-assets' && segments[2] === 'visibility' && method === 'PATCH') {
    requireAdmin(principal); // fail fast on role before resource resolution
    const payload = requireObject(await parseJsonBody(request));
    const visibility = requireVisibility(payload.visibility);
    const view = await setAssetVisibility(db, principal, segments[1]!, visibility);
    await audit(deps, principal, null, view.clientId, 'asset.visibility', 'client_asset', view.id, requestId);
    return jsonResponse(view, 200);
  }

  throw notFound('Unknown API route.');
}
/* eslint-enable @typescript-eslint/no-non-null-assertion */

/**
 * Entry point for every /api/v1/* request. R-2: guest-direct routes
 * (`/api/v1/r/:token`) resolve by capability token and run BEFORE the v1
 * principal machinery — no session cookie or api key is read or set there.
 * Everything else resolves the principal (401 when absent), dispatches, and
 * renders every failure through the typed envelope.
 */
export async function handlePortalApiV1(request: Request, deps: RequestDeps): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter((s) => s.length > 0);
    if (segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'r') {
      return await handleGuestRoute(request, deps, segments.slice(3), requestId);
    }
    // Operator order 2026-10-06: the asset-link guest family resolves by
    // capability token and runs BEFORE the v1 principal machinery — the token
    // is never read as a session cookie or an API key there.
    if (segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'a') {
      return await handleGuestAssetRoute(request, deps, segments.slice(3), requestId);
    }
    const principal = await resolvePrincipal(deps, request);
    if (principal === null) throw unauthorized();
    if (segments[0] !== 'api' || segments[1] !== 'v1') {
      throw notFound('Unknown API route.');
    }
    const method = request.method;
    return await route(method, segments.slice(2), { request, deps, principal, requestId, url });
  } catch (error) {
    return errorToResponse(error, requestId);
  }
}
