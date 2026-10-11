import { sha256 } from '@noble/hashes/sha2.js';

/**
 * Upload runtime proof surface (contracts.md §4, P-001 scope):
 * - streaming byte counter that enforces declared size and hard limits
 *   DURING the read (over-limit/extra bytes are rejected before anything is
 *   committed), never trusting Content-Length alone;
 * - incremental SHA-256 compatible with the Workers runtime (@noble/hashes,
 *   pure JS over typed arrays — no node:crypto, no full buffering);
 * - magic-signature detection for jpeg/png/webp/mp4 (v1 formats, HEIC and
 *   everything else rejected);
 * - R2 staging write with exact fixed length (FixedLengthStream), so a body
 *   that undershoots or overshoots its declared size never commits; and a
 *   write-once final material key derived from the verified digest.
 *
 * All bindings (R2Bucket) are injected; no host imports. Memory discipline:
 * only one chunk in flight plus a 16-byte signature window and hash state.
 */

export type V1MediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4';

export interface UploadLimits {
  /** Exact byte count declared at init time. */
  declaredBytes: number;
  /** Hard cap independent of the declaration (defense against lying init). */
  maxBytes: number;
}

export interface IngestStats {
  bytes: number;
  sha256Hex: string;
  mediaType: V1MediaType | null;
  /** Largest chunk observed while streaming (memory-discipline evidence). */
  maxChunkBytes: number;
}

export type IngestFailure =
  | { reason: 'oversize'; bytes: number; limit: number }
  | { reason: 'trailing_bytes'; bytes: number; declaredBytes: number }
  | { reason: 'invalid_signature'; bytes: number };

export type IngestOutcome =
  | { ok: true; stats: IngestStats }
  | { ok: false; failure: IngestFailure };

export type StageFailure = IngestFailure | { reason: 'staging_write_failed'; cause: string };

export type StageOutcome =
  | { ok: true; stagingKey: string; stats: IngestStats }
  | { ok: false; failure: StageFailure };

export type FinalizeFailure =
  | { reason: 'staging_missing'; stagingKey: string }
  | { reason: 'bytes_mismatch'; expected: number; actual: number }
  | { reason: 'hash_mismatch'; expected: string; actual: string }
  | { reason: 'signature_mismatch'; declared: V1MediaType; detected: V1MediaType | null }
  | { reason: 'final_conflict'; key: string };

/** Which mechanism enforced write-once on the final object (recorded, not hidden). */
export type WriteOnceStrategy = 'conditional-copy' | 'streaming-put-head-check';

/**
 * R2 copy binding (present in current workerd/miniflare, absent from the
 * installed @cloudflare/workers-types): declared structurally and feature-
 * detected so the runtime uses native copy when available.
 */
interface R2CopyOptions {
  onlyIf?: R2Conditional;
  httpMetadata?: R2HTTPMetadata;
}
type R2BucketWithCopy = R2Bucket & {
  copy(
    destination: string,
    source: string,
    options?: R2CopyOptions,
  ): Promise<R2Object | undefined>;
};

function bucketWithCopy(bucket: R2Bucket): R2BucketWithCopy | null {
  const candidate = bucket as unknown as { copy?: unknown };
  return typeof candidate.copy === 'function'
    ? (bucket as unknown as R2BucketWithCopy)
    : null;
}

export type FinalizeOutcome =
  | { ok: true; key: string; etag: string | null; writeOnceStrategy: WriteOnceStrategy }
  | { ok: false; failure: FinalizeFailure };

const SIGNATURE_WINDOW = 16;

/** Incremental SHA-256 over streamed chunks (Workers-compatible). */
export interface IncrementalHash {
  update(chunk: Uint8Array): void;
  digestHex(): string;
}

export function createIncrementalSha256(): IncrementalHash {
  const hasher = sha256.create();
  return {
    update(chunk: Uint8Array): void {
      hasher.update(chunk);
    },
    digestHex(): string {
      return bytesToHex(hasher.digest());
    },
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Detect v1 media types from the leading bytes (magic signatures). */
export function detectMediaType(head: Uint8Array): V1MediaType | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    head.length >= 4 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47
  ) {
    return 'image/png';
  }
  if (
    head.length >= 12 &&
    head[0] === 0x52 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x46 &&
    head[8] === 0x57 &&
    head[9] === 0x45 &&
    head[10] === 0x42 &&
    head[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (
    head.length >= 8 &&
    head[4] === 0x66 && // f
    head[5] === 0x74 && // t
    head[6] === 0x79 && // y
    head[7] === 0x70 //    p
  ) {
    // MP4 family box; brands like heic/heif share ftyp but are not v1.
    const brand = String.fromCharCode(head[8], head[9], head[10], head[11]);
    return brand === 'isom' || brand === 'mp42' || brand === 'mp41' || brand === 'avc1'
      ? 'video/mp4'
      : null;
  }
  return null;
}

/**
 * Single streaming pass: counts bytes, hashes incrementally, sniffs the
 * signature, and enforces both limits as soon as they are exceeded. Rejects
 * before any downstream write can commit when used via stageUpload.
 */
export async function ingestStream(
  body: ReadableStream<Uint8Array>,
  limits: UploadLimits,
  onChunk?: (chunk: Uint8Array, cumulativeBytes: number) => void,
): Promise<IngestOutcome> {
  const hash = createIncrementalSha256();
  const head = new Uint8Array(SIGNATURE_WINDOW);
  let headFilled = 0;
  let bytes = 0;
  let maxChunkBytes = 0;
  let mediaType: V1MediaType | null = null;
  const reader = body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxChunkBytes) maxChunkBytes = value.byteLength;

      const total = bytes + value.byteLength;
      if (total > limits.maxBytes) {
        return {
          ok: false,
          failure: { reason: 'oversize', bytes: total, limit: limits.maxBytes },
        };
      }
      if (total > limits.declaredBytes) {
        return {
          ok: false,
          failure: {
            reason: 'trailing_bytes',
            bytes: total,
            declaredBytes: limits.declaredBytes,
          },
        };
      }

      if (headFilled < SIGNATURE_WINDOW) {
        const take = Math.min(SIGNATURE_WINDOW - headFilled, value.byteLength);
        head.set(value.subarray(0, take), headFilled);
        headFilled += take;
        // MP4 brands occupy bytes 8..11, so decide only once the window
        // covers them; earlier media types are decided by the same call.
        if (headFilled >= 12) {
          mediaType = detectMediaType(head);
          if (mediaType === null) {
            return {
              ok: false,
              failure: { reason: 'invalid_signature', bytes: total },
            };
          }
        }
      }

      hash.update(value);
      bytes = total;
      onChunk?.(value, bytes);
    }
  } finally {
    reader.releaseLock();
  }

  if (bytes > 0) {
    const decided = mediaType ?? detectMediaType(head);
    if (decided === null) {
      return { ok: false, failure: { reason: 'invalid_signature', bytes } };
    }
    mediaType = decided;
  }

  return {
    ok: true,
    stats: { bytes, sha256Hex: hash.digestHex(), mediaType, maxChunkBytes },
  };
}

/**
 * Streams the body into R2 staging through a FixedLengthStream sized to the
 * declared byte count. Any over-limit, trailing-byte, short-body, or
 * bad-signature condition errors the pipe BEFORE `bucket.put` can settle
 * successfully, so nothing is committed under a failed upload.
 */
export async function stageUpload(
  bucket: R2Bucket,
  input: {
    stream: ReadableStream<Uint8Array>;
    stagingKey: string;
    limits: UploadLimits;
  },
): Promise<StageOutcome> {
  const fixed = new FixedLengthStream(input.limits.declaredBytes);
  const writer = fixed.writable.getWriter();
  // Started concurrently; settles only when the exact declared length has
  // flowed through without error.
  const putPromise = bucket.put(input.stagingKey, fixed.readable);
  const hash = createIncrementalSha256();
  const head = new Uint8Array(SIGNATURE_WINDOW);
  let headFilled = 0;
  let bytes = 0;
  let maxChunkBytes = 0;
  let mediaType: V1MediaType | null = null;
  const reader = input.stream.getReader();

  const fail = async (
    failure: StageFailure,
    error: unknown,
  ): Promise<StageOutcome> => {
    try {
      await reader.cancel();
    } catch {
      /* already cancelled */
    }
    try {
      await writer.abort(error instanceof Error ? error : new Error('upload rejected'));
    } catch {
      /* already aborted */
    }
    try {
      await putPromise;
    } catch {
      // Expected: the staged write must not commit for a rejected upload.
    }
    return { ok: false, failure };
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxChunkBytes) maxChunkBytes = value.byteLength;

      const total = bytes + value.byteLength;
      if (total > input.limits.maxBytes) {
        return await fail(
          { reason: 'oversize', bytes: total, limit: input.limits.maxBytes },
          new Error('oversize'),
        );
      }
      if (total > input.limits.declaredBytes) {
        return await fail(
          {
            reason: 'trailing_bytes',
            bytes: total,
            declaredBytes: input.limits.declaredBytes,
          },
          new Error('trailing_bytes'),
        );
      }

      if (headFilled < SIGNATURE_WINDOW) {
        const take = Math.min(SIGNATURE_WINDOW - headFilled, value.byteLength);
        head.set(value.subarray(0, take), headFilled);
        headFilled += take;
        // MP4 brands occupy bytes 8..11, so decide only once the window
        // covers them; the abort still prevents any commit.
        if (headFilled >= 12) {
          mediaType = detectMediaType(head);
          if (mediaType === null) {
            return await fail(
              { reason: 'invalid_signature', bytes: total },
              new Error('invalid_signature'),
            );
          }
        }
      }

      hash.update(value);
      await writer.write(value);
      bytes = total;
    }
    await writer.close();
    if (bytes > 0) {
      const decided = mediaType ?? detectMediaType(head);
      if (decided === null) {
        return await fail(
          { reason: 'invalid_signature', bytes },
          new Error('invalid_signature'),
        );
      }
      mediaType = decided;
    }
  } catch (error) {
    return fail(
      { reason: 'staging_write_failed', cause: String(error) },
      error,
    );
  }

  try {
    await putPromise;
  } catch (error) {
    return {
      ok: false,
      failure: { reason: 'staging_write_failed', cause: String(error) },
    };
  }

  return {
    ok: true,
    stagingKey: input.stagingKey,
    stats: { bytes, sha256Hex: hash.digestHex(), mediaType, maxChunkBytes },
  };
}

/**
 * Server-side verification and immutable final write (contracts.md §4):
 * re-reads the STAGED object from R2 and re-verifies size, SHA-256, and magic
 * signature by streaming it (never buffered whole), then writes the final key
 * exactly once. The final key is caller-derived (include the verified digest)
 * and is never the staging key; an existing final object is a conflict, never
 * an overwrite. The copy/put fallback chain records which mechanism the
 * runtime actually exercised.
 */
export async function finalizeUpload(
  bucket: R2Bucket,
  input: {
    stagingKey: string;
    finalKey: string;
    declared: { sha256Hex: string; bytes: number; mediaType: V1MediaType };
  },
): Promise<FinalizeOutcome> {
  const staged = await bucket.get(input.stagingKey);
  if (staged === null) {
    return { ok: false, failure: { reason: 'staging_missing', stagingKey: input.stagingKey } };
  }

  // Stream the staged bytes: verifies what R2 actually stores, chunk by chunk.
  const verification = await ingestStream(staged.body, {
    declaredBytes: input.declared.bytes,
    maxBytes: input.declared.bytes,
  });
  if (!verification.ok) {
    if (verification.failure.reason === 'trailing_bytes' || verification.failure.reason === 'oversize') {
      return {
        ok: false,
        failure: {
          reason: 'bytes_mismatch',
          expected: input.declared.bytes,
          actual: verification.failure.bytes,
        },
      };
    }
    return {
      ok: false,
      failure: { reason: 'signature_mismatch', declared: input.declared.mediaType, detected: null },
    };
  }
  if (verification.stats.bytes !== input.declared.bytes) {
    return {
      ok: false,
      failure: {
        reason: 'bytes_mismatch',
        expected: input.declared.bytes,
        actual: verification.stats.bytes,
      },
    };
  }
  if (verification.stats.sha256Hex !== input.declared.sha256Hex) {
    return {
      ok: false,
      failure: {
        reason: 'hash_mismatch',
        expected: input.declared.sha256Hex,
        actual: verification.stats.sha256Hex,
      },
    };
  }
  if (verification.stats.mediaType !== input.declared.mediaType) {
    return {
      ok: false,
      failure: {
        reason: 'signature_mismatch',
        declared: input.declared.mediaType,
        detected: verification.stats.mediaType,
      },
    };
  }

  const existing = await bucket.head(input.finalKey);
  if (existing !== null) {
    return { ok: false, failure: { reason: 'final_conflict', key: input.finalKey } };
  }

  // Prefer a native conditional copy (create-if-absent semantics when the
  // runtime honors the "etag does not match anything" idiom); fall back to a
  // streamed fixed-length put behind the head check above. Single-isolate
  // write-once; any remaining race window is documented here instead of being
  // hidden behind a fake atomic claim.
  const copier = bucketWithCopy(bucket);
  if (copier) {
    try {
      const conditional = await copier.copy(input.finalKey, input.stagingKey, {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: input.declared.mediaType },
      });
      if (
        conditional &&
        !('preconditionFailed' in conditional && conditional.preconditionFailed)
      ) {
        return {
          ok: true,
          key: input.finalKey,
          etag: conditional.etag ?? null,
          writeOnceStrategy: 'conditional-copy',
        };
      }
      return { ok: false, failure: { reason: 'final_conflict', key: input.finalKey } };
    } catch {
      // Copy unsupported or rejected: fall through to the streamed put.
    }
  }
  const source = await bucket.get(input.stagingKey);
  if (source === null) {
    return { ok: false, failure: { reason: 'staging_missing', stagingKey: input.stagingKey } };
  }
  const fixed = new FixedLengthStream(input.declared.bytes);
  const streamed = source.body.pipeTo(fixed.writable).then(
    () => 'streamed',
    (cause: unknown) => {
      throw new Error(`staging read failed: ${String(cause)}`);
    },
  );
  try {
    const [put] = await Promise.all([
      bucket.put(input.finalKey, fixed.readable, {
        httpMetadata: { contentType: input.declared.mediaType },
      }),
      streamed,
    ]);
    return {
      ok: true,
      key: input.finalKey,
      etag: put.etag ?? null,
      writeOnceStrategy: 'streaming-put-head-check',
    };
  } catch {
    return {
      ok: false,
      failure: { reason: 'final_conflict', key: input.finalKey },
    };
  }
}

/* ---------------------------------------------------------------------------
 * Upload session orchestration (P-002, contracts.md §4/§6):
 * init → authenticated PUT → complete → ready.
 * - init validates principal/client/grant, declared type+size, quota and
 *   idempotency; the server generates id and staging key (never accepted from
 *   callers) and the PENDING row is written before any R2 IO;
 * - quota is a per-client budget (default 1 GiB) reserved through a
 *   single-statement CAS, so concurrent inits cannot overcommit;
 * - PUT streams with a real byte counter and fixed-length staging (rejected
 *   bodies commit nothing); complete re-verifies the staged object on the
 *   server and only then creates the immutable final object and marks the
 *   resource ready in the same atomic D1 batch as the quota commit;
 * - a D1 failure after the R2 write leaves an inaccessible orphan whose retry
 *   path verifies the existing final object (content-addressed key) instead
 *   of ever faking readiness.
 * ------------------------------------------------------------------------- */

import { and, eq, gte, sql } from 'drizzle-orm';
import type { CompleteUploadRequest, MaterialView, UploadSessionView } from '@videomaker/customer-assets';
import type { PortalDb } from './db';
import {
  clientQuota,
  deliveryOutput,
  deliveryRevision,
  material,
  portalProject,
  uploadSession,
} from './db/schema';
import { PortalError, authorizeClient, notFound, conflict, badRequest, rawRun, principalId, type Principal } from './access';
import { storageKeys } from './storage';

export type UploadKind = 'material' | 'delivery_output';

const MiB = 1024 * 1024;

/** v1 format limits (decisions.json defaults): images 20 MiB, MP4 50 MiB. */
export const V1_TYPE_LIMIT_BYTES: Record<V1MediaType, number> = {
  'image/jpeg': 20 * MiB,
  'image/png': 20 * MiB,
  'image/webp': 20 * MiB,
  'video/mp4': 50 * MiB,
};

/** Default per-client quota budget (decisions.json: 1 GiB). */
export const DEFAULT_CLIENT_QUOTA_BYTES = 1024 * MiB;

/** Staging sessions expire quickly; abandoned staging has no GC in v1. */
export const UPLOAD_SESSION_TTL_MS = 60 * 60 * 1000;

export function isV1MediaType(value: unknown): value is V1MediaType {
  return (
    value === 'image/jpeg' || value === 'image/png' || value === 'image/webp' || value === 'video/mp4'
  );
}

export type UploadSessionRow = typeof uploadSession.$inferSelect;
export type MaterialRow = typeof material.$inferSelect;
export type DeliveryOutputRow = typeof deliveryOutput.$inferSelect;

function sessionView(row: UploadSessionRow): UploadSessionView {
  return {
    uploadId: row.id,
    clientId: row.clientId,
    kind: row.kind as UploadKind,
    mediaType: row.declaredMediaType as V1MediaType,
    declaredBytes: row.declaredBytes,
    status: row.status as UploadSessionView['status'],
    expiresAt: row.expiresMs,
  };
}

export function materialView(row: MaterialRow): MaterialView {
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.originalName ?? row.id,
    mediaType: row.mediaType as V1MediaType,
    bytes: row.bytes,
    sha256: row.sha256,
    status: 'ready',
    createdAt: row.createdMs,
  };
}

function scopeForKind(kind: UploadKind): string {
  return kind === 'material' ? 'materials:write' : 'deliveries:write';
}

/**
 * Insert-or-ignore quota bootstrap. R-2 (additive export): the guest request
 * flow reuses this so its dual reservation always runs against a live row.
 */
export async function ensureQuotaRow(db: PortalDb, clientId: string): Promise<void> {
  await rawRun(
    db,
    sql`INSERT OR IGNORE INTO client_quota (client_id, used_bytes, reserved_bytes, limit_bytes, updated_ms)
        VALUES (${clientId}, 0, 0, ${DEFAULT_CLIENT_QUOTA_BYTES}, 0)`,
  );
}

/**
 * Single-statement CAS: reserved += delta only when the budget admits it.
 * R-2 (additive export): the guest request flow reuses THIS statement as one
 * arm of the dual reservation — same SQL, same CAS semantics, no fork.
 */
export async function reserveQuota(db: PortalDb, clientId: string, delta: number): Promise<boolean> {
  const result = await rawRun(
    db,
    sql`UPDATE client_quota SET reserved_bytes = reserved_bytes + ${delta}, updated_ms = ${Date.now()}
        WHERE client_id = ${clientId} AND reserved_bytes + ${delta} <= limit_bytes`,
  );
  return result.meta.changes === 1;
}

/** Releases a reservation (failure/expiry path); never lets it go negative. */
export async function releaseQuota(db: PortalDb, clientId: string, delta: number): Promise<void> {
  await rawRun(
    db,
    sql`UPDATE client_quota SET reserved_bytes = MAX(0, reserved_bytes - ${delta}), updated_ms = ${Date.now()}
        WHERE client_id = ${clientId}`,
  );
}

export interface InitUploadInput {
  kind: UploadKind;
  mediaType: V1MediaType;
  declaredBytes: number;
  sha256?: string;
  name?: string;
  deliveryId?: string;
  outputName?: string;
  /** Optional project attribution (P-101, R-1); validated, bound at complete. */
  portalProjectId?: string;
}

/**
 * Project attribution guard (P-101, R-1): the named PortalProject must exist
 * AND belong to the upload's client — unknown or foreign projects are 404
 * (v1 enumeration rule, never 403). Runs BEFORE any quota reservation or row
 * write in init, and BEFORE any resource mutation in complete, so a rejected
 * attribution always leaves the session exactly as it was.
 */
async function assertProjectInClient(db: PortalDb, clientId: string, portalProjectId: string): Promise<void> {
  if (typeof portalProjectId !== 'string' || portalProjectId.length === 0 || portalProjectId.length > 64) {
    throw badRequest('portalProjectId has an invalid format.');
  }
  const [row] = await db
    .select({ id: portalProject.id, portalClientId: portalProject.portalClientId })
    .from(portalProject)
    .where(eq(portalProject.id, portalProjectId))
    .limit(1);
  if (!row || row.portalClientId !== clientId) throw notFound();
}

/**
 * Creates the upload session: validation -> quota reservation (CAS) ->
 * pending row. The staging key is server-generated and never returned.
 */
export async function initUploadSession(
  db: PortalDb,
  principal: Principal,
  clientId: string,
  workspaceId: string,
  input: InitUploadInput,
): Promise<UploadSessionView> {
  await authorizeClient(db, principal, clientId, scopeForKind(input.kind));

  if (!Number.isInteger(input.declaredBytes) || input.declaredBytes <= 0) {
    throw badRequest('declaredBytes must be a positive integer.');
  }
  // P-101: early attribution validation (fail fast BEFORE the quota CAS);
  // the attribution itself binds at complete, which must repeat the field.
  if (input.portalProjectId !== undefined) {
    if (input.kind !== 'material') {
      throw badRequest('portalProjectId is only valid for material uploads.');
    }
    await assertProjectInClient(db, clientId, input.portalProjectId);
  }
  const typeLimit = V1_TYPE_LIMIT_BYTES[input.mediaType];
  if (input.declaredBytes > typeLimit) {
    throw new PortalError(
      413,
      'payload_too_large',
      `declaredBytes exceeds the ${input.mediaType} limit of ${typeLimit} bytes.`,
    );
  }

  let deliveryRow: typeof deliveryRevision.$inferSelect | undefined;
  let outputRow: DeliveryOutputRow | undefined;
  if (input.kind === 'delivery_output') {
    const declaredSha = input.sha256;
    if (declaredSha === undefined) throw badRequest('sha256 is required for delivery_output uploads.');
    if (input.deliveryId === undefined || input.outputName === undefined) {
      throw badRequest('deliveryId and outputName are required for delivery_output uploads.');
    }
    [deliveryRow] = await db
      .select()
      .from(deliveryRevision)
      .where(eq(deliveryRevision.id, input.deliveryId))
      .limit(1);
    if (!deliveryRow || deliveryRow.clientId !== clientId) throw notFound();
    if (deliveryRow.status === 'ready') throw conflict('This delivery is already complete.');
    [outputRow] = await db
      .select()
      .from(deliveryOutput)
      .where(and(eq(deliveryOutput.deliveryId, input.deliveryId), eq(deliveryOutput.name, input.outputName)))
      .limit(1);
    if (!outputRow) throw notFound();
    if (outputRow.objectKey !== null) throw conflict('This output was already staged.');
    // Exactness: the staged bytes must be exactly the declared output.
    if (
      input.declaredBytes !== outputRow.bytes ||
      input.mediaType !== outputRow.mediaType ||
      declaredSha !== outputRow.sha256
    ) {
      throw conflict('Upload declaration does not match the selected output.');
    }
  }

  await ensureQuotaRow(db, clientId);
  // Concurrent-safe reservation: the CAS decides, never a read-modify-write.
  const reserved = await reserveQuota(db, clientId, input.declaredBytes);
  if (!reserved) {
    throw new PortalError(
      429,
      'rate_limited',
      'Client storage quota exceeded for this upload; wait for pending uploads to finish.',
    );
  }

  const now = Date.now();
  try {
    const [row] = await db
      .insert(uploadSession)
      .values({
        id: crypto.randomUUID(),
        clientId,
        workspaceId,
        kind: input.kind,
        stagingKey: storageKeys.staging(),
        declaredBytes: input.declaredBytes,
        declaredMediaType: input.mediaType,
        declaredSha256: input.kind === 'delivery_output' ? (input.sha256 ?? null) : null,
        deliveryId: input.deliveryId ?? null,
        outputName: input.outputName ?? null,
        originalName: input.name ?? null,
        principalId: principalId(principal),
        status: 'pending',
        expiresMs: now + UPLOAD_SESSION_TTL_MS,
        createdMs: now,
      })
      .returning();
    return sessionView(row!);
  } catch (error) {
    // Session row failed after the reservation: release and surface.
    await releaseQuota(db, clientId, input.declaredBytes);
    throw error;
  }
}

async function loadAuthorizedSession(
  db: PortalDb,
  principal: Principal,
  uploadId: string,
): Promise<UploadSessionRow> {
  const [row] = await db.select().from(uploadSession).where(eq(uploadSession.id, uploadId)).limit(1);
  if (!row) throw notFound();
  // Sessions are bound to their creating principal (contracts.md §6): another
  // principal — even one authorized for the same client — gets 404.
  if (row.principalId !== principalId(principal)) throw notFound();
  await authorizeClient(db, principal, row.clientId, scopeForKind(row.kind as UploadKind));
  return row;
}

/** PUT /api/v1/uploads/:id/content — streams the body into private staging. */
export async function putUploadContent(
  db: PortalDb,
  bucket: R2Bucket,
  principal: Principal,
  uploadId: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<{ bytes: number; sha256: string; mediaType: V1MediaType }> {
  const session = await loadAuthorizedSession(db, principal, uploadId);

  if (session.status === 'staged') {
    throw conflict('Upload content was already received; call complete instead of re-uploading.');
  }
  if (session.status !== 'pending') {
    throw conflict(`Upload session is ${session.status} and cannot accept content.`);
  }
  if (session.expiresMs < Date.now()) {
    await db.update(uploadSession).set({ status: 'expired' }).where(eq(uploadSession.id, session.id));
    throw conflict('Upload session expired; start a new upload.');
  }
  if (body === null) throw badRequest('A non-empty request body is required.');

  const outcome = await stageUpload(bucket, {
    stream: body,
    stagingKey: session.stagingKey,
    // Exact fixed length: overshoot and undershoot both fail the staging.
    limits: { declaredBytes: session.declaredBytes, maxBytes: session.declaredBytes },
  });

  if (!outcome.ok) {
    const reason = outcome.failure.reason;
    if (reason === 'oversize' || reason === 'trailing_bytes') {
      throw new PortalError(413, 'payload_too_large', 'Body size does not match the declared byte count.');
    }
    if (reason === 'invalid_signature') {
      throw new PortalError(415, 'unsupported_media_type', 'Body does not match any accepted v1 media type.');
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
    bytes: outcome.stats.bytes,
    sha256: outcome.stats.sha256Hex,
    mediaType: outcome.stats.mediaType!,
  };
}

export type CompletedUpload =
  | { kind: 'material'; material: MaterialView; replayed: boolean }
  | { kind: 'delivery_output'; output: DeliveryOutputRow; deliveryId: string; replayed: boolean };

/**
 * Commits quota usage (used += n, reserved -= n) behind a CAS predicate.
 * R-2 (additive export): reused inside the guest complete batch.
 */
export function commitQuotaStatement(db: PortalDb, clientId: string, bytes: number) {
  const now = Date.now();
  return db
    .update(clientQuota)
    .set({
      usedBytes: sql`${clientQuota.usedBytes} + ${bytes}`,
      reservedBytes: sql`${clientQuota.reservedBytes} - ${bytes}`,
      updatedMs: now,
    })
    .where(and(eq(clientQuota.clientId, clientId), gte(clientQuota.reservedBytes, bytes)));
}

/**
 * Quota release for a failed finalize (batched with the session status).
 * R-2 (additive export): same compensatory release on the guest failure path.
 */
export function releaseQuotaStatement(db: PortalDb, clientId: string, bytes: number) {
  const now = Date.now();
  return db
    .update(clientQuota)
    .set({ reservedBytes: sql`MAX(0, ${clientQuota.reservedBytes} - ${bytes})`, updatedMs: now })
    .where(eq(clientQuota.clientId, clientId));
}

/**
 * complete: server-side verification and registration (contracts.md §4).
 * Only a verified staged object reaches an immutable final key, and only a
 * committed D1 batch marks the resource ready. Retries are idempotent:
 * - a `ready` session replays its resource view;
 * - an orphaned final object (D1 failed after R2 in a prior attempt) is
 *   recognized by its content-addressed key and verified before registration,
 *   so the retry converges without duplicating bytes or faking readiness.
 *
 * P-101 (R-1): an optional project attribution may name a PortalProject of
 * the session's client; it is validated BEFORE any mutation (a rejection
 * leaves the session staged and retryable) and binds onto the freshly created
 * material row only. Undefined attribution = free v1 upload, byte-identical
 * path (no extra statement runs).
 */
export async function completeUploadSession(
  db: PortalDb,
  bucket: R2Bucket,
  principal: Principal,
  uploadId: string,
  attribution?: { portalProjectId?: string },
): Promise<CompletedUpload> {
  const session = await loadAuthorizedSession(db, principal, uploadId);

  let portalProjectId: string | null = null;
  if (attribution?.portalProjectId !== undefined) {
    if (session.kind !== 'material') {
      throw badRequest('portalProjectId is only valid for material uploads.');
    }
    await assertProjectInClient(db, session.clientId, attribution.portalProjectId);
    portalProjectId = attribution.portalProjectId;
  }

  if (session.status === 'ready') {
    return replayCompletedResource(db, session);
  }
  if (session.status === 'staged') {
    if (session.expiresMs < Date.now()) {
      await db.update(uploadSession).set({ status: 'expired' }).where(eq(uploadSession.id, session.id));
      throw conflict('Upload session expired before completion; start a new upload.');
    }
    return finalizeStaged(db, bucket, session, portalProjectId);
  }
  if (session.status === 'pending') {
    throw conflict('Upload content has not been received yet.');
  }
  throw conflict(`Upload session is ${session.status}; it cannot be completed.`);
}

async function replayCompletedResource(db: PortalDb, session: UploadSessionRow): Promise<CompletedUpload> {
  if (session.kind === 'material') {
    if (session.materialId === null) throw new PortalError(500, 'internal', 'ready session without material reference');
    const [row] = await db.select().from(material).where(eq(material.id, session.materialId)).limit(1);
    if (!row) throw new PortalError(500, 'internal', 'ready session with missing material row');
    return { kind: 'material', material: materialView(row), replayed: true };
  }
  const [row] = await db
    .select()
    .from(deliveryOutput)
    .where(and(eq(deliveryOutput.deliveryId, session.deliveryId!), eq(deliveryOutput.name, session.outputName!)))
    .limit(1);
  if (!row || row.objectKey === null) throw new PortalError(500, 'internal', 'ready session with missing output row');
  return { kind: 'delivery_output', output: row, deliveryId: session.deliveryId!, replayed: true };
}

async function finalizeStaged(
  db: PortalDb,
  bucket: R2Bucket,
  session: UploadSessionRow,
  portalProjectId: string | null,
): Promise<CompletedUpload> {
  const bytes = session.actualBytes!;
  const sha256Hex = session.actualSha256!;
  const mediaType = session.actualMediaType! as V1MediaType;

  // The declaration made at init is the contract: detected bytes that sniff
  // as a different type never reach ready (lying Content-Type rejected).
  if (session.actualMediaType !== session.declaredMediaType) {
    await db.batch([
      db
        .update(uploadSession)
        .set({ status: 'failed', completedMs: Date.now() })
        .where(eq(uploadSession.id, session.id)),
      releaseQuotaStatement(db, session.clientId, session.declaredBytes),
    ]);
    throw new PortalError(
      415,
      'unsupported_media_type',
      'Content does not match the media type declared at upload init.',
    );
  }

  const finalKey =
    session.kind === 'material'
      ? storageKeys.materialFinal(session.clientId, sha256Hex)
      : storageKeys.deliveryOutputFinal(session.deliveryId!, sha256Hex);

  const finalized = await finalizeUpload(bucket, {
    stagingKey: session.stagingKey,
    finalKey,
    declared: { sha256Hex, bytes, mediaType },
  });

  let orphanRecovered = false;
  if (finalized.ok) {
    orphanRecovered = false;
  } else if (finalized.failure.reason === 'final_conflict') {
    // Orphan recovery: the final key is content-addressed and only ever
    // written after full server-side verification, so an existing object
    // with the exact expected size IS this payload's prior successful write.
    const existing = await bucket.head(finalKey);
    if (existing === null || existing.size !== bytes) {
      throw conflict('A different object already occupies this content address.');
    }
    orphanRecovered = true;
  } else {
    void orphanRecovered; // recorded for audit/ops; does not change the result
    // Verification failed: nothing is ready, the reservation is released.
    await db.batch([
      db
        .update(uploadSession)
        .set({ status: 'failed', completedMs: Date.now() })
        .where(eq(uploadSession.id, session.id)),
      releaseQuotaStatement(db, session.clientId, session.declaredBytes),
    ]);
    if (finalized.failure.reason === 'signature_mismatch') {
      throw new PortalError(415, 'unsupported_media_type', 'Staged bytes do not match the declared media type.');
    }
    throw conflict('Staged bytes failed server-side verification; upload rejected.');
  }

  if (session.kind === 'material') {
    return completeMaterial(db, session, finalKey, sha256Hex, mediaType, portalProjectId);
  }
  return completeDeliveryOutput(db, session, finalKey);
}

async function completeMaterial(
  db: PortalDb,
  session: UploadSessionRow,
  finalKey: string,
  sha256Hex: string,
  mediaType: V1MediaType,
  portalProjectId: string | null,
): Promise<CompletedUpload> {
  // Content-addressed dedupe: identical bytes within a client reuse the row.
  const [duplicate] = await db
    .select()
    .from(material)
    .where(and(eq(material.clientId, session.clientId), eq(material.sha256, sha256Hex)))
    .limit(1);

  const materialId = duplicate?.id ?? crypto.randomUUID();

  // Atomic commit: ready row + session status + quota usage land together.
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
        sha256: sha256Hex,
        status: 'ready',
        uploadedBy: session.principalId,
        createdMs: Date.now(),
      })
      .onConflictDoNothing({ target: [material.clientId, material.sha256] }),
    db
      .update(uploadSession)
      .set({ status: 'ready', materialId, completedMs: Date.now() })
      .where(eq(uploadSession.id, session.id)),
    commitQuotaStatement(db, session.clientId, session.declaredBytes),
  ]);
  const commitResult = results[2];
  if (commitResult.meta.changes !== 1) {
    throw new PortalError(500, 'internal', 'quota commit invariant violated');
  }

  // Re-read by content: a concurrent identical upload may have won the insert,
  // and both attempts must converge on the SAME row.
  const [row] = await db
    .select()
    .from(material)
    .where(and(eq(material.clientId, session.clientId), eq(material.sha256, sha256Hex)))
    .limit(1);
  if (!row) throw new PortalError(500, 'internal', 'material row missing after commit');
  if (row.id !== materialId) {
    await db.update(uploadSession).set({ materialId: row.id }).where(eq(uploadSession.id, session.id));
  }

  // P-101 (R-1): bind the requested attribution onto the FRESHLY created row
  // only — a dedupe-reused row keeps the project context it was first created
  // in (materials are immutable post-complete, contracts.md §4). The guard
  // makes the write a no-op instead of a silent overwrite in that race. The
  // column exists only where 0003 is applied; an explicit `sql` template keeps
  // the v1 drizzle column set untouched (db/schema.ts note).
  if (portalProjectId !== null && duplicate === undefined) {
    await rawRun(
      db,
      sql`UPDATE material SET portal_project_id = ${portalProjectId}
          WHERE id = ${row.id} AND portal_project_id IS NULL`,
    );
  }
  return { kind: 'material', material: materialView(row), replayed: false };
}

async function completeDeliveryOutput(
  db: PortalDb,
  session: UploadSessionRow,
  finalKey: string,
): Promise<CompletedUpload> {
  const now = Date.now();
  const results = await db.batch([
    db
      .update(deliveryOutput)
      .set({ objectKey: finalKey, finalizedMs: now })
      .where(and(eq(deliveryOutput.deliveryId, session.deliveryId!), eq(deliveryOutput.name, session.outputName!))),
    db
      .update(uploadSession)
      .set({ status: 'ready', completedMs: now })
      .where(eq(uploadSession.id, session.id)),
    commitQuotaStatement(db, session.clientId, session.declaredBytes),
  ]);
  const commitResult = results[2];
  if (commitResult.meta.changes !== 1) {
    throw new PortalError(500, 'internal', 'quota commit invariant violated');
  }
  const [row] = await db
    .select()
    .from(deliveryOutput)
    .where(and(eq(deliveryOutput.deliveryId, session.deliveryId!), eq(deliveryOutput.name, session.outputName!)))
    .limit(1);
  if (!row) throw new PortalError(500, 'internal', 'output row missing after commit');
  return { kind: 'delivery_output', output: row, deliveryId: session.deliveryId!, replayed: false };
}
