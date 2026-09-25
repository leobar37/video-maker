/**
 * R2 object store + bucket admin: checksum verification, objectExists
 * semantics, plan-mode refusal and the public-host coherence guard.
 * No network: the S3 seam and fetch are fakes.
 */
import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';

import type { R2Env } from '@videomaker/credentials';

import type { ProviderContext } from '../ports';
import { PlanModeError } from './context';
import {
  ChecksumMismatchError,
  ObjectNotFoundError,
  R2BucketAdmin,
  R2ObjectStore,
} from './r2-store';

const ENV: R2Env = {
  accountId: 'testaccount',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  bucket: 'assets-bucket',
  endpoint: 'https://testaccount.r2.cloudflarestorage.com',
  publicUrl: 'https://cdn.example.com',
};

function sha256(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

interface FakeObject {
  body: Uint8Array;
  contentType?: string;
  metadata?: Record<string, string>;
  etag: string;
}

/** In-memory S3 seam: identifies commands by constructor name + input. */
class FakeS3 {
  objects = new Map<string, FakeObject>();
  calls: string[] = [];
  listKeys: string[] | undefined;

  send = async (command: unknown): Promise<unknown> => {
    const cmd = command as {
      constructor: { name: string };
      input: Record<string, unknown>;
    };
    this.calls.push(cmd.constructor.name);
    const key = String(cmd.input.Key ?? '');
    switch (cmd.constructor.name) {
      case 'PutObjectCommand': {
        const body = cmd.input.Body as Uint8Array;
        const metadata = (cmd.input.Metadata ?? {}) as Record<string, string>;
        const stored: FakeObject = {
          body,
          contentType: cmd.input.ContentType as string | undefined,
          metadata,
          etag: `"etag-${this.objects.size}"`,
        };
        this.objects.set(key, stored);
        return { ETag: stored.etag };
      }
      case 'HeadObjectCommand': {
        const obj = this.objects.get(key);
        if (!obj) throw Object.assign(new Error('missing'), { name: 'NotFound' });
        return {
          ContentLength: obj.body.byteLength,
          ETag: obj.etag,
          ContentType: obj.contentType,
          Metadata: obj.metadata,
        };
      }
      case 'GetObjectCommand': {
        const obj = this.objects.get(key);
        if (!obj) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        return {
          Body: obj.body,
          ETag: obj.etag,
          ContentType: obj.contentType,
          Metadata: obj.metadata,
        };
      }
      case 'ListObjectsV2Command': {
        const keys = this.listKeys ?? [...this.objects.keys()].slice(0, 1);
        return { Contents: keys.map((k) => ({ Key: k })) };
      }
      default:
        throw new Error(`unexpected command ${cmd.constructor.name}`);
    }
  };
}

interface FetchCall {
  url: string;
  method: string;
}

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function ctxOf(
  mode: 'plan' | 'run',
  fetchImpl: FetchStub = () => {
    throw new Error('fetch must not be called');
  },
): { ctx: ProviderContext; fetchCalls: FetchCall[]; secretReads: string[] } {
  const fetchCalls: FetchCall[] = [];
  const secretReads: string[] = [];
  const ctx: ProviderContext = {
    mode,
    secrets: {
      getSecret: async (name: string) => {
        secretReads.push(name);
        throw new Error('secrets must not be read');
      },
    },
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), method: init?.method ?? 'GET' });
      return fetchImpl(input, init);
    }) as typeof fetch,
    clock: { now: () => new Date('2026-09-24T12:00:00.000Z') },
  };
  return { ctx, fetchCalls, secretReads };
}

function response(status: number): Response {
  return new Response('', { status });
}

describe('R2ObjectStore', () => {
  it('put records the sha256 metadata; inspect verifies the stored bytes', async () => {
    const fake = new FakeS3();
    const store = new R2ObjectStore(ENV, { client: fake });
    const { ctx } = ctxOf('run');
    const body = new TextEncoder().encode('snapshot bytes');

    const putMeta = await store.put('marketing/a.mp4', body, { contentType: 'video/mp4' }, ctx);
    expect(putMeta.sha256).toBe(sha256(body));
    expect(putMeta.publicUrl).toBe('https://cdn.example.com/marketing/a.mp4');

    const meta = await store.inspect('marketing/a.mp4', ctx);
    expect(meta.sha256).toBe(sha256(body));
    expect(meta.bytes).toBe(body.byteLength);
  });

  it('inspect detects a checksum mismatch (stored bytes ≠ recorded sha256)', async () => {
    const fake = new FakeS3();
    const store = new R2ObjectStore(ENV, { client: fake });
    const { ctx } = ctxOf('run');
    await store.put('marketing/a.mp4', new TextEncoder().encode('approved'), {}, ctx);

    // Corruption after upload: metadata still claims the approved checksum.
    fake.objects.get('marketing/a.mp4')!.body = new TextEncoder().encode('tampered');

    await expect(store.inspect('marketing/a.mp4', ctx)).rejects.toThrow(ChecksumMismatchError);
  });

  it('inspect/get on a missing object throw ObjectNotFoundError', async () => {
    const store = new R2ObjectStore(ENV, { client: new FakeS3() });
    const { ctx } = ctxOf('run');
    await expect(store.inspect('missing.mp4', ctx)).rejects.toThrow(ObjectNotFoundError);
    await expect(store.get('missing.mp4', ctx)).rejects.toThrow(ObjectNotFoundError);
  });

  it('objectExists: true on hit, false on 404 (errors propagate)', async () => {
    const fake = new FakeS3();
    const store = new R2ObjectStore(ENV, { client: fake });
    const { ctx } = ctxOf('run');
    await store.put('present.txt', new TextEncoder().encode('x'), {}, ctx);
    expect(await store.objectExists('present.txt', ctx)).toBe(true);
    expect(await store.objectExists('absent.txt', ctx)).toBe(false);
  });

  it('plan mode refuses every operation with zero S3 sends and zero secret reads', async () => {
    const fake = new FakeS3();
    const store = new R2ObjectStore(ENV, { client: fake });
    const { ctx, secretReads } = ctxOf('plan');
    const body = new TextEncoder().encode('x');

    await expect(store.head('k', ctx)).rejects.toThrow(PlanModeError);
    await expect(store.put('k', body, {}, ctx)).rejects.toThrow(PlanModeError);
    await expect(store.get('k', ctx)).rejects.toThrow(PlanModeError);
    await expect(store.inspect('k', ctx)).rejects.toThrow(PlanModeError);
    await expect(store.objectExists('k', ctx)).rejects.toThrow(PlanModeError);
    expect(fake.calls).toHaveLength(0);
    expect(secretReads).toHaveLength(0);
  });
});

describe('R2BucketAdmin.verifyPublicUrlCoherence', () => {
  it('catches a bucket/URL mismatch (static pair check, also in plan mode)', async () => {
    const admin = new R2BucketAdmin(ENV, { client: new FakeS3() });
    const plan = ctxOf('plan');
    const run = ctxOf('run');

    const wrongUrl = await admin.verifyPublicUrlCoherence(
      ENV.bucket,
      'https://other.example.com',
      plan.ctx,
    );
    expect(wrongUrl.ok).toBe(false);
    expect(wrongUrl.detail).toContain('mismatch');

    const wrongBucket = await admin.verifyPublicUrlCoherence(
      'other-bucket',
      ENV.publicUrl,
      run.ctx,
    );
    expect(wrongBucket.ok).toBe(false);
    expect(wrongBucket.detail).toContain('mismatch');
    expect(plan.fetchCalls).toHaveLength(0);
  });

  it('rejects a non-http(s) or query-carrying public URL', async () => {
    const admin = new R2BucketAdmin(ENV, { client: new FakeS3() });
    const { ctx } = ctxOf('run');
    expect((await admin.verifyPublicUrlCoherence(ENV.bucket, 'no-es-url', ctx)).ok).toBe(false);
    expect(
      (await admin.verifyPublicUrlCoherence(ENV.bucket, 'ftp://cdn.example.com', ctx)).ok,
    ).toBe(false);
    expect(
      (await admin.verifyPublicUrlCoherence(ENV.bucket, 'https://cdn.example.com/?x=1', ctx)).ok,
    ).toBe(false);
  });

  it('live probe: object in the bucket must answer 200 on the public URL', async () => {
    const fake = new FakeS3();
    const admin = new R2BucketAdmin(ENV, { client: fake });
    await new R2ObjectStore(ENV, { client: fake }).put(
      'marketing/a.mp4',
      new TextEncoder().encode('x'),
      {},
      ctxOf('run').ctx,
    );

    const bad = ctxOf('run', () => Promise.resolve(response(404)));
    const result = await admin.verifyPublicUrlCoherence(ENV.bucket, ENV.publicUrl, bad.ctx);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('404');
    expect(bad.fetchCalls).toEqual([
      { url: 'https://cdn.example.com/marketing/a.mp4', method: 'HEAD' },
    ]);

    const good = ctxOf('run', () => Promise.resolve(response(200)));
    expect(
      (await admin.verifyPublicUrlCoherence(ENV.bucket, `${ENV.publicUrl}/`, good.ctx)).ok,
    ).toBe(true);
  });

  it('plan mode answers from the pair alone (zero fetch) and run mode probes an empty bucket safely', async () => {
    const admin = new R2BucketAdmin(ENV, { client: new FakeS3() });
    const plan = ctxOf('plan');
    const planResult = await admin.verifyPublicUrlCoherence(ENV.bucket, ENV.publicUrl, plan.ctx);
    expect(planResult.ok).toBe(true);
    expect(planResult.detail).toContain('plan mode');
    expect(plan.fetchCalls).toHaveLength(0);

    const run = ctxOf('run');
    const runResult = await admin.verifyPublicUrlCoherence(ENV.bucket, ENV.publicUrl, run.ctx);
    expect(runResult.ok).toBe(true);
    expect(run.fetchCalls).toHaveLength(0);
  });
});
