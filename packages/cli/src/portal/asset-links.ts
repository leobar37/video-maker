/**
 * Portal asset-link bridge (operator order 2026-10-06; contratos aditivos §9
 * · customer-assets-requests): the per-asset half of the ONLY permitted link
 * between a local Studio workspace and the remote portal.
 *
 * - `mintPortalAssetLink`: mints the guest-direct upload link bound to
 *   EXACTLY ONE local Studio asset. Local truth first (the project and the
 *   OPEN asset must exist — never a blind mint), then POST
 *   /api/v1/asset-upload-links with the NEW `assets:write` agent scope (old
 *   grants are denied server-side). The URL travels exactly once in the
 *   response for MANUAL operator delivery (0 emails) and is never persisted
 *   or logged here. `--client` is kept as a cross-check: the resolved pointer
 *   MUST belong to that portal client.
 * - `pullAssetMaterials`: imports ALL ready materials whose asset_target is
 *   the given Studio asset id into the EXPLICIT local Studio project via the
 *   existing `pullMaterial` bridge (confined temp, SHA-256 + magic
 *   verification, provenance sidecar incl. linkId, locked/atomic asset.json
 *   update). Idempotent by (origin, materialId): retries converge with zero
 *   duplicates and never overwrite a different input. A workspace WITHOUT
 *   that project/asset is a hard error — no destination is ever invented; a
 *   project that does not relate to the material's portal client is refused
 *   by the pullMaterial relation check (contracts.md §3).
 *
 * Errors are typed exactly like the rest of the bridge: `StudioServiceError`
 * for local/usage failures and `ApiClientError` for remote ones. Credentials
 * never appear in errors, plans or provenance; minted URLs never land in logs.
 */
import { StudioServiceError, createStudioContext, getCreativeProject, inspectCreativeAsset, type StudioContext } from '@videomaker/studio';
import type { AssetTargetMaterialView, AssetUploadLinkView } from '@videomaker/customer-assets';

import { rmdir, rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createPortalClient } from './auth';
import { importMaterialBytes, pullMaterial, type PullMaterialResult } from './bridge';
import { listLandedTakes } from './ingest-server';
import { walkPages } from './requests';

function fail(code: 'INVALID_INPUT' | 'NOT_FOUND', message: string, details?: Record<string, unknown>): never {
  throw new StudioServiceError(code, message, details);
}

/** Verifies the LOCAL project + OPEN asset exist before any remote call. */
async function inspectLocalTarget(studio: StudioContext, projectId: string, assetId: string): Promise<void> {
  await getCreativeProject(studio, { id: projectId });
  await inspectCreativeAsset(studio, { projectId, assetId });
}

/* ---------------------------------------------------------------------------
 * mint (URL de entrega manual, una sola vez)
 * ------------------------------------------------------------------------- */

export interface MintPortalAssetLinkInput {
  origin: string;
  /** Local workspace whose project/asset must already exist (execute mode). */
  workspaceDir: string;
  /** LOCAL Studio project id (the server resolves the portal pointer). */
  studioProjectId: string;
  /** LOCAL Studio asset id the uploads bind to (material.asset_target). */
  studioAssetId: string;
  /** Optional cross-check: the resolved pointer MUST belong to this client. */
  portalClientId?: string;
  /** `<n>m|h|d` 30m..30d, validated locally by the spec layer; default 7d. */
  expiresIn?: string;
}

export interface PortalAssetLinkMintResult {
  url: string;
  linkId: string;
  portalClientId: string;
  portalProjectId: string | null;
  studioProjectId: string;
  studioAssetId: string;
  expiresAt: number;
}

/**
 * Mints (and rotates) the per-asset guest link. Two ordered steps by design:
 * local inspection (a link for a non-existent local asset is an operator
 * mistake, refused before ANY network call) and the remote mint whose URL
 * exists only in this response (never logged, never persisted).
 */
export async function mintPortalAssetLink(input: MintPortalAssetLinkInput): Promise<PortalAssetLinkMintResult> {
  if (input.studioProjectId.trim().length === 0) fail('INVALID_INPUT', '--project (id studio local) es obligatorio.');
  if (input.studioAssetId.trim().length === 0) fail('INVALID_INPUT', '--asset (id studio local) es obligatorio.');
  const studio: StudioContext = createStudioContext(input.workspaceDir);
  await inspectLocalTarget(studio, input.studioProjectId, input.studioAssetId);

  const client = createPortalClient(input.origin);
  const link: AssetUploadLinkView = await client.mintAssetUploadLink({
    studioProjectId: input.studioProjectId,
    studioAssetId: input.studioAssetId,
    ...(input.portalClientId !== undefined ? { portalClientId: input.portalClientId } : {}),
    ...(input.expiresIn !== undefined ? { expiresIn: input.expiresIn } : {}),
    origin: input.origin,
  });
  if (input.portalClientId !== undefined && link.portalClientId !== input.portalClientId) {
    fail('INVALID_INPUT', '--client no coincide con el cliente del puntero resuelto para ese proyecto studio; corregí los ids (nunca se mintea un link cruzado).', {
      proyecto: link.portalClientId,
      recibido: input.portalClientId,
    });
  }
  return {
    url: link.url,
    linkId: link.linkId,
    portalClientId: link.portalClientId,
    portalProjectId: link.portalProjectId,
    studioProjectId: link.studioProjectId,
    studioAssetId: link.studioAssetId,
    expiresAt: link.expiresAt,
  };
}

/* ---------------------------------------------------------------------------
 * pull (imports ALL ready materials with asset_target == that asset)
 * ------------------------------------------------------------------------- */

export interface PullAssetMaterialsInput {
  origin: string;
  workspaceDir: string;
  /** LOCAL Studio project that receives the inputs (must already exist). */
  studioProjectId: string;
  /** LOCAL Studio asset id whose linked materials get imported. */
  studioAssetId: string;
}

export interface AssetImportedMaterial {
  id: string;
  name?: string;
  mediaType: AssetTargetMaterialView['mediaType'];
  bytes: number;
  sha256: string;
  inputPath: string;
  provenancePath: string;
  addedInputs: string[];
  reusedBytes: boolean;
  /** Producing link id (server-resolved provenance; null for legacy rows). */
  linkId: string | null;
}

export interface PullAssetMaterialsResult {
  executed: true;
  studioProjectId: string;
  studioAssetId: string;
  imported: AssetImportedMaterial[];
  addedInputs: string[];
}

/**
 * Imports every ready material whose asset_target is the given LOCAL Studio
 * asset id into the EXACT open asset. Order of failures (nothing is invented,
 * nothing is written on failure):
 * 1. remote listing of the per-asset import set (an empty set is a clear
 *    INVALID_INPUT, never a silent success),
 * 2. local project + open-asset inspection,
 * 3. per-material verified import — each one re-checks that the local project
 *    relates to the material's portal client (pullMaterial relation guard)
 *    and records the producing linkId in the provenance sidecar.
 */
export async function pullAssetMaterials(input: PullAssetMaterialsInput): Promise<PullAssetMaterialsResult> {
  if (input.studioProjectId.trim().length === 0) fail('INVALID_INPUT', '--project (id studio local) es obligatorio.');
  if (input.studioAssetId.trim().length === 0) fail('INVALID_INPUT', '--asset (id studio local) es obligatorio.');
  const client = createPortalClient(input.origin);
  const targets = await walkPages<AssetTargetMaterialView>((cursor) =>
    client.listAssetUploadLinkMaterials(input.studioAssetId, { cursor, limit: 100 }),
  );
  if (targets.length === 0) {
    fail('INVALID_INPUT', 'No hay materiales ready con asset_target en ese asset studio; verificá el id o minteá un link nuevo.', {
      studioAssetId: input.studioAssetId,
    });
  }

  const studio: StudioContext = createStudioContext(input.workspaceDir);
  await inspectLocalTarget(studio, input.studioProjectId, input.studioAssetId);

  const imported: AssetImportedMaterial[] = [];
  const addedInputs: string[] = [];
  for (const target of targets) {
    const result: PullMaterialResult = await pullMaterial({
      origin: input.origin,
      workspaceDir: input.workspaceDir,
      projectId: input.studioProjectId,
      assetId: input.studioAssetId,
      materialId: target.id,
      ...(target.linkId !== null ? { linkId: target.linkId } : {}),
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
      linkId: target.linkId,
    });
    addedInputs.push(...result.addedInputs);
  }
  return {
    executed: true,
    studioProjectId: input.studioProjectId,
    studioAssetId: input.studioAssetId,
    imported,
    addedInputs,
  };
}

/* ---------------------------------------------------------------------------
 * tailnet ingest pull (operator order 2026-10-06; §10 customer-assets-requests)
 * ------------------------------------------------------------------------- */

export interface PullLandedTakesInput {
  workspaceDir: string;
  /** Landing root (default `.tmp/portal-ingest`, resolved from the cwd). */
  ingestDir: string;
  /** LOCAL Studio project that receives the takes (must already exist). */
  studioProjectId: string;
  /** LOCAL Studio asset id the takes bind to (must exist and be OPEN). */
  studioAssetId: string;
  /** Optional tokenHash prefix (8+ hex) to import only one link's takes. */
  tokenHashPrefix?: string;
}

export interface IngestImportedTake {
  takeId: string;
  tokenHash: string;
  sha256: string;
  bytes: number;
  ingestOrigin: string;
  inputPath: string;
  provenancePath: string;
  addedInputs: string[];
  reusedBytes: boolean;
  /** True when the verified import let the pull drain the landing entry. */
  removedFromLanding: boolean;
}

export interface PullLandedTakesResult {
  executed: true;
  studioProjectId: string;
  studioAssetId: string;
  ingestDir: string;
  imported: IngestImportedTake[];
  addedInputs: string[];
}

/**
 * Imports LANDED tailnet takes into the EXACT open Studio asset. This is a
 * LOCAL operation by design: no portal call, no credential — the takes never
 * became portal materials (§10). Every take is content-addressed and goes
 * through the SAME verified import path as portal pulls (`importMaterialBytes`:
 * SHA-256 + bytes + magic re-verified, exclusive-create input, deterministic
 * provenance sidecar with `tailnet: true` + tokenHash, locked atomic
 * asset.json update). The landing entry is removed ONLY after a verified
 * import, so a retry after a partial failure converges; a landing already
 * drained by a previous pull is an EMPTY success (idempotent), unlike the
 * portal pull whose empty import set is an operator mistake.
 *
 * linkId note: the v1 portal guest view is minimal (§3 — no ids), so the
 * ingest path records `tokenHash` (the UNIQUE portal join key) in the
 * sidecar; `linkId` is included only when a future portal view exposes it.
 */
export async function pullLandedTakes(input: PullLandedTakesInput): Promise<PullLandedTakesResult> {
  if (input.studioProjectId.trim().length === 0) fail('INVALID_INPUT', '--project (id studio local) es obligatorio.');
  if (input.studioAssetId.trim().length === 0) fail('INVALID_INPUT', '--asset (id studio local) es obligatorio.');
  const workspaceRoot = resolve(input.workspaceDir);
  const studio: StudioContext = createStudioContext(workspaceRoot);
  // Local truth first: the destination is the EXACT open asset, never invented.
  await getCreativeProject(studio, { id: input.studioProjectId });
  const inspection = await inspectCreativeAsset(studio, { projectId: input.studioProjectId, assetId: input.studioAssetId });

  const takes = await listLandedTakes(input.ingestDir, { tokenPrefix: input.tokenHashPrefix });
  const imported: IngestImportedTake[] = [];
  const addedInputs: string[] = [];
  for (const take of takes) {
    const manifest = take.manifest;
    const bytes = new Uint8Array(await readFile(take.bytesPath));
    const importedTake = await importMaterialBytes({
      workspaceRoot,
      assetDirAbs: inspection.assetDir,
      projectId: input.studioProjectId,
      assetId: input.studioAssetId,
      material: {
        id: manifest.takeId,
        mediaType: manifest.mediaType,
        bytes: manifest.bytes,
        sha256: manifest.sha256,
      },
      bytes,
      provenance: {
        schemaVersion: 1,
        source: 'tailnet-ingest',
        origin: manifest.ingestOrigin,
        materialId: manifest.takeId,
        studioProjectId: input.studioProjectId,
        studioAssetId: input.studioAssetId,
        tokenHash: take.tokenHash,
        tailnet: true,
        assetTitle: manifest.binding.assetTitle,
        projectTitle: manifest.binding.projectTitle,
        ...(manifest.linkId !== undefined ? { linkId: manifest.linkId } : {}),
        mediaType: manifest.mediaType,
        bytes: manifest.bytes,
        sha256: manifest.sha256,
      },
    });
    // Verified import done: drain the landing entry (bytes + manifest; the
    // hash-named dir too when it is empty). A failure above keeps the take.
    await rm(take.bytesPath, { force: true });
    await rm(take.manifestPath, { force: true });
    // Only the EMPTY hash-named dir is removed (other takes may remain).
    await rmdir(take.dir).catch(() => undefined);
    imported.push({
      takeId: manifest.takeId,
      tokenHash: take.tokenHash,
      sha256: manifest.sha256,
      bytes: manifest.bytes,
      ingestOrigin: manifest.ingestOrigin,
      inputPath: importedTake.inputPath,
      provenancePath: importedTake.provenancePath,
      addedInputs: importedTake.addedInputs,
      reusedBytes: importedTake.reusedBytes,
      removedFromLanding: true,
    });
    addedInputs.push(...importedTake.addedInputs);
  }
  return {
    executed: true,
    studioProjectId: input.studioProjectId,
    studioAssetId: input.studioAssetId,
    ingestDir: resolve(input.ingestDir),
    imported,
    addedInputs,
  };
}
