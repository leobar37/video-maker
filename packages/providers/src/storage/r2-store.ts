/**
 * R2/S3 object storage adapter over `@aws-sdk/client-s3`.
 *
 * - `R2ObjectStore` implements the `ObjectStore` port: head/put/get/inspect,
 *   with sha256 checksum verification on `inspect` (identity comes from the
 *   downloaded bytes, never from the ETag — multipart uploads are not a hash)
 *   and the origin `objectExists` semantics (true / false on 404 / throw).
 * - `R2BucketAdmin` implements the `BucketAdmin` port: `verifyPublicUrlCoherence`
 *   is the public-host guard that must pass before mutating manifests — the
 *   bucket and its public URL are ONE declaration, and a pair mixed across
 *   sources publishes links that answer 404.
 *
 * Invariants:
 * - Plan mode refuses every operation that would touch the network (NFR-002).
 * - The default S3 client runs with `maxAttempts: 1`: no silent SDK retries for
 *   uploads/lookups. Raise it explicitly via `R2StoreOptions.maxAttempts`.
 * - Secret values never enter logs, metadata, or errors (NFR-001); the only
 *   metadata written is the object's own sha256 checksum.
 */
import { createHash } from 'node:crypto';

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { R2Env } from '@videomaker/credentials';

import type { BucketAdmin, ObjectMeta, ObjectStore, ProviderContext } from '../ports';
import { assertRunMode } from './context';

/** Minimal S3 seam: the real `S3Client` satisfies it, tests inject a fake. */
export interface S3Like {
  send(command: unknown): Promise<unknown>;
}

export interface R2StoreOptions {
  /** Injected S3 client (test seam). Defaults to `createR2Client(env)`. */
  client?: S3Like;
  /** Explicit retry policy for the default client; 1 = never retry (default). */
  maxAttempts?: number;
}

/** One object missing in the bucket (404 on head/get/inspect). */
export class ObjectNotFoundError extends Error {
  constructor(
    readonly bucket: string,
    readonly key: string,
  ) {
    super(`Object does not exist: s3://${bucket}/${key}`);
    this.name = 'ObjectNotFoundError';
  }
}

/** The remote answered but would not prove the stored bytes. */
export class RemoteUnverifiableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteUnverifiableError';
  }
}

/** Stored bytes do not match the checksum recorded at upload time. */
export class ChecksumMismatchError extends Error {
  constructor(
    readonly key: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `Checksum mismatch for ${key}: stored metadata says sha256=${expected} ` +
        `but the downloaded bytes hash to sha256=${actual}.`,
    );
    this.name = 'ChecksumMismatchError';
  }
}

/**
 * S3 client for an R2 environment. `maxAttempts` defaults to 1 on purpose:
 * uploads and lookups must never be silently retried by the SDK.
 */
export function createR2Client(env: R2Env, opts: { maxAttempts?: number } = {}): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: env.endpoint,
    credentials: {
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
    },
    maxAttempts: opts.maxAttempts ?? 1,
  });
}

/** 404 detection shared by head/get/inspect (name or HTTP status). */
export function isNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ('name' in err && (err.name === 'NotFound' || err.name === 'NoSuchKey')) return true;
  if ('$metadata' in err) {
    const metadata = (err as { $metadata: unknown }).$metadata;
    if (typeof metadata === 'object' && metadata !== null && 'httpStatusCode' in metadata) {
      return (metadata as { httpStatusCode: unknown }).httpStatusCode === 404;
    }
  }
  return false;
}

async function bodyToBytes(body: unknown): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  const candidate = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof candidate.transformToByteArray === 'function') {
    return await candidate.transformToByteArray();
  }
  if (typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
      bytes += chunk.byteLength;
    }
    const out = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
  throw new RemoteUnverifiableError(
    'R2 returned a body that is neither bytes nor a supported stream.',
  );
}

/** Streams the body once, hashing as it goes (identity from GET bytes). */
async function hashBody(body: unknown): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  if (!body) return { sha256: hash.digest('hex'), bytes: 0 };
  if (body instanceof Uint8Array) {
    hash.update(body);
    return { sha256: hash.digest('hex'), bytes: body.byteLength };
  }
  const candidate = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof candidate.transformToByteArray === 'function') {
    const raw = await candidate.transformToByteArray();
    hash.update(raw);
    return { sha256: hash.digest('hex'), bytes: raw.byteLength };
  }
  if (typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
    let bytes = 0;
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      bytes += chunk.byteLength;
    }
    return { sha256: hash.digest('hex'), bytes };
  }
  throw new RemoteUnverifiableError(
    'R2 returned a body that is neither bytes nor a supported stream.',
  );
}

function sha256Of(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
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

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

export function publicUrlFor(env: R2Env, key: string): string {
  return `${normalizeUrl(env.publicUrl)}/${key}`;
}

/** `ObjectStore` plus the origin `objectExists` semantics, over one R2 environment. */
export class R2ObjectStore implements ObjectStore {
  readonly env: R2Env;
  readonly client: S3Like;

  constructor(env: R2Env, opts: R2StoreOptions = {}) {
    this.env = env;
    this.client = opts.client ?? createR2Client(env, { maxAttempts: opts.maxAttempts });
  }

  /** Head-object lookup; `null` on 404. */
  async head(key: string, ctx: ProviderContext): Promise<ObjectMeta | null> {
    assertRunMode(ctx, 'R2 head');
    return this.headRaw(key);
  }

  /** Origin semantics: true on hit, false on 404, throw on any other error. */
  async objectExists(key: string, ctx: ProviderContext): Promise<boolean> {
    return (await this.head(key, ctx)) !== null;
  }

  async put(
    key: string,
    body: Uint8Array,
    opts: { contentType?: string },
    ctx: ProviderContext,
  ): Promise<ObjectMeta> {
    assertRunMode(ctx, 'R2 put');
    const sha256 = sha256Of(body);
    const output = asRecord(
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.env.bucket,
          Key: key,
          Body: body,
          ContentLength: body.byteLength,
          ...(opts.contentType ? { ContentType: opts.contentType } : {}),
          // Non-secret integrity metadata only.
          Metadata: { sha256 },
        }),
      ),
    );
    return {
      key,
      bytes: body.byteLength,
      sha256,
      etag: stringField(output, 'ETag'),
      contentType: opts.contentType,
      publicUrl: publicUrlFor(this.env, key),
    };
  }

  async get(key: string, ctx: ProviderContext): Promise<Uint8Array> {
    assertRunMode(ctx, 'R2 get');
    return bodyToBytes(await this.getRaw(key));
  }

  /**
   * Metadata plus checksum verification: downloads the object, hashes the
   * served bytes and compares against the sha256 recorded at upload time.
   * A mismatch means the stored object is not the approved snapshot.
   */
  async inspect(key: string, ctx: ProviderContext): Promise<ObjectMeta> {
    assertRunMode(ctx, 'R2 inspect');
    const head = await this.headRaw(key);
    if (!head) throw new ObjectNotFoundError(this.env.bucket, key);
    const output = asRecord(await this.getRaw(key));
    const { sha256, bytes } = await hashBody(output.Body);
    const expected = head.sha256;
    if (expected && expected !== sha256) {
      throw new ChecksumMismatchError(key, expected, sha256);
    }
    return {
      key,
      bytes,
      sha256,
      etag: stringField(output, 'ETag') ?? head.etag,
      contentType: stringField(output, 'ContentType') ?? head.contentType,
      publicUrl: publicUrlFor(this.env, key),
    };
  }

  private async headRaw(key: string): Promise<ObjectMeta | null> {
    try {
      const output = asRecord(
        await this.client.send(new HeadObjectCommand({ Bucket: this.env.bucket, Key: key })),
      );
      const metadata = asRecord(output.Metadata);
      return {
        key,
        bytes: numberField(output, 'ContentLength') ?? 0,
        sha256: stringField(metadata, 'sha256'),
        etag: stringField(output, 'ETag'),
        contentType: stringField(output, 'ContentType'),
        publicUrl: publicUrlFor(this.env, key),
      };
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  private async getRaw(key: string): Promise<unknown> {
    try {
      return await this.client.send(new GetObjectCommand({ Bucket: this.env.bucket, Key: key }));
    } catch (err) {
      if (isNotFoundError(err)) throw new ObjectNotFoundError(this.env.bucket, key);
      throw err;
    }
  }
}

export interface CoherenceCheck {
  ok: boolean;
  detail?: string;
}

const PAIR_HINT =
  'Bucket and public URL must come from the same source: declare ' +
  'R2_MARKETING_BUCKET_NAME/R2_MARKETING_PUBLIC_URL as a pair (or the generic ' +
  'R2_BUCKET_NAME/R2_PUBLIC_URL pair). A mixed pair uploads to one bucket while ' +
  'publishing links to another and answers 404.';

/**
 * `BucketAdmin` guard. The bucket and the public URL are one declaration:
 *
 * 1. static coherence — the pair under test must match the resolved `R2Env`
 *    pair (catches cross-source mixes and wrong arguments) and the URL must be
 *    a plain http(s) URL;
 * 2. live coherence (run mode only) — an object that exists in the bucket must
 *    answer 200 on the public URL, proving consumers can actually read it.
 */
export class R2BucketAdmin implements BucketAdmin {
  readonly env: R2Env;
  readonly client: S3Like;

  constructor(env: R2Env, opts: R2StoreOptions = {}) {
    this.env = env;
    this.client = opts.client ?? createR2Client(env, { maxAttempts: opts.maxAttempts });
  }

  async verifyPublicUrlCoherence(
    bucket: string,
    publicUrl: string,
    ctx: ProviderContext,
  ): Promise<CoherenceCheck> {
    let parsed: URL;
    try {
      parsed = new URL(publicUrl);
    } catch {
      return {
        ok: false,
        detail: `Public URL is not an absolute URL: "${publicUrl}". ${PAIR_HINT}`,
      };
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return {
        ok: false,
        detail: `Public URL must be a plain http(s) origin URL: "${publicUrl}". ${PAIR_HINT}`,
      };
    }
    if (!bucket) {
      return { ok: false, detail: `Empty bucket name for public URL ${publicUrl}. ${PAIR_HINT}` };
    }
    if (bucket !== this.env.bucket || normalizeUrl(publicUrl) !== normalizeUrl(this.env.publicUrl)) {
      return {
        ok: false,
        detail:
          `Bucket/URL mismatch: under test s3://${bucket} + ${normalizeUrl(publicUrl)}, ` +
          `configured s3://${this.env.bucket} + ${normalizeUrl(this.env.publicUrl)}. ${PAIR_HINT}`,
      };
    }
    if (ctx.mode === 'plan') {
      return {
        ok: true,
        detail: 'Pair matches the resolved environment; plan mode skips the live serve check.',
      };
    }

    // Live check: whatever exists in the bucket must be served by the public URL.
    let firstKey: string | undefined;
    try {
      const output = asRecord(
        await this.client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 })),
      );
      const contents = output.Contents;
      if (Array.isArray(contents) && contents.length > 0) {
        firstKey = stringField(asRecord(contents[0]), 'Key');
      }
    } catch (err) {
      return {
        ok: false,
        detail: `Could not list s3://${bucket} to verify the public URL: ${(err as Error).message}`,
      };
    }
    if (!firstKey) {
      return {
        ok: true,
        detail: `Pair matches the resolved environment; s3://${bucket} has no object to probe yet.`,
      };
    }
    const url = `${normalizeUrl(publicUrl)}/${firstKey}`;
    let status: number;
    try {
      status = (await ctx.fetchImpl(url, { method: 'HEAD', cache: 'no-store' })).status;
    } catch (err) {
      return {
        ok: false,
        detail: `Could not verify the public URL ${url}: ${(err as Error).message}. ${PAIR_HINT}`,
      };
    }
    if (status !== 200) {
      return {
        ok: false,
        detail:
          `Public URL answers ${status} for ${url} while the object lives in s3://${bucket}. ` +
          PAIR_HINT,
      };
    }
    return {
      ok: true,
      detail: `Public URL serves objects of s3://${bucket} (probe ${firstKey} → 200).`,
    };
  }
}
