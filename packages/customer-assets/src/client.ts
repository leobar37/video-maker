/**
 * @videomaker/customer-assets — typed fetch client for the portal v1 API
 * (contracts.md §6/§7).
 *
 * Pure module: no Node or Bun imports, only the platform `fetch`. Base URL and
 * credentials are injected by the caller; nothing is persisted, logged, or
 * derived from the environment. Credential discipline (contracts.md §7):
 * - the API key header is attached ONLY to requests against the configured
 *   base URL (every URL is built from `baseUrl`, never from server data);
 * - `redirect: 'error'` guarantees a credential never follows a redirect:
 *   the portal API does not redirect, so any 3xx is a hard failure instead of
 *   a silent cross-origin credential leak.
 */

import type {
  AccessLinkView,
  AdoptClientRequest,
  ApiError,
  AssetTargetMaterialView,
  AssetUploadLinkAdminView,
  AssetUploadLinkView,
  AssetView,
  CloseAssetUploadLinkRequest,
  CloseUploadRequestRequest,
  CreateDeliveryRequest,
  CreatePostRequest,
  CreateProjectRequest,
  CreateUploadRequestRequest,
  DeliveryView,
  GuestAssetCompleteResult,
  GuestAssetInitUploadRequest,
  GuestAssetLinkView,
  GridState,
  GuestPutUploadResult,
  GuestUploadSessionView,
  InitUploadRequest,
  MaterialView,
  MeInfo,
  MintAccessLinkRequest,
  MintAssetLinkRequest,
  MintRequestLinkRequest,
  Page,
  PatchGridRequest,
  PortalClientView,
  PortalProjectView,
  PostView,
  PutUploadResult,
  RenameProjectRequest,
  SetVisibilityRequest,
  UpdatePostRequest,
  UploadRequestLinkView,
  UploadRequestView,
  UploadSessionView,
  TailnetIngestChunkResult,
  TailnetIngestCompleteRequest,
  TailnetIngestCompleteResult,
  TailnetIngestView,
} from './contracts.js';

/** Error thrown for every non-2xx API response (typed envelope). */
export class ApiClientError extends Error {
  readonly code: ApiError['error']['code'];
  readonly requestId: string;
  readonly status: number;

  constructor(status: number, code: ApiError['error']['code'], message: string, requestId: string) {
    super(`[${status}] ${code}: ${message}`);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/** Credential source: a static value or a per-call resolver (call-time only). */
export type CredentialSource = string | (() => string | undefined);

export interface CustomerAssetsClientOptions {
  /** Approved portal origin, e.g. https://customers-assets.example (no path). */
  baseUrl: string;
  /** Agent API key (Better Auth `x-api-key`); resolved fresh on every call. */
  apiKey?: CredentialSource;
  /** Optional cookie header source for same-origin human sessions (tests/UI). */
  cookie?: CredentialSource;
  /** Fetch implementation override (defaults to globalThis.fetch). */
  fetchImpl?: typeof fetch;
}

export interface ListOptions {
  cursor?: string | null;
  limit?: number;
}

export interface ContentOptions {
  /** Single byte range for MP4/images: `{ start }` / `{ start, end }` / suffix. */
  range?: { start?: number; end?: number; suffix?: number };
}

export class CustomerAssetsClient {
  private readonly baseUrl: string;
  private readonly apiKey?: CredentialSource;
  private readonly cookie?: CredentialSource;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CustomerAssetsClientOptions) {
    const parsed = new URL(options.baseUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('baseUrl must be an http(s) origin');
    }
    this.baseUrl = parsed.origin;
    this.apiKey = options.apiKey;
    this.cookie = options.cookie;
    // `bind` matters in browsers: an unbound fetch loses its window receiver
    // ("Illegal invocation") when invoked as a plain callable.
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Credential headers are attached ONLY for same-origin requests. */
  private credentialHeaders(url: URL): HeadersInit {
    const headers: Record<string, string> = {};
    if (url.origin !== this.baseUrl) return headers;
    const key = typeof this.apiKey === 'function' ? this.apiKey() : this.apiKey;
    if (key) headers['x-api-key'] = key;
    const cookie = typeof this.cookie === 'function' ? this.cookie() : this.cookie;
    if (cookie) headers.cookie = cookie;
    return headers;
  }

  private async request<T>(
    method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH',
    path: string,
    init: {
      body?: unknown;
      rawBody?: BodyInit;
      contentType?: string;
      query?: Record<string, string | number | undefined>;
      idempotencyKey?: string;
      ifMatch?: string;
      range?: ContentOptions['range'];
    } = {},
  ): Promise<Response> {
    const url = new URL(this.baseUrl + path);
    if (init.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const headers = new Headers(this.credentialHeaders(url));
    if (init.contentType) headers.set('content-type', init.contentType);
    if (init.idempotencyKey) headers.set('idempotency-key', init.idempotencyKey);
    if (init.ifMatch !== undefined) headers.set('if-match', init.ifMatch);
    if (init.range) {
      const { start, end, suffix } = init.range;
      if (suffix !== undefined) headers.set('range', `bytes=-${suffix}`);
      else if (start !== undefined && end !== undefined) headers.set('range', `bytes=${start}-${end}`);
      else if (start !== undefined) headers.set('range', `bytes=${start}-`);
    }
    const body =
      init.rawBody ??
      (init.body === undefined ? undefined : JSON.stringify(init.body));
    const response = await this.fetchImpl(url, {
      method,
      headers,
      body,
      redirect: 'error',
    });
    if (!response.ok) {
      let code: ApiError['error']['code'] = 'internal';
      let message = response.statusText || 'request failed';
      let requestId = '';
      try {
        const parsed = (await response.json()) as ApiError;
        code = parsed.error.code;
        message = parsed.error.message;
        requestId = parsed.error.requestId;
      } catch {
        /* non-JSON error body: keep status-text fallback */
      }
      throw new ApiClientError(response.status, code, message, requestId);
    }
    return response as Response;
  }

  /* identity ------------------------------------------------------------- */

  async me(): Promise<MeInfo> {
    return (await this.request('GET', '/api/v1/me')).json() as Promise<MeInfo>;
  }

  /* clients -------------------------------------------------------------- */

  async listClients(options: ListOptions = {}): Promise<Page<PortalClientView>> {
    return (await this.request('GET', '/api/v1/clients', {
      query: { cursor: options.cursor ?? undefined, limit: options.limit },
    })).json() as Promise<Page<PortalClientView>>;
  }

  /** Integrator-only client projection (workspace grant + clients:write). */
  async adoptClient(request: AdoptClientRequest, idempotencyKey?: string): Promise<PortalClientView> {
    return (await this.request('POST', '/api/v1/clients/adopt', {
      body: request,
      idempotencyKey,
    })).json() as Promise<PortalClientView>;
  }

  /* projects (P-101, R-1) -------------------------------------------------- */

  /** Lists a client's project pointers (admin + members of that client). */
  async listProjects(clientId: string, options: ListOptions = {}): Promise<Page<PortalProjectView>> {
    return (await this.request(
      'GET',
      `/api/v1/clients/${encodeURIComponent(clientId)}/projects`,
      { query: { cursor: options.cursor ?? undefined, limit: options.limit } },
    )).json() as Promise<Page<PortalProjectView>>;
  }

  /** Admin-human-only projection of an existing Studio project. */
  async createProject(clientId: string, request: CreateProjectRequest, idempotencyKey?: string): Promise<PortalProjectView> {
    return (await this.request(
      'POST',
      `/api/v1/clients/${encodeURIComponent(clientId)}/projects`,
      { body: request, idempotencyKey },
    )).json() as Promise<PortalProjectView>;
  }

  /** Admin-human-only display-title rename. */
  async renameProject(projectId: string, request: RenameProjectRequest): Promise<PortalProjectView> {
    return (await this.request('PATCH', `/api/v1/projects/${encodeURIComponent(projectId)}`, {
      body: request,
    })).json() as Promise<PortalProjectView>;
  }

  /* materials ------------------------------------------------------------ */

  async listMaterials(clientId: string, options: ListOptions = {}): Promise<Page<MaterialView>> {
    return (await this.request('GET', `/api/v1/clients/${encodeURIComponent(clientId)}/materials`, {
      query: { cursor: options.cursor ?? undefined, limit: options.limit },
    })).json() as Promise<Page<MaterialView>>;
  }

  async getMaterial(materialId: string): Promise<MaterialView> {
    return (await this.request('GET', `/api/v1/materials/${encodeURIComponent(materialId)}`))
      .json() as Promise<MaterialView>;
  }

  /** Raw content stream (Range/HEAD supported by the server). */
  async getMaterialContent(materialId: string, options: ContentOptions & { head?: boolean } = {}): Promise<Response> {
    return this.request(options.head ? 'HEAD' : 'GET', `/api/v1/materials/${encodeURIComponent(materialId)}/content`, {
      range: options.range,
    });
  }

  /* uploads (materials and delivery outputs share the protocol) ---------- */

  async initUpload(clientId: string, request: InitUploadRequest, idempotencyKey?: string): Promise<UploadSessionView> {
    return (await this.request('POST', `/api/v1/clients/${encodeURIComponent(clientId)}/uploads`, {
      body: request,
      idempotencyKey,
    })).json() as Promise<UploadSessionView>;
  }

  async putUploadContent(
    uploadId: string,
    body: BodyInit,
    options: { contentType?: string } = {},
  ): Promise<PutUploadResult> {
    return (await this.request('PUT', `/api/v1/uploads/${encodeURIComponent(uploadId)}/content`, {
      rawBody: body,
      contentType: options.contentType,
    })).json() as Promise<PutUploadResult>;
  }

  async completeUpload(uploadId: string): Promise<MaterialView> {
    return (await this.request('POST', `/api/v1/uploads/${encodeURIComponent(uploadId)}/complete`, {}))
      .json() as Promise<MaterialView>;
  }

  /* deliveries and assets ------------------------------------------------ */

  async createDelivery(
    clientId: string,
    request: CreateDeliveryRequest,
    idempotencyKey?: string,
  ): Promise<DeliveryView> {
    return (await this.request('POST', `/api/v1/clients/${encodeURIComponent(clientId)}/deliveries`, {
      body: request,
      idempotencyKey,
    })).json() as Promise<DeliveryView>;
  }

  async completeDelivery(deliveryId: string): Promise<DeliveryView> {
    return (await this.request('POST', `/api/v1/deliveries/${encodeURIComponent(deliveryId)}/complete`, {}))
      .json() as Promise<DeliveryView>;
  }

  async listAssets(clientId: string): Promise<Page<AssetView>> {
    return (await this.request('GET', `/api/v1/clients/${encodeURIComponent(clientId)}/assets`))
      .json() as Promise<Page<AssetView>>;
  }

  async getDeliveryOutput(
    deliveryId: string,
    outputName: string,
    options: ContentOptions & { head?: boolean } = {},
  ): Promise<Response> {
    return this.request(
      options.head ? 'HEAD' : 'GET',
      `/api/v1/deliveries/${encodeURIComponent(deliveryId)}/outputs/${encodeURIComponent(outputName)}`,
      { range: options.range },
    );
  }

  /* posts and grid (admin-only writes) ----------------------------------- */

  async listPosts(clientId: string): Promise<Page<PostView>> {
    return (await this.request('GET', `/api/v1/clients/${encodeURIComponent(clientId)}/posts`))
      .json() as Promise<Page<PostView>>;
  }

  async createPost(clientId: string, request: CreatePostRequest, idempotencyKey?: string): Promise<PostView> {
    return (await this.request('POST', `/api/v1/clients/${encodeURIComponent(clientId)}/posts`, {
      body: request,
      idempotencyKey,
    })).json() as Promise<PostView>;
  }

  async patchPost(postId: string, patch: UpdatePostRequest, ifMatchVersion?: number): Promise<PostView> {
    return (await this.request('PATCH', `/api/v1/posts/${encodeURIComponent(postId)}`, {
      body: patch,
      ifMatch: ifMatchVersion === undefined ? undefined : `"${ifMatchVersion}"`,
    })).json() as Promise<PostView>;
  }

  async patchGrid(
    clientId: string,
    request: PatchGridRequest,
    options: { ifMatchInsteadOfBodyVersion?: boolean } = {},
  ): Promise<GridState> {
    const bodyVersion = options.ifMatchInsteadOfBodyVersion ? undefined : request.version;
    return (await this.request('PATCH', `/api/v1/clients/${encodeURIComponent(clientId)}/grid`, {
      body: { order: request.order, ...(bodyVersion === undefined ? {} : { version: bodyVersion }) },
      ifMatch: options.ifMatchInsteadOfBodyVersion ? `"${request.version}"` : undefined,
    })).json() as Promise<GridState>;
  }

  /** GET grid — admin-only read of the current version + ordered posts. */
  async getGrid(clientId: string): Promise<GridState> {
    return (await this.request('GET', `/api/v1/clients/${encodeURIComponent(clientId)}/grid`))
      .json() as Promise<GridState>;
  }

  /* access-link minting (admin human / agent with access:write) ------------ */

  /**
   * Mints a single-use Better Auth login URL for a client member. The URL is
   * delivered out-of-band by the operator (WhatsApp etc.); it is returned
   * exactly once and must never be logged or persisted by the caller.
   * Deliberately NOT idempotency-keyed: every call mints a fresh link.
   */
  async mintAccessLink(clientId: string, request: MintAccessLinkRequest): Promise<AccessLinkView> {
    return (await this.request(
      'POST',
      `/api/v1/clients/${encodeURIComponent(clientId)}/access-links`,
      { body: request },
    )).json() as Promise<AccessLinkView>;
  }

  async setAssetVisibility(assetId: string, request: SetVisibilityRequest): Promise<AssetView> {
    return (await this.request('PATCH', `/api/v1/client-assets/${encodeURIComponent(assetId)}/visibility`, {
      body: request,
    })).json() as Promise<AssetView>;
  }

  /* upload requests (P-102, R-2; admin human / agent requests:*) ---------- */

  /** Lists a project's upload requests (admin, client members, requests:read). */
  async listRequests(projectId: string, options: ListOptions = {}): Promise<Page<UploadRequestView>> {
    return (await this.request('GET', `/api/v1/projects/${encodeURIComponent(projectId)}/requests`, {
      query: { cursor: options.cursor ?? undefined, limit: options.limit },
    })).json() as Promise<Page<UploadRequestView>>;
  }

  /** Gets one request (admin, client members, requests:read). */
  async getRequest(requestId: string): Promise<UploadRequestView> {
    return (await this.request('GET', `/api/v1/requests/${encodeURIComponent(requestId)}`))
      .json() as Promise<UploadRequestView>;
  }

  /** Creates a request (admin human or agent with requests:write). */
  async createRequest(
    projectId: string,
    request: CreateUploadRequestRequest,
    idempotencyKey?: string,
  ): Promise<UploadRequestView> {
    return (await this.request('POST', `/api/v1/projects/${encodeURIComponent(projectId)}/requests`, {
      body: request,
      idempotencyKey,
    })).json() as Promise<UploadRequestView>;
  }

  /**
   * Mints (and rotates) the guest-direct link of a request. The URL is shown
   * exactly once and delivered by the operator's own channel (0 emails);
   * never logged or persisted. Deliberately NOT idempotency-keyed, exactly
   * like mintAccessLink.
   */
  async mintRequestLink(requestId: string, request: MintRequestLinkRequest): Promise<UploadRequestLinkView> {
    return (await this.request('POST', `/api/v1/requests/${encodeURIComponent(requestId)}/link`, {
      body: request,
    })).json() as Promise<UploadRequestLinkView>;
  }

  /** Closes a request early (admin human or requests:write); 409 when ended. */
  async closeRequest(requestId: string, request?: CloseUploadRequestRequest): Promise<UploadRequestView> {
    return (await this.request('POST', `/api/v1/requests/${encodeURIComponent(requestId)}/close`, {
      body: request ?? {},
    })).json() as Promise<UploadRequestView>;
  }

  /** Lists the materials completed through a request (metadata only). */
  async listRequestMaterials(requestId: string, options: ListOptions = {}): Promise<Page<MaterialView>> {
    return (await this.request('GET', `/api/v1/requests/${encodeURIComponent(requestId)}/materials`, {
      query: { cursor: options.cursor ?? undefined, limit: options.limit },
    })).json() as Promise<Page<MaterialView>>;
  }

  /* asset upload links (operator order 2026-10-06; admin human / assets:write) --- */

  /**
   * Mints (and rotates) the guest-direct upload link of ONE Studio asset.
   * The URL is shown exactly once and delivered by the operator's own channel
   * (0 emails); never logged or persisted. Deliberately NOT idempotency-keyed,
   * exactly like mintAccessLink/mintRequestLink.
   *
   * Additive tailnet option (§10 customer-assets-requests): when `tailnet` is
   * given, the response also carries `tailnetUrl` — the SAME capability token
   * served by the workstation-local ingest server over the tailnet
   * (`http://<host>:<port>/subir/<token>`). The host is caller-resolved
   * (`tailscale ip -4`); this pure module never shells out and the portal
   * never learns the tailnet address.
   */
  async mintAssetUploadLink(
    request: MintAssetLinkRequest,
    options: { tailnet?: { host: string; port: number } } = {},
  ): Promise<AssetUploadLinkView & { tailnetUrl?: string }> {
    const link = (await (
      await this.request('POST', '/api/v1/asset-upload-links', {
        body: request,
      })
    ).json()) as AssetUploadLinkView;
    if (options.tailnet === undefined) return link;
    const token = link.url.split('/asset-upload/')[1] ?? '';
    if (token.length === 0) return { ...link };
    return {
      ...link,
      tailnetUrl: `http://${options.tailnet.host}:${options.tailnet.port}/subir/${encodeURIComponent(token)}`,
    };
  }

  /** Lists asset upload links (admin human); filters are optional. */
  async listAssetUploadLinks(
    options: { client?: string; asset?: string } & ListOptions = {},
  ): Promise<Page<AssetUploadLinkAdminView>> {
    return (await this.request('GET', '/api/v1/asset-upload-links', {
      query: {
        client: options.client,
        asset: options.asset,
        cursor: options.cursor ?? undefined,
        limit: options.limit,
      },
    })).json() as Promise<Page<AssetUploadLinkAdminView>>;
  }

  /** Gets one asset upload link (admin human); never carries the token. */
  async getAssetUploadLink(linkId: string): Promise<AssetUploadLinkAdminView> {
    return (await this.request('GET', `/api/v1/asset-upload-links/${encodeURIComponent(linkId)}`))
      .json() as Promise<AssetUploadLinkAdminView>;
  }

  /** Closes an OPEN link early (admin human); 409 when already ended. */
  async closeAssetUploadLink(linkId: string, request?: CloseAssetUploadLinkRequest): Promise<AssetUploadLinkAdminView> {
    return (await this.request('POST', `/api/v1/asset-upload-links/${encodeURIComponent(linkId)}/close`, {
      body: request ?? {},
    })).json() as Promise<AssetUploadLinkAdminView>;
  }

  /**
   * Lists the ready materials whose `asset_target` is the given LOCAL Studio
   * asset id — the exact import set of `portal-asset-pull` (admin human or
   * agent with materials:read).
   */
  async listAssetUploadLinkMaterials(assetId: string, options: ListOptions = {}): Promise<Page<AssetTargetMaterialView>> {
    return (await this.request('GET', '/api/v1/asset-upload-links/materials', {
      query: { asset: assetId, cursor: options.cursor ?? undefined, limit: options.limit },
    })).json() as Promise<Page<AssetTargetMaterialView>>;
  }

  /* guest asset upload family (mirrors the guest request methods' shape) --- */

  /** GET /api/v1/a/:token — minimal view (asset/project titles + quota). */
  async getAssetUploadGuestView(token: string): Promise<GuestAssetLinkView> {
    return (await this.request('GET', `/api/v1/a/${encodeURIComponent(token)}`))
      .json() as Promise<GuestAssetLinkView>;
  }

  /** POST /api/v1/a/:token/uploads — client-quota reservation only. */
  async initAssetUpload(token: string, request: GuestAssetInitUploadRequest, idempotencyKey?: string): Promise<GuestUploadSessionView> {
    return (await this.request('POST', `/api/v1/a/${encodeURIComponent(token)}/uploads`, {
      body: request,
      idempotencyKey,
    })).json() as Promise<GuestUploadSessionView>;
  }

  /** PUT /api/v1/a/:token/uploads/:id/content — same streaming staging. */
  async putAssetUploadContent(
    token: string,
    uploadId: string,
    body: BodyInit,
    options: { contentType?: string } = {},
  ): Promise<PutUploadResult> {
    return (await this.request(
      'PUT',
      `/api/v1/a/${encodeURIComponent(token)}/uploads/${encodeURIComponent(uploadId)}/content`,
      { rawBody: body, contentType: options.contentType },
    )).json() as Promise<PutUploadResult>;
  }

  /** POST /api/v1/a/:token/uploads/:id/complete — verify + attribute. */
  async completeAssetUpload(token: string, uploadId: string): Promise<GuestAssetCompleteResult> {
    return (await this.request(
      'POST',
      `/api/v1/a/${encodeURIComponent(token)}/uploads/${encodeURIComponent(uploadId)}/complete`,
      {},
    )).json() as Promise<GuestAssetCompleteResult>;
  }

  /* tailnet ingest (§10 customer-assets-requests; NO credentials, NO portal) - */

  /**
   * Drives the workstation-local ingest server over the tailnet. These calls
   * go to an EXPLICIT `ingestBaseUrl` (never `baseUrl`): the ingest path is
   * closed-network (WireGuard device identity) and carries NO app login, so
   * this method attaches NO credential headers at all and never follows
   * redirects. Errors keep the portal-style typed envelope.
   */
  private async ingestRequest<T>(
    method: 'GET' | 'PUT' | 'POST',
    ingestBaseUrl: string,
    token: string,
    pathSuffix: string,
    init: { body?: BodyInit; contentType?: string; query?: Record<string, string | number> } = {},
  ): Promise<T> {
    const base = new URL(ingestBaseUrl);
    if (base.protocol !== 'https:' && base.protocol !== 'http:') {
      throw new Error('ingestBaseUrl must be an http(s) origin');
    }
    const url = new URL(`${base.origin}/subir/${encodeURIComponent(token)}${pathSuffix}`);
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, String(value));
    const headers = new Headers();
    if (init.contentType !== undefined) headers.set('content-type', init.contentType);
    const response = await this.fetchImpl(url, { method, headers, body: init.body, redirect: 'error' });
    if (!response.ok) {
      let code: ApiError['error']['code'] = 'internal';
      let message = response.statusText || 'ingest request failed';
      let requestId = '';
      try {
        const parsed = (await response.json()) as ApiError;
        code = parsed.error.code;
        message = parsed.error.message;
        requestId = parsed.error.requestId;
      } catch {
        /* non-JSON error body: keep status-text fallback */
      }
      throw new ApiClientError(response.status, code, message, requestId);
    }
    return (response as Response).json() as Promise<T>;
  }

  /** GET /subir/:token — token validity + binding + resume offset. */
  async getTailnetIngestView(ingestBaseUrl: string, token: string): Promise<TailnetIngestView> {
    return this.ingestRequest<TailnetIngestView>('GET', ingestBaseUrl, token, '');
  }

  /**
   * PUT /subir/:token — one chunk. `offset` is the staging position this
   * chunk starts at (server answers 409 with the real offset on mismatch);
   * `total` mirrors the Content-Range total (checked for cross-chunk drift).
   */
  async putTailnetIngestChunk(
    ingestBaseUrl: string,
    token: string,
    body: BodyInit,
    options: { offset?: number; total?: number; contentType?: string } = {},
  ): Promise<TailnetIngestChunkResult> {
    return this.ingestRequest<TailnetIngestChunkResult>('PUT', ingestBaseUrl, token, '', {
      body,
      ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
      ...(options.offset !== undefined || options.total !== undefined
        ? { query: { ...(options.offset !== undefined ? { offset: options.offset } : {}), ...(options.total !== undefined ? { total: options.total } : {}) } }
        : {}),
    });
  }

  /** POST /subir/:token/complete — verify, hash and land the take. */
  async completeTailnetIngest(
    ingestBaseUrl: string,
    token: string,
    request: TailnetIngestCompleteRequest,
  ): Promise<TailnetIngestCompleteResult> {
    return this.ingestRequest<TailnetIngestCompleteResult>('POST', ingestBaseUrl, token, '/complete', {
      body: JSON.stringify(request),
      contentType: 'application/json',
    });
  }
}

/** Convenience factory. */
export function createCustomerAssetsClient(options: CustomerAssetsClientOptions): CustomerAssetsClient {
  return new CustomerAssetsClient(options);
}
