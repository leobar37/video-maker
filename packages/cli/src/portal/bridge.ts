/**
 * Portal↔Studio bridge (P-003, contracts.md §5/§7): the ONLY permitted link
 * between a local Studio workspace and the remote customer-assets portal.
 *
 * - `adoptPortalClient`: projects an existing Studio client into the portal
 *   (ids + allowlisted display name; never a parallel remote client.json).
 * - `pullMaterial`: downloads a remote material into a confined temp dir,
 *   verifies sha256/bytes/magic, registers it as an INPUT of an OPEN asset
 *   with a deterministic provenance sidecar and a validated, locked, atomic
 *   asset.json update. Retries of the same (origin, materialId) converge to
 *   the same bytes/path/relation with zero duplicates; a different input is
 *   never overwritten and failures never alter previous asset state.
 * - `pushDelivery`: reads a SEALED revision manifest, re-computes its rootHash
 *   with the existing pure module, verifies local output bytes and transmits
 *   ONLY the selected outputs with idempotent staging. Sources, recipe,
 *   manifests, snapshots and env files never leave the machine; nothing is
 *   rendered, recovered or snapshot implicitly.
 *
 * Errors are typed: `StudioServiceError` for local/usage failures (exit 2 for
 * input codes, 1 operational) and `ApiClientError` for remote failures — the
 * spec layer maps both to the stable envelope. Credentials never appear in
 * errors, plans or provenance.
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  CreativeAssetSchema,
  computeRevisionRootHash,
  isSafeRelativePath,
  sha256Hex,
  type CreativeAsset,
  type RevisionManifest,
} from '@videomaker/schemas';
import { V1_MEDIA_TYPES } from '@videomaker/customer-assets';
import {
  StudioServiceError,
  createStudioContext,
  getClient,
  getCreativeProject,
  getRevisionManifest,
  inspectCreativeAsset,
  type StudioContext,
} from '@videomaker/studio';
import { ApiClientError, CustomerAssetsClient } from '@videomaker/customer-assets/client';
import type { DeliveryView, MaterialView, OutputRef, PortalClientView, V1MediaType } from '@videomaker/customer-assets';

import { createPortalClient } from './auth';

/* ---------------------------------------------------------------------------
 * Small local fs/paths helpers (mirror the studio workspace invariants)
 * ------------------------------------------------------------------------- */

function fail(code: 'INVALID_INPUT' | 'NOT_FOUND' | 'PATH_UNSAFE' | 'CONFLICT' | 'HASH_MISMATCH' | 'OUTPUT_MISSING' | 'AUTH_REQUIRED', message: string, details?: Record<string, unknown>, cause?: unknown): never {
  throw new StudioServiceError(code, message, details, cause);
}

/** Resolves `rel` inside `base`, rejecting absolute/escaping declarations. */
function contained(base: string, rel: string, label: string): string {
  if (!isSafeRelativePath(rel)) {
    fail('PATH_UNSAFE', `Ruta insegura declarada para ${label}.`, { path: rel });
  }
  const abs = resolve(base, rel);
  const relCheck = relative(resolve(base), abs);
  if (relCheck === '' || relCheck.startsWith('..') || isAbsolute(relCheck)) {
    fail('PATH_UNSAFE', `Ruta de ${label} escapa del directorio base.`, { path: rel });
  }
  return abs;
}

type PathKind = 'missing' | 'file' | 'directory' | 'symlink' | 'special';

async function kindOf(absPath: string): Promise<PathKind> {
  try {
    const stats = await lstat(absPath);
    if (stats.isSymbolicLink()) return 'symlink';
    if (stats.isDirectory()) return 'directory';
    if (stats.isFile()) return 'file';
    return 'special';
  } catch {
    return 'missing';
  }
}

/**
 * Rejects symlinked (or non-directory) EXISTING PARENT components of a
 * declared relative path (the tail is the file itself and is checked by the
 * caller). Missing components are allowed: the bridge creates plain
 * directories itself.
 */
async function assertRealDirComponents(baseDir: string, relPath: string, label: string): Promise<void> {
  const parts = relPath.split('/').filter((segment) => segment.length > 0);
  let current = resolve(baseDir);
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = join(current, parts[index]!);
    const kind = await kindOf(current);
    if (kind === 'missing') return; // tail parents: the bridge creates them plainly
    if (kind === 'symlink') {
      fail('PATH_UNSAFE', `Componente simbólico en la ruta de ${label}; nunca se sigue.`, { path: relPath, component: parts[index] });
    }
    if (kind !== 'directory') {
      fail('PATH_UNSAFE', `Componente inesperado (no directorio) en la ruta de ${label}.`, { path: relPath, component: parts[index] });
    }
  }
}

/** Same lock file the studio snapshot service uses: one writer per asset. */
function assetLockPath(workspaceRoot: string, projectId: string, assetId: string): string {
  return join(workspaceRoot, '.vm', 'locks', `${projectId}--${assetId}.lock`);
}

const EXTENSION_BY_MEDIA_TYPE: Record<V1MediaType, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
};

/** Deterministic, path-safe slug from the material id (never a traversal). */
function slugOfMaterialId(materialId: string): string {
  const slug = materialId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : 'material';
}

/** True when `text` appears in `bytes` starting at `start` (ASCII compare). */
function hasAsciiAt(bytes: Uint8Array, start: number, text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[start + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

/** Verifies the declared v1 media type against the actual magic bytes. */
function assertMagicBytes(bytes: Uint8Array, mediaType: V1MediaType, label: string): void {
  const head = bytes.subarray(0, 12);
  const matches: Record<V1MediaType, boolean> = {
    'image/jpeg': head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
    'image/png': head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47,
    'image/webp': hasAsciiAt(head, 0, 'RIFF') && hasAsciiAt(head, 8, 'WEBP'),
    'video/mp4': bytes.length > 8 && hasAsciiAt(bytes, 4, 'ftyp'),
  };
  if (!matches[mediaType]) {
    fail('HASH_MISMATCH', `Los bytes de ${label} no coinciden con la firma del media type registrado.`, { mediaType });
  }
}

/**
 * Confined download area INSIDE the workspace (`.vm` is pruned from seals and
 * excluded from studio backups). All material bytes land here first and are
 * verified from disk before anything touches the asset.
 */
function tempRootOf(workspaceRoot: string): string {
  return join(workspaceRoot, '.vm', 'tmp', `portal-pull-${process.pid}-${randomUUID()}`);
}

/* ---------------------------------------------------------------------------
 * adopt
 * ------------------------------------------------------------------------- */

export interface AdoptPortalClientInput {
  origin: string;
  workspaceDir: string;
  workspaceId: string;
  studioClientId: string;
}

export interface AdoptPortalClientResult {
  workspaceId: string;
  studioClientId: string;
  name: string;
  portalClient: PortalClientView;
}

/**
 * Projects an EXISTING local Studio client into the portal workspace: ids and
 * allowlisted display name only. The stable idempotency key makes replays of
 * the same (workspaceId, studioClientId) return the same portal client.
 */
export async function adoptPortalClient(input: AdoptPortalClientInput): Promise<AdoptPortalClientResult> {
  if (input.workspaceId.trim().length === 0) fail('INVALID_INPUT', '--workspace-id es obligatorio.');
  if (input.studioClientId.trim().length === 0) fail('INVALID_INPUT', 'El clientId (studio) es obligatorio.');
  const studio = createStudioContext(input.workspaceDir);
  const local = await getClient(studio, { id: input.studioClientId });
  const client = createPortalClient(input.origin);
  const idempotencyKey = await sha256Hex(`adopt:${input.workspaceId}:${input.studioClientId}`);
  const portalClient = await client.adoptClient(
    { workspaceId: input.workspaceId, studioClientId: local.id, name: local.name },
    `portal-adopt-${idempotencyKey}`,
  );
  return { workspaceId: input.workspaceId, studioClientId: local.id, name: local.name, portalClient };
}

/* ---------------------------------------------------------------------------
 * pullMaterial
 * ------------------------------------------------------------------------- */

export interface PullMaterialInput {
  origin: string;
  workspaceDir: string;
  projectId: string;
  assetId: string;
  materialId: string;
  /**
   * R-3 (customer-assets-requests): when the pull happens through an upload
   * request, the provenance sidecar records the requestId too — procedencia
   * `(origin, materialId, requestId)` (contracts.md §6 additive). Undefined
   * for plain `portal-material-pull`, whose sidecar bytes stay identical.
   */
  requestId?: string;
  /**
   * Operator order 2026-10-06 (asset upload links): when the pull happens
   * through a per-asset link, the provenance sidecar records the producing
   * linkId too — `(origin, materialId, linkId)`. Undefined elsewhere.
   */
  linkId?: string;
}

export interface PullMaterialResult {
  material: { id: string; name?: string; mediaType: V1MediaType; bytes: number; sha256: string };
  portalClient: { id: string; studioClientId: string };
  /** Workspace-relative input path registered on the asset. */
  inputPath: string;
  /** Workspace-relative provenance sidecar path registered on the asset. */
  provenancePath: string;
  /** Entries actually added to `asset.json` `inputs` on THIS run ([] on pure retry). */
  addedInputs: string[];
  /** True when the input bytes were already present (verified, reused). */
  reusedBytes: boolean;
}

/**
 * Deterministic provenance sidecar (no credentials, no local paths, no
 * timestamps): identical (origin, materialId[, requestId]) → identical sidecar
 * bytes, so retries are byte-stable and the sidecar seals cleanly in later
 * revisions. The requestId appears ONLY for request-pulled materials.
 */
function provenanceDoc(
  origin: string,
  material: MaterialView,
  studioClientId: string,
  requestId?: string,
  linkId?: string,
): Record<string, string | number> {
  return {
    schemaVersion: 1,
    source: 'portal',
    origin,
    materialId: material.id,
    portalClientId: material.clientId,
    studioClientId,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(linkId !== undefined ? { linkId } : {}),
    mediaType: material.mediaType,
    bytes: material.bytes,
    sha256: material.sha256,
  };
}

/* ---------------------------------------------------------------------------
 * Shared verified import (portal pulls AND tailnet ingest pulls)
 * ------------------------------------------------------------------------- */

/** Material metadata the bytes must match EXACTLY (hash + length + magic). */
export interface MaterialBytesMeta {
  id: string;
  name?: string;
  mediaType: V1MediaType;
  bytes: number;
  sha256: string;
}

export interface ImportMaterialBytesInput {
  /** Absolute workspace root (studio invariants apply). */
  workspaceRoot: string;
  /** Absolute asset directory the import is confined to. */
  assetDirAbs: string;
  projectId: string;
  assetId: string;
  /** Registered/manifest material metadata the bytes are verified against. */
  material: MaterialBytesMeta;
  /** Exact bytes to land; verified BEFORE anything is written near the asset. */
  bytes: Uint8Array;
  /** Deterministic provenance document (no credentials, no local paths). */
  provenance: Record<string, string | number | boolean>;
}

export interface ImportMaterialBytesResult {
  /** Workspace-relative input path registered on the asset. */
  inputPath: string;
  /** Workspace-relative provenance sidecar path registered on the asset. */
  provenancePath: string;
  /** Entries actually added to `asset.json` `inputs` on THIS run ([] on retry). */
  addedInputs: string[];
  /** True when the input bytes were already present (verified, reused). */
  reusedBytes: boolean;
}

/**
 * The ONE verified import path: re-verifies the bytes against the material
 * metadata (sha256 + length + magic), exclusive-creates the content-derived
 * input (an existing DIFFERENT file is a hard conflict, an identical one is a
 * retry), writes the caller-built deterministic provenance sidecar and
 * performs the locked, schema-validated, atomic `asset.json` update.
 * `pullMaterial` (portal downloads) and the tailnet ingest pull (local
 * landing dir) both funnel through here, so idempotency by
 * (origin, materialId) and the never-overwrite rule live in exactly one place.
 */
export async function importMaterialBytes(input: ImportMaterialBytesInput): Promise<ImportMaterialBytesResult> {
  const bytesSha = await sha256Hex(input.bytes);
  if (bytesSha !== input.material.sha256) {
    fail('HASH_MISMATCH', 'Los bytes no coinciden con el sha256 registrado del material.', { materialId: input.material.id });
  }
  if (input.bytes.length !== input.material.bytes) {
    fail('HASH_MISMATCH', 'Los bytes no coinciden con el tamaño registrado del material.', {
      materialId: input.material.id,
      bytes: input.bytes.length,
      esperados: input.material.bytes,
    });
  }
  assertMagicBytes(input.bytes, input.material.mediaType, 'el material');

  const base = `${slugOfMaterialId(input.material.id)}-${input.material.sha256.slice(0, 8)}`;
  const extension = EXTENSION_BY_MEDIA_TYPE[input.material.mediaType];
  const inputRel = `inputs/portal/${base}${extension}`;
  const provenanceRel = `inputs/portal/${base}.provenance.json`;
  for (const rel of [inputRel, provenanceRel]) {
    contained(input.assetDirAbs, rel, 'input del material');
  }
  await assertRealDirComponents(input.assetDirAbs, inputRel, 'input del material');

  const inputAbs = resolve(input.assetDirAbs, inputRel);
  const provenanceAbs = resolve(input.assetDirAbs, provenanceRel);

  // Exclusive-create the input: an existing DIFFERENT file is a hard
  // conflict (never overwrite), an identical one is a retry (reuse).
  let reusedBytes = false;
  const existingKind = await kindOf(inputAbs);
  if (existingKind === 'symlink' || existingKind === 'special' || existingKind === 'directory') {
    fail('PATH_UNSAFE', 'La ruta destino del input existe y no es un archivo regular; nunca se sobrescribe.', { path: inputRel, kind: existingKind });
  }
  if (existingKind === 'file') {
    const existingBytes = new Uint8Array(await readFile(inputAbs));
    if ((await sha256Hex(existingBytes)) !== input.material.sha256 || existingBytes.length !== input.material.bytes) {
      fail('CONFLICT', 'Ya existe un input distinto en la ruta destino; renombralo antes de importar (nunca se sobrescribe).', { path: inputRel });
    }
    reusedBytes = true;
  } else {
    await mkdir(dirname(inputAbs), { recursive: true });
    const handle = await open(inputAbs, 'wx').catch(
      (cause: unknown) => fail('CONFLICT', 'La ruta destino del input se ocupó concurrentemente.', { path: inputRel }, cause) as never,
    );
    try {
      await handle.writeFile(input.bytes);
    } finally {
      await handle.close();
    }
  }

  // Provenance sidecar inside inputs (sealed by future revisions).
  const provenanceSerialized = `${JSON.stringify(input.provenance, null, 2)}\n`;
  const provenanceKind = await kindOf(provenanceAbs);
  if (provenanceKind === 'symlink' || provenanceKind === 'special' || provenanceKind === 'directory') {
    fail('PATH_UNSAFE', 'La ruta del sidecar de provenance existe y no es un archivo regular.', { path: provenanceRel, kind: provenanceKind });
  }
  if (provenanceKind === 'file') {
    let existingDoc: unknown;
    try {
      existingDoc = JSON.parse(await readFile(provenanceAbs, 'utf8'));
    } catch {
      existingDoc = undefined;
    }
    const record = existingDoc as Record<string, unknown> | undefined;
    const same =
      record !== undefined &&
      record.origin === input.provenance.origin &&
      record.materialId === input.provenance.materialId &&
      record.sha256 === input.material.sha256;
    if (!same) {
      fail('CONFLICT', 'El sidecar de provenance existente corresponde a otra procedencia; nunca se sobrescribe.', { path: provenanceRel });
    }
  } else {
    await mkdir(dirname(provenanceAbs), { recursive: true });
    const handle = await open(provenanceAbs, 'wx').catch(
      (cause: unknown) => fail('CONFLICT', 'La ruta del sidecar de provenance se ocupó concurrentemente.', { path: provenanceRel }, cause) as never,
    );
    try {
      await handle.writeFile(provenanceSerialized, 'utf8');
    } finally {
      await handle.close();
    }
  }

  // Locked, validated, atomic asset.json update (same lock as snapshot).
  const addedInputs = await registerInputsLocked(input.workspaceRoot, input.assetDirAbs, input.projectId, input.assetId, [inputRel, provenanceRel]);
  return { inputPath: inputRel, provenancePath: provenanceRel, addedInputs, reusedBytes };
}

/**
 * Pulls a portal material into the OPEN asset's inputs (contracts.md §5):
 * explicit project/asset, download to confined temp, hash/bytes/magic
 * verification, exclusive-create input + provenance sidecar, then a locked,
 * schema-validated, atomic asset.json update. The project must relate to the
 * Studio client of the portal client that owns the material.
 */
export async function pullMaterial(input: PullMaterialInput): Promise<PullMaterialResult> {
  const workspaceRoot = resolve(input.workspaceDir);
  const studio: StudioContext = createStudioContext(workspaceRoot);
  // Local truth first (typed NOT_FOUND/INVALID_INPUT before any network).
  const project = await getCreativeProject(studio, { id: input.projectId });
  const inspection = await inspectCreativeAsset(studio, { projectId: input.projectId, assetId: input.assetId });
  const assetDirAbs = inspection.assetDir;

  const client = createPortalClient(input.origin);
  const material = await client.getMaterial(input.materialId);
  const response = await client.getMaterialContent(input.materialId);
  const download = new Uint8Array(await response.arrayBuffer());

  // Verify BEFORE anything is written near the asset.
  const downloadSha = await sha256Hex(download);
  if (downloadSha !== material.sha256) {
    fail('HASH_MISMATCH', 'Los bytes descargados no coinciden con el sha256 registrado del material.', { materialId: material.id });
  }
  if (download.length !== material.bytes) {
    fail('HASH_MISMATCH', 'Los bytes descargados no coinciden con el tamaño registrado del material.', { materialId: material.id, bytes: download.length, esperados: material.bytes });
  }
  assertMagicBytes(download, material.mediaType, 'el material');

  // contracts.md §5: the existing project must relate to the material's
  // registered client (via its Studio client id).
  const page = await client.listClients();
  const portalClient = page.items.find((entry) => entry.id === material.clientId);
  if (portalClient === undefined) {
    fail('NOT_FOUND', 'El material pertenece a un cliente portal no visible para este principal.', { materialId: material.id });
  }
  if (!project.clientIds.includes(portalClient.studioClientId)) {
    fail('INVALID_INPUT', 'El proyecto studio no se relaciona con el cliente del material; añadí el studioClientId a project.json clientIds (nunca se crea un proyecto implícito).', {
      projectId: project.id,
      studioClientId: portalClient.studioClientId,
    });
  }

  // Destination derivation + confinement checks now live in the shared
  // importMaterialBytes path (content-derived names inside the asset inputs).

  const tempDir = tempRootOf(workspaceRoot);
  let staged: Uint8Array;
  try {
    await mkdir(tempDir, { recursive: true });
    const stagedPath = join(tempDir, 'material.bin');
    await writeFile(stagedPath, download);
    // Verify what ACTUALLY landed on disk (not just the in-memory buffer).
    staged = new Uint8Array(await readFile(stagedPath));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  // Single verified import path (shared with the tailnet ingest pull): the
  // bytes are re-verified against the registered material, the input +
  // provenance sidecar are exclusive-created and the asset.json update is
  // locked, validated and atomic. Idempotent by (origin, materialId).
  const imported = await importMaterialBytes({
    workspaceRoot,
    assetDirAbs,
    projectId: input.projectId,
    assetId: input.assetId,
    material: {
      id: material.id,
      ...(material.name !== undefined ? { name: material.name } : {}),
      mediaType: material.mediaType,
      bytes: material.bytes,
      sha256: material.sha256,
    },
    bytes: staged,
    provenance: provenanceDoc(input.origin, material, portalClient.studioClientId, input.requestId, input.linkId),
  });
  return {
    material: {
      id: material.id,
      ...(material.name !== undefined ? { name: material.name } : {}),
      mediaType: material.mediaType,
      bytes: material.bytes,
      sha256: material.sha256,
    },
    portalClient: { id: portalClient.id, studioClientId: portalClient.studioClientId },
    inputPath: imported.inputPath,
    provenancePath: imported.provenancePath,
    addedInputs: imported.addedInputs,
    reusedBytes: imported.reusedBytes,
  };
}

/**
 * Adds `entries` to `asset.json` `inputs` under the studio asset lock:
 * schema-validated read → mutation → re-validation → temp write → atomic
 * rename. Returns only the entries that were actually added (empty on retry).
 */
async function registerInputsLocked(
  workspaceRoot: string,
  assetDirAbs: string,
  projectId: string,
  assetId: string,
  entries: readonly string[],
): Promise<string[]> {
  const lockPath = assetLockPath(workspaceRoot, projectId, assetId);
  await mkdir(dirname(lockPath), { recursive: true });
  const lock = await open(lockPath, 'wx').catch((cause: unknown) => {
    throw new StudioServiceError('CONFLICT', 'Otra operación mantiene el lock de este asset; reintentá cuando termine.', { projectId, assetId }, cause);
  });
  try {
    const assetFileAbs = join(assetDirAbs, 'asset.json');
    const raw = JSON.parse(await readFile(assetFileAbs, 'utf8')) as unknown;
    const parsed = CreativeAssetSchema.safeParse(raw);
    if (!parsed.success) {
      fail('INVALID_INPUT', 'asset.json viola el contrato de datos; no se modifica.', { assetId });
    }
    const doc: CreativeAsset = parsed.data;
    const added: string[] = [];
    for (const entry of entries) {
      if (!doc.inputs.includes(entry)) {
        doc.inputs.push(entry);
        added.push(entry);
      }
    }
    if (added.length > 0) {
      const validated = CreativeAssetSchema.parse(doc);
      const tempAsset = `${assetFileAbs}.tmp-${randomUUID()}`;
      await writeFile(tempAsset, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
      await rename(tempAsset, assetFileAbs);
    }
    return added;
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

/* ---------------------------------------------------------------------------
 * pushDelivery
 * ------------------------------------------------------------------------- */

export interface PushDeliveryInput {
  origin: string;
  workspaceDir: string;
  portalClientId: string;
  projectId: string;
  assetId: string;
  revisionId: string;
  /** Selected output names (comma string already split by the spec layer). */
  outputNames: readonly string[];
}

export interface SelectedOutput extends OutputRef {
  path: string;
}

export interface PushDeliveryResult {
  delivery: DeliveryView;
  outputs: OutputRef[];
  rootHash: string;
  revisionId: string;
}

interface VerifiedOutput extends SelectedOutput {
  bytesLocal: Uint8Array;
}

/**
 * Reads the sealed manifest, verifies the rootHash with the existing pure
 * module, verifies local bytes of the SELECTED outputs only, then stages and
 * uploads exactly those outputs with stable idempotency keys. No source,
 * recipe, manifest or snapshot bytes are ever read for transmission.
 */
export async function pushDelivery(input: PushDeliveryInput): Promise<PushDeliveryResult> {
  const workspaceRoot = resolve(input.workspaceDir);
  const studio = createStudioContext(workspaceRoot);
  const manifest: RevisionManifest = await getRevisionManifest(studio, {
    projectId: input.projectId,
    assetId: input.assetId,
    revisionId: input.revisionId,
  });

  // Seal integrity: pure re-computation must reproduce the stored rootHash.
  const computedRootHash = await computeRevisionRootHash(manifest);
  if (computedRootHash !== manifest.rootHash) {
    fail('HASH_MISMATCH', 'El rootHash del manifest sellado no coincide con el recálculo puro; la revisión está corrupta o alterada.', {
      revisionId: manifest.revisionId,
    });
  }

  const names: string[] = [];
  for (const raw of input.outputNames) {
    const name = raw.trim();
    if (name.length === 0) fail('INVALID_INPUT', '--outputs requiere nombres de output no vacíos.');
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) {
    fail('INVALID_INPUT', '--outputs requiere al menos un nombre de output del manifest.');
  }

  const outputRefByName = new Map(manifest.outputs.map((ref) => [ref.name, ref]));
  const fileByPath = new Map(manifest.files.map((file) => [file.path, file]));
  const selected: SelectedOutput[] = names.map((name) => {
    const ref = outputRefByName.get(name);
    if (ref === undefined) {
      fail('INVALID_INPUT', `El output "${name}" no está declarado en el manifest ${manifest.revisionId}.`, {
        revisionId: manifest.revisionId,
        disponibles: manifest.outputs.map((entry) => entry.name),
      });
    }
    const file = fileByPath.get(ref!.path);
    if (file === undefined || file.role !== 'output') {
      fail('INVALID_INPUT', `El output "${name}" no referencia un archivo sellado con rol output.`, { revisionId: manifest.revisionId });
    }
    if (!V1_MEDIA_TYPES.includes(file.mediaType as V1MediaType)) {
      fail('INVALID_INPUT', `El media type del output "${name}" no es admitido por el portal v1.`, { mediaType: file.mediaType });
    }
    return {
      name,
      path: ref!.path,
      mediaType: file.mediaType as V1MediaType,
      bytes: file.bytes,
      sha256: file.sha256,
    };
  });

  // Verify LOCAL bytes of the selected outputs (restore explicitly if absent;
  // the bridge never re-renders, re-renders nothing, recovers nothing).
  const assetDirAbs = join(workspaceRoot, 'projects', input.projectId, 'assets', input.assetId);
  const verified: VerifiedOutput[] = [];
  for (const output of selected) {
    const abs = contained(assetDirAbs, output.path, `output ${output.name}`);
    const kind = await kindOf(abs);
    if (kind === 'missing') {
      fail('OUTPUT_MISSING', 'Falta el archivo local de un output sellado; restaurá la revisión explícitamente (asset restore), nunca de forma implícita.', { path: output.path });
    }
    await assertRealDirComponents(assetDirAbs, output.path, `output ${output.name}`);
    if (kind !== 'file') {
      fail('PATH_UNSAFE', 'Un output sellado debe ser un archivo regular local.', { path: output.path, kind });
    }
    const bytes = new Uint8Array(await readFile(abs));
    if (bytes.length !== output.bytes || (await sha256Hex(bytes)) !== output.sha256) {
      fail('HASH_MISMATCH', 'Los bytes locales del output difieren del manifest sellado; restaurá la revisión explícitamente antes de entregar.', { name: output.name });
    }
    verified.push({ ...output, bytesLocal: bytes });
  }

  const client = createPortalClient(input.origin);
  const idempotencyKey = await sha256Hex(
    `push:${input.portalClientId}:${input.projectId}:${input.assetId}:${input.revisionId}:${manifest.rootHash}:${names.join(',')}`,
  );
  const delivery = await client.createDelivery(
    input.portalClientId,
    {
      projectId: input.projectId,
      assetId: input.assetId,
      revisionId: input.revisionId,
      rootHash: manifest.rootHash,
      title: manifest.assetSnapshot.title,
      kind: manifest.assetSnapshot.kind,
      outputs: verified.map(({ name, mediaType, bytes, sha256 }) => ({ name, mediaType, bytes, sha256 })),
    },
    `portal-push-${idempotencyKey}`,
  );

  for (const output of verified) {
    const session = await client.initUpload(
      input.portalClientId,
      {
        kind: 'delivery_output',
        mediaType: output.mediaType,
        declaredBytes: output.bytes,
        sha256: output.sha256,
        deliveryId: delivery.id,
        outputName: output.name,
      },
      `portal-push-${idempotencyKey}:${output.name}`,
    );
    if (session.status === 'pending') {
      // Copy into a fresh ArrayBuffer so the payload satisfies BodyInit.
      await putOnce(client, session.uploadId, output, new Uint8Array(output.bytesLocal));
    }
    // contracts.md §4 (init → PUT → complete → ready): the PUT only stages
    // bytes; the per-output complete is what verifies and finalizes the
    // delivery output server-side. 'staged' (or a replayed session) means the
    // bytes were already received — re-PUT would 409 by design and complete
    // converges idempotently (P-005: found against the real emulated app;
    // the previous flow only worked against an over-permissive fake).
    await client.completeUpload(session.uploadId);
  }

  const completed = await client.completeDelivery(delivery.id);
  return {
    delivery: completed,
    outputs: verified.map(({ name, mediaType, bytes, sha256 }) => ({ name, mediaType, bytes, sha256 })),
    rootHash: manifest.rootHash,
    revisionId: input.revisionId,
  };
}

/**
 * PUT with replay tolerance: a previous attempt may have staged (409 "already
 * received") or even finalized (409 "session is ready") the bytes after the
 * idempotency ledger recorded a pending session — both are the already-
 * received outcome, not failures; the caller's completeUpload converges.
 */
async function putOnce(client: CustomerAssetsClient, uploadId: string, output: VerifiedOutput, body: Uint8Array<ArrayBuffer>): Promise<void> {
  try {
    await client.putUploadContent(uploadId, body, { contentType: output.mediaType });
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 409 && /already received|already staged|is ready/i.test(error.message)) {
      return;
    }
    throw error;
  }
}

/** Material views are already display-safe; re-exported for the spec layer. */
export type { MaterialView, DeliveryView };
