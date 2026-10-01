/**
 * Studio R2 adapter (`StudioR2Storage`) over a fake S3 seam — no network:
 *
 * - `putImmutable` sends `IfNoneMatch: '*'` (create-only; R2 S3 API supports
 *   it on PutObject) and records the sha256 as object metadata.
 * - 412 on an existing key with IDENTICAL bytes ⇒ idempotent success (a
 *   retry after a lost response); with DIFFERENT bytes ⇒
 *   `StudioStorageConflictError` (never an overwrite).
 * - `list` pages through cursors; `head`/`get` answer null / typed missing.
 * - The private factory REQUIRES the explicit private bucket and never falls
 *   back to `env.bucket` (which can be the PUBLIC media bucket).
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { R2Env } from '@videomaker/credentials';

import {
  createPrivateStudioR2Storage,
  StudioPrivateBucketMissingError,
  StudioR2Storage,
  StudioStorageConflictError,
  studioPrivateBucketOf,
} from './studio-r2';
import { ObjectNotFoundError } from './r2-store';

const ENV: R2Env = {
  accountId: 'testaccount',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  bucket: 'media-public-prd', // the (possibly PUBLIC) media bucket
  endpoint: 'https://testaccount.r2.cloudflarestorage.com',
  publicUrl: 'https://cdn.example.com',
  bundlesBucket: 'video-maker-archive-prd',
};

interface FakeEntry {
  body: Uint8Array;
  contentType?: string;
  metadata?: Record<string, string>;
  etag: string;
}

interface SentCommand {
  name: string;
  input: Record<string, unknown>;
}

/** In-memory S3 seam honoring `IfNoneMatch: '*'` with a real 412. */
class FakeS3 {
  objects = new Map<string, FakeEntry>();
  sent: SentCommand[] = [];
  pageSize = 2;

  send = async (command: unknown): Promise<unknown> => {
    const name = (command as { constructor: { name: string } }).constructor.name;
    const input = (command as { input: Record<string, unknown> }).input;
    this.sent.push({ name, input });
    const key = String(input.Key ?? '');
    if (name === PutObjectCommand.name) {
      const existing = this.objects.get(key);
      if (input.IfNoneMatch === '*' && existing !== undefined) {
        throw Object.assign(new Error('At least one of the pre-conditions you specified did not hold'), {
          name: 'PreconditionFailed',
          $metadata: { httpStatusCode: 412 },
        });
      }
      const body = input.Body as Uint8Array;
      const entry: FakeEntry = {
        body,
        contentType: input.ContentType as string | undefined,
        metadata: input.Metadata as Record<string, string> | undefined,
        etag: `"etag-${this.objects.size}"`,
      };
      this.objects.set(key, entry);
      return { ETag: entry.etag };
    }
    if (name === HeadObjectCommand.name) {
      const entry = this.objects.get(key);
      if (entry === undefined) throw Object.assign(new Error('missing'), { name: 'NotFound' });
      return {
        ContentLength: entry.body.byteLength,
        ETag: entry.etag,
        ContentType: entry.contentType,
        Metadata: entry.metadata,
      };
    }
    if (name === GetObjectCommand.name) {
      const entry = this.objects.get(key);
      if (entry === undefined) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      return { Body: entry.body, ETag: entry.etag, ContentType: entry.contentType, Metadata: entry.metadata };
    }
    if (name === ListObjectsV2Command.name) {
      const prefix = String(input.Prefix ?? '');
      const matched = [...this.objects.keys()].filter((candidate) => candidate.startsWith(prefix)).sort();
      const start = input.ContinuationToken === undefined ? 0 : Number.parseInt(String(input.ContinuationToken), 10);
      const keys = matched.slice(start, start + this.pageSize);
      const next = start + this.pageSize < matched.length ? String(start + this.pageSize) : undefined;
      return { Contents: keys.map((candidate) => ({ Key: candidate })), ...(next !== undefined ? { NextContinuationToken: next } : {}) };
    }
    throw new Error(`fake S3: unexpected command ${name}`);
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeStorage(pageSize?: number): { storage: StudioR2Storage; fake: FakeS3 } {
  const fake = new FakeS3();
  if (pageSize !== undefined) fake.pageSize = pageSize;
  const storage = createPrivateStudioR2Storage(ENV, { client: fake });
  return { storage, fake };
}

describe('StudioR2Storage: putImmutable create-only', () => {
  test('sube con IfNoneMatch "*" y registra sha256 como metadata (nunca ETag como hash)', async () => {
    const { storage, fake } = makeStorage();
    const bytes = new TextEncoder().encode('contenido sellado\n');
    const meta = await storage.putImmutable('objects/ab/abcd', bytes, 'text/plain');

    expect(meta).toEqual({ key: 'objects/ab/abcd', bytes: bytes.byteLength, sha256: sha256(bytes), etag: expect.any(String) });
    const put = fake.sent.find((command) => command.name === PutObjectCommand.name)!;
    expect(put.input.IfNoneMatch).toBe('*');
    expect(put.input.Bucket).toBe('video-maker-archive-prd');
    expect((put.input.Metadata as Record<string, string>).sha256).toBe(sha256(bytes));
    // head reports the metadata sha (identity from bytes, never the ETag).
    expect(await storage.head('objects/ab/abcd')).toEqual({
      key: 'objects/ab/abcd',
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      etag: expect.any(String),
    });
  });

  test('412 con bytes idénticos ⇒ éxito idempotente (respuesta perdida tras el commit)', async () => {
    const { storage, fake } = makeStorage();
    const bytes = new TextEncoder().encode('manifest bytes\n');
    await storage.putImmutable('studio/v1/…/manifest.json', bytes, 'application/json');
    const sentBefore = fake.sent.length;
    const meta = await storage.putImmutable('studio/v1/…/manifest.json', bytes, 'application/json');
    expect(meta.sha256).toBe(sha256(bytes));
    // The 412 path resolved by GET + comparison, not by overwriting.
    const after = fake.sent.slice(sentBefore);
    expect(after.map((command) => command.name)).toEqual([PutObjectCommand.name, GetObjectCommand.name]);
    expect(fake.objects.get('studio/v1/…/manifest.json')!.body).toEqual(bytes);
  });

  test('412 con bytes distintos ⇒ StudioStorageConflictError y el objeto queda intacto', async () => {
    const { storage } = makeStorage();
    const original = new TextEncoder().encode('bytes originales\n');
    await storage.putImmutable('objects/ab/abcd', original, 'text/plain');
    const altered = new TextEncoder().encode('otros bytes\n');
    const conflict = storage.putImmutable('objects/ab/abcd', altered, 'text/plain');
    await expect(conflict).rejects.toBeInstanceOf(StudioStorageConflictError);
    await expect(conflict).rejects.toThrow(/sha256/);
    expect(await storage.get('objects/ab/abcd')).toEqual(original);
  });

  test('head/get de objeto inexistente ⇒ null / ObjectNotFoundError', async () => {
    const { storage } = makeStorage();
    expect(await storage.head('objects/00/ninguno')).toBeNull();
    await expect(storage.get('objects/00/ninguno')).rejects.toBeInstanceOf(ObjectNotFoundError);
  });
});

describe('StudioR2Storage: list paginado con cursores', () => {
  test('recorre páginas siguiendo ContinuationToken hasta el fin', async () => {
    const { storage } = makeStorage(2);
    for (let index = 0; index < 5; index += 1) {
      await storage.putImmutable(`objects/a${index}/key-${index}`, new TextEncoder().encode(`v${index}`), 'text/plain');
    }
    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await storage.list('objects/', cursor);
      pages += 1;
      collected.push(...page.keys);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(pages).toBe(3); // 2 + 2 + 1
    expect(collected).toEqual([...collected].sort());
    expect(collected).toHaveLength(5);
  });

  test('prefix exacto: las keys ajenas no aparecen', async () => {
    const { storage } = makeStorage(10);
    await storage.putImmutable('studio/v1/a.json', new TextEncoder().encode('a'), 'application/json');
    await storage.putImmutable('objects/ab/abcd', new TextEncoder().encode('b'), 'text/plain');
    const page = await storage.list('studio/v1/');
    expect(page.keys).toEqual(['studio/v1/a.json']);
    expect(page.nextCursor).toBeUndefined();
  });
});

describe('factory privado: bucket explícito, sin fallback público', () => {
  test('sin R2_BUNDLES_BUCKET_NAME rechaza; NUNCA cae al bucket de medios', () => {
    const withoutPrivate = { ...ENV, bundlesBucket: undefined } as R2Env;
    expect(() => studioPrivateBucketOf(withoutPrivate)).toThrow(StudioPrivateBucketMissingError);
    expect(() => createPrivateStudioR2Storage(withoutPrivate, { client: new FakeS3() })).toThrow(StudioPrivateBucketMissingError);
    expect(() => studioPrivateBucketOf(withoutPrivate)).toThrow(/R2_BUNDLES_BUCKET_NAME/);
  });

  test('usa el bucket privado explícito aunque env.bucket sea el de medios', async () => {
    const { storage, fake } = makeStorage();
    expect(storage.bucket).toBe('video-maker-archive-prd');
    await storage.putImmutable('objects/ab/abcd', new TextEncoder().encode('x'), 'text/plain');
    const put = fake.sent.find((command) => command.name === PutObjectCommand.name)!;
    expect(put.input.Bucket).toBe('video-maker-archive-prd');
    expect(put.input.Bucket).not.toBe(ENV.bucket);
  });

  test('constructor sin env ni client ⇒ error explícito', () => {
    expect(() => new StudioR2Storage({ bucket: 'cualquiera' })).toThrow(/client or an R2 environment/);
  });
});
