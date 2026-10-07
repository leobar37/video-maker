/**
 * Test support for the portal bridge (gate G-cap-live): an IN-PROCESS fake
 * portal origin bound to 127.0.0.1:0 (ephemeral, no DNS, no real network) plus
 * a Studio workspace fixture. The fake mimics ONLY the v1 surface the CLI
 * uses, with the same envelope/pages/error semantics as contracts.md §6, and
 * records every request (method, path, key header) so tests can assert
 * exactly which bytes travelled and which credentials were sent.
 *
 * This module is test infrastructure; bun test never imports it in
 * production paths.
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256Hex } from '@videomaker/schemas';
import type { MaterialView, OutputRef, PortalClientView, PortalProjectView, UploadRequestState, UploadRequestView, UploadSessionView, V1MediaType } from '@videomaker/customer-assets';

// ---------------------------------------------------------------------------
// Fake portal origin
// ---------------------------------------------------------------------------

export type FakeAuthMode = 'ok' | 'expired' | 'revoked' | 'forbidden';

export interface FakeRequest {
  method: string;
  path: string;
  apiKey: string | null;
  bodyText: string | null;
}

export interface FakeDeliveryOutput {
  ref: OutputRef;
  bytes: Uint8Array | null;
}

export interface FakeDelivery {
  id: string;
  clientId: string;
  projectId: string;
  assetId: string;
  revisionId: string;
  rootHash: string;
  title: string;
  kind: string;
  status: 'pending' | 'ready' | 'failed';
  outputs: Map<string, FakeDeliveryOutput>;
  createdAt: number;
}

/** Internal fake upload-request row (R-3): view + active token + materials. */
export interface FakeUploadRequest {
  view: UploadRequestView;
  /** SHA-256 of the ACTIVE capability token (null = none minted/alive). */
  tokenHash: string | null;
  tokenExpiresAt: number;
  /** Material ids completed through this request, in completion order. */
  materialIds: string[];
}

export interface FakeUploadRequestSnapshot {
  request: UploadRequestView;
  materialIds: string[];
}

/** A minted guest link: raw token + URL (tests only; never logged). */
export interface FakeMintedRequestLink {
  url: string;
  token: string;
  requestId: string;
  expiresAt: number;
  limits: { maxFiles: number; maxBytes: number };
}

/** Internal fake per-asset upload link (operator order 2026-10-06). */
export interface FakeAssetLink {
  id: string;
  portalClientId: string;
  portalProjectId: string | null;
  studioProjectId: string;
  studioAssetId: string;
  state: 'open' | 'used' | 'closed' | 'expired';
  expiresAt: number;
  createdAt: number;
  closedAt: number | null;
  closeReason: string | null;
  /** SHA-256 of the ACTIVE capability token (rotation nulls the prior). */
  tokenHash: string | null;
  tokenExpiresAt: number;
  /** Material ids completed through this link, in completion order. */
  materialIds: string[];
}

export interface FakeAssetLinkSnapshot {
  link: Omit<FakeAssetLink, 'tokenHash' | 'tokenExpiresAt'>;
  materialIds: string[];
}

/** A minted per-asset link: raw token + URL (tests only; never logged). */
export interface FakeMintedAssetLink {
  url: string;
  token: string;
  linkId: string;
  expiresAt: number;
}

export interface FakePortal {
  origin: string;
  port: number;
  apiKey: string;
  readonly requests: FakeRequest[];
  seedClient(input: { workspaceId: string; studioClientId: string; name: string; quotaBytes?: number }): PortalClientView;
  seedMaterial(input: { clientId: string; name: string; mediaType: MaterialView['mediaType']; bytes: Uint8Array }): Promise<MaterialView>;
  /** Corrupts the SERVED bytes while keeping the registered sha (drift probe). */
  swapMaterialBytes(materialId: string, bytes: Uint8Array): void;
  /** Seeds a PortalProject pointer (R-1 projection) for a seeded client. */
  seedProject(input: { clientId: string; studioProjectId: string; name: string }): PortalProjectView;
  /** Seeds an open upload request with a first minted guest link (R-3). */
  seedRequest(input: { projectId: string; clientId: string; title: string; instructions?: string; maxFiles: number; maxBytes: number; expiresIn?: string }): FakeMintedRequestLink & { request: UploadRequestView };
  /** Snapshots of every seeded/created upload request (view + materials). */
  portalRequests(): FakeUploadRequestSnapshot[];
  /** Seeds an open per-asset upload link with its first minted token (2026-10-06). */
  seedAssetLink(input: { clientId: string; studioProjectId: string; studioAssetId: string; expiresIn?: string }): FakeMintedAssetLink & { link: FakeAssetLink };
  /** Snapshots of every seeded/created per-asset link (no token material). */
  assetLinks(): FakeAssetLinkSnapshot[];
  /**
   * Forces a per-asset link into a terminal state (ingest-server probes):
   * `closed` kills the token (guest view 404, like the real admin close);
   * `expired` stays resolvable so the view shows the terminal state (200 +
   * `state: 'expired'`) while every upload must be refused.
   */
  settleAssetLink(linkId: string, reason: 'closed' | 'expired'): void;
  deliveries(): FakeDelivery[];
  stop(): Promise<void>;
}

export interface FakePortalOptions {
  apiKey?: string;
  authMode?: FakeAuthMode;
  /**
   * Server-side scopes of the fake principal (R-3): omit for the full v1+R-3
   * set; pass a narrower list to exercise FORBIDDEN envelopes (e.g. an
   * "old-scope" agent without requests:read/requests:write).
   */
  scopes?: string[];
  /** Respond 302 for this exact path (redirect-credential-leak probe). */
  redirect?: { path: string; location: string };
  /** Answer with this error the FIRST time `path` is hit, then serve normally. */
  failOnce?: { path: string; status: number; code: string; message: string };
}

const FAKE_SCOPES = [
  'clients:read',
  'clients:write',
  'materials:read',
  'materials:write',
  'deliveries:read',
  'deliveries:write',
  'access:write',
  'requests:read',
  'requests:write',
  // Operator order 2026-10-06 (asset upload links).
  'assets:write',
];

/** Fixed per-file cap for guest uploads (simplified v1 type limits). */
const FAKE_GUEST_FILE_CAP = 512 * 1_048_576;

/** Sync digest for token hashing inside the in-process fake (Bun runtime). */
function sha256HexSync(text: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(text);
  return hasher.digest('hex');
}

/** `<n>m|h|d` bounded 30m..30d, default 7d — mirrors parseExpiresIn; -1 invalid. */
function parseFakeExpiresIn(raw: unknown): number {
  if (raw === undefined) return 7 * 24 * 3_600;
  if (typeof raw !== 'string' || !/^(\d+)(m|h|d)$/.test(raw)) return -1;
  const match = /^(\d+)(m|h|d)$/.exec(raw)!;
  const amount = Number.parseInt(match[1]!, 10);
  const seconds = amount * (match[2] === 'm' ? 60 : match[2] === 'h' ? 3_600 : 86_400);
  if (seconds < 30 * 60 || seconds > 30 * 24 * 3_600) return -1;
  return seconds;
}

export async function startFakePortal(options: FakePortalOptions = {}): Promise<FakePortal> {
  const apiKey = options.apiKey ?? 'fake-portal-key';
  const authMode: FakeAuthMode = options.authMode ?? 'ok';
  const scopes = options.scopes ?? FAKE_SCOPES;
  const clients = new Map<string, PortalClientView>();
  const materials = new Map<string, { view: MaterialView; bytes: Uint8Array; assetTarget?: string; linkId?: string }>();
  const deliveries = new Map<string, FakeDelivery>();
  const uploads = new Map<string, { session: UploadSessionView; expectedSha256: string | null; bytes: Uint8Array | null; output: FakeDeliveryOutput | null }>();
  const idempotency = new Map<string, { fingerprint: string; status: number; body: string }>();
  // R-3 fake state (dual CAS simplified but consistent):
  const projects = new Map<string, PortalProjectView>();
  const uploadRequests = new Map<string, FakeUploadRequest>();
  const requestByTokenHash = new Map<string, string>();
  // Operator order 2026-10-06: per-asset upload links (rotation + quota
  // simplified, semantics consistent with the real server).
  const assetLinks = new Map<string, FakeAssetLink>();
  const assetLinkByTokenHash = new Map<string, string>();
  const assetGuestSessions = new Map<string, { session: { uploadId: string; mediaType: V1MediaType; declaredBytes: number; status: 'pending' | 'staged' | 'ready' | 'failed'; expiresAt: number; guestHash: string; linkId: string; name: string | null }; expectedSha256: string | null; bytes: Uint8Array | null }>();
  const guestSessions = new Map<string, { session: { uploadId: string; mediaType: V1MediaType; declaredBytes: number; status: 'pending' | 'staged' | 'ready' | 'failed'; expiresAt: number; guestHash: string; requestId: string; name: string | null }; expectedSha256: string | null; bytes: Uint8Array | null }>();
  const quotaByClient = new Map<string, { limitBytes: number; reservedBytes: number }>();
  const requests: FakeRequest[] = [];
  let sequence = 0;
  let failOnceServed = false;

  const nextId = (prefix: string): string => `${prefix}-${(sequence += 1)}`;

  const json = (status: number, value: unknown): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  const failJson = (status: number, code: string, message: string): Response =>
    json(status, { error: { code, message, requestId: nextId('req') } });

  const guard = (request: Request, url: URL, guestRoute: boolean): Response | null => {
    if (options.redirect !== undefined && url.pathname === options.redirect.path) {
      requests.push({ method: request.method, path: url.pathname, apiKey: request.headers.get('x-api-key'), bodyText: null });
      return new Response(null, { status: 302, headers: { location: options.redirect.location } });
    }
    if (options.failOnce !== undefined && url.pathname.startsWith(options.failOnce.path) && !failOnceServed) {
      failOnceServed = true;
      requests.push({ method: request.method, path: url.pathname, apiKey: request.headers.get('x-api-key'), bodyText: null });
      return failJson(options.failOnce.status, options.failOnce.code, options.failOnce.message);
    }
    // Guest-direct routes (R-3) resolve by capability token in the path: no
    // session, no cookie and NO api key is read or required (contracts §3).
    if (guestRoute) return null;
    if (authMode !== 'ok') {
      if (authMode === 'forbidden') return failJson(403, 'forbidden', 'Missing required scope: deliveries:write');
      return failJson(401, 'unauthorized', authMode === 'expired' ? 'The API key has expired.' : 'The API key has been revoked.');
    }
    const keyHeader = request.headers.get('x-api-key');
    if (keyHeader === null || keyHeader.length === 0) {
      return failJson(401, 'unauthorized', 'Authentication required.');
    }
    if (keyHeader !== apiKey) {
      return failJson(401, 'unauthorized', 'Invalid API key.');
    }
    return null;
  };

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter((segment) => segment.length > 0).slice(2); // after api/v1
    const guardResponse = guard(request, url, segments[0] === 'r' || segments[0] === 'a');
    if (guardResponse !== null) return guardResponse;
    const method = request.method;
    // Read the body EXACTLY once: binary-safe for PUT content, decoded for
    // JSON routes and the request log.
    const bodyBytes = method === 'GET' || method === 'HEAD' ? null : new Uint8Array(await request.arrayBuffer());
    const bodyText = bodyBytes === null ? null : new TextDecoder().decode(bodyBytes);
    requests.push({ method, path: url.pathname, apiKey: request.headers.get('x-api-key'), bodyText });

    // GET /me
    if (segments.length === 1 && segments[0] === 'me' && method === 'GET') {
      return json(200, { me: { kind: 'agent', userId: 'agent-user-1', scopes } });
    }

    // GET /clients
    if (segments.length === 1 && segments[0] === 'clients' && method === 'GET') {
      const items = [...clients.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
      return json(200, paginate(items, url));
    }

    // POST /clients/adopt
    if (segments.length === 2 && segments[0] === 'clients' && segments[1] === 'adopt' && method === 'POST') {
      const body = JSON.parse(requests[requests.length - 1]!.bodyText ?? '{}') as Record<string, unknown>;
      const fingerprint = JSON.stringify(body);
      const idemKey = request.headers.get('idempotency-key');
      if (idemKey !== null) {
        const replay = idempotency.get(`adopt:${idemKey}`);
        if (replay !== undefined) {
          if (replay.fingerprint !== fingerprint) return failJson(409, 'conflict', 'Idempotency key reused with a different payload.');
          return json(replay.status, JSON.parse(replay.body));
        }
      }
      const workspaceId = String(body.workspaceId ?? '');
      const studioClientId = String(body.studioClientId ?? '');
      const name = String(body.name ?? '');
      for (const existing of clients.values()) {
        if (existing.workspaceId === workspaceId && existing.studioClientId === studioClientId) {
          if (existing.name !== name) return failJson(409, 'conflict', 'Client already adopted with a different name.');
          if (idemKey !== null) idempotency.set(`adopt:${idemKey}`, { fingerprint, status: 200, body: JSON.stringify(existing) });
          return json(200, existing);
        }
      }
      if (workspaceId.length === 0 || studioClientId.length === 0 || name.length === 0) {
        return failJson(400, 'bad_request', 'workspaceId, studioClientId and name are required.');
      }
      const view: PortalClientView = { id: nextId('pc'), workspaceId, studioClientId, name, projectionVersion: 1, createdAt: Date.now() };
      clients.set(view.id, view);
      if (idemKey !== null) idempotency.set(`adopt:${idemKey}`, { fingerprint, status: 200, body: JSON.stringify(view) });
      return json(200, view);
    }

    // GET /clients/:clientId/materials
    if (segments.length === 3 && segments[0] === 'clients' && segments[2] === 'materials' && method === 'GET') {
      const clientId = segments[1]!;
      const items = [...materials.values()].map((entry) => entry.view).filter((view) => view.clientId === clientId).sort((a, b) => (a.id < b.id ? -1 : 1));
      return json(200, paginate(items, url));
    }

    // GET /materials/:id
    if (segments.length === 2 && segments[0] === 'materials' && method === 'GET') {
      const entry = materials.get(segments[1]!);
      if (entry === undefined) return failJson(404, 'not_found', 'Material not found.');
      return json(200, entry.view);
    }

    // GET /materials/:id/content — raw bytes, private origin only.
    if (segments.length === 3 && segments[0] === 'materials' && segments[2] === 'content' && method === 'GET') {
      const entry = materials.get(segments[1]!);
      if (entry === undefined) return failJson(404, 'not_found', 'Material not found.');
      return new Response(new Uint8Array(entry.bytes), { status: 200, headers: { 'content-type': entry.view.mediaType, 'x-content-type-options': 'nosniff' } });
    }

    // POST /clients/:clientId/uploads
    if (segments.length === 3 && segments[0] === 'clients' && segments[2] === 'uploads' && method === 'POST') {
      const clientId = segments[1]!;
      const body = JSON.parse(requests[requests.length - 1]!.bodyText ?? '{}') as Record<string, unknown>;
      const fingerprint = JSON.stringify(body);
      const idemKey = request.headers.get('idempotency-key');
      const idemId = `upload:${clientId}:${idemKey}`;
      if (idemKey !== null) {
        const replay = idempotency.get(idemId);
        if (replay !== undefined) {
          if (replay.fingerprint !== fingerprint) return failJson(409, 'conflict', 'Idempotency key reused with a different payload.');
          return json(replay.status, JSON.parse(replay.body));
        }
      }
      if (body.kind !== 'delivery_output') return failJson(400, 'bad_request', 'Fake portal supports delivery_output uploads only in this suite.');
      const delivery = deliveries.get(String(body.deliveryId ?? ''));
      if (delivery === undefined) return failJson(404, 'not_found', 'Delivery not found.');
      if (delivery.status === 'ready') return failJson(409, 'conflict', 'This delivery is already complete.');
      const outputName = String(body.outputName ?? '');
      const output = delivery.outputs.get(outputName);
      if (output === undefined) return failJson(404, 'not_found', 'Output not part of the delivery.');
      if (output.bytes !== null) return failJson(409, 'conflict', 'This output was already staged.');
      if (body.sha256 !== output.ref.sha256 || body.declaredBytes !== output.ref.bytes || body.mediaType !== output.ref.mediaType) {
        return failJson(409, 'conflict', 'Upload declaration does not match the selected output.');
      }
      const session: UploadSessionView = {
        uploadId: nextId('up'),
        clientId,
        kind: 'delivery_output',
        mediaType: output.ref.mediaType,
        declaredBytes: output.ref.bytes,
        status: 'pending',
        expiresAt: Date.now() + 3_600_000,
      };
      uploads.set(session.uploadId, { session, expectedSha256: output.ref.sha256, bytes: null, output });
      if (idemKey !== null) idempotency.set(idemId, { fingerprint, status: 200, body: JSON.stringify(session) });
      return json(200, session);
    }

    // PUT /uploads/:id/content
    if (segments.length === 3 && segments[0] === 'uploads' && segments[2] === 'content' && method === 'PUT') {
      const uploadId = segments[1]!;
      const upload = uploads.get(uploadId);
      if (upload === undefined) return failJson(404, 'not_found', 'Upload session not found.');
      if (upload.session.status === 'staged') return failJson(409, 'conflict', 'Upload content was already received; call complete instead of re-uploading.');
      if (upload.session.status !== 'pending') return failJson(409, 'conflict', `Upload session is ${upload.session.status} and cannot accept content.`);
      const bodyBytesVerified = bodyBytes ?? new Uint8Array();
      const digest = await sha256Hex(bodyBytesVerified);
      if (upload.expectedSha256 !== null && digest !== upload.expectedSha256) {
        return failJson(422, 'bad_request', 'Staged bytes failed server-side verification.');
      }
      upload.bytes = bodyBytesVerified;
      upload.session.status = 'staged';
      if (upload.output !== null) {
        upload.output.bytes = bodyBytesVerified;
      }
      return json(200, { uploadId, status: 'staged', bytes: bodyBytesVerified.length, sha256: digest, mediaType: upload.session.mediaType });
    }

    // POST /uploads/:id/complete — finalizes staging into the delivery output
    // (same semantics as the real app: the PUT only stages; P-005 alignment).
    if (segments.length === 3 && segments[0] === 'uploads' && segments[2] === 'complete' && method === 'POST') {
      const uploadId = segments[1]!;
      const upload = uploads.get(uploadId);
      if (upload === undefined) return failJson(404, 'not_found', 'Upload session not found.');
      const outputView = {
        name: upload.output?.ref.name ?? '',
        mediaType: upload.session.mediaType,
        bytes: upload.bytes?.length ?? 0,
        sha256: upload.expectedSha256 ?? '',
        ready: upload.session.status === 'ready' || upload.session.status === 'staged',
      };
      if (upload.session.status === 'ready') return json(200, { output: outputView });
      if (upload.session.status !== 'staged') return failJson(409, 'conflict', 'Upload content has not been received yet.');
      upload.session.status = 'ready';
      return json(201, { output: outputView });
    }

    // POST /clients/:clientId/deliveries
    if (segments.length === 3 && segments[0] === 'clients' && segments[2] === 'deliveries' && method === 'POST') {
      const clientId = segments[1]!;
      const body = JSON.parse(requests[requests.length - 1]!.bodyText ?? '{}') as Record<string, unknown>;
      const fingerprint = JSON.stringify(body);
      const idemKey = request.headers.get('idempotency-key');
      const idemId = `delivery:${clientId}:${idemKey}`;
      if (idemKey !== null) {
        const replay = idempotency.get(idemId);
        if (replay !== undefined) {
          if (replay.fingerprint !== fingerprint) return failJson(409, 'conflict', 'Idempotency key reused with a different payload.');
          return json(replay.status, JSON.parse(replay.body));
        }
      }
      const revisionId = String(body.revisionId ?? '');
      for (const existing of deliveries.values()) {
        if (existing.revisionId === revisionId) {
          const existingNames = [...existing.outputs.keys()].sort().join(',');
          const incomingNames = (Array.isArray(body.outputs) ? body.outputs : []).map((output) => String((output as Record<string, unknown>).name)).sort().join(',');
          if (existingNames !== incomingNames || existing.rootHash !== String(body.rootHash ?? '')) {
            return failJson(409, 'conflict', 'This Studio revision was already delivered with different outputs.');
          }
          return json(200, deliveryViewOf(existing));
        }
      }
      const rawOutputs = Array.isArray(body.outputs) ? body.outputs as Array<Record<string, unknown>> : [];
      if (typeof body.rootHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.rootHash) || rawOutputs.length === 0) {
        return failJson(400, 'bad_request', 'rootHash (64 hex) and a non-empty outputs list are required.');
      }
      const delivery: FakeDelivery = {
        id: nextId('dlv'),
        clientId,
        projectId: String(body.projectId ?? ''),
        assetId: String(body.assetId ?? ''),
        revisionId,
        rootHash: body.rootHash,
        title: String(body.title ?? ''),
        kind: String(body.kind ?? ''),
        status: 'pending',
        outputs: new Map(rawOutputs.map((output) => [String(output.name), {
          ref: { name: String(output.name), mediaType: String(output.mediaType) as OutputRef['mediaType'], bytes: Number(output.bytes), sha256: String(output.sha256) },
          bytes: null,
        }])),
        createdAt: Date.now(),
      };
      deliveries.set(delivery.id, delivery);
      const view = deliveryViewOf(delivery);
      if (idemKey !== null) idempotency.set(idemId, { fingerprint, status: 200, body: JSON.stringify(view) });
      return json(200, view);
    }

    // POST /deliveries/:id/complete
    if (segments.length === 3 && segments[0] === 'deliveries' && segments[2] === 'complete' && method === 'POST') {
      const delivery = deliveries.get(segments[1]!);
      if (delivery === undefined) return failJson(404, 'not_found', 'Delivery not found.');
      if (delivery.status === 'ready') return json(200, deliveryViewOf(delivery));
      const missing = [...delivery.outputs.values()].filter((output) => output.bytes === null);
      if (missing.length > 0) return failJson(409, 'conflict', `Delivery has ${missing.length} unstaged output(s); stage them before completing.`);
      delivery.status = 'ready';
      return json(200, deliveryViewOf(delivery));
    }

    // GET /clients/:clientId/assets
    if (segments.length === 3 && segments[0] === 'clients' && segments[2] === 'assets' && method === 'GET') {
      const clientId = segments[1]!;
      const items = [...deliveries.values()].filter((delivery) => delivery.clientId === clientId && delivery.status === 'ready').sort((a, b) => (a.id < b.id ? -1 : 1)).map((delivery) => ({
        id: `ca-${delivery.id}`,
        clientId,
        deliveryId: delivery.id,
        title: delivery.title,
        revisionId: delivery.revisionId,
        visibility: 'internal',
        editorialStatus: 'draft',
        outputs: [...delivery.outputs.values()].map((output) => output.ref),
        createdAt: delivery.createdAt,
        rootHash: delivery.rootHash,
      }));
      return json(200, paginate(items, url));
    }

    // POST /clients/:clientId/access-links — same envelope as the real v1
    // surface: single-use login URL with expiry (fake token, fake origin).
    if (segments.length === 3 && segments[0] === 'clients' && segments[2] === 'access-links' && method === 'POST') {
      const body = JSON.parse(requests[requests.length - 1]!.bodyText ?? '{}') as Record<string, unknown>;
      const email = String(body.email ?? '');
      if (email.length === 0 || !email.includes('@')) {
        return failJson(400, 'bad_request', 'email is required.');
      }
      const rawExpiresIn = body.expiresIn;
      if (rawExpiresIn !== undefined && (typeof rawExpiresIn !== 'string' || !/^(\d+)(m|h|d)$/.test(rawExpiresIn))) {
        return failJson(400, 'bad_request', 'expiresIn must look like 30m, 48h or 7d.');
      }
      const seconds = rawExpiresIn === undefined
        ? 7 * 24 * 3_600
        : Number.parseInt(/^(\d+)(m|h|d)$/.exec(rawExpiresIn)![1]!, 10) * (rawExpiresIn.endsWith('m') ? 60 : rawExpiresIn.endsWith('h') ? 3_600 : 86_400);
      if (seconds < 30 * 60 || seconds > 30 * 24 * 3_600) {
        return failJson(400, 'bad_request', 'expiresIn must be between 30 minutes and 30 days.');
      }
      return json(201, {
        url: `${url.origin}/api/auth/magic-link/verify?token=fake-minted-token&callbackURL=${encodeURIComponent(`${url.origin}/`)}`,
        email,
        expiresAt: Date.now() + seconds * 1_000,
        singleUse: true,
      });
    }

    // GET|POST /clients/:clientId/projects — R-1 pointer projection (fake:
    // creation approximated with the clients:write scope; duplicates 409).
    if (segments.length === 3 && segments[0] === 'clients' && segments[2] === 'projects' && method === 'GET') {
      const items = [...projects.values()].filter((project) => project.portalClientId === segments[1]).sort((a, b) => (a.id < b.id ? -1 : 1));
      return json(200, paginate(items, url));
    }
    if (segments.length === 3 && segments[0] === 'clients' && segments[2] === 'projects' && method === 'POST') {
      if (!scopes.includes('clients:write')) return failJson(403, 'forbidden', 'Missing required scope: clients:write');
      const body = JSON.parse(requests[requests.length - 1]!.bodyText ?? '{}') as Record<string, unknown>;
      const studioProjectId = String(body.studioProjectId ?? '');
      const name = String(body.name ?? '');
      if (studioProjectId.length === 0 || name.length === 0) return failJson(400, 'bad_request', 'studioProjectId and name are required.');
      for (const existing of projects.values()) {
        if (existing.portalClientId === segments[1] && existing.studioProjectId === studioProjectId) {
          return failJson(409, 'conflict', 'This client already has a pointer to that Studio project.');
        }
      }
      const view: PortalProjectView = { id: nextId('pp'), portalClientId: segments[1]!, workspaceId: clients.get(segments[1]!)?.workspaceId ?? 'ws-fake', studioProjectId, name, projectionVersion: 1, createdAt: Date.now() };
      projects.set(view.id, view);
      return json(201, view);
    }

    // POST|GET /projects/:projectId/requests — R-3 (admin human or
    // requests:write creates; requests:read lists; lazy expiry on list).
    if (segments.length === 3 && segments[0] === 'projects' && segments[2] === 'requests' && method === 'POST') {
      if (!scopes.includes('requests:write')) return failJson(403, 'forbidden', 'Missing required scope: requests:write');
      const project = projects.get(segments[1]!);
      if (project === undefined) return failJson(404, 'not_found', 'Project not found.');
      const body = JSON.parse(requests[requests.length - 1]!.bodyText ?? '{}') as Record<string, unknown>;
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (title.length === 0) return failJson(400, 'bad_request', 'title is required.');
      const maxFiles = body.maxFiles === undefined ? 10 : Number(body.maxFiles);
      if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 500) {
        return failJson(400, 'bad_request', 'maxFiles must be an integer between 1 and 500.');
      }
      const quota = quotaByClient.get(project.portalClientId) ?? { limitBytes: 2 * 1_073_741_824, reservedBytes: 0 };
      const maxBytes = body.maxBytes === undefined ? Math.min(2 * 1_073_741_824, quota.limitBytes) : Number(body.maxBytes);
      if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > quota.limitBytes) {
        return failJson(400, 'bad_request', 'maxBytes must be a positive integer within the client quota.');
      }
      const now = Date.now();
      const expiresInSeconds = parseFakeExpiresIn(body.expiresIn);
      if (expiresInSeconds < 0) return failJson(400, 'bad_request', 'expiresIn must look like 30m, 48h or 7d (30m..30d).');
      const view: UploadRequestView = {
        id: nextId('req'),
        portalProjectId: project.id,
        portalClientId: project.portalClientId,
        title,
        instructions: typeof body.instructions === 'string' && body.instructions.trim().length > 0 ? body.instructions : null,
        maxFiles,
        maxBytes,
        usedFiles: 0,
        usedBytes: 0,
        remainingFiles: maxFiles,
        remainingBytes: maxBytes,
        state: 'open',
        expiresAt: now + expiresInSeconds * 1_000,
        createdAt: now,
        closedAt: null,
        closeReason: null,
      };
      const row: FakeUploadRequest = { view, tokenHash: null, tokenExpiresAt: 0, materialIds: [] };
      uploadRequests.set(view.id, row);
      return json(201, view);
    }
    if (segments.length === 3 && segments[0] === 'projects' && segments[2] === 'requests' && method === 'GET') {
      if (!scopes.includes('requests:read')) return failJson(403, 'forbidden', 'Missing required scope: requests:read');
      const project = projects.get(segments[1]!);
      if (project === undefined) return failJson(404, 'not_found', 'Project not found.');
      const items = [...uploadRequests.values()]
        .filter((row) => row.view.portalProjectId === project.id)
        .map((row) => settleFakeRequest(row).view)
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      return json(200, paginate(items, url));
    }

    // GET /requests/:id — metadata (requests:read).
    if (segments.length === 2 && segments[0] === 'requests' && method === 'GET') {
      if (!scopes.includes('requests:read')) return failJson(403, 'forbidden', 'Missing required scope: requests:read');
      const row = uploadRequests.get(segments[1]!);
      if (row === undefined) return failJson(404, 'not_found', 'Request not found.');
      return json(200, settleFakeRequest(row).view);
    }

    // GET /requests/:id/materials — metadata only (requests:read).
    if (segments.length === 3 && segments[0] === 'requests' && segments[2] === 'materials' && method === 'GET') {
      if (!scopes.includes('requests:read')) return failJson(403, 'forbidden', 'Missing required scope: requests:read');
      const row = uploadRequests.get(segments[1]!);
      if (row === undefined) return failJson(404, 'not_found', 'Request not found.');
      const items = row.materialIds.map((materialId) => materials.get(materialId)?.view).filter((view): view is MaterialView => view !== undefined);
      return json(200, paginate(items, url));
    }

    // POST /requests/:id/close — requests:write; 409 when already ended.
    if (segments.length === 3 && segments[0] === 'requests' && segments[2] === 'close' && method === 'POST') {
      if (!scopes.includes('requests:write')) return failJson(403, 'forbidden', 'Missing required scope: requests:write');
      const row = uploadRequests.get(segments[1]!);
      if (row === undefined) return failJson(404, 'not_found', 'Request not found.');
      const settled = settleFakeRequest(row);
      if (settled.view.state === 'expired') return failJson(409, 'conflict', 'This request already expired and cannot be closed.');
      if (settled.view.state === 'closed') return failJson(409, 'conflict', 'This request is already closed.');
      const body = JSON.parse(requests[requests.length - 1]!.bodyText ?? '{}') as Record<string, unknown>;
      const reason = typeof body.reason === 'string' && body.reason.trim().length > 0 ? body.reason.trim().slice(0, 200) : 'closed_by_admin';
      settled.view.state = 'closed';
      settled.view.closedAt = Date.now();
      settled.view.closeReason = reason;
      return json(200, settled.view);
    }

    // POST /requests/:id/link — mint/rotate (requests:write; 409 non-open).
    if (segments.length === 3 && segments[0] === 'requests' && segments[2] === 'link' && method === 'POST') {
      if (!scopes.includes('requests:write')) return failJson(403, 'forbidden', 'Missing required scope: requests:write');
      const row = uploadRequests.get(segments[1]!);
      if (row === undefined) return failJson(404, 'not_found', 'Request not found.');
      const settled = settleFakeRequest(row);
      if (settled.view.state !== 'open') return failJson(409, 'conflict', 'Request links are minted only for open requests.');
      const body = JSON.parse(requests[requests.length - 1]!.bodyText ?? '{}') as Record<string, unknown>;
      const linkExpiresIn = parseFakeExpiresIn(body.expiresIn);
      if (linkExpiresIn < 0) return failJson(400, 'bad_request', 'expiresIn must look like 30m, 48h or 7d (30m..30d).');
      const minted = mintFakeRequestLink(settled, linkExpiresIn, url.origin);
      return json(201, { url: minted.url, requestId: settled.view.id, tokenId: nextId('tok'), expiresAt: minted.expiresAt, limits: { maxFiles: settled.view.maxFiles, maxBytes: settled.view.maxBytes } });
    }

    // Guest-direct family (R-3): /api/v1/r/:token — NO api key, the token is
    // the capability. Wrong/revoked/expired token = the same 404.
    if (segments.length >= 2 && segments[0] === 'r') {
      return guestRoute(request, segments, url, bodyBytes);
    }

    // Asset upload links (operator order 2026-10-06).
    if (segments.length >= 1 && segments[0] === 'asset-upload-links') {
      if (segments.length === 1 && method === 'POST') {
        if (!scopes.includes('assets:write')) return failJson(403, 'forbidden', 'Missing required scope: assets:write');
        const body = JSON.parse(requests[requests.length - 1]!.bodyText ?? '{}') as Record<string, unknown>;
        const studioProjectId = String(body.studioProjectId ?? '');
        const studioAssetId = String(body.studioAssetId ?? '');
        const portalClientId = typeof body.portalClientId === 'string' ? body.portalClientId : undefined;
        if (studioProjectId.length === 0 || studioAssetId.length === 0) {
          return failJson(400, 'bad_request', 'studioProjectId and studioAssetId are required.');
        }
        const pointers = [...projects.values()].filter((entry) =>
          entry.studioProjectId === studioProjectId && (portalClientId === undefined || entry.portalClientId === portalClientId));
        if (pointers.length === 0) return failJson(404, 'not_found', 'No portal project pointer for that Studio project id.');
        if (pointers.length > 1) return failJson(409, 'conflict', 'Ambiguous Studio project id; pass portalClientId.');
        const pointer = pointers[0]!;
        const linkExpiresIn = parseFakeExpiresIn(body.expiresIn);
        if (linkExpiresIn < 0) return failJson(400, 'bad_request', 'expiresIn must look like 30m, 48h or 7d (30m..30d).');
        const minted = mintFakeAssetLink(pointer.portalClientId, pointer.id, studioProjectId, studioAssetId, linkExpiresIn, url.origin);
        return json(201, {
          url: minted.url,
          linkId: minted.linkId,
          portalClientId: pointer.portalClientId,
          portalProjectId: pointer.id,
          studioProjectId,
          studioAssetId,
          expiresAt: minted.expiresAt,
        });
      }
      // GET /api/v1/asset-upload-links/materials?asset= — per-asset import
      // set (agent needs materials:read; admin surface is out of fake scope).
      if (segments.length === 2 && segments[1] === 'materials' && method === 'GET') {
        if (!scopes.includes('materials:read')) return failJson(403, 'forbidden', 'Missing required scope: materials:read');
        const asset = url.searchParams.get('asset') ?? '';
        const items = [...materials.values()]
          .map((entry) => ({ view: entry.view, assetTarget: entry.assetTarget, linkId: entry.linkId ?? null }))
          .filter((entry) => entry.assetTarget === asset)
          .sort((a, b) => (a.view.id < b.view.id ? -1 : 1))
          .map((entry) => ({ ...entry.view, assetTarget: entry.assetTarget!, linkId: entry.linkId }));
        return json(200, paginate(items, url));
      }
      return failJson(404, 'not_found', `Unknown route ${method} ${url.pathname}.`);
    }

    // Guest-direct asset family: /api/v1/a/:token — NO api key, same 404
    // neutrality as the request family.
    if (segments.length >= 2 && segments[0] === 'a') {
      return guestAssetRoute(request, segments, url, bodyBytes);
    }

    return failJson(404, 'not_found', `Unknown route ${method} ${url.pathname}.`);
  }

  /** Lazy expiry (contracts §4): FIRST touch past the deadline flips state. */
  function settleFakeRequest(row: FakeUploadRequest): FakeUploadRequest {
    if (row.view.state === 'open' && row.view.expiresAt <= Date.now()) {
      row.view.state = 'expired';
      row.view.closedAt = Date.now();
      row.view.closeReason = 'expired';
    }
    return row;
  }

  /** Mints a fresh token and REVOKES the previous one (one live token). */
  function mintFakeRequestLink(row: FakeUploadRequest, expiresInSeconds: number, origin: string): { url: string; token: string; expiresAt: number } {
    if (row.tokenHash !== null) requestByTokenHash.delete(row.tokenHash);
    const token = `tok-${nextId('cap')}-${Math.random().toString(36).slice(2, 10)}`;
    row.tokenHash = sha256HexSync(token);
    row.tokenExpiresAt = Date.now() + expiresInSeconds * 1_000;
    requestByTokenHash.set(row.tokenHash, row.view.id);
    return { url: `${origin}/request/${token}`, token, expiresAt: row.tokenExpiresAt };
  }

  /** Syncs derived budget fields before serving a view. */
  function fakeRequestView(row: FakeUploadRequest): UploadRequestView {
    row.view.remainingFiles = Math.max(0, row.view.maxFiles - row.view.usedFiles);
    row.view.remainingBytes = Math.max(0, row.view.maxBytes - row.view.usedBytes);
    return row.view;
  }


  /**
   * Resolves the guest capability: hash → active (unrevoked, unexpired)
   * token → its request (lazily expired). Anything else is the SAME 404.
   */
  function resolveFakeGuest(rawToken: string): FakeUploadRequest | null {
    if (typeof rawToken !== 'string' || rawToken.length === 0) return null;
    const hash = sha256HexSync(rawToken);
    const requestId = requestByTokenHash.get(hash);
    if (requestId === undefined) return null;
    const row = uploadRequests.get(requestId);
    if (row === undefined) return null;
    if (row.tokenHash !== hash || row.tokenExpiresAt <= Date.now()) return null;
    return settleFakeRequest(row);
  }

  async function guestRoute(request: Request, segments: string[], url: URL, bodyBytes: Uint8Array | null): Promise<Response> {
    const guest = resolveFakeGuest(segments[1]!);
    const method = request.method;
    if (guest === null) return failJson(404, 'not_found', 'This request link is not valid or has expired.');
    const rest = segments.slice(2);

    // GET /api/v1/r/:token — minimal view, no ids of any other resource.
    if (rest.length === 0 && method === 'GET') {
      const view = guest.view;
      return json(200, {
        title: view.title,
        instructions: view.instructions,
        state: view.state,
        expiresAt: view.expiresAt,
        maxFiles: view.maxFiles,
        maxBytes: view.maxBytes,
        remainingFiles: fakeRequestView(guest).remainingFiles,
        remainingBytes: view.remainingBytes,
      });
    }

    // POST /api/v1/r/:token/uploads — init with the DUAL reservation
    // (simplified but consistent: request CAS + client quota CAS; a lost arm
    // answers 429, per-file oversize 413, non-open request 409).
    if (rest.length === 1 && rest[0] === 'uploads' && method === 'POST') {
      if (guest.view.state !== 'open') {
        return failJson(409, 'conflict', `This request is ${guest.view.state} and cannot accept uploads.`);
      }
      const body = JSON.parse(requests[requests.length - 1]!.bodyText ?? '{}') as Record<string, unknown>;
      const declaredBytes = Number(body.declaredBytes);
      const mediaType = String(body.mediaType ?? '') as V1MediaType;
      if (!Number.isInteger(declaredBytes) || declaredBytes <= 0) return failJson(400, 'bad_request', 'declaredBytes must be a positive integer.');
      if (declaredBytes > FAKE_GUEST_FILE_CAP) return failJson(413, 'payload_too_large', 'declaredBytes exceeds the per-file limit.');
      if (guest.view.maxFiles - guest.view.usedFiles < 1 || guest.view.maxBytes - guest.view.usedBytes < declaredBytes) {
        return failJson(429, 'rate_limited', 'This request has no remaining budget for that file.');
      }
      const quota = quotaByClient.get(guest.view.portalClientId) ?? { limitBytes: 2 * 1_073_741_824, reservedBytes: 0 };
      quotaByClient.set(guest.view.portalClientId, quota);
      if (quota.reservedBytes + declaredBytes > quota.limitBytes) {
        return failJson(429, 'rate_limited', 'Client storage quota exceeded for this upload; try again later.');
      }
      // BOTH arms apply (simplified single-phase reservation).
      quota.reservedBytes += declaredBytes;
      guest.view.usedFiles += 1;
      guest.view.usedBytes += declaredBytes;
      const tokenHash = guest.tokenHash ?? '';
      const session = {
        uploadId: nextId('up'),
        mediaType,
        declaredBytes,
        status: 'pending' as const,
        expiresAt: Date.now() + 3_600_000,
        guestHash: tokenHash,
        requestId: guest.view.id,
        name: typeof body.name === 'string' && body.name.trim().length > 0 ? body.name : null,
      };
      guestSessions.set(session.uploadId, { session, expectedSha256: null, bytes: null });
      return json(201, { uploadId: session.uploadId, mediaType: session.mediaType, declaredBytes: session.declaredBytes, status: session.status, expiresAt: session.expiresAt });
    }

    // PUT /api/v1/r/:token/uploads/:sessionId/content — session bound to the
    // minting token (another token of the SAME request gets 404).
    if (rest.length === 3 && rest[0] === 'uploads' && rest[2] === 'content' && method === 'PUT') {
      const entry = guestSessions.get(rest[1]!);
      if (entry === undefined || entry.session.guestHash !== (guest.tokenHash ?? '')) {
        return failJson(404, 'not_found', 'Upload session not found.');
      }
      if (entry.session.status === 'staged' || entry.session.status === 'ready') {
        return failJson(409, 'conflict', 'Upload content was already received; call complete instead of re-uploading.');
      }
      const bodyBytesVerified = bodyBytes ?? new Uint8Array();
      const digest = await sha256Hex(bodyBytesVerified);
      if (bodyBytesVerified.length !== entry.session.declaredBytes) {
        return failJson(413, 'payload_too_large', 'Body size does not match the declared byte count.');
      }
      entry.bytes = bodyBytesVerified;
      entry.expectedSha256 = digest;
      entry.session.status = 'staged';
      return json(200, { uploadId: entry.session.uploadId, status: 'staged', bytes: bodyBytesVerified.length, sha256: digest, mediaType: entry.session.mediaType });
    }

    // POST /api/v1/r/:token/uploads/:sessionId/complete — verify + create the
    // material row attributed to the request; auto-fulfil at the limits.
    if (rest.length === 3 && rest[0] === 'uploads' && rest[2] === 'complete' && method === 'POST') {
      const entry = guestSessions.get(rest[1]!);
      if (entry === undefined || entry.session.guestHash !== (guest.tokenHash ?? '')) {
        return failJson(404, 'not_found', 'Upload session not found.');
      }
      if (entry.session.status === 'pending') {
        return failJson(409, 'conflict', 'Upload content has not been received yet.');
      }
      if (entry.session.status !== 'staged') {
        return failJson(409, 'conflict', `Upload session is ${entry.session.status}; it cannot be completed.`);
      }
      // Closure between PUT and complete is effective immediately: release
      // the reservation and refuse (budget stays frozen with the request).
      if (guest.view.state !== 'open') {
        guest.view.usedFiles = Math.max(0, guest.view.usedFiles - 1);
        guest.view.usedBytes = Math.max(0, guest.view.usedBytes - entry.session.declaredBytes);
        const quota = quotaByClient.get(guest.view.portalClientId);
        if (quota !== undefined) quota.reservedBytes = Math.max(0, quota.reservedBytes - entry.session.declaredBytes);
        entry.session.status = 'failed';
        return failJson(409, 'conflict', `This request is ${guest.view.state} and no longer accepts uploads.`);
      }
      const sha = entry.expectedSha256 ?? '';
      const bytes = entry.bytes ?? new Uint8Array();
      // Content-addressed dedupe within the client (v1 rule): a deduped row
      // keeps its ORIGINAL context (not attributed to this request).
      const duplicate = [...materials.values()].find((candidate) => candidate.view.clientId === guest.view.portalClientId && candidate.view.sha256 === sha);
      const materialId = duplicate !== undefined
        ? duplicate.view.id
        : nextId('mat');
      if (duplicate === undefined) {
        materials.set(materialId, {
          view: {
            id: materialId,
            clientId: guest.view.portalClientId,
            name: entry.session.name ?? 'material',
            mediaType: entry.session.mediaType,
            bytes: bytes.length,
            sha256: sha,
            status: 'ready',
            createdAt: Date.now(),
          },
          bytes,
        });
        guest.materialIds.push(materialId);
      }
      entry.session.status = 'ready';
      // Auto-close at the limit: exactly once via the state guard.
      if (guest.view.state === 'open' && (guest.view.usedFiles >= guest.view.maxFiles || guest.view.usedBytes >= guest.view.maxBytes)) {
        guest.view.state = 'fulfilled';
        guest.view.closedAt = Date.now();
        guest.view.closeReason = 'fulfilled';
      }
      return json(201, {
        material: materials.get(materialId)!.view,
        request: {
          title: guest.view.title,
          instructions: guest.view.instructions,
          state: guest.view.state,
          expiresAt: guest.view.expiresAt,
          maxFiles: guest.view.maxFiles,
          maxBytes: guest.view.maxBytes,
          remainingFiles: fakeRequestView(guest).remainingFiles,
          remainingBytes: guest.view.remainingBytes,
        },
      });
    }

    return failJson(404, 'not_found', `Unknown guest route ${method} ${url.pathname}.`);
  }

  /**
   * Mints a fresh per-asset link and CLOSES the previous open one for the
   * same (client, asset) — rotation, one live capability per asset.
   */
  function mintFakeAssetLink(
    portalClientId: string,
    portalProjectId: string | null,
    studioProjectId: string,
    studioAssetId: string,
    expiresInSeconds: number,
    origin: string,
  ): { url: string; token: string; linkId: string; expiresAt: number } {
    const now = Date.now();
    for (const link of assetLinks.values()) {
      if (link.portalClientId === portalClientId && link.studioAssetId === studioAssetId && link.state === 'open') {
        link.state = 'closed';
        link.closedAt = now;
        link.closeReason = 'rotated';
        if (link.tokenHash !== null) assetLinkByTokenHash.delete(link.tokenHash);
        link.tokenHash = null;
      }
    }
    const id = nextId('aul');
    const token = `tok-${nextId('acap')}-${Math.random().toString(36).slice(2, 10)}`;
    const expiresAt = now + expiresInSeconds * 1_000;
    const link: FakeAssetLink = {
      id,
      portalClientId,
      portalProjectId,
      studioProjectId,
      studioAssetId,
      state: 'open',
      expiresAt,
      createdAt: now,
      closedAt: null,
      closeReason: null,
      tokenHash: sha256HexSync(token),
      tokenExpiresAt: expiresAt,
      materialIds: [],
    };
    assetLinks.set(id, link);
    assetLinkByTokenHash.set(link.tokenHash!, id);
    return { url: `${origin}/asset-upload/${token}`, token, linkId: id, expiresAt };
  }

  /**
   * Resolves the guest capability: hash → ACTIVE (open, unexpired) link.
   * Closed (rotated/admin) is the same null as unknown; expired links still
   * resolve so the page can SHOW the terminal state.
   */
  function resolveFakeAssetGuest(rawToken: string): { link: FakeAssetLink } | null {
    if (typeof rawToken !== 'string' || rawToken.length === 0) return null;
    const hash = sha256HexSync(rawToken);
    const linkId = assetLinkByTokenHash.get(hash);
    if (linkId === undefined) return null;
    const link = assetLinks.get(linkId);
    if (link === undefined || link.tokenHash !== hash) return null;
    if (link.state === 'open' && link.expiresAt <= Date.now()) {
      link.state = 'expired';
      link.closedAt = Date.now();
      link.closeReason = 'expired';
    }
    if (link.state === 'closed') return null;
    return { link };
  }

  function fakeAssetQuota(clientId: string): { limitBytes: number; reservedBytes: number } {
    const quota = quotaByClient.get(clientId) ?? { limitBytes: 2 * 1_073_741_824, reservedBytes: 0 };
    quotaByClient.set(clientId, quota);
    return quota;
  }

  async function guestAssetRoute(request: Request, segments: string[], url: URL, bodyBytes: Uint8Array | null): Promise<Response> {
    const resolved = resolveFakeAssetGuest(segments[1]!);
    const method = request.method;
    if (resolved === null) return failJson(404, 'not_found', 'Este enlace no es válido o ha vencido.');
    const { link } = resolved;
    const rest = segments.slice(2);

    const guestView = () => {
      const project = link.portalProjectId !== null ? projects.get(link.portalProjectId) : undefined;
      const quota = fakeAssetQuota(link.portalClientId);
      return {
        assetTitle: link.studioAssetId,
        projectTitle: project?.name ?? link.studioProjectId,
        state: link.state,
        expiresAt: link.expiresAt,
        quota: {
          limitBytes: quota.limitBytes,
          remainingBytes: Math.max(0, quota.limitBytes - quota.reservedBytes),
        },
      };
    };

    // GET /api/v1/a/:token — minimal view, no ids of any resource.
    if (rest.length === 0 && method === 'GET') {
      return json(200, guestView());
    }

    // POST /api/v1/a/:token/uploads — client-quota CAS only (no request
    // budget), open links only, per-file cap 413.
    if (rest.length === 1 && rest[0] === 'uploads' && method === 'POST') {
      if (link.state !== 'open') {
        return failJson(409, 'conflict', `Este enlace está ${link.state} y no acepta subidas.`);
      }
      const body = JSON.parse(requests[requests.length - 1]!.bodyText ?? '{}') as Record<string, unknown>;
      const declaredBytes = Number(body.declaredBytes);
      const mediaType = String(body.mediaType ?? '') as V1MediaType;
      if (!Number.isInteger(declaredBytes) || declaredBytes <= 0) return failJson(400, 'bad_request', 'declaredBytes must be a positive integer.');
      if (declaredBytes > FAKE_GUEST_FILE_CAP) return failJson(413, 'payload_too_large', 'declaredBytes exceeds the per-file limit.');
      const quota = fakeAssetQuota(link.portalClientId);
      if (quota.reservedBytes + declaredBytes > quota.limitBytes) {
        return failJson(429, 'rate_limited', 'Client storage quota exceeded for this upload; try again later.');
      }
      quota.reservedBytes += declaredBytes;
      const session = {
        uploadId: nextId('aup'),
        mediaType,
        declaredBytes,
        status: 'pending' as const,
        expiresAt: Date.now() + 3_600_000,
        guestHash: link.tokenHash ?? '',
        linkId: link.id,
        name: typeof body.name === 'string' && body.name.trim().length > 0 ? body.name : null,
      };
      assetGuestSessions.set(session.uploadId, { session, expectedSha256: null, bytes: null });
      return json(201, { uploadId: session.uploadId, mediaType: session.mediaType, declaredBytes: session.declaredBytes, status: session.status, expiresAt: session.expiresAt });
    }

    // PUT /api/v1/a/:token/uploads/:sessionId/content — bound to the token.
    if (rest.length === 3 && rest[0] === 'uploads' && rest[2] === 'content' && method === 'PUT') {
      const entry = assetGuestSessions.get(rest[1]!);
      if (entry === undefined || entry.session.guestHash !== (link.tokenHash ?? '')) {
        return failJson(404, 'not_found', 'Upload session not found.');
      }
      if (entry.session.status === 'staged' || entry.session.status === 'ready') {
        return failJson(409, 'conflict', 'Upload content was already received; call complete instead of re-uploading.');
      }
      const uploadBytes = bodyBytes ?? new Uint8Array();
      const digest = await sha256Hex(uploadBytes);
      if (uploadBytes.length !== entry.session.declaredBytes) {
        return failJson(413, 'payload_too_large', 'Body size does not match the declared byte count.');
      }
      entry.bytes = uploadBytes;
      entry.expectedSha256 = digest;
      entry.session.status = 'staged';
      return json(200, { uploadId: entry.session.uploadId, status: 'staged', bytes: uploadBytes.length, sha256: digest, mediaType: entry.session.mediaType });
    }

    // POST /api/v1/a/:token/uploads/:sessionId/complete — verify + material
    // attributed to the EXACT asset (asset_target + linkId); the link flips
    // used exactly once.
    if (rest.length === 3 && rest[0] === 'uploads' && rest[2] === 'complete' && method === 'POST') {
      const entry = assetGuestSessions.get(rest[1]!);
      if (entry === undefined || entry.session.guestHash !== (link.tokenHash ?? '')) {
        return failJson(404, 'not_found', 'Upload session not found.');
      }
      if (entry.session.status === 'pending') {
        return failJson(409, 'conflict', 'Upload content has not been received yet.');
      }
      if (entry.session.status !== 'staged') {
        return failJson(409, 'conflict', `Upload session is ${entry.session.status}; it cannot be completed.`);
      }
      if (link.state !== 'open') {
        entry.session.status = 'failed';
        return failJson(409, 'conflict', `Este enlace está ${link.state} y ya no acepta subidas.`);
      }
      const sha = entry.expectedSha256 ?? '';
      const uploadBytes = entry.bytes ?? new Uint8Array();
      const duplicate = [...materials.values()].find((candidate) => candidate.view.clientId === link.portalClientId && candidate.view.sha256 === sha);
      const materialId = duplicate !== undefined ? duplicate.view.id : nextId('mat');
      if (duplicate === undefined) {
        materials.set(materialId, {
          view: {
            id: materialId,
            clientId: link.portalClientId,
            name: entry.session.name ?? 'material',
            mediaType: entry.session.mediaType,
            bytes: uploadBytes.length,
            sha256: sha,
            status: 'ready',
            createdAt: Date.now(),
          },
          bytes: uploadBytes,
          assetTarget: link.studioAssetId,
          linkId: link.id,
        });
        link.materialIds.push(materialId);
      }
      entry.session.status = 'ready';
      link.state = 'used';
      link.closedAt = Date.now();
      link.closeReason = 'used';
      return json(201, {
        material: materials.get(materialId)!.view,
        link: guestView(),
      });
    }

    return failJson(404, 'not_found', `Unknown guest asset route ${method} ${url.pathname}.`);
  }

  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: route });
  const port = server.port as number; // port 0 → the OS assigns an ephemeral port

  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    apiKey,
    requests,
    seedClient(input) {
      const view: PortalClientView = { id: nextId('pc'), workspaceId: input.workspaceId, studioClientId: input.studioClientId, name: input.name, projectionVersion: 1, createdAt: Date.now() };
      clients.set(view.id, view);
      quotaByClient.set(view.id, { limitBytes: input.quotaBytes ?? 2 * 1_073_741_824, reservedBytes: 0 });
      return view;
    },
    seedProject(input) {
      const view: PortalProjectView = {
        id: nextId('pp'),
        portalClientId: input.clientId,
        workspaceId: clients.get(input.clientId)?.workspaceId ?? 'ws-fake',
        studioProjectId: input.studioProjectId,
        name: input.name,
        projectionVersion: 1,
        createdAt: Date.now(),
      };
      projects.set(view.id, view);
      return view;
    },
    seedRequest(input) {
      const project = projects.get(input.projectId);
      if (project === undefined) throw new Error(`seedRequest: proyecto ${input.projectId} no sembrado`);
      const now = Date.now();
      const expiresInSeconds = input.expiresIn === undefined ? 7 * 24 * 3_600 : parseFakeExpiresIn(input.expiresIn);
      if (expiresInSeconds < 0) throw new Error('seedRequest: expiresIn inválido (30m..30d)');
      const view: UploadRequestView = {
        id: nextId('req'),
        portalProjectId: project.id,
        portalClientId: project.portalClientId,
        title: input.title,
        instructions: input.instructions ?? null,
        maxFiles: input.maxFiles,
        maxBytes: input.maxBytes,
        usedFiles: 0,
        usedBytes: 0,
        remainingFiles: input.maxFiles,
        remainingBytes: input.maxBytes,
        state: 'open',
        expiresAt: now + expiresInSeconds * 1_000,
        createdAt: now,
        closedAt: null,
        closeReason: null,
      };
      const row: FakeUploadRequest = { view, tokenHash: null, tokenExpiresAt: 0, materialIds: [] };
      uploadRequests.set(view.id, row);
      const minted = mintFakeRequestLink(row, expiresInSeconds, `http://127.0.0.1:${server.port}`);
      return {
        url: minted.url,
        token: minted.token,
        requestId: view.id,
        expiresAt: minted.expiresAt,
        limits: { maxFiles: view.maxFiles, maxBytes: view.maxBytes },
        request: view,
      };
    },
    portalRequests(): FakeUploadRequestSnapshot[] {
      return [...uploadRequests.values()].map((row) => ({ request: { ...row.view }, materialIds: [...row.materialIds] }));
    },
    seedAssetLink(input) {
      const pointers = [...projects.values()].filter((entry) =>
        entry.studioProjectId === input.studioProjectId && entry.portalClientId === input.clientId);
      if (pointers.length !== 1) throw new Error(`seedAssetLink: pointer de ${input.studioProjectId}/${input.clientId} no sembrado o ambiguo`);
      const expiresInSeconds = input.expiresIn === undefined ? 7 * 24 * 3_600 : parseFakeExpiresIn(input.expiresIn);
      if (expiresInSeconds < 0) throw new Error('seedAssetLink: expiresIn inválido (30m..30d)');
      const minted = mintFakeAssetLink(input.clientId, pointers[0]!.id, input.studioProjectId, input.studioAssetId, expiresInSeconds, `http://127.0.0.1:${server.port}`);
      return {
        url: minted.url,
        token: minted.token,
        linkId: minted.linkId,
        expiresAt: minted.expiresAt,
        link: { ...assetLinks.get(minted.linkId)! },
      };
    },
    assetLinks(): FakeAssetLinkSnapshot[] {
      return [...assetLinks.values()].map((link) => {
        const { tokenHash: _tokenHash, tokenExpiresAt: _tokenExpiresAt, ...view } = link;
        return { link: { ...view }, materialIds: [...link.materialIds] };
      });
    },
    settleAssetLink(linkId, reason) {
      const link = assetLinks.get(linkId);
      if (link === undefined) return;
      const now = Date.now();
      link.state = reason;
      link.closedAt = now;
      link.closeReason = reason;
      if (reason === 'closed' && link.tokenHash !== null) {
        assetLinkByTokenHash.delete(link.tokenHash);
      }
    },
    async seedMaterial(input) {
      const view: MaterialView = {
        id: nextId('mat'),
        clientId: input.clientId,
        name: input.name,
        mediaType: input.mediaType,
        bytes: input.bytes.length,
        sha256: await sha256Hex(input.bytes),
        status: 'ready',
        createdAt: Date.now(),
      };
      materials.set(view.id, { view, bytes: input.bytes });
      return view;
    },
    deliveries(): FakeDelivery[] {
      return [...deliveries.values()];
    },
    swapMaterialBytes(materialId, bytes) {
      const entry = materials.get(materialId);
      if (entry !== undefined) entry.bytes = bytes;
    },
    async stop() {
      server.stop(true);
    },
  };
}

/** Cursor = `m<index>`; `limit` (default 50) bounds the page. */
function paginate<T>(items: readonly T[], url: URL): { items: T[]; nextCursor: string | null } {
  const cursor = url.searchParams.get('cursor');
  const start = cursor !== null && cursor.startsWith('m') ? Number(cursor.slice(1)) : 0;
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw !== null ? Number(limitRaw) : 50;
  const sliced = items.slice(start, start + limit);
  const next = start + sliced.length;
  return { items: sliced, nextCursor: next < items.length ? `m${next}` : null };
}

function deliveryViewOf(delivery: FakeDelivery) {
  return {
    id: delivery.id,
    clientId: delivery.clientId,
    workspaceId: 'ws-fake',
    projectId: delivery.projectId,
    assetId: delivery.assetId,
    revisionId: delivery.revisionId,
    rootHash: delivery.rootHash,
    title: delivery.title,
    kind: delivery.kind,
    status: delivery.status,
    outputs: [...delivery.outputs.values()].map((output) => ({ ...output.ref, ready: output.bytes !== null })),
    createdAt: delivery.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Studio workspace fixture (client + project + OPEN asset with empty inputs)
// ---------------------------------------------------------------------------

export interface WorkspaceFixture {
  root: string;
  workspaceDir: string;
  studioClientId: string;
  projectId: string;
  assetId: string;
  assetDir: string;
}

const PNG_BYTES = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (char) => char.charCodeAt(0),
);

/** Synthetic JPEG: valid magic (FF D8 FF) with APP0/JFIF-ish header. */
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0xff, 0xd9]);

export { PNG_BYTES, JPEG_BYTES };

/** Creates a temp Studio workspace with one client, one project and one open asset. */
export async function makeWorkspace(prefix = 'portal-bridge'): Promise<WorkspaceFixture> {
  const root = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const workspaceDir = join(root, 'workspace');
  const studioClientId = 'acme';
  const projectId = 'proj';
  const assetId = 'asset-one';
  const assetDir = join(workspaceDir, 'projects', projectId, 'assets', assetId);
  await mkdir(join(workspaceDir, 'clients', studioClientId), { recursive: true });
  await mkdir(assetDir, { recursive: true });
  await mkdir(join(assetDir, 'workroom'), { recursive: true });
  await mkdir(join(assetDir, 'outputs'), { recursive: true });
  await writeFile(join(workspaceDir, 'clients', studioClientId, 'client.json'), `${JSON.stringify({ schemaVersion: 1, id: studioClientId, name: 'Acme Inc.' }, null, 2)}\n`);
  await writeFile(join(workspaceDir, 'projects', projectId, 'project.json'), `${JSON.stringify({ schemaVersion: 1, id: projectId, name: 'Proyecto', clientIds: [studioClientId] }, null, 2)}\n`);
  await writeFile(join(assetDir, 'asset.json'), `${JSON.stringify({ schemaVersion: 1, id: assetId, projectId, kind: 'video', title: 'Pieza uno', presetRefs: [], sources: [], inputs: [], outputs: [] }, null, 2)}\n`);
  return { root, workspaceDir, studioClientId, projectId, assetId, assetDir };
}
