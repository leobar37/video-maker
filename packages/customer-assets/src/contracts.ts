/**
 * @videomaker/customer-assets — SDK contracts (pure).
 *
 * Shared wire types for the customer-assets portal v1, derived from
 * `.plans/customer-assets-portal/contracts.md` §6 (API HTTP v1).
 *
 * Constraints (contracts.md §5, goal G-001):
 * - No Node or Bun imports: this module must stay bundleable by any
 *   runtime (Workers, Bun CLI, browser). Keep it types + const tables only.
 * - No `success` flag: pages are `{ items, nextCursor }` and errors use the
 *   `{ error: { code, message, requestId } }` envelope.
 * - P-003 will extend this module (client SDK); do not widen it silently.
 */

/** Principal kinds recognized by the portal (contracts.md §3). */
export type PrincipalKind = 'admin' | 'member' | 'agent';

/** Media types accepted by uploads v1 (decisions.json defaults; HEIC excluded). */
export const V1_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
] as const;
export type V1MediaType = (typeof V1_MEDIA_TYPES)[number];

/** Machine-readable error codes (contracts.md §6). */
export const ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'payload_too_large',
  'unsupported_media_type',
  'rate_limited',
  'bad_request',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Typed error envelope: every non-2xx response body, no success flag. */
export interface ApiError {
  error: {
    code: ErrorCode;
    message: string;
    /** Opaque request correlation id; never contains secrets or tokens. */
    requestId: string;
  };
}

/** Page shape for all list endpoints (contracts.md §6). */
export interface Page<T> {
  items: T[];
  /** Opaque cursor; null/absent when no further page exists. */
  nextCursor: string | null;
}

/* ---------------------------------------------------------------------------
 * v1 wire DTOs (P-002). Server-internal fields (object keys, staging keys,
 * provenance internals, grant key ids) are deliberately absent from every
 * client-facing shape: clients see display metadata only (contracts.md §1).
 * ------------------------------------------------------------------------- */

/** Server-side agent scopes (contracts.md §3). Never accepted from callers. */
export const AGENT_SCOPES = [
  'clients:read',
  'clients:write',
  'materials:read',
  'materials:write',
  'deliveries:read',
  'deliveries:write',
  // Operator-ordered addition (2026-10-05): mint single-use client login
  // links. Minting stays admin-human or this explicit agent scope; a grant
  // created before this scope existed simply never holds it.
  'access:write',
  // R-2 additive scopes (customer-assets-requests): create/close upload
  // requests and mint/rotate their guest links (`requests:write`); list/read
  // requests and their materials (`requests:read`). Server-side only, defined
  // in the grant — grants created before R-2 never hold them.
  'requests:read',
  'requests:write',
  // Operator-ordered addition (2026-10-06, asset upload links): mint per-asset
  // guest upload links. Minting stays admin-human or this explicit agent
  // scope; a grant created before this scope existed simply never holds it
  // (same pattern as `access:write` / `requests:*`).
  'assets:write',
] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

/**
 * Admin/agent-only minted login link (operator-ordered, 2026-10-05): the URL
 * is the Better Auth magic-link verification URL (same hashed, single-use
 * token path as every magic link) captured server-side instead of emailed.
 * The token/url are delivered out-of-band by the operator and NEVER persisted
 * by the portal beyond Better Auth's own hashed verification row.
 */
export interface AccessLinkView {
  /** Full verification URL; shown exactly once to the minting principal. */
  url: string;
  email: string;
  /** Epoch ms when the single-use token stops verifying (mint + expiresIn). */
  expiresAt: number;
  singleUse: true;
}

export interface MintAccessLinkRequest {
  /** Member email; a missing portal user is provisioned as role=member. */
  email: string;
  /**
   * Link lifetime: `<n>m`|`<n>h`|`<n>d` (e.g. `30m`, `48h`, `7d`). Bounds are
   * enforced server-side: minimum 30 minutes, maximum 30 days; default 7d.
   */
  expiresIn?: string;
  /**
   * Must equal the portal's approved origin (echo of `--origin`); the server
   * clamps any minted link to its own approved origin regardless.
   */
  origin?: string;
}

export interface MeInfo {
  me: {
    kind: PrincipalKind;
    /** Opaque portal user id; agents keep their owning user id. */
    userId: string;
    email?: string;
    role?: 'admin' | 'member';
    /** Agent principals only: server-side scopes of the active grant. */
    scopes?: readonly string[];
  };
}

export interface PortalClientView {
  id: string;
  workspaceId: string;
  studioClientId: string;
  name: string;
  projectionVersion: number;
  createdAt: number;
}

export interface AdoptClientRequest {
  workspaceId: string;
  studioClientId: string;
  /** Display name allowlist (contracts.md §1); nothing else is stored. */
  name: string;
}

/* ---------------------------------------------------------------------------
 * PortalProject projection (P-101, R-1; contracts.md §5 additive ·
 * customer-assets-requests). Canonical Studio pointer per portal client;
 * creation/rename are admin-human-only, members list their own client's
 * projects, agents have no project operations (contracts.md §3 additive).
 * ------------------------------------------------------------------------- */

export interface PortalProjectView {
  id: string;
  portalClientId: string;
  workspaceId: string;
  studioProjectId: string;
  /** Display title, sanitized like every v1 display field. */
  name: string;
  projectionVersion: number;
  createdAt: number;
  /** Materials attributed to this project (null when omitted). */
  materialCount?: number;
}

export interface CreateProjectRequest {
  /** Existing Studio project id; validated server-side, never invented. */
  studioProjectId: string;
  /** Display title allowlist (sanitize like v1); nothing else is stored. */
  name: string;
}

export interface RenameProjectRequest {
  name: string;
}

export interface MaterialView {
  id: string;
  clientId: string;
  /** Original filename, display only (path stripped, length-capped). */
  name: string;
  mediaType: V1MediaType;
  bytes: number;
  sha256: string;
  status: 'ready';
  createdAt: number;
}

export interface InitUploadRequest {
  /** `material` for client materials, `delivery_output` for staging outputs. */
  kind: 'material' | 'delivery_output';
  mediaType: V1MediaType;
  declaredBytes: number;
  /** Required for delivery_output: exact expected digest of the output bytes. */
  sha256?: string;
  /** Display-only original name (materials). */
  name?: string;
  /** Target for delivery_output uploads. */
  deliveryId?: string;
  outputName?: string;
  /**
   * Optional project attribution (P-101, R-1): a project of THIS client.
   * Init validates it early (404 for unknown/other-client projects); the
   * attribution itself binds at upload COMPLETE, which must repeat the field.
   * Absent everywhere = free v1 upload, NULL attribution, identical flow.
   */
  portalProjectId?: string;
}

/**
 * Optional body of POST /api/v1/uploads/:id/complete (P-101, R-1): when
 * `portalProjectId` names a project of the upload's client, the created
 * material row is attributed to it; any other value is rejected BEFORE any
 * resource is created. No body at all = free v1 upload, byte-identical path.
 */
export interface CompleteUploadRequest {
  portalProjectId?: string;
}

export interface UploadSessionView {
  uploadId: string;
  clientId: string;
  kind: 'material' | 'delivery_output';
  mediaType: V1MediaType;
  declaredBytes: number;
  status: 'pending' | 'staged' | 'ready' | 'rejected' | 'failed' | 'expired';
  expiresAt: number;
}

export interface PutUploadResult {
  uploadId: string;
  status: 'staged';
  bytes: number;
  sha256: string;
  mediaType: V1MediaType;
}

/** One selected output of a delivery (exact refs; contracts.md §2). */
export interface OutputRef {
  name: string;
  mediaType: V1MediaType;
  bytes: number;
  sha256: string;
}

export interface CreateDeliveryRequest {
  projectId: string;
  assetId: string;
  revisionId: string;
  /** Exact sealed manifest root hash (lowercase hex sha256). */
  rootHash: string;
  title: string;
  kind: string;
  outputs: OutputRef[];
  /** Optional minimal provenance; secrets/paths are never included. */
  provenance?: Record<string, string | number | boolean | null>;
}

export interface DeliveryView {
  id: string;
  clientId: string;
  workspaceId: string;
  projectId: string;
  assetId: string;
  revisionId: string;
  rootHash: string;
  title: string;
  kind: string;
  status: 'pending' | 'ready' | 'failed';
  outputs: (OutputRef & { ready: boolean })[];
  createdAt: number;
}

export interface AssetView {
  id: string;
  clientId: string;
  deliveryId: string;
  title: string;
  revisionId: string;
  visibility: 'internal' | 'client_visible';
  editorialStatus: string;
  outputs: OutputRef[];
  createdAt: number;
  /** Admin/agent only: exact provenance of the delivered revision. */
  rootHash?: string;
}

export type Visibility = 'internal' | 'client_visible';

export interface SetVisibilityRequest {
  visibility: Visibility;
}

export interface PostView {
  id: string;
  clientId: string;
  assetId: string;
  title: string;
  caption: string | null;
  cover: OutputRef;
  outputs: OutputRef[];
  visibility: Visibility;
  position: number;
  version: number;
  createdAt: number;
}

export interface CreatePostRequest {
  assetId: string;
  title: string;
  caption?: string;
  /** Ordered selected output names; must all belong to the asset delivery. */
  outputNames: string[];
  /** Exact cover: one of outputNames. */
  coverOutputName: string;
  visibility: Visibility;
}

export interface UpdatePostRequest {
  title?: string;
  caption?: string | null;
  visibility?: Visibility;
  coverOutputName?: string;
  outputNames?: string[];
}

export interface GridState {
  version: number;
  posts: { postId: string; position: number; visibility: Visibility }[];
}

export interface PatchGridRequest {
  /** Current grid version (optimistic concurrency); also accepted via If-Match. */
  version: number;
  /** Ordered post ids for this client. */
  order: string[];
}

/* ---------------------------------------------------------------------------
 * Upload requests (P-102, R-2; contracts.md §2/§3/§5 additive ·
 * customer-assets-requests). A request is a pedido de material per
 * PortalProject with creator-fixed limits; a guest-direct capability token
 * allows uploading to EXACTLY that request without login, session or any
 * other visibility. The raw token exists only in the minted URL.
 * ------------------------------------------------------------------------- */

export type UploadRequestState = 'open' | 'fulfilled' | 'closed' | 'expired';

/** Admin/agent/member view of an upload request (display + budget only). */
export interface UploadRequestView {
  id: string;
  portalProjectId: string;
  portalClientId: string;
  title: string;
  instructions: string | null;
  maxFiles: number;
  maxBytes: number;
  usedFiles: number;
  usedBytes: number;
  remainingFiles: number;
  remainingBytes: number;
  state: UploadRequestState;
  /** Epoch ms when the request stops accepting uploads (lazy evaluation). */
  expiresAt: number;
  createdAt: number;
  closedAt?: number | null;
  closeReason?: string | null;
}

/** Body of POST /api/v1/projects/:projectId/requests (admin or requests:write). */
export interface CreateUploadRequestRequest {
  title: string;
  instructions?: string;
  /** Defaults: 10 files / 2 GiB; ALWAYS validated against the client quota. */
  maxFiles?: number;
  maxBytes?: number;
  /** `<n>m`|`<n>h`|`<n>d`, bounded 30m..30d; default 7d. */
  expiresIn?: string;
}

/**
 * Minted guest link (POST /api/v1/requests/:id/link): the URL is returned
 * EXACTLY ONCE and delivered out-of-band by the operator (0 emails). It is
 * never logged, audited or persisted in plaintext. Re-minting revokes the
 * previous token (one active token per request).
 */
export interface UploadRequestLinkView {
  url: string;
  requestId: string;
  /** Opaque token row id (the capability itself is never echoed again). */
  tokenId: string;
  expiresAt: number;
  limits: { maxFiles: number; maxBytes: number };
}

/** Body of POST /api/v1/requests/:id/link. */
export interface MintRequestLinkRequest {
  /** `<n>m`|`<n>h`|`<n>d`, bounded 30m..30d; default 7d. */
  expiresIn?: string;
  /**
   * Must equal the portal's approved origin (echo of `--origin`); the server
   * clamps any minted link to its own approved origin regardless.
   */
  origin?: string;
}

/** Body of POST /api/v1/requests/:id/close (display-only audit reason). */
export interface CloseUploadRequestRequest {
  reason?: string;
}

/** Minimal guest view (GET /api/v1/r/:token): no ids of any other resource. */
export interface GuestRequestView {
  title: string;
  instructions: string | null;
  state: UploadRequestState;
  expiresAt: number;
  maxFiles: number;
  maxBytes: number;
  remainingFiles: number;
  remainingBytes: number;
}

/** Guest init body (POST /api/v1/r/:token/uploads): material uploads only. */
export interface GuestInitUploadRequest {
  mediaType: V1MediaType;
  declaredBytes: number;
  name?: string;
}

/** Trimmed session view for the guest (no client ids, no internal state). */
export interface GuestUploadSessionView {
  uploadId: string;
  mediaType: V1MediaType;
  declaredBytes: number;
  status: 'pending' | 'staged' | 'ready' | 'failed' | 'expired';
  expiresAt: number;
}

export interface GuestPutUploadResult {
  uploadId: string;
  status: 'staged';
  bytes: number;
  sha256: string;
  mediaType: V1MediaType;
}

/** Guest complete result: the material plus the refreshed request budget. */
export interface GuestCompleteResult {
  material: MaterialView;
  request: GuestRequestView;
}


/* ---------------------------------------------------------------------------
 * Asset upload links (operator order 2026-10-06; contracts aditivos §9 ·
 * customer-assets-requests). An operator (admin human OR agent key holding
 * the NEW `assets:write` scope — grants created before it never hold it)
 * mints an upload link bound to EXACTLY ONE Studio asset. The guest opens
 * it from a phone with NO login and uploads; the take lands attributed to
 * that exact asset (material.asset_target), and `portal-asset-pull` imports
 * it into the EXACT open local asset. 0 emails: the URL exists only in the
 * mint response and is delivered out-of-band by the operator.
 * ------------------------------------------------------------------------- */

/** Lazy state machine of an asset upload link (evaluated on every touch). */
export type AssetUploadLinkState = 'open' | 'used' | 'closed' | 'expired';

/**
 * Minted asset upload link (POST /api/v1/asset-upload-links): the URL is
 * returned EXACTLY ONCE and delivered by the operator's own channel (0
 * emails); it is never logged, audited or persisted in plaintext. One ACTIVE
 * link per (portal client, Studio asset): re-minting closes the previous one
 * (rotation). Deliberately NOT idempotency-keyed, exactly like
 * mintAccessLink/mintRequestLink — replay storage would persist a minted URL.
 */
export interface AssetUploadLinkView {
  url: string;
  /** Opaque link row id (the capability token is never echoed again). */
  linkId: string;
  portalClientId: string;
  /** PortalProject pointer resolved server-side from the Studio project id. */
  portalProjectId: string | null;
  studioProjectId: string;
  studioAssetId: string;
  /** Epoch ms when the link stops accepting uploads (lazy evaluation). */
  expiresAt: number;
}

/** Body of POST /api/v1/asset-upload-links (admin human or assets:write). */
export interface MintAssetLinkRequest {
  /** LOCAL Studio project id; the server resolves the PortalProject pointer. */
  studioProjectId: string;
  /** LOCAL Studio asset id the uploads are bound to (material.asset_target). */
  studioAssetId: string;
  /** Optional cross-check: the resolved pointer MUST belong to this client. */
  portalClientId?: string;
  /** Optional explicit pointer (skips resolution; cross-checked against the
   * Studio project id). */
  portalProjectId?: string;
  /** `<n>m`|`<n>h`|`<n>d`, bounded 30m..30d; default 7d. */
  expiresIn?: string;
  /**
   * Must equal the portal's approved origin (echo of `--origin`); the server
   * clamps any minted link to its own approved origin regardless.
   */
  origin?: string;
}

/** Admin manage view of an asset upload link — NEVER carries the token. */
export interface AssetUploadLinkAdminView {
  id: string;
  portalClientId: string;
  portalProjectId: string | null;
  studioProjectId: string;
  studioAssetId: string;
  state: AssetUploadLinkState;
  expiresAt: number;
  createdAt: number;
  closedAt: number | null;
  closeReason: string | null;
}

/** Body of POST /api/v1/asset-upload-links/:id/close (display-only reason). */
export interface CloseAssetUploadLinkRequest {
  reason?: string;
}

/**
 * One ready material targeted at a Studio asset (GET
 * /api/v1/asset-upload-links/materials?asset=…): the v1 MaterialView plus the
 * exact binding and the producing link id (resolved from the upload's
 * hashed guest principal — no new material columns).
 */
export interface AssetTargetMaterialView {
  id: string;
  clientId: string;
  name: string;
  mediaType: V1MediaType;
  bytes: number;
  sha256: string;
  status: 'ready';
  createdAt: number;
  /** Studio asset id this material was uploaded for. */
  assetTarget: string;
  /** Asset upload link that produced it (null for non-guest uploads). */
  linkId: string | null;
}

/** Minimal guest view (GET /api/v1/a/:token): display fields + quota ONLY —
 * no ids of any other resource, no catalog, no other client's data. */
export interface GuestAssetLinkView {
  assetTitle: string;
  projectTitle: string;
  state: AssetUploadLinkState;
  expiresAt: number;
  quota: {
    /** Client storage budget in bytes (the same quota every upload competes for). */
    limitBytes: number;
    /** limit − used − reserved, floored at 0. */
    remainingBytes: number;
  };
}

/** Guest init body for asset links: identical grammar to request uploads. */
export type GuestAssetInitUploadRequest = GuestInitUploadRequest;

/** Guest complete result: the material plus the refreshed link view. */
export interface GuestAssetCompleteResult {
  material: MaterialView;
  link: GuestAssetLinkView;
}

/* ---------------------------------------------------------------------------
 * Tailnet ingest (operator order 2026-10-06; contratos aditivos §10 ·
 * customer-assets-requests): large-file takes (~500MB) travel over the
 * Tailscale tailnet — an already-authenticated WireGuard network — to a
 * workstation-local ingest server. NO app login on this path; the capability
 * token still scopes every byte to its asset (defense in depth). The portal
 * stays the ONLY source of token validity: the ingest server resolves each
 * token through the guest view `GET {portalOrigin}/api/v1/a/:token` (200 +
 * `state: 'open'` required, ~60s cache) and NEVER trusts client-supplied
 * bindings. Bytes NEVER traverse Cloudflare. Landed files are NOT portal
 * materials: they enter Studio via `portal-asset-ingest-pull`.
 * ------------------------------------------------------------------------- */

/** Portal guest-view binding snapshot the ingest server records verbatim. */
export interface TailnetIngestBinding {
  assetTitle: string;
  projectTitle: string;
  state: AssetUploadLinkState;
  expiresAt: number;
  quota: {
    limitBytes: number;
    remainingBytes: number;
  };
}

/** GET /subir/:token — resume view: binding + caps + current staged offset. */
export interface TailnetIngestView {
  binding: TailnetIngestBinding;
  /** Max bytes accepted per PUT chunk (32 MiB). */
  chunkSize: number;
  /** Max assembled bytes per take (5 GiB). */
  maxBytes: number;
  /** Bytes already staged for this token (resume offset). */
  received: number;
}

/** PUT /subir/:token — one chunk appended at the declared offset. */
export interface TailnetIngestChunkResult {
  /** New staging size after this chunk (next offset to send). */
  received: number;
  chunkSize: number;
  maxBytes: number;
}

/** POST /subir/:token/complete body; `sha256` enables idempotent replay. */
export interface TailnetIngestCompleteRequest {
  /** Expected assembled size; mismatch is a 409 with the real size. */
  bytes: number;
  /** Optional: retry a lost complete response for an already-landed take. */
  sha256?: string;
}

/**
 * POST /subir/:token/complete result AND the landing manifest shape written
 next to the take bytes (`<takeId>.manifest.json`). The binding is ALWAYS the
 portal view snapshot — a binding sent by the uploader is ignored by design.
 */
export interface TailnetIngestManifest {
  schemaVersion: 1;
  source: 'tailnet-ingest';
  /** Content-addressed take id: `take-<first 8 hex of sha256>`. */
  takeId: string;
  /** SHA-256 of the capability token (UNIQUE portal join key; never the token). */
  tokenHash: string;
  /** Producing link id — present ONLY when the portal view exposes one; the
   * v1 guest view is minimal (§3), so provenance keys on tokenHash instead. */
  linkId?: string;
  /** Portal guest-view binding snapshot recorded at validation time. */
  binding: TailnetIngestBinding;
  sha256: string;
  bytes: number;
  mediaType: 'video/mp4';
  /** ISO-8601 instant of the verified landing. */
  receivedAt: string;
  /** Ingest server origin recorded for provenance `(origin, takeId)`. */
  ingestOrigin: string;
}

/** Complete response: the landed manifest plus the idempotent-replay flag. */
export interface TailnetIngestCompleteResult extends TailnetIngestManifest {
  /** True when the take had already landed (replay converges, no dup). */
  idempotent: boolean;
}
