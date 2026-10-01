/**
 * scripts/studio-verify-r2.ts — `bun run studio:verify:r2` (P-006, LIVE R2).
 *
 * Authorized by gate G-cw-live-r2 (resolved: approved) — fixture privado de
 * <= 20 MiB, namespace de proyecto único, EXCLUSIVAMENTE bucket privado
 * existente, sin delete ni objetos públicos, sin IA ni publicación.
 *
 * What it proves, with real requests:
 *   1. sync idempotente: rebuilds the deterministic demo workspace (same
 *      fixtures ⇒ same manifests ⇒ same keys) and syncs both projects; a
 *      rerun never uploads the fixture twice (content-addressed dedupe);
 *   2. verifyProjectBackup deep (GET + SHA-256 de cada objeto);
 *   3. conditional PUT proof: same bytes on an existing key resolve
 *      idempotently; DIFFERENT bytes on the same key are rejected and the
 *      stored object is proven byte-unchanged (IfNoneMatch semantics);
 *   4. remote-only recovery: a FRESH context + NEW empty dir, from ONLY the
 *      projectId + storage (no local registry/cache/manifests), restores both
 *      revisions of the image and video assets and every file is compared by
 *      SHA-256 (sources, inputs, presets, outputs, manifests);
 *   5. catalog rebuild in the recovered workspace without any remote index;
 *   6. non-secret inventory persisted to
 *      `evidence/creative-workspace/live-inventory.json` so the coordinator
 *      can reproduce the SAME namespace without another upload.
 *
 * Never prints secret values, signed URLs or raw SDK errors; no fallback if
 * credentials or the private bucket are missing — that is a blocker, exit 1.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveR2Env } from '@videomaker/credentials';
import {
  createPrivateStudioR2Storage,
  StudioPrivateBucketMissingError,
  StudioStorageConflictError,
  type StudioR2Storage,
} from '@videomaker/providers';
import {
  buildStudioCatalog,
  createStudioContext,
  listAllKeys,
  recoverProjectFromStorage,
  storageManifestKey,
  storageObjectKeyForSha,
  syncProject,
  verifyProjectBackup,
  type RevisionManifest,
  type StudioStorage,
} from '@videomaker/studio';

import { buildDemoWorkspace, sha256Bytes, type DemoRevisionInfo, type DemoWorkspace } from './studio-demo';

const REPO_ROOT = path.join(import.meta.dir, '..');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'evidence', 'creative-workspace');
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, 'validation.json');
const INVENTORY_FILE = path.join(EVIDENCE_DIR, 'live-inventory.json');
const SESSION_FILE = path.join(EVIDENCE_DIR, 'live-session.json');
const LEDGER_FILE = path.join(EVIDENCE_DIR, 'live-put-ledger.json');

/** Live namespace of THIS private session (persisted once, reused on reruns). */
let PROJECT_SHARED = '';
let PROJECT_SOLO = '';
/** Authorization cap for the whole namespace. */
const MAX_NAMESPACE_BYTES = 20 * 1024 * 1024;
/** Operator authorization (2026-10-01T03:53Z): <=10 MiB ADDITIONAL cumulative
 *  attempted putImmutable payload bytes, ONLY the existing private bucket. */
const AUTHORIZED_PRIVATE_BUCKET = 'video-maker-archive-prd';
const AUTHORIZED_ADDITIONAL_PUT_CAP = 10 * 1024 * 1024;

interface LiveSessionDoc {
  schemaVersion: 1;
  createdAt: string;
  bucket: string;
  projectIds: { shared: string; solo: string };
}

interface PutLedgerRun {
  at: string;
  status: 'pending' | 'committed' | 'failed';
  reservedBytes: number;
  attemptedPutBytes?: number;
  exitCode?: number;
}

/** Fail-closed budget: pending/failed runs keep their RESERVE consumed. */
interface PutLedgerDoc {
  schemaVersion: 1;
  bucket: string;
  capBytes: number;
  runs: PutLedgerRun[];
}

function ledgerConsumed(ledger: PutLedgerDoc): number {
  return ledger.runs.reduce(
    (total, run) => total + (run.status === 'committed' && run.attemptedPutBytes !== undefined ? run.attemptedPutBytes : run.reservedBytes),
    0,
  );
}

interface LiveFailure {
  step: string;
  detail: string;
}

const failures: LiveFailure[] = [];

function requireThat(step: string, condition: boolean, detail: string): void {
  if (!condition) failures.push({ step, detail });
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await readFile(absPath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Counting storage (metrics only; the protocol is the inner adapter's)
// ---------------------------------------------------------------------------

interface StorageMetrics {
  head: number;
  get: number;
  list: number;
  put: number;
  putPayloadBytes: number;
}

function countingStorage(
  inner: StudioStorage,
  budget: { consumedBefore: number; cap: number },
): { storage: StudioStorage; metrics: StorageMetrics } {
  const metrics: StorageMetrics = { head: 0, get: 0, list: 0, put: 0, putPayloadBytes: 0 };
  const storage: StudioStorage = {
    head: async (key) => {
      metrics.head += 1;
      return inner.head(key);
    },
    get: async (key) => {
      metrics.get += 1;
      return inner.get(key);
    },
    list: async (prefix, cursor) => {
      metrics.list += 1;
      return inner.list(prefix, cursor);
    },
    putImmutable: async (key, bytes, mediaType) => {
      if (budget.consumedBefore + metrics.putPayloadBytes + bytes.byteLength > budget.cap) {
        throw new Error(
          `PRESUPUESTO_PUT_EXCEDIDO: ${budget.consumedBefore + metrics.putPayloadBytes + bytes.byteLength} > ${budget.cap} bytes de payload PUT acumulado autorizado.`,
        );
      }
      metrics.put += 1;
      metrics.putPayloadBytes += bytes.byteLength;
      return inner.putImmutable(key, bytes, mediaType);
    },
  };
  return { storage, metrics };
}

// ---------------------------------------------------------------------------
// Remote-vs-expected comparisons (SHA proof of every restored file)
// ---------------------------------------------------------------------------

interface RevisionCheck {
  projectId: string;
  assetId: string;
  revisionId: string;
  rootHash: string;
  manifestKey: string;
  manifestBytesEqual: boolean;
  filesChecked: number;
  filesShaOk: number;
}

async function checkRecoveredRevision(
  sourceManifest: RevisionManifest,
  sourceManifestPath: string,
  outDir: string,
): Promise<RevisionCheck> {
  const ref = { projectId: sourceManifest.projectId, assetId: sourceManifest.assetId, revisionId: sourceManifest.revisionId };
  const revisionRoot = path.join(outDir, 'revisions', ref.projectId, ref.assetId, ref.revisionId);
  const manifestBytes = await readFile(path.join(revisionRoot, 'manifest.json'));
  const sourceBytes = await readFile(sourceManifestPath);
  let filesShaOk = 0;
  for (const file of sourceManifest.files) {
    const restored = await readFile(path.join(revisionRoot, 'files', file.path));
    if ((await sha256Bytes(new Uint8Array(restored))) === file.sha256 && restored.byteLength === file.bytes) filesShaOk += 1;
  }
  return {
    projectId: ref.projectId,
    assetId: ref.assetId,
    revisionId: ref.revisionId,
    rootHash: sourceManifest.rootHash,
    manifestKey: storageManifestKey(ref.projectId, ref.assetId, ref.revisionId),
    manifestBytesEqual:
      manifestBytes.byteLength === sourceBytes.byteLength &&
      (await sha256Bytes(new Uint8Array(manifestBytes))) === (await sha256Bytes(new Uint8Array(sourceBytes))),
    filesChecked: sourceManifest.files.length,
    filesShaOk,
  };
}

async function activeFileSha(outDir: string, projectId: string, assetId: string, rel: string): Promise<string | null> {
  try {
    return await sha256Bytes(new Uint8Array(await readFile(path.join(outDir, 'projects', projectId, 'assets', assetId, rel))));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Non-secret inventory
// ---------------------------------------------------------------------------

interface InventoryDoc {
  schemaVersion: 1;
  bucket: string;
  projectIds: string[];
  generatedAt: string;
  revisions: Array<{ projectId: string; assetId: string; revisionId: string; rootHash: string; manifestKey: string }>;
  keys: Array<{ key: string; bytes: number }>;
  namespaceBytes: number;
}

async function buildInventory(bucket: string, demo: DemoWorkspace, storage: StudioStorage): Promise<InventoryDoc> {
  const revisions: InventoryDoc['revisions'] = [];
  for (const revision of [demo.assets.cover.r1, demo.assets.cover.r2, demo.assets.video.r1, demo.assets.video.r2]) {
    revisions.push({
      projectId: revision.projectId,
      assetId: revision.assetId,
      revisionId: revision.revisionId,
      rootHash: revision.rootHash,
      manifestKey: storageManifestKey(revision.projectId, revision.assetId, revision.revisionId),
    });
  }
  const keys: InventoryDoc['keys'] = [];
  for (const projectId of [PROJECT_SHARED, PROJECT_SOLO]) {
    for (const key of await listAllKeys(storage, `studio/v1/projects/${projectId}/`)) {
      const meta = await storage.head(key);
      keys.push({ key, bytes: meta?.bytes ?? 0 });
    }
  }
  keys.sort((a, b) => (a.key < b.key ? -1 : 1));
  const namespaceBytes = keys.reduce((total, entry) => total + entry.bytes, 0);
  // Content objects live under `objects/`, outside the project prefix: count
  // the UNIQUE objects the manifests reference (non-secret SHAs only).
  const uniqueShas = new Set<string>();
  for (const revision of [demo.assets.cover.r1, demo.assets.cover.r2, demo.assets.video.r1, demo.assets.video.r2]) {
    for (const file of revision.manifest.files) uniqueShas.add(file.sha256);
  }
  const objectKeys: InventoryDoc['keys'] = [];
  for (const sha of [...uniqueShas].sort()) {
    const key = storageObjectKeyForSha(sha);
    const meta = await storage.head(key);
    objectKeys.push({ key, bytes: meta?.bytes ?? 0 });
  }
  return {
    schemaVersion: 1,
    bucket,
    projectIds: [PROJECT_SHARED, PROJECT_SOLO],
    generatedAt: new Date().toISOString(),
    revisions,
    keys: [...keys, ...objectKeys].sort((a, b) => (a.key < b.key ? -1 : 1)),
    namespaceBytes: namespaceBytes + objectKeys.reduce((total, entry) => total + entry.bytes, 0),
  };
}

async function mergeEvidence(section: Record<string, unknown>): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  let current: Record<string, unknown> = {};
  if (await fileExists(EVIDENCE_FILE)) {
    current = JSON.parse(await readFile(EVIDENCE_FILE, 'utf8')) as Record<string, unknown>;
  }
  const visual = typeof current.visual === 'object' && current.visual !== null ? (current.visual as Record<string, unknown>) : {};
  const merged: Record<string, unknown> = {
    ...current,
    schemaVersion: 1,
    goal: 'G-001',
    visual: { ...visual, status: visual.status === 'confirmed' ? 'PENDING' : (visual.status ?? 'PENDING') },
    ...section,
  };
  await writeFile(EVIDENCE_FILE, `${JSON.stringify(merged, null, 2)}\n`);
}

/** Redacts any error to its public shape: no secret values, no raw SDK dump. */
function publicError(error: unknown): { name: string; message: string } {
  if (error instanceof StudioPrivateBucketMissingError) {
    return { name: 'StudioPrivateBucketMissingError', message: 'R2_BUNDLES_BUCKET_NAME (bucket privado) no está configurado.' };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { name: error instanceof Error ? error.constructor.name : 'UnknownError', message: message.slice(0, 200) };
}

/** Requires the operator's EXPLICIT note (archive-prd + 10MiB adicionales). */
async function operatorAuthorizationNote(): Promise<{ ok: boolean; detail: string }> {
  const proc = Bun.spawn(['climier', 'history', 'G-cw-live-r2', '--limit', '10'], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) {
    return { ok: false, detail: 'climier history G-cw-live-r2 no disponible' };
  }
  try {
    const parsed = JSON.parse(stdout) as { entries?: Array<{ note?: unknown; ts?: unknown }> };
    for (const entry of parsed.entries ?? []) {
      const note = typeof entry.note === 'string' ? entry.note : '';
      if (note.includes('video-maker-archive-prd') && note.includes('ADICIONALES') && /10\s*MiB/i.test(note)) {
        return { ok: true, detail: `nota del operador ${typeof entry.ts === 'string' ? entry.ts : ''}` };
      }
    }
  } catch {
    // fall through to the fail-closed answer
  }
  return { ok: false, detail: 'sin nota explícita del operador (video-maker-archive-prd + 10MiB adicionales) en G-cw-live-r2' };
}

/** Persisted once: the unique live namespace reused by every rerun. */
async function loadOrCreateLiveSession(): Promise<LiveSessionDoc> {
  if (await fileExists(SESSION_FILE)) {
    return JSON.parse(await readFile(SESSION_FILE, 'utf8')) as LiveSessionDoc;
  }
  const stamp = new Date().toISOString().slice(5, 10).replace('-', '');
  const suffix = randomBytes(3).toString('hex');
  const doc: LiveSessionDoc = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    bucket: AUTHORIZED_PRIVATE_BUCKET,
    projectIds: { shared: `cw-live-${stamp}-${suffix}`, solo: `cw-live-${stamp}-${suffix}-solo` },
  };
  await writeFile(SESSION_FILE, `${JSON.stringify(doc, null, 2)}\n`);
  return doc;
}

async function loadOrInitPutLedger(): Promise<PutLedgerDoc> {
  if (await fileExists(LEDGER_FILE)) {
    return JSON.parse(await readFile(LEDGER_FILE, 'utf8')) as PutLedgerDoc;
  }
  return { schemaVersion: 1, bucket: AUTHORIZED_PRIVATE_BUCKET, capBytes: AUTHORIZED_ADDITIONAL_PUT_CAP, runs: [] };
}

/** The PREVIOUS (media-bucket) evidence stays untouched as incident proof. */
async function preserveMediaIncidentEvidence(): Promise<void> {
  if (await fileExists(SESSION_FILE)) return; // only before the FIRST private run
  if (await fileExists(EVIDENCE_FILE)) {
    await writeFile(path.join(EVIDENCE_DIR, 'validation-media-incident.json'), await readFile(EVIDENCE_FILE));
  }
  if (await fileExists(INVENTORY_FILE)) {
    await writeFile(path.join(EVIDENCE_DIR, 'live-inventory-media-incident.json'), await readFile(INVENTORY_FILE));
  }
}

async function main(): Promise<number> {
  const startedAt = new Date();
  const t0 = Date.now();
  console.log('[studio:verify:r2] exigiendo nota explícita del operador (archive-prd + 10MiB adicionales)…');
  const authorization = await operatorAuthorizationNote();
  if (!authorization.ok) {
    console.error(`[studio:verify:r2] BLOQUEO de autorización: ${authorization.detail}.`);
    await mergeEvidence({
      live: { ranAt: startedAt.toISOString(), exitCode: 1, command: 'bun run studio:verify:r2', blocked: true, blocker: { code: 'AUTH_REQUIRED', message: authorization.detail } },
    });
    return 1;
  }
  console.log(`[studio:verify:r2] autorización: ${authorization.detail}.`);

  await preserveMediaIncidentEvidence();
  const session = await loadOrCreateLiveSession();
  PROJECT_SHARED = session.projectIds.shared;
  PROJECT_SOLO = session.projectIds.solo;
  console.log(`[studio:verify:r2] sesión privada ${PROJECT_SHARED} / ${PROJECT_SOLO} → ${AUTHORIZED_PRIVATE_BUCKET}.`);

  let inner: StudioR2Storage;
  try {
    const env = await resolveR2Env({ mode: 'run' });
    // Test-only runtime PIN (operator-authorized): credentials stay env-first,
    // the BUCKET name is forced to the authorized private archive bucket.
    inner = createPrivateStudioR2Storage({ ...env, bundlesBucket: AUTHORIZED_PRIVATE_BUCKET });
  } catch (error) {
    const redacted = publicError(error);
    console.error(`[studio:verify:r2] BLOQUEO de credenciales/bucket: ${redacted.name} — ${redacted.message}`);
    console.error('[studio:verify:r2] Sin fallback: no se usa el bucket público ni se edita .env. Reportar al coordinador.');
    await mergeEvidence({
      live: {
        ranAt: startedAt.toISOString(),
        exitCode: 1,
        command: 'bun run studio:verify:r2',
        blocked: true,
        blocker: { code: 'AUTH_REQUIRED', ...redacted },
      },
    });
    return 1;
  }
  const bucket = inner.bucket;
  if (bucket !== AUTHORIZED_PRIVATE_BUCKET) {
    console.error(`[studio:verify:r2] BLOQUEO interno: bucket PINneado quedó "${bucket}" (esperado ${AUTHORIZED_PRIVATE_BUCKET}).`);
    return 1;
  }

  // Deterministic demo: same fixtures ⇒ same manifests ⇒ same keys ⇒ reruns dedupe.
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cw-live-'));
  const workspaceDir = path.join(tempRoot, 'workspace');
  const demo = await buildDemoWorkspace(workspaceDir, { projectIds: { shared: PROJECT_SHARED, solo: PROJECT_SOLO } });
  const manifestPathOf = (revision: DemoRevisionInfo): string =>
    path.join(workspaceDir, 'revisions', revision.projectId, revision.assetId, revision.revisionId, 'manifest.json');

  // PUT-payload budget, reserved BEFORE any network write (fail-closed).
  const ledger = await loadOrInitPutLedger();
  const allRevisions = [demo.assets.cover.r1, demo.assets.cover.r2, demo.assets.video.r1, demo.assets.video.r2];
  const expectedManifestKeys = new Set(allRevisions.map((revision) => storageManifestKey(revision.projectId, revision.assetId, revision.revisionId)));
  const probeKeyEstimate = `studio/v1/projects/${PROJECT_SHARED}/probe/ifnone-match-32b.bin`;
  const remoteKeys = new Set([
    ...(await listAllKeys(inner, `studio/v1/projects/${PROJECT_SHARED}/`)),
    ...(await listAllKeys(inner, `studio/v1/projects/${PROJECT_SOLO}/`)),
  ]);
  const namespaceAlreadyUploaded =
    [...expectedManifestKeys].every((key) => remoteKeys.has(key)) && remoteKeys.has(probeKeyEstimate);
  const uniqueObjectBytes = new Map(allRevisions.flatMap((revision) => revision.manifest.files.map((file) => [file.sha256, file.bytes] as const)));
  const manifestDocBytes = allRevisions.reduce((total, revision) => total + JSON.stringify(revision.manifest).length, 0);
  const reservedBytes = namespaceAlreadyUploaded
    ? 3 * 32 + 8192 // rerun: only 32-byte conditional attempts + slack
    : [...uniqueObjectBytes.values()].reduce((total, bytes) => total + bytes, 0) + manifestDocBytes + 2 * 4096 + 3 * 32 + 65536;
  const consumedBefore = ledgerConsumed(ledger);
  if (consumedBefore + reservedBytes > AUTHORIZED_ADDITIONAL_PUT_CAP) {
    console.error(
      `[studio:verify:r2] BLOQUEO de presupuesto: ${consumedBefore} ya reservados/intentados + ${reservedBytes} de esta corrida > ${AUTHORIZED_ADDITIONAL_PUT_CAP} bytes autorizados.`,
    );
    await mergeEvidence({
      live: { ranAt: startedAt.toISOString(), exitCode: 1, command: 'bun run studio:verify:r2', blocked: true, blocker: { code: 'INVALID_INPUT', message: `Presupuesto PUT agotado: ${consumedBefore}+${reservedBytes} > ${AUTHORIZED_ADDITIONAL_PUT_CAP}.` }, ledgerConsumedBefore: consumedBefore, reservedBytes },
    });
    return 1;
  }
  ledger.runs.push({ at: new Date().toISOString(), status: 'pending', reservedBytes });
  await writeFile(LEDGER_FILE, `${JSON.stringify(ledger, null, 2)}\n`);
  console.log(`[studio:verify:r2] presupuesto PUT reservado: ${reservedBytes} bytes (previo ${consumedBefore}; tope ${AUTHORIZED_ADDITIONAL_PUT_CAP}).`);
  const { storage, metrics } = countingStorage(inner, { consumedBefore, cap: AUTHORIZED_ADDITIONAL_PUT_CAP });
  const ledgerRun = ledger.runs[ledger.runs.length - 1]!;

  console.log('[studio:verify:r2] sync idempotente (upload solo lo que falta)…');
  const syncShared = await syncProject(demo.ctx, { projectId: PROJECT_SHARED, storage });
  const syncSolo = await syncProject(demo.ctx, { projectId: PROJECT_SOLO, storage });
  const receipts = [...syncShared.receipts, ...syncSolo.receipts];
  requireThat('live:sync:confirmed', receipts.length === 4 && receipts.every((receipt) => receipt.status === 'confirmed'), `receipts: ${receipts.map((receipt) => receipt.status).join(',')}`);

  console.log('[studio:verify:r2] verify deep (GET + SHA-256 por objeto)…');
  const verifyShared = await verifyProjectBackup(demo.ctx, { projectId: PROJECT_SHARED, storage, deep: true });
  const verifySolo = await verifyProjectBackup(demo.ctx, { projectId: PROJECT_SOLO, storage, deep: true });
  requireThat('live:verify:shared', verifyShared.failures.length === 0, `fallos deep: ${verifyShared.failures.length}`);
  requireThat('live:verify:solo', verifySolo.failures.length === 0, `fallos deep: ${verifySolo.failures.length}`);
  requireThat('live:verify:revisiones', verifyShared.verified.length === 2 && verifySolo.verified.length === 2, 'deep verify debe cubrir 2 revisiones por proyecto');

  // Conditional-put proof on a 32-byte SYNTHETIC probe object (coordinator
  // directive 2026-10-01): never offer large fixture payloads here again.
  // The probe lives under `probe/`, which the sync/recover/inventory code
  // never lists (they use `assets/` and `checkpoints/` prefixes only).
  console.log('[studio:verify:r2] prueba condicional IfNoneMatch (objeto sintético de 32 bytes)…');
  const PROBE_BYTES = new Uint8Array(32).map((_, index) => index);
  const probeKey = `studio/v1/projects/${PROJECT_SHARED}/probe/ifnone-match-32b.bin`;
  const probeSha = await sha256Bytes(PROBE_BYTES);
  const tamperedProbe = new Uint8Array(PROBE_BYTES);
  tamperedProbe[0] = (tamperedProbe[0] ?? 0) ^ 0xff;
  const created = await storage.putImmutable(probeKey, PROBE_BYTES, 'application/octet-stream');
  requireThat('live:condicional:creado', created.sha256 === probeSha, 'el probe de 32 bytes debía crearse limpio');
  const sameMeta = await storage.putImmutable(probeKey, PROBE_BYTES, 'application/octet-stream');
  requireThat('live:condicional:mismos-bytes', sameMeta.sha256 === probeSha, 'PUT idempotente con mismos bytes debía resolverse');
  let conflictRejected = false;
  try {
    await storage.putImmutable(probeKey, tamperedProbe, 'application/octet-stream');
  } catch (error) {
    conflictRejected = error instanceof StudioStorageConflictError;
  }
  requireThat('live:condicional:conflicto', conflictRejected, 'PUT con bytes distintos debía rechazarse (StudioStorageConflictError)');
  const after = await storage.get(probeKey);
  requireThat('live:condicional:objeto-intacto', (await sha256Bytes(after)) === probeSha, 'el objeto cambió tras un PUT conflictivo — la condición real no protegió la key');

  console.log('[studio:verify:r2] recovery remote-only (ctx nuevo, dir nuevo, sin registry/cache local)…');
  const outShared = path.join(tempRoot, 'recover-shared');
  const outSolo = path.join(tempRoot, 'recover-solo');
  const ctxShared = createStudioContext(path.join(tempRoot, 'fresh-shared'));
  const ctxSolo = createStudioContext(path.join(tempRoot, 'fresh-solo'));
  const recoveredShared = await recoverProjectFromStorage(ctxShared, {
    projectId: PROJECT_SHARED,
    storage,
    outDir: outShared,
    checkpointId: demo.checkpoints.shared,
  });
  const recoveredSolo = await recoverProjectFromStorage(ctxSolo, {
    projectId: PROJECT_SOLO,
    storage,
    outDir: outSolo,
    checkpointId: demo.checkpoints.solo,
  });
  requireThat('live:recover:revisiones', recoveredShared.restored.length === 2 && recoveredSolo.restored.length === 2, 'la recovery debe traer LAS DOS revisiones por asset');

  const revisionChecks: RevisionCheck[] = [];
  for (const revision of [demo.assets.cover.r1, demo.assets.cover.r2, demo.assets.video.r1, demo.assets.video.r2]) {
    const outDir = revision.projectId === PROJECT_SHARED ? outShared : outSolo;
    revisionChecks.push(await checkRecoveredRevision(revision.manifest, manifestPathOf(revision), outDir));
  }
  for (const check of revisionChecks) {
    requireThat(`live:sha:${check.revisionId}`, check.manifestBytesEqual && check.filesShaOk === check.filesChecked, `manifest/SHA: ${check.filesShaOk}/${check.filesChecked} archivos OK`);
  }

  // Exact outputs/sources/presets of the ACTIVE (checkpoint-selected) revision.
  const coverFeedR2 = demo.assets.cover.r2.manifest.files.find((file) => file.path === 'outputs/feed.png');
  const videoMp4R2 = demo.assets.video.r2.manifest.files.find((file) => file.path === 'workroom/remotion-hello/outputs/hello.mp4');
  const videoLockR2 = demo.assets.video.r2.manifest.files.find((file) => file.path === 'workroom/remotion-hello/bun.lock');
  const activeCoverFeedSha = await activeFileSha(outShared, PROJECT_SHARED, demo.assets.cover.assetId, 'outputs/feed.png');
  const activeVideoSha = await activeFileSha(outSolo, PROJECT_SOLO, demo.assets.video.assetId, 'workroom/remotion-hello/outputs/hello.mp4');
  const activeLockSha = await activeFileSha(outSolo, PROJECT_SOLO, demo.assets.video.assetId, 'workroom/remotion-hello/bun.lock');
  requireThat('live:activo:cover-feed', coverFeedR2 !== undefined && activeCoverFeedSha === coverFeedR2.sha256, 'el output activo de cover no coincide por SHA');
  requireThat('live:activo:video-mp4', videoMp4R2 !== undefined && activeVideoSha === videoMp4R2.sha256, 'el MP4 activo no coincide por SHA');
  requireThat('live:activo:video-lock', videoLockR2 !== undefined && activeLockSha === videoLockR2.sha256, 'el lock del proyecto Remotion no coincide por SHA');

  // Preset registry rebuilt from preset-role files (logo resource by SHA).
  const bfcLogoV2 = demo.assets.cover.r2.manifest.presetSnapshots.find(
    (preset) => preset.presetId === demo.presets.bfcLogoV2.presetId,
  );
  const logoResource = bfcLogoV2?.resources?.[0];
  if (logoResource !== undefined) {
    const logoPath = path.join(
      outShared,
      'presets',
      demo.presets.bfcLogoV2.presetId,
      'versions',
      demo.presets.bfcLogoV2.versionId,
      logoResource.path,
    );
    const logoSha = await sha256Bytes(new Uint8Array(await readFile(logoPath)));
    requireThat('live:preset:logo-sha', logoSha === logoResource.sha256, 'el logo del preset restaurado no coincide por SHA');
  } else {
    requireThat('live:preset:logo-sha', false, 'recurso de logo ausente en el snapshot de preset');
  }

  console.log('[studio:verify:r2] reconstrucción de catálogo sin índice remoto…');
  const catalogShared = await buildStudioCatalog(createStudioContext(outShared));
  const catalogSolo = await buildStudioCatalog(createStudioContext(outSolo));
  requireThat(
    'live:catalogo:entries',
    catalogShared.entries.length === 2 && catalogSolo.entries.length === 2,
    'cada proyecto recuperado debe listar sus 2 revisiones (una entry por revisión)',
  );
  const coverEntry = catalogShared.entries.find((entry) => entry.revisionId === demo.assets.cover.r2.revisionId);
  const videoEntry = catalogSolo.entries.find((entry) => entry.revisionId === demo.assets.video.r2.revisionId);
  requireThat(
    'live:catalogo:activo',
    coverEntry?.revisionId === demo.assets.cover.r2.revisionId && videoEntry?.revisionId === demo.assets.video.r2.revisionId,
    'el catálogo reconstruido debe seleccionar la revisión del checkpoint',
  );
  requireThat(
    'live:catalogo:produccion',
    coverEntry?.production.presentOutputs.length === 2 && videoEntry?.production.presentOutputs.length === 2,
    'outputs presentes en el workspace recuperado',
  );
  requireThat(
    'live:catalogo:backup-honesto',
    coverEntry?.backup.status === 'local' && videoEntry?.backup.status === 'local',
    'sin receipts locales el estado de backup es local, nunca confirmed inventado',
  );

  console.log('[studio:verify:r2] inventario no secreto + tope de 20 MiB…');
  const inventory = await buildInventory(bucket, demo, storage);
  requireThat('live:tope:20MiB', inventory.namespaceBytes <= MAX_NAMESPACE_BYTES, `namespace excede el tope autorizado: ${inventory.namespaceBytes} bytes`);

  requireThat('live:inventario:probe', inventory.keys.some((entry) => entry.key === probeKeyEstimate), 'el objeto probe de 32 bytes debe figurar en el inventario');
  let inventoryComparison: Record<string, unknown> = { priorInventory: false };
  if (await fileExists(INVENTORY_FILE)) {
    const prior = JSON.parse(await readFile(INVENTORY_FILE, 'utf8')) as InventoryDoc;
    inventoryComparison = { priorInventory: true, priorBucketDiffers: prior.bucket !== inventory.bucket };
    if (prior.bucket === inventory.bucket) {
    const currentByKey = new Map(inventory.keys.map((entry) => [entry.key, entry.bytes]));
    const drifted = prior.keys.filter((entry) => currentByKey.get(entry.key) !== entry.bytes);
    const missing = prior.keys.filter((entry) => !currentByKey.has(entry.key));
    const priorRevisionKeys = new Set(prior.revisions.map((revision) => revision.manifestKey));
    const currentRevisionKeys = new Set(inventory.revisions.map((revision) => revision.manifestKey));
    const lostRevisions = [...priorRevisionKeys].filter((key) => !currentRevisionKeys.has(key));
    const newKeys = inventory.keys.filter((entry) => !prior.keys.some((priorEntry) => priorEntry.key === entry.key));
    requireThat('live:rerun:sin-drift', drifted.length === 0 && missing.length === 0, `objetos previos cambiados/ausentes: ${drifted.length + missing.length}`);
    requireThat('live:rerun:revisiones-estables', lostRevisions.length === 0, 'una revisión previa desapareció del respaldo');
    inventoryComparison = {
      ...inventoryComparison,
      priorKeys: prior.keys.length,
      priorRevisions: prior.revisions.length,
      newKeysThisRun: newKeys.length,
      newKeys: newKeys.map((entry) => entry.key),
      dedupVerified: newKeys.length === 0,
    };
    }
  }
  await writeFile(INVENTORY_FILE, `${JSON.stringify(inventory, null, 2)}\n`);

  const durationMs = Date.now() - t0;
  await rm(tempRoot, { recursive: true, force: true });

  const exitCode = failures.length === 0 ? 0 : 1;
  ledgerRun.status = exitCode === 0 ? 'committed' : 'failed';
  ledgerRun.attemptedPutBytes = metrics.putPayloadBytes;
  ledgerRun.exitCode = exitCode;
  await writeFile(LEDGER_FILE, `${JSON.stringify(ledger, null, 2)}\n`);
  await mergeEvidence({
    live: {
      ranAt: startedAt.toISOString(),
      exitCode,
      status: exitCode === 0 ? 'completed-private' : 'failed',
      command: 'bun run studio:verify:r2',
      authorization: { note: authorization.detail, bucket: AUTHORIZED_PRIVATE_BUCKET, additionalPutCapBytes: AUTHORIZED_ADDITIONAL_PUT_CAP },
      runtimePin: 'createPrivateStudioR2Storage({ ...env, bundlesBucket: video-maker-archive-prd }) — credenciales env-first, nombre de bucket fijado',
      sessionPath: 'evidence/creative-workspace/live-session.json',
      putLedgerPath: 'evidence/creative-workspace/live-put-ledger.json',
      putLedger: { reservedBytes, attemptedPutBytes: metrics.putPayloadBytes, consumedBefore, consumedAfter: ledgerConsumed(ledger), capBytes: AUTHORIZED_ADDITIONAL_PUT_CAP },
      mediaIncidentRef: 'evidence/creative-workspace/validation-media-incident.json (evidencia REAL del bucket media preservada)',
      gate: 'G-cw-live-r2 + nota explícita del operador 2026-10-01T03:53Z',
      bucket,
      projectIds: [PROJECT_SHARED, PROJECT_SOLO],
      receipts: receipts.map((receipt) => ({ revisionId: receipt.revisionId, status: receipt.status, rootHash: receipt.rootHash, manifestKey: receipt.manifestKey })),
      deepVerify: { shared: verifyShared.verified.length, solo: verifySolo.verified.length, failures: [...verifyShared.failures, ...verifySolo.failures] },
      conditionalPutProof: { key: probeKey, probeBytes: 32, sameBytesIdempotent: true, differentBytesRejected: true, objectUnchanged: true },
      recoveredRevisions: revisionChecks,
      activeShaProofs: { coverFeed: activeCoverFeedSha, videoMp4: activeVideoSha, remotionLock: activeLockSha },
      catalogRebuild: { shared: catalogShared.entries.length, solo: catalogSolo.entries.length },
      metrics: { ...metrics, durationMs, maxAttempts: 1, namespaceBytes: inventory.namespaceBytes, objectCount: inventory.keys.length },
      inventoryPath: 'evidence/creative-workspace/live-inventory.json',
      inventoryComparison,
      failures,
    },
  });

  if (failures.length > 0) {
    console.error(`[studio:verify:r2] FALLÓ con ${failures.length} problema(s):`);
    for (const failure of failures) console.error(`  - [${failure.step}] ${failure.detail}`);
    return 1;
  }
  console.log(
    `[studio:verify:r2] OK — ${receipts.length} revisiones confirmed, deep verify sin fallos, ` +
      `${revisionChecks.length} revisiones recuperadas remote-only con SHA exacto, catálogo reconstruido, ` +
      `${inventory.namespaceBytes} bytes en namespace (${(inventory.namespaceBytes / 1024 / 1024).toFixed(2)} MiB <= 20 MiB), ${durationMs} ms.`,
  );
  return 0;
}

const code = await main();
process.exit(code);
