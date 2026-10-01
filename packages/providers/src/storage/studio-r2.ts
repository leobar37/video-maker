/**
 * R2 adapter for the studio backup port (`StudioStorage`, contracts.md §5/§7).
 *
 * It reuses the existing S3 seam (`createR2Client` / `S3Like`) and adds the
 * one primitive the legacy `ObjectStore` port does not have: a CREATE-ONLY
 * upload. `putImmutable` sends `IfNoneMatch: '*'` on PutObject — supported by
 * the R2 S3 API (verified read-only against
 * https://developers.cloudflare.com/r2/api/s3/api/, 2026-07-31) — so the
 * manifest commit has no HEAD+PUT race:
 *
 * - 412 PreconditionFailed ⇒ the key already exists ⇒ the stored bytes are
 *   fetched and compared: identical ⇒ idempotent success (a lost response
 *   after commit is NOT an error), different ⇒ `StudioStorageConflictError`
 *   (the protocol never overwrites).
 * - Identity is the SHA-256 of the bytes (stored as object metadata); ETags
 *   are never treated as content hashes.
 * - All objects live in ONE explicit private bucket. The factory for private
 *   backups REFUSES to fall back to `env.bucket`, which can be the PUBLIC
 *   media bucket: a missing private bucket is an explicit configuration
 *   error, never a silent upload of sources to a public bucket.
 *
 * No public writes exist in this adapter: opt-in public delivery of selected
 * outputs is a separate, explicitly authorized surface outside this phase.
 */
import { createHash } from 'node:crypto';

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { R2Env } from '@videomaker/credentials';
import type { ObjectMeta as StudioObjectMeta, StudioStorage } from '@videomaker/studio';

import { bodyToBytes, createR2Client, isNotFoundError, ObjectNotFoundError, type S3Like } from './r2-store';

/** Same-key-different-bytes: the caller maps this to a CONFLICT. */
export class StudioStorageConflictError extends Error {
  constructor(
    readonly key: string,
    readonly expectedSha256: string,
    readonly existingSha256: string,
  ) {
    super(
      `Immutable object conflict on ${key}: expected sha256=${expectedSha256} but the stored object hashes to sha256=${existingSha256}.`,
    );
    this.name = 'StudioStorageConflictError';
  }
}

/** The private backup bucket is missing: explicit config error, no fallback. */
export class StudioPrivateBucketMissingError extends Error {
  constructor() {
    super(
      'The private studio backup bucket is not configured. Declare R2_BUNDLES_BUCKET_NAME (private archive bucket); ' +
        'private backups never fall back to the media/public bucket. Values are never printed.',
    );
    this.name = 'StudioPrivateBucketMissingError';
  }
}

/** Page size for `list`; pagination continues via cursors until the end. */
const R2_LIST_MAX_KEYS = 1000;

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function stringField(source: Record<string, unknown>, name: string): string | undefined {
  const value = source[name];
  return typeof value === 'string' ? value : undefined;
}

function numberField(source: Record<string, unknown>, name: string): number | undefined {
  const value = source[name];
  return typeof value === 'number' ? value : undefined;
}

/** 412 detection by error name or HTTP status (S3 SDK error shape). */
function isPreconditionFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('name' in error && error.name === 'PreconditionFailed') return true;
  if ('$metadata' in error) {
    const metadata = error.$metadata;
    if (typeof metadata === 'object' && metadata !== null && 'httpStatusCode' in metadata) {
      return metadata.httpStatusCode === 412;
    }
  }
  return false;
}

export interface StudioR2StorageOptions {
  /** Explicit bucket for every object (private archive bucket). */
  bucket: string;
  /** R2 environment for the default client (required unless `client` is injected). */
  env?: R2Env;
  /** Injected S3 client (test seam); defaults to `createR2Client(env)`. */
  client?: S3Like;
  /** Passed to the default client; 1 = never silently retry (default). */
  maxAttempts?: number;
}

/**
 * `StudioStorage` over one explicit bucket of an R2 environment. The bucket
 * is ALWAYS the constructor argument — this class never reads `env.bucket`
 * (which may be the public media bucket).
 */
export class StudioR2Storage implements StudioStorage {
  readonly bucket: string;
  readonly client: S3Like;

  constructor(opts: StudioR2StorageOptions) {
    if (typeof opts.bucket !== 'string' || opts.bucket.trim().length === 0) {
      throw new StudioPrivateBucketMissingError();
    }
    this.bucket = opts.bucket;
    if (opts.client !== undefined) {
      this.client = opts.client;
    } else if (opts.env !== undefined) {
      this.client = createR2Client(opts.env, { maxAttempts: opts.maxAttempts });
    } else {
      throw new Error('StudioR2Storage requires an injected client or an R2 environment.');
    }
  }

  /** Head lookup: `null` on 404; `sha256` is the uploaded metadata or `''`. */
  async head(key: string): Promise<StudioObjectMeta | null> {
    try {
      const output = asRecord(await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })));
      const metadata = asRecord(output.Metadata);
      const etag = stringField(output, 'ETag');
      return {
        key,
        bytes: numberField(output, 'ContentLength') ?? 0,
        sha256: stringField(metadata, 'sha256') ?? '',
        ...(etag !== undefined ? { etag } : {}),
      };
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      const output = asRecord(await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })));
      return await bodyToBytes(output.Body);
    } catch (error) {
      if (isNotFoundError(error)) throw new ObjectNotFoundError(this.bucket, key);
      throw error;
    }
  }

  /**
   * Create-only upload (`IfNoneMatch: '*'`). A 412 means the key exists: the
   * stored bytes are compared — identical ⇒ idempotent success (retry after
   * a lost response), different ⇒ `StudioStorageConflictError`.
   */
  async putImmutable(key: string, bytes: Uint8Array, mediaType: string): Promise<StudioObjectMeta> {
    const sha256 = sha256Of(bytes);
    try {
      const output = asRecord(
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: bytes,
            ContentLength: bytes.byteLength,
            ContentType: mediaType,
            // Non-secret integrity metadata only.
            Metadata: { sha256 },
            IfNoneMatch: '*',
          }),
        ),
      );
      const etag = stringField(output, 'ETag');
      return { key, bytes: bytes.byteLength, sha256, ...(etag !== undefined ? { etag } : {}) };
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error;
      const existing = await this.get(key);
      const existingSha256 = sha256Of(existing);
      if (existingSha256 === sha256) {
        return { key, bytes: bytes.byteLength, sha256 };
      }
      throw new StudioStorageConflictError(key, sha256, existingSha256);
    }
  }

  /** One page of a prefix listing; pagination continues via `nextCursor`. */
  async list(prefix: string, cursor?: string): Promise<{ keys: string[]; nextCursor?: string }> {
    const output = asRecord(
      await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: R2_LIST_MAX_KEYS,
          ...(cursor !== undefined ? { ContinuationToken: cursor } : {}),
        }),
      ),
    );
    const contents = Array.isArray(output.Contents) ? output.Contents : [];
    const keys = contents
      .map((entry) => stringField(asRecord(entry), 'Key'))
      .filter((key): key is string => key !== undefined && key.length > 0);
    const nextCursor = stringField(output, 'NextContinuationToken');
    return { keys, ...(nextCursor !== undefined && nextCursor.length > 0 ? { nextCursor } : {}) };
  }
}

/** Env name of the private archive bucket (config value, never a secret). */
export const STUDIO_PRIVATE_BUCKET_ENV_NAME = 'R2_BUNDLES_BUCKET_NAME';

/**
 * Private-bucket factory for studio backups: `R2_BUNDLES_BUCKET_NAME` is
 * REQUIRED. `env.bucket` (marketing/generic pair) can be the PUBLIC media
 * bucket, so a missing private configuration is an explicit error instead of
 * a fallback that would upload sources, presets and manifests publicly.
 */
export function studioPrivateBucketOf(env: R2Env): string {
  const bucket = env.bundlesBucket;
  if (typeof bucket !== 'string' || bucket.trim().length === 0) {
    throw new StudioPrivateBucketMissingError();
  }
  return bucket;
}

export interface PrivateStudioR2StorageOptions {
  /** Injected S3 client (test seam). Defaults to `createR2Client(env)`. */
  client?: S3Like;
  /** Passed to the default client; 1 = never silently retry (default). */
  maxAttempts?: number;
}

/** Builds the private studio storage over the explicit archive bucket. */
export function createPrivateStudioR2Storage(env: R2Env, opts: PrivateStudioR2StorageOptions = {}): StudioR2Storage {
  return new StudioR2Storage({ bucket: studioPrivateBucketOf(env), env, client: opts.client, maxAttempts: opts.maxAttempts });
}
