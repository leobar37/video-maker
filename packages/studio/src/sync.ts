/**
 * Backup protocol over the injected `StudioStorage` port (contracts.md §7):
 * full-file sync (HTML/SVG/JSON/fonts/lockfiles/outputs/presets — everything
 * the sealed manifest declares), an immutable manifest commit, shallow/deep
 * verification and remote-only recovery.
 *
 * Protocol invariants:
 * - The commit point is `putImmutable` (create-only). There is NO
 *   HEAD-then-mutable-PUT race and NO ETag↔sha256 aliasing: identity is
 *   always the SHA-256 of the bytes.
 * - Same key with different bytes ⇒ CONFLICT. Same key with identical bytes
 *   ⇒ idempotent (a retry after a lost response reuses the committed object).
 * - The receipt is written OUTSIDE the manifest and only becomes
 *   `confirmed` after the manifest AND every object of the revision are
 *   confirmed. Failures degrade to `failed` with a redacted error, never a
 *   partial confirmed state.
 * - Sync NEVER regenerates outputs: bytes are read from the sealed local
 *   revision copies and re-verified against the manifest hashes.
 * - Recovery never reads the local registry/cache/receipts: everything is
 *   rebuilt from remote manifests (validated) plus content-addressed
 *   objects. The fetched manifest BYTES are written unchanged so the local
 *   receipt binding (manifestSha256) stays exact.
 */
import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  canonicalStudioJson,
  computeRevisionRootHash,
  isSafeRelativeFilePath,
  ProjectCheckpointSchema,
  RevisionManifestSchema,
  sha256Hex,
  SyncReceiptSchema,
  type CreativeProject,
  type ProjectCheckpoint,
  type RevisionManifest,
  type SnapshotFile,
  type StudioClient,
  type StudioError,
  type StudioJsonValue,
  type SyncReceipt,
} from '@videomaker/schemas';

import type { RevisionRef, StudioContext, StudioStorage } from './contracts';
import { fail, isStudioServiceError, StudioServiceError } from './errors';
import { assertStudioId, parseOrInvalid } from './jsonio';
import {
  assetsRoot,
  checkpointFileOf,
  checkpointsRoot,
  describePathKind,
  isInsideDir,
  listDirNames,
  manifestFileOf,
  pathExists,
  receiptFileOf,
  revisionDir,
  revisionsRoot,
  workspaceRoot,
} from './paths';
import { storageCheckpointKey, storageManifestKey, storageObjectKeyForSha } from './receipts';

const MANIFEST_MEDIA_TYPE = 'application/json';
/** Defensive bound: a listing that never ends is a storage failure. */
const MAX_LIST_PAGES = 10_000;

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function refKey(ref: RevisionRef): string {
  return `${ref.projectId}/${ref.assetId}/${ref.revisionId}`;
}

function toStudioError(error: unknown): StudioServiceError {
  if (isStudioServiceError(error)) return error;
  return new StudioServiceError('STORAGE_UNAVAILABLE', 'Fallo de almacenamiento no tipado (detalle redactado).', undefined, error);
}

function studioErrorOf(error: unknown): StudioError {
  const typed = toStudioError(error);
  return { code: typed.code, message: typed.message };
}

/** Wraps a storage call so raw transport errors never leak (redacted). */
async function storageCall<T>(action: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isStudioServiceError(error)) throw error;
    throw new StudioServiceError('STORAGE_UNAVAILABLE', `El almacenamiento remoto falló durante ${action}.`, { action }, error);
  }
}

function parseJsonBytes(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause) {
    fail('INVALID_INPUT', `${label} no es JSON válido.`, undefined, cause);
  }
}

/** Lists a prefix to the end, following cursors (contracts.md §5). */
export async function listAllKeys(storage: StudioStorage, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await storageCall(`list ${prefix}`, () => storage.list(prefix, cursor));
    pages += 1;
    if (pages > MAX_LIST_PAGES) {
      fail('STORAGE_UNAVAILABLE', 'La paginación del listado remoto no termina.', { prefix });
    }
    keys.push(...page.keys);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return [...new Set(keys)].sort();
}

/** `studio/v1/projects/<p>/assets/<a>/revisions/<r>/manifest.json` → ref. */
export function parseRevisionFromManifestKey(key: string): RevisionRef | null {
  const segments = key.split('/');
  if (segments.length !== 9) return null;
  if (segments[0] !== 'studio' || segments[1] !== 'v1' || segments[2] !== 'projects' || segments[4] !== 'assets' || segments[6] !== 'revisions' || segments[8] !== 'manifest.json') {
    return null;
  }
  return { projectId: segments[3]!, assetId: segments[5]!, revisionId: segments[7]! };
}

/** Unique, sorted content-addressed object keys of a manifest. */
export function objectKeysOf(manifest: RevisionManifest): string[] {
  return [...new Set(manifest.files.map((file) => storageObjectKeyForSha(file.sha256)))].sort();
}

/** sha → declared byte length; inconsistent declarations are rejected. */
function bytesByShaOf(manifest: RevisionManifest): Map<string, number> {
  const map = new Map<string, number>();
  for (const file of manifest.files) {
    const known = map.get(file.sha256);
    if (known !== undefined && known !== file.bytes) {
      fail('INVALID_INPUT', 'El manifest declara tamaños distintos para el mismo hash de objeto.', { sha256: file.sha256 });
    }
    map.set(file.sha256, file.bytes);
  }
  return map;
}

/** Representative file of one content hash (media type for the upload). */
function fileForSha(manifest: RevisionManifest, sha256: string): SnapshotFile {
  const file = [...manifest.files].sort((a, b) => (a.path < b.path ? -1 : 1)).find((candidate) => candidate.sha256 === sha256);
  if (file === undefined) {
    fail('INVALID_INPUT', 'El manifest no declara el objeto buscado.', { sha256 });
  }
  return file;
}

/** Parses raw manifest bytes: JSON → schema (rootHash checked separately). */
function parseManifestBytes(bytes: Uint8Array, label: string): RevisionManifest {
  return parseOrInvalid(RevisionManifestSchema, parseJsonBytes(bytes, label), label);
}

async function assertManifestSeal(manifest: RevisionManifest, label: string): Promise<void> {
  const recomputed = await computeRevisionRootHash(manifest);
  if (recomputed !== manifest.rootHash) {
    fail('HASH_MISMATCH', `${label}: el manifest no coincide con su rootHash (posible alteración).`, {
      revisionId: manifest.revisionId,
      declaredRootHash: manifest.rootHash,
    });
  }
}

/** Local sealed revision: raw bytes + validated manifest (seal re-checked). */
async function readLocalRevision(root: string, ref: RevisionRef): Promise<{ bytes: Uint8Array; manifest: RevisionManifest }> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(manifestFileOf(root, ref.projectId, ref.assetId, ref.revisionId)));
  } catch (cause) {
    fail('NOT_FOUND', 'Manifest local ausente; nada que sincronizar.', { revisionId: ref.revisionId }, cause);
  }
  const manifest = parseManifestBytes(bytes, `manifest ${ref.revisionId}`);
  if (manifest.projectId !== ref.projectId || manifest.assetId !== ref.assetId || manifest.revisionId !== ref.revisionId) {
    fail('INVALID_INPUT', 'El manifest local no corresponde a la revisión referida.', { revisionId: ref.revisionId });
  }
  await assertManifestSeal(manifest, `manifest ${ref.revisionId}`);
  return { bytes, manifest };
}

/** Reads one sealed file and re-verifies it against the manifest entry. */
async function readSealedFile(root: string, ref: RevisionRef, file: SnapshotFile): Promise<Uint8Array> {
  const abs = path.join(revisionDir(root, ref.projectId, ref.assetId, ref.revisionId), 'files', file.path);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(abs));
  } catch (cause) {
    fail('NOT_FOUND', 'Archivo sellado ausente en la revisión local.', { revisionId: ref.revisionId, path: file.path }, cause);
  }
  const sha256 = await sha256Hex(bytes);
  if (sha256 !== file.sha256 || bytes.byteLength !== file.bytes) {
    fail('HASH_MISMATCH', 'El archivo sellado local no coincide con su hash declarado.', { revisionId: ref.revisionId, path: file.path });
  }
  return bytes;
}

/** Exclusive raw-byte write (never overwrites; parent dirs created). */
async function writeExclusiveBytes(absPath: string, bytes: Uint8Array, label: string): Promise<void> {
  await mkdir(path.dirname(absPath), { recursive: true });
  let handle;
  try {
    handle = await open(absPath, 'wx');
  } catch (cause) {
    fail('CONFLICT', `${label} ya existe; la recuperación nunca sobrescribe.`, { file: path.basename(absPath) }, cause);
  }
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

/** Writes one active file unless an identical copy already exists there. */
async function writeActiveBytes(absPath: string, bytes: Uint8Array, label: string): Promise<void> {
  try {
    await writeExclusiveBytes(absPath, bytes, label);
    return;
  } catch (error) {
    if (!isStudioServiceError(error) || error.code !== 'CONFLICT') throw error;
  }
  const existing = new Uint8Array(await readFile(absPath));
  if (!bytesEqual(existing, bytes)) {
    fail('CONFLICT', `${label} ya existe con otros bytes; la recuperación nunca pisa metadata divergente.`, { file: path.basename(absPath) });
  }
}

async function writeReceipt(root: string, ref: RevisionRef, receipt: SyncReceipt): Promise<void> {
  const file = receiptFileOf(root, ref.projectId, ref.assetId, ref.revisionId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Object upload/confirm primitives
// ---------------------------------------------------------------------------

/**
 * Create-only upload with lost-response tolerance: if `putImmutable` throws,
 * the object may already be committed. The stored bytes are fetched and
 * compared — identical ⇒ idempotent success, different ⇒ CONFLICT.
 */
async function putImmutableResolvingConflict(
  storage: StudioStorage,
  key: string,
  bytes: Uint8Array,
  mediaType: string,
): Promise<void> {
  try {
    await storage.putImmutable(key, bytes, mediaType);
    return;
  } catch {
    // Deliberately fall through: the failure is resolved by comparison.
  }
  let existing: Uint8Array;
  try {
    existing = await storage.get(key);
  } catch {
    fail('STORAGE_UNAVAILABLE', 'No se pudo subir el objeto ni leer el remoto tras el fallo.', { key });
  }
  if (!bytesEqual(existing, bytes)) {
    fail('CONFLICT', 'La key remota ya contiene otros bytes; el protocolo nunca sobrescribe.', { key });
  }
}

/**
 * Confirms one object: size always; sha256 from metadata when the storage
 * exposes it, otherwise by downloading and hashing the bytes (identity is
 * never an ETag).
 */
async function confirmObject(storage: StudioStorage, key: string, expected: { sha256: string; bytes: number }): Promise<void> {
  const head = await storageCall(`head ${key}`, () => storage.head(key));
  if (head === null) {
    fail('STORAGE_UNAVAILABLE', 'El objeto remoto desapareció tras confirmarse.', { key });
  }
  if (head.bytes !== expected.bytes) {
    fail('CONFLICT', 'El objeto remoto existe con otro tamaño para la misma key.', {
      key,
      expectedBytes: expected.bytes,
      actualBytes: head.bytes,
    });
  }
  if (head.sha256 !== '') {
    if (head.sha256 !== expected.sha256) {
      fail('CONFLICT', 'La key remota ya contiene otros bytes (hash distinto).', { key });
    }
    return;
  }
  const stored = await storageCall(`get ${key}`, () => storage.get(key));
  if ((await sha256Hex(stored)) !== expected.sha256) {
    fail('CONFLICT', 'Los bytes del objeto remoto no corresponden al hash declarado.', { key });
  }
}
/**
 * Ensures one content-addressed object exists with the exact bytes. Existing
 * objects are REUSED (a retry never re-uploads); missing ones are uploaded
 * from the sealed local copy and confirmed.
 */
async function ensureObject(
  storage: StudioStorage,
  root: string,
  ref: RevisionRef,
  manifest: RevisionManifest,
  sha256: string,
): Promise<void> {
  const key = storageObjectKeyForSha(sha256);
  const expectedBytes = bytesByShaOf(manifest).get(sha256)!;
  const head = await storageCall(`head ${key}`, () => storage.head(key));
  if (head === null) {
    const file = fileForSha(manifest, sha256);
    const bytes = await readSealedFile(root, ref, file);
    await putImmutableResolvingConflict(storage, key, bytes, file.mediaType);
  }
  await confirmObject(storage, key, { sha256, bytes: expectedBytes });
}

/**
 * Commits an immutable JSON document (manifest or checkpoint): existing key
 * with identical bytes ⇒ idempotent; different bytes ⇒ CONFLICT; otherwise a
 * create-only upload verified by reading the stored bytes back.
 */
async function commitImmutableDocument(storage: StudioStorage, key: string, bytes: Uint8Array, label: string): Promise<void> {
  const head = await storageCall(`head ${key}`, () => storage.head(key));
  if (head !== null) {
    const existing = await storageCall(`get ${key}`, () => storage.get(key));
    if (!bytesEqual(existing, bytes)) {
      fail('CONFLICT', `El documento remoto ya tiene otros bytes para ${label}; jamás se sobrescribe.`, { key });
    }
    return; // Already committed (e.g. a retry after a lost response).
  }
  await putImmutableResolvingConflict(storage, key, bytes, MANIFEST_MEDIA_TYPE);
  const stored = await storageCall(`get ${key}`, () => storage.get(key));
  if (!bytesEqual(stored, bytes)) {
    fail('HASH_MISMATCH', `El documento remoto no devuelve los bytes confirmados para ${label}.`, { key });
  }
}

// ---------------------------------------------------------------------------
// syncProject
// ---------------------------------------------------------------------------

async function syncRevision(root: string, ref: RevisionRef, storage: StudioStorage): Promise<SyncReceipt> {
  const { bytes: manifestBytes, manifest } = await readLocalRevision(root, ref);
  const manifestKey = storageManifestKey(ref.projectId, ref.assetId, ref.revisionId);
  const base = {
    schemaVersion: 1 as const,
    projectId: ref.projectId,
    assetId: ref.assetId,
    revisionId: ref.revisionId,
    rootHash: manifest.rootHash,
    manifestKey,
    manifestSha256: await sha256Hex(manifestBytes),
  };
  await writeReceipt(root, ref, parseOrInvalid(SyncReceiptSchema, { ...base, status: 'syncing', confirmedObjects: [] }, `receipt ${ref.revisionId}`));

  try {
    const confirmedObjects: string[] = [];
    for (const key of objectKeysOf(manifest)) {
      await ensureObject(storage, root, ref, manifest, key.split('/')[2]!);
      confirmedObjects.push(key);
    }
    await commitImmutableDocument(storage, manifestKey, manifestBytes, `manifest ${ref.revisionId}`);
    confirmedObjects.push(manifestKey);
    const receipt = parseOrInvalid(
      SyncReceiptSchema,
      { ...base, status: 'confirmed', confirmedObjects: [...new Set(confirmedObjects)].sort() },
      `receipt ${ref.revisionId}`,
    );
    await writeReceipt(root, ref, receipt);
    return receipt;
  } catch (error) {
    const receipt = parseOrInvalid(
      SyncReceiptSchema,
      { ...base, status: 'failed', confirmedObjects: [], error: studioErrorOf(error) },
      `receipt ${ref.revisionId}`,
    );
    await writeReceipt(root, ref, receipt);
    return receipt;
  }
}

async function syncCheckpoints(root: string, projectId: string, storage: StudioStorage): Promise<void> {
  let checkpointNames: string[] = [];
  try {
    checkpointNames = (await readdir(checkpointsRoot(root, projectId))).filter((name) => name.endsWith('.json')).sort();
  } catch {
    checkpointNames = []; // no checkpoints yet: nothing to sync.
  }
  for (const name of checkpointNames) {
    const checkpointId = name.slice(0, -'.json'.length);
    const file = checkpointFileOf(root, projectId, checkpointId);
    const bytes = new Uint8Array(await readFile(file));
    const checkpoint = parseOrInvalid(ProjectCheckpointSchema, parseJsonBytes(bytes, `checkpoint ${name}`), `checkpoint ${name}`);
    if (checkpoint.projectId !== projectId) {
      fail('INVALID_INPUT', 'El checkpoint local no pertenece al proyecto sincronizado.', { checkpointId: checkpoint.checkpointId });
    }
    if (checkpoint.checkpointId !== checkpointId) {
      fail('INVALID_INPUT', 'El id del documento checkpoint no coincide con el archivo local; no se publica.', {
        fileCheckpointId: checkpointId,
        documentCheckpointId: checkpoint.checkpointId,
      });
    }
    // A checkpoint may only be published when EVERY referenced revision is
    // committed remotely with matching ids/rootHash. A revision whose upload
    // failed (or whose manifest conflicts) leaves the checkpoint unpublished:
    // typed failure, never a silent success pointing at a missing ref.
    for (const entry of checkpoint.entries) {
      const key = storageManifestKey(projectId, entry.assetId, entry.revisionId);
      let manifest: RevisionManifest;
      try {
        manifest = parseManifestBytes(await storageCall(`get ${key}`, () => storage.get(key)), `manifest remoto ${entry.revisionId}`);
      } catch (cause) {
        fail('NOT_FOUND', 'El checkpoint referencia una revisión sin manifest remoto committeado; no se publica.', {
          checkpointId: checkpoint.checkpointId,
          assetId: entry.assetId,
          revisionId: entry.revisionId,
        }, cause);
      }
      await assertManifestSeal(manifest, `manifest remoto ${entry.revisionId}`);
      if (manifest.projectId !== projectId || manifest.assetId !== entry.assetId || manifest.revisionId !== entry.revisionId) {
        fail('HASH_MISMATCH', 'El manifest remoto no corresponde a la entrada del checkpoint; no se publica.', {
          checkpointId: checkpoint.checkpointId,
          assetId: entry.assetId,
          revisionId: entry.revisionId,
        });
      }
      if (manifest.rootHash !== entry.rootHash) {
        fail('HASH_MISMATCH', 'El rootHash del checkpoint no coincide con el manifest remoto; no se publica.', {
          checkpointId: checkpoint.checkpointId,
          assetId: entry.assetId,
          revisionId: entry.revisionId,
        });
      }
    }
    await commitImmutableDocument(storage, storageCheckpointKey(projectId, checkpoint.checkpointId), bytes, `checkpoint ${checkpoint.checkpointId}`);
  }
}

/**
 * Uploads every sealed revision of a project (all declared files, private by
 * default) plus its checkpoints. Per-revision failures degrade to `failed`
 * receipts — they never abort the remaining revisions and never produce a
 * confirmed state without full evidence.
 */
export async function syncProject(ctx: StudioContext, input: { projectId: string; storage: StudioStorage }): Promise<{ receipts: SyncReceipt[] }> {
  assertStudioId(input.projectId, 'project id');
  const root = workspaceRoot(ctx);
  if (!(await pathExists(path.join(root, 'projects', input.projectId, 'project.json')))) {
    fail('NOT_FOUND', 'El proyecto no existe en el workspace.', { projectId: input.projectId });
  }
  const receipts: SyncReceipt[] = [];
  for (const assetId of (await listDirNames(assetsRoot(root, input.projectId))).sort()) {
    const revisionIds = (await listDirNames(revisionsRoot(root, input.projectId, assetId)))
      .filter((name) => !name.startsWith('.staging-'))
      .sort();
    for (const revisionId of revisionIds) {
      receipts.push(await syncRevision(root, { projectId: input.projectId, assetId, revisionId }, input.storage));
    }
  }
  await syncCheckpoints(root, input.projectId, input.storage);
  return { receipts };
}

// ---------------------------------------------------------------------------
// verifyProjectBackup
// ---------------------------------------------------------------------------

/** Shallow (HEAD + metadata) or deep (GET + SHA-256) check of one object. */
async function verifyObject(storage: StudioStorage, key: string, sha256: string, expectedBytes: number, deep: boolean): Promise<void> {
  const head = await storageCall(`head ${key}`, () => storage.head(key));
  if (head === null) {
    fail('NOT_FOUND', 'Objeto del respaldo ausente en el almacenamiento remoto.', { key });
  }
  if (head.bytes !== expectedBytes) {
    fail('HASH_MISMATCH', 'El objeto remoto tiene otro tamaño que el declarado por el manifest.', { key, expectedBytes, actualBytes: head.bytes });
  }
  if (deep) {
    const stored = await storageCall(`get ${key}`, () => storage.get(key));
    if ((await sha256Hex(stored)) !== sha256) {
      fail('HASH_MISMATCH', 'Deep verify: los bytes descargados no hashean al SHA-256 declarado.', { key });
    }
    return;
  }
  if (head.sha256 !== '' && head.sha256 !== sha256) {
    fail('HASH_MISMATCH', 'Los metadatos del objeto remoto declaran otro hash.', { key });
  }
}

/**
 * Verifies the remote backup of a project from the REMOTE listing (cursors to
 * the end): every manifest is fetched, schema- and seal-validated, and its
 * objects checked (deep ⇒ GET + SHA-256). Local revisions are cross-checked
 * so a manifest with the same id but different content is reported.
 */
export async function verifyProjectBackup(
  ctx: StudioContext,
  input: { projectId: string; storage: StudioStorage; deep: boolean },
): Promise<{ verified: RevisionRef[]; failures: StudioError[] }> {
  assertStudioId(input.projectId, 'project id');
  const root = workspaceRoot(ctx);
  const failures: StudioError[] = [];
  const verified: RevisionRef[] = [];
  const remoteBytesByKey = new Map<string, Uint8Array>();

  const prefix = `studio/v1/projects/${input.projectId}/assets/`;
  for (const key of await listAllKeys(input.storage, prefix)) {
    const ref = parseRevisionFromManifestKey(key);
    if (ref === null || ref.projectId !== input.projectId) {
      failures.push({ code: 'INVALID_INPUT', message: 'Key remota con formato inválido bajo el prefix del proyecto.', details: { key } });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await storageCall(`get ${key}`, () => input.storage.get(key));
    } catch (error) {
      failures.push(studioErrorOf(error));
      continue;
    }
    remoteBytesByKey.set(key, bytes);
    let manifest: RevisionManifest;
    try {
      manifest = parseManifestBytes(bytes, `manifest remoto ${ref.revisionId}`);
      await assertManifestSeal(manifest, `manifest remoto ${ref.revisionId}`);
      if (manifest.projectId !== ref.projectId || manifest.assetId !== ref.assetId || manifest.revisionId !== ref.revisionId) {
        fail('INVALID_INPUT', 'El manifest remoto no corresponde a la key que lo contiene.', { key });
      }
    } catch (error) {
      failures.push(studioErrorOf(error));
      continue;
    }
    let objectsOk = true;
    const bytesBySha = bytesByShaOf(manifest);
    for (const sha256 of [...bytesBySha.keys()].sort()) {
      try {
        await verifyObject(input.storage, storageObjectKeyForSha(sha256), sha256, bytesBySha.get(sha256)!, input.deep);
      } catch (error) {
        failures.push(studioErrorOf(error));
        objectsOk = false;
      }
    }
    if (objectsOk) verified.push(ref);
  }

  if (remoteBytesByKey.size === 0) {
    // An empty remote namespace is NOT a healthy backup: report it instead of
    // returning a vacuous success (the CLI then exits 1).
    failures.push({
      code: 'NOT_FOUND',
      message: 'El respaldo remoto del proyecto no existe (namespace sin manifests).',
      details: { projectId: input.projectId },
    });
  }

  // Local cross-check: every local revision must be backed up byte-exactly.
  for (const assetId of (await listDirNames(assetsRoot(root, input.projectId))).sort()) {
    for (const revisionId of (await listDirNames(revisionsRoot(root, input.projectId, assetId)))
      .filter((name) => !name.startsWith('.staging-'))
      .sort()) {
      const key = storageManifestKey(input.projectId, assetId, revisionId);
      if (remoteBytesByKey.get(key) === undefined) {
        failures.push({
          code: 'NOT_FOUND',
          message: 'Revisión local sin manifest remoto: el respaldo está incompleto.',
          details: { assetId, revisionId },
        });
        continue;
      }
      try {
        const local = new Uint8Array(await readFile(manifestFileOf(root, input.projectId, assetId, revisionId)));
        if (!bytesEqual(local, remoteBytesByKey.get(key)!)) {
          failures.push({
            code: 'HASH_MISMATCH',
            message: 'El manifest remoto difiere de los bytes sellados locales (mismo id, otro contenido).',
            details: { assetId, revisionId },
          });
        }
      } catch (error) {
        failures.push(studioErrorOf(error));
      }
    }
  }
  return { verified: verified.sort((a, b) => (refKey(a) < refKey(b) ? -1 : 1)), failures };
}


// ---------------------------------------------------------------------------
// recoverProjectFromStorage
// ---------------------------------------------------------------------------

interface RemoteRevision {
  ref: RevisionRef;
  bytes: Uint8Array;
  manifest: RevisionManifest;
}

/** Fetches + validates every remote revision of the project (remote-only). */
async function fetchRemoteRevisions(storage: StudioStorage, projectId: string): Promise<Map<string, RemoteRevision>> {
  const byRef = new Map<string, RemoteRevision>();
  for (const key of await listAllKeys(storage, `studio/v1/projects/${projectId}/assets/`)) {
    const ref = parseRevisionFromManifestKey(key);
    if (ref === null || ref.projectId !== projectId) {
      fail('INVALID_INPUT', 'Key remota con formato inválido; la recuperación valida ids antes de restaurar.', { key });
    }
    const bytes = await storageCall(`get ${key}`, () => storage.get(key));
    const manifest = parseManifestBytes(bytes, `manifest remoto ${ref.revisionId}`);
    await assertManifestSeal(manifest, `manifest remoto ${ref.revisionId}`);
    if (manifest.projectId !== ref.projectId || manifest.assetId !== ref.assetId || manifest.revisionId !== ref.revisionId) {
      fail('INVALID_INPUT', 'El manifest remoto no corresponde a la key que lo contiene.', { key });
    }
    byRef.set(refKey(ref), { ref, bytes, manifest });
  }
  return byRef;
}

/**
 * Active revision selection (contracts.md §5): explicit `revisionRefs`
 * (at most one per asset), explicit `checkpointId`, or the unique head per
 * asset derived from `parentRevisionId` — never listing order/timestamps.
 */
async function selectActiveRevisions(
  storage: StudioStorage,
  projectId: string,
  remote: Map<string, RemoteRevision>,
  input: { revisionRefs?: RevisionRef[]; checkpointId?: string },
): Promise<RemoteRevision[]> {
  if (input.revisionRefs !== undefined && input.checkpointId !== undefined) {
    fail('INVALID_INPUT', 'Elegí un solo selector activo: --checkpoint o --revisions, no ambos.');
  }
  if (input.revisionRefs !== undefined) {
    const byAsset = new Map<string, RemoteRevision>();
    for (const ref of input.revisionRefs) {
      assertStudioId(ref.assetId, 'asset id');
      assertStudioId(ref.revisionId, 'revision id');
      if (ref.projectId !== projectId) {
        fail('INVALID_INPUT', 'revisionRefs debe apuntar al proyecto que se recupera.', { assetId: ref.assetId });
      }
      if (byAsset.has(ref.assetId)) {
        fail('INVALID_INPUT', 'revisionRefs declara varias revisiones del mismo asset; elegí una.', { assetId: ref.assetId });
      }
      const found = remote.get(refKey({ projectId, assetId: ref.assetId, revisionId: ref.revisionId }));
      if (found === undefined) {
        fail('NOT_FOUND', 'La revisión pedida no existe en el respaldo remoto.', { assetId: ref.assetId, revisionId: ref.revisionId });
      }
      byAsset.set(ref.assetId, found);
    }
    return [...byAsset.values()].sort((a, b) => (refKey(a.ref) < refKey(b.ref) ? -1 : 1));
  }
  if (input.checkpointId !== undefined) {
    assertStudioId(input.checkpointId, 'checkpoint id');
    const key = storageCheckpointKey(projectId, input.checkpointId);
    const bytes = await storageCall(`get ${key}`, () => storage.get(key));
    const checkpoint = parseOrInvalid(ProjectCheckpointSchema, parseJsonBytes(bytes, `checkpoint ${input.checkpointId}`), `checkpoint ${input.checkpointId}`);
    if (checkpoint.projectId !== projectId) {
      fail('INVALID_INPUT', 'El checkpoint remoto no pertenece al proyecto que se recupera.', { checkpointId: checkpoint.checkpointId });
    }
    const selected: RemoteRevision[] = [];
    for (const entry of checkpoint.entries) {
      const found = remote.get(refKey({ projectId, assetId: entry.assetId, revisionId: entry.revisionId }));
      if (found === undefined) {
        fail('NOT_FOUND', 'El checkpoint apunta a una revisión inexistente en el respaldo.', { assetId: entry.assetId, revisionId: entry.revisionId });
      }
      if (found.manifest.rootHash !== entry.rootHash) {
        fail('HASH_MISMATCH', 'El rootHash del checkpoint no coincide con el manifest remoto.', { assetId: entry.assetId, revisionId: entry.revisionId });
      }
      selected.push(found);
    }
    return selected.sort((a, b) => (refKey(a.ref) < refKey(b.ref) ? -1 : 1));
  }
  // Unique head per asset from the parent chain (order-independent).
  const byAsset = new Map<string, RemoteRevision[]>();
  for (const revision of remote.values()) {
    const list = byAsset.get(revision.ref.assetId) ?? [];
    list.push(revision);
    byAsset.set(revision.ref.assetId, list);
  }
  const selected: RemoteRevision[] = [];
  for (const [assetId, revisions] of [...byAsset.entries()].sort()) {
    const parents = new Set<string>();
    for (const revision of revisions) {
      if (revision.manifest.parentRevisionId !== undefined) parents.add(revision.manifest.parentRevisionId);
    }
    const heads = revisions.map((revision) => revision.ref.revisionId).filter((id) => !parents.has(id)).sort();
    if (heads.length === 0) {
      fail('CONFLICT', `El historial remoto de ${assetId} no tiene cabeza (¿ciclo?); usá un selector explícito.`, { assetId });
    }
    if (heads.length > 1) {
      fail('CONFLICT', `El asset ${assetId} tiene varias cabezas de historial; pasá --checkpoint o --revisions. Las revisiones remotas se preservan íntegras.`, {
        assetId,
        heads,
      });
    }
    selected.push(revisions.find((revision) => revision.ref.revisionId === heads[0])!);
  }
  return selected.sort((a, b) => (refKey(a.ref) < refKey(b.ref) ? -1 : 1));
}

function canonicalJsonOf(value: unknown): string {
  return canonicalStudioJson(value as unknown as StudioJsonValue);
}

/**
 * Maps a sealed snapshot path `presets/<pid>/<vid>/<rest>` to the REGISTRY
 * layout `presets/<pid>/versions/<vid>/<rest>`, validating the namespace
 * against the preset versions the manifest actually snapshotted.
 */
function presetRegistryPathOf(file: SnapshotFile, manifest: RevisionManifest): string {
  const segments = file.path.split('/');
  if (segments.length < 4 || segments[0] !== 'presets') {
    fail('INVALID_INPUT', 'Archivo de preset con ruta fuera del namespace esperado.', { path: file.path, role: file.role });
  }
  const [, presetId, versionId, ...rest] = segments;
  const known = manifest.presetSnapshots.some((preset) => preset.presetId === presetId && preset.versionId === versionId);
  if (!known) {
    fail('INVALID_INPUT', 'Archivo de preset ajeno a las versiones declaradas por el manifest.', { path: file.path });
  }
  return path.join('presets', presetId!, 'versions', versionId!, ...rest);
}

/**
 * Active workspace metadata from the SELECTED revisions (never random
 * order), plus the materialization of EVERY immutable preset version found
 * in ALL restored revisions (preset versions are content-addressed and never
 * depend on which revision is active).
 */
async function writeActiveWorkspace(outRoot: string, projectId: string, all: RemoteRevision[], selected: RemoteRevision[]): Promise<void> {
  const projectByCanonical = new Map<string, CreativeProject>();
  const clientByCanonical = new Map<string, StudioClient>();
  const clientCanonicalById = new Map<string, string>();
  for (const revision of selected) {
    projectByCanonical.set(canonicalJsonOf(revision.manifest.projectSnapshot), revision.manifest.projectSnapshot);
    for (const client of revision.manifest.clientSnapshots) {
      const canonical = canonicalJsonOf(client);
      clientByCanonical.set(canonical, client);
      const known = clientCanonicalById.get(client.id);
      if (known !== undefined && known !== canonical) {
        fail('CONFLICT', 'Las revisiones seleccionadas difieren en el snapshot de un cliente; acotá el selector.', { clientId: client.id });
      }
      clientCanonicalById.set(client.id, canonical);
    }
  }
  if (projectByCanonical.size > 1) {
    fail('CONFLICT', 'Las revisiones seleccionadas difieren en el snapshot del proyecto; acotá el selector.', {
      projectId,
      variants: projectByCanonical.size,
    });
  }
  if (projectByCanonical.size === 1) {
    const project = [...projectByCanonical.values()][0]!;
    await writeActiveBytes(path.join(outRoot, 'projects', projectId, 'project.json'), new TextEncoder().encode(`${JSON.stringify(project, null, 2)}\n`), 'project.json');
  }
  for (const [clientId, canonical] of [...clientCanonicalById.entries()].sort()) {
    const client = clientByCanonical.get(canonical)!;
    await writeActiveBytes(path.join(outRoot, 'clients', clientId, 'client.json'), new TextEncoder().encode(`${JSON.stringify(client, null, 2)}\n`), `client ${clientId}`);
  }

  // 1. EVERY preset version of EVERY restored revision lands in the registry.
  //    Routing is by ROLE, never by path prefix: an asset source directory
  //    named `presets/` is ordinary asset content and stays in the asset.
  //    Same registry path with different bytes ⇒ CONFLICT (never a silent
  //    stomp, regardless of listing order).
  for (const revision of [...all].sort((a, b) => (refKey(a.ref) < refKey(b.ref) ? -1 : 1))) {
    const filesDir = path.join(outRoot, 'revisions', projectId, revision.ref.assetId, revision.ref.revisionId, 'files');
    for (const file of revision.manifest.files) {
      if (file.role !== 'preset') continue;
      const bytes = new Uint8Array(await readFile(path.join(filesDir, file.path)));
      await writeActiveBytes(path.join(outRoot, presetRegistryPathOf(file, revision.manifest)), bytes, file.path);
    }
  }

  // 2. Active working copies of the SELECTED revisions (non-preset files,
  //    including an asset-local `presets/` source directory).
  for (const revision of selected) {
    const filesDir = path.join(outRoot, 'revisions', projectId, revision.ref.assetId, revision.ref.revisionId, 'files');
    for (const file of revision.manifest.files) {
      if (file.role === 'preset') continue; // already materialized above
      const bytes = new Uint8Array(await readFile(path.join(filesDir, file.path)));
      const assetRoot = path.join(outRoot, 'projects', projectId, 'assets', revision.ref.assetId);
      const destination = file.path === 'asset.json' ? path.join(assetRoot, 'asset.json') : path.join(assetRoot, file.path);
      await writeActiveBytes(destination, bytes, file.path);
    }
  }
}

/**
 * Rebuilds a project workspace in an EMPTY directory using ONLY the remote
 * backup: manifests (fetched bytes written unchanged) and content-addressed
 * objects verified by SHA-256. No local registry, cache, receipt or index is
 * read; nothing is regenerated or executed. All remote revisions are
 * preserved; the ACTIVE metadata comes from the explicit selector (or the
 * unique head per asset).
 */
export async function recoverProjectFromStorage(
  ctx: StudioContext,
  input: { projectId: string; storage: StudioStorage; outDir: string; revisionRefs?: RevisionRef[]; checkpointId?: string },
): Promise<{ restored: RevisionRef[]; outDir: string }> {
  assertStudioId(input.projectId, 'project id');
  if (typeof input.outDir !== 'string' || input.outDir.trim().length === 0) {
    fail('INVALID_INPUT', 'outDir es obligatorio y no puede estar vacío.', { field: 'outDir' });
  }
  const outAbs = path.resolve(input.outDir);
  const currentRoot = workspaceRoot(ctx);
  if (isInsideDir(currentRoot, outAbs) || isInsideDir(outAbs, currentRoot)) {
    fail('PATH_UNSAFE', 'El destino de recuperación no puede solaparse con el workspace actual.', { outDir: input.outDir });
  }
  if (await pathExists(outAbs)) {
    if ((await describePathKind(outAbs)) !== 'directory') {
      fail('CONFLICT', 'El destino de recuperación existe y no es un directorio.', { outDir: input.outDir });
    }
    if ((await readdir(outAbs)).length > 0) {
      fail('CONFLICT', 'El directorio de destino no está vacío; la recuperación nunca sobrescribe.', { outDir: input.outDir });
    }
  }


  const remote = await fetchRemoteRevisions(input.storage, input.projectId);
  if (remote.size === 0) {
    fail('NOT_FOUND', 'El respaldo remoto no tiene revisiones para este proyecto.', { projectId: input.projectId });
  }
  // Selection happens BEFORE any write: a conflict leaves the target clean.
  const selected = await selectActiveRevisions(input.storage, input.projectId, remote, input);

  await mkdir(outAbs, { recursive: true });
  // 1. Every remote revision: raw manifest bytes + verified object files.
  for (const revision of [...remote.values()].sort((a, b) => (refKey(a.ref) < refKey(b.ref) ? -1 : 1))) {
    const revisionOut = revisionDir(outAbs, revision.ref.projectId, revision.ref.assetId, revision.ref.revisionId);
    await writeExclusiveBytes(path.join(revisionOut, 'manifest.json'), revision.bytes, `manifest ${revision.ref.revisionId}`);
    for (const file of revision.manifest.files) {
      if (!isSafeRelativeFilePath(file.path)) {
        fail('PATH_UNSAFE', 'El manifest remoto declara una ruta insegura.', { path: file.path });
      }
      const objectKey = storageObjectKeyForSha(file.sha256);
      const stored = await storageCall(`get ${objectKey}`, () => input.storage.get(objectKey));
      if ((await sha256Hex(stored)) !== file.sha256 || stored.byteLength !== file.bytes) {
        fail('HASH_MISMATCH', 'El objeto remoto no coincide con el hash declarado por el manifest.', {
          revisionId: revision.ref.revisionId,
          path: file.path,
        });
      }
      await writeExclusiveBytes(path.join(revisionOut, 'files', file.path), stored, file.path);
    }
  }
  // 2. Active registry: every preset version (all revisions) + the metadata
  //    of the SELECTED revisions (explicit, never random).
  await writeActiveWorkspace(outAbs, input.projectId, [...remote.values()], selected);
  // 3. Checkpoints: raw fetched bytes, schema-validated AND reference-checked
  //    BEFORE any write. The default recovery path validates exactly like the
  //    selector branch: a dangling or mismatched checkpoint is diagnosed and
  //    never materialized.
  for (const key of await listAllKeys(input.storage, `studio/v1/projects/${input.projectId}/checkpoints/`)) {
    const name = key.split('/').pop()!;
    if (!name.endsWith('.json')) continue;
    const keyCheckpointId = name.slice(0, -'.json'.length);
    const bytes = await storageCall(`get ${key}`, () => input.storage.get(key));
    const checkpoint: ProjectCheckpoint = parseOrInvalid(ProjectCheckpointSchema, parseJsonBytes(bytes, `checkpoint ${name}`), `checkpoint ${name}`);
    if (checkpoint.projectId !== input.projectId) {
      fail('INVALID_INPUT', 'Checkpoint remoto ajeno al proyecto recuperado.', { key });
    }
    if (checkpoint.checkpointId !== keyCheckpointId) {
      fail('INVALID_INPUT', 'El id del checkpoint remoto no coincide con la key que lo contiene; no se materializa.', {
        keyCheckpointId,
        documentCheckpointId: checkpoint.checkpointId,
      });
    }
    for (const entry of checkpoint.entries) {
      const referenced = remote.get(refKey({ projectId: input.projectId, assetId: entry.assetId, revisionId: entry.revisionId }));
      if (referenced === undefined) {
        fail('NOT_FOUND', 'El checkpoint remoto referencia una revisión inexistente en el respaldo; no se materializa.', {
          checkpointId: checkpoint.checkpointId,
          assetId: entry.assetId,
          revisionId: entry.revisionId,
        });
      }
      const manifest = referenced.manifest;
      if (manifest.projectId !== input.projectId || manifest.assetId !== entry.assetId || manifest.revisionId !== entry.revisionId) {
        fail('HASH_MISMATCH', 'El manifest remoto no corresponde a la entrada del checkpoint; no se materializa.', {
          checkpointId: checkpoint.checkpointId,
          assetId: entry.assetId,
          revisionId: entry.revisionId,
        });
      }
      if (manifest.rootHash !== entry.rootHash) {
        fail('HASH_MISMATCH', 'El rootHash del checkpoint remoto no coincide con el manifest validado; no se materializa.', {
          checkpointId: checkpoint.checkpointId,
          assetId: entry.assetId,
          revisionId: entry.revisionId,
        });
      }
    }
    await writeExclusiveBytes(checkpointFileOf(outAbs, input.projectId, checkpoint.checkpointId), bytes, `checkpoint ${checkpoint.checkpointId}`);
  }

  return {
    restored: [...remote.values()].map((revision) => revision.ref).sort((a, b) => (refKey(a) < refKey(b) ? -1 : 1)),
    outDir: outAbs,
  };
}
