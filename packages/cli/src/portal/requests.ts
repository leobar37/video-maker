/**
 * Portal request bridge (P-103, R-3; contracts.md §6 additive ·
 * customer-assets-requests): the request-facing half of the ONLY permitted
 * link between a local Studio workspace and the remote portal.
 *
 * - `createPortalRequest`: creates the upload request on the given
 *   PortalProject pointer and mints its guest link in one `--execute` step.
 *   The URL travels exactly once in the response for MANUAL operator delivery
 *   (0 emails) and is never persisted or logged here. `--client` is kept as a
 *   cross-check: the created request MUST belong to that portal client.
 *   NOTE (R-3 finding, contracts.md §3 vs §6): agents are refused on the
 *   project routes BY DESIGN (R-1), so the CLI takes the portal project id
 *   explicitly instead of resolving (client, studioProjectId) → pointer.
 * - `listPortalRequests`: lists ONE pointer's requests (agents cannot
 *   enumerate a client's pointers), optionally filtered by state.
 * - `closePortalRequest` / `mintPortalRequestLink`: thin typed wrappers
 *   (close is 409 on already-ended requests; re-mint ROTATES the token).
 * - `pullRequestMaterials`: imports ALL ready materials of one request into
 *   the EXPLICIT local Studio project via the existing `pullMaterial` bridge
 *   path (confined temp, SHA-256 + magic verification, provenance sidecar
 *   incl. requestId, locked/atomic asset.json update). Idempotent by
 *   (origin, materialId): retries converge with zero duplicates and never
 *   overwrite a different input. A workspace WITHOUT that project is a hard
 *   error — no destination is ever invented; a project that does not relate
 *   to the request's portal client is refused by the pullMaterial relation
 *   check (agents cannot read the pointer row itself — contracts.md §3).
 *
 * Errors are typed exactly like the rest of the bridge: `StudioServiceError`
 * for local/usage failures and `ApiClientError` for remote ones. Credentials
 * never appear in errors, plans or provenance; minted URLs never land in logs.
 */
import { StudioServiceError, createStudioContext, getCreativeProject, inspectCreativeAsset, type StudioContext } from '@videomaker/studio';
import type { MaterialView, UploadRequestLinkView, UploadRequestState, UploadRequestView, V1MediaType } from '@videomaker/customer-assets';

import { createPortalClient } from './auth';
import { pullMaterial, type PullMaterialResult } from './bridge';

/** Walks every page of a paged portal list (bounded; cursor is opaque). */
export async function walkPages<T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const result = await fetchPage(cursor);
    items.push(...result.items);
    if (result.nextCursor === null || result.nextCursor.length === 0) return items;
    cursor = result.nextCursor;
  }
  throw new StudioServiceError('INVALID_INPUT', 'La lista del portal no terminó de paginar (cursor cíclico?).');
}

/* ---------------------------------------------------------------------------
 * create (create + mint in one --execute step)
 * ------------------------------------------------------------------------- */

export interface CreatePortalRequestInput {
  origin: string;
  /** PortalProject pointer id (agents cannot enumerate pointers: §3). */
  portalProjectId: string;
  /** Optional cross-check: the created request MUST belong to this client. */
  portalClientId?: string;
  title: string;
  instructions?: string;
  maxFiles: number;
  maxBytes: number;
  /** `<n>m|h|d` 30m..30d, validated locally by the spec layer; default 7d. */
  expiresIn?: string;
}

export interface PortalRequestCreateResult {
  requestId: string;
  url: string;
  expiresAt: number;
  limits: { maxFiles: number; maxBytes: number };
  request: UploadRequestView;
  project: { id: string; portalClientId: string };
}

function fail(code: 'INVALID_INPUT' | 'NOT_FOUND', message: string, details?: Record<string, unknown>): never {
  throw new StudioServiceError(code, message, details);
}

/**
 * Creates the upload request on the given PortalProject pointer and mints its
 * first guest link. Two remote calls by design: the URL exists only in this
 * response (never logged, never persisted — the operator delivers it).
 */
export async function createPortalRequest(input: CreatePortalRequestInput): Promise<PortalRequestCreateResult> {
  if (input.title.trim().length === 0) fail('INVALID_INPUT', 'El título del request es obligatorio.');
  const client = createPortalClient(input.origin);
  const request = await client.createRequest(input.portalProjectId, {
    title: input.title,
    ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
    maxFiles: input.maxFiles,
    maxBytes: input.maxBytes,
    ...(input.expiresIn !== undefined ? { expiresIn: input.expiresIn } : {}),
  });
  if (input.portalClientId !== undefined && request.portalClientId !== input.portalClientId) {
    fail('INVALID_INPUT', '--client no coincide con el cliente del proyecto portal dado; corregí los ids (nunca se crea un request cruzado).', {
      proyecto: request.portalClientId,
      recibido: input.portalClientId,
    });
  }
  const link: UploadRequestLinkView = await client.mintRequestLink(request.id, {
    expiresIn: input.expiresIn,
    origin: input.origin,
  });
  return {
    requestId: request.id,
    url: link.url,
    expiresAt: link.expiresAt,
    limits: link.limits,
    request,
    project: { id: request.portalProjectId, portalClientId: request.portalClientId },
  };
}

/* ---------------------------------------------------------------------------
 * list / close / link
 * ------------------------------------------------------------------------- */

export interface PortalRequestListItem {
  request: UploadRequestView;
  portalProjectId: string;
  portalClientId: string;
}

export interface ListPortalRequestsInput {
  origin: string;
  /** PortalProject pointer id (agents cannot enumerate pointers: §3). */
  portalProjectId: string;
  /** Optional cross-check: every request MUST belong to this client. */
  portalClientId?: string;
  /** Optional client-side state filter (open|fulfilled|closed|expired). */
  state?: UploadRequestState;
}

/** Lists ONE pointer's requests (optionally state-filtered). */
export async function listPortalRequests(input: ListPortalRequestsInput): Promise<PortalRequestListItem[]> {
  const client = createPortalClient(input.origin);
  const requests = await walkPages<UploadRequestView>((cursor) =>
    client.listRequests(input.portalProjectId, { cursor, limit: 100 }),
  );
  const items: PortalRequestListItem[] = [];
  for (const request of requests) {
    if (input.portalClientId !== undefined && request.portalClientId !== input.portalClientId) {
      fail('INVALID_INPUT', '--client no coincide con el cliente del proyecto portal dado.', {
        proyecto: request.portalClientId,
        recibido: input.portalClientId,
      });
    }
    if (input.state === undefined || request.state === input.state) {
      items.push({ request, portalProjectId: request.portalProjectId, portalClientId: request.portalClientId });
    }
  }
  return items;
}

export interface ClosePortalRequestInput {
  origin: string;
  requestId: string;
  reason?: string;
}

/** Closes a request early; the server answers 409 when it already ended. */
export async function closePortalRequest(input: ClosePortalRequestInput): Promise<UploadRequestView> {
  const client = createPortalClient(input.origin);
  return client.closeRequest(input.requestId, input.reason === undefined ? {} : { reason: input.reason });
}

export interface MintPortalRequestLinkInput {
  origin: string;
  requestId: string;
  expiresIn?: string;
}

/**
 * Mints (and ROTATES) the guest link of an open request: the previous token
 * dies immediately (one live capability per request). The URL is returned
 * exactly once for manual delivery.
 */
export async function mintPortalRequestLink(input: MintPortalRequestLinkInput): Promise<UploadRequestLinkView> {
  const client = createPortalClient(input.origin);
  return client.mintRequestLink(input.requestId, { expiresIn: input.expiresIn, origin: input.origin });
}

/* ---------------------------------------------------------------------------
 * pull (imports ALL ready materials of ONE request)
 * ------------------------------------------------------------------------- */

export interface PullRequestMaterialsInput {
  origin: string;
  workspaceDir: string;
  requestId: string;
  /** LOCAL Studio project that receives the inputs (must already exist). */
  projectId: string;
  assetId: string;
}

export interface RequestImportedMaterial {
  id: string;
  name?: string;
  mediaType: V1MediaType;
  bytes: number;
  sha256: string;
  inputPath: string;
  provenancePath: string;
  addedInputs: string[];
  reusedBytes: boolean;
}

export interface PullRequestMaterialsResult {
  executed: true;
  requestId: string;
  state: UploadRequestState;
  portalProject: { id: string; portalClientId: string; studioProjectId: string };
  assetId: string;
  imported: RequestImportedMaterial[];
  addedInputs: string[];
}

/**
 * Imports every ready material of the request into the EXACT Studio project
 * of the pointer, reusing the `portal-material-pull` bridge for each one.
 * Order of failures (nothing is invented, nothing is written on failure):
 * 1. remote request resolution (404 keeps local state untouched),
 * 2. local project existence (clear error, NO destination created),
 * 3. open-asset inspection,
 * 4. per-material verified import — each one re-checks that the local project
 * relates to the request's portal client (pullMaterial relation guard).
 */
export async function pullRequestMaterials(input: PullRequestMaterialsInput): Promise<PullRequestMaterialsResult> {
  const client = createPortalClient(input.origin);
  const request = await client.getRequest(input.requestId);

  const workspaceRoot = resolveWorkspace(input.workspaceDir);
  const studio: StudioContext = createStudioContext(workspaceRoot);
  // Local truth BEFORE any write: the EXPLICIT project must already exist
  // (nunca se inventa un destino; agents cannot read the pointer row, so the
  // operator names the project and the pullMaterial relation guard enforces
  // that it relates to the request's portal client).
  await getCreativeProject(studio, { id: input.projectId });
  await inspectCreativeAsset(studio, { projectId: input.projectId, assetId: input.assetId });

  const materials = await walkPages<MaterialView>((cursor) =>
    client.listRequestMaterials(request.id, { cursor, limit: 100 }),
  );
  if (materials.length === 0) {
    fail('INVALID_INPUT', 'El request no tiene materiales ready para importar.', { requestId: request.id, state: request.state });
  }

  const imported: RequestImportedMaterial[] = [];
  const addedInputs: string[] = [];
  for (const material of materials) {
    const result: PullMaterialResult = await pullMaterial({
      origin: input.origin,
      workspaceDir: input.workspaceDir,
      projectId: input.projectId,
      assetId: input.assetId,
      materialId: material.id,
      requestId: request.id,
    });
    imported.push({
      id: result.material.id,
      ...(result.material.name !== undefined ? { name: result.material.name } : {}),
      mediaType: result.material.mediaType,
      bytes: result.material.bytes,
      sha256: result.material.sha256,
      inputPath: result.inputPath,
      provenancePath: result.provenancePath,
      addedInputs: result.addedInputs,
      reusedBytes: result.reusedBytes,
    });
    addedInputs.push(...result.addedInputs);
  }
  return {
    executed: true,
    requestId: request.id,
    state: request.state,
    portalProject: { id: request.portalProjectId, portalClientId: request.portalClientId, studioProjectId: input.projectId },
    assetId: input.assetId,
    imported,
    addedInputs,
  };
}

function resolveWorkspace(workspaceDir: string): string {
  if (workspaceDir.trim().length === 0) fail('INVALID_INPUT', '--workspace es obligatorio.');
  return workspaceDir;
}

/** Re-exported for the spec layer's human renderings. */
export type { UploadRequestView, UploadRequestState };
