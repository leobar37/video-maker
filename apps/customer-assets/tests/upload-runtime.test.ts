import { env } from 'cloudflare:workers';
import { expect, it, describe } from 'vitest';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import {
  createIncrementalSha256,
  detectMediaType,
  finalizeUpload,
  ingestStream,
  sha256Hex,
  stageUpload,
  type V1MediaType,
} from '../src/server/uploads';

// P-001 upload runtime proof against emulated R2 (Miniflare in workerd).
// Streams are synthetic and small except the explicitly sized 50 MiB video
// probe, which is generated lazily chunk-by-chunk (never materialized).

const STAGING_PREFIX = 'staging/';

function bytesOf(...parts: number[][]): Uint8Array {
  return new Uint8Array(parts.flat());
}

function chunkedStream(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

/** Lazily generated stream of `totalBytes` in `chunkSize` chunks (mp4 magic). */
function sizedStream(totalBytes: number, chunkSize: number): ReadableStream<Uint8Array> {
  let sent = 0;
  const header = bytesOf([0x00, 0x00, 0x00, 0x18], [...'ftyp'].map((c) => c.charCodeAt(0)), [
    ...'isom',
  ].map((c) => c.charCodeAt(0)));
  const block = new Uint8Array(chunkSize);
  block.set(header, 0);
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, totalBytes - sent);
      controller.enqueue(size === chunkSize ? block : block.slice(0, size));
      sent += size;
    },
  });
}

const JPEG = bytesOf(
  [0xff, 0xd8, 0xff, 0xe0],
  [...'jpegfixture'].map((c) => c.charCodeAt(0)),
);
const PNG = bytesOf(
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  [...'pngfixture'].map((c) => c.charCodeAt(0)),
);
const WEBP = bytesOf(
  [...'RIFF'].map((c) => c.charCodeAt(0)),
  [0x14, 0x00, 0x00, 0x00],
  [...'WEBP'].map((c) => c.charCodeAt(0)),
  [...'webpfixt'].map((c) => c.charCodeAt(0)),
);
const MP4 = bytesOf(
  [0x00, 0x00, 0x00, 0x18],
  [...'ftyp'].map((c) => c.charCodeAt(0)),
  [...'isom'].map((c) => c.charCodeAt(0)),
  [...'mp4fixture'].map((c) => c.charCodeAt(0)),
);
const NOT_MP4 = bytesOf([...'definitely not an mp4 file'].map((c) => c.charCodeAt(0)));

const MB = 1024 * 1024;
const BUCKET = () => env.ASSETS;

describe('magic signature detection', () => {
  it('accepts jpeg/png/webp/mp4 and rejects everything else (HEIC included)', () => {
    expect(detectMediaType(JPEG)).toBe<V1MediaType>('image/jpeg');
    expect(detectMediaType(PNG)).toBe<V1MediaType>('image/png');
    expect(detectMediaType(WEBP)).toBe<V1MediaType>('image/webp');
    expect(detectMediaType(MP4)).toBe<V1MediaType>('video/mp4');
    expect(detectMediaType(NOT_MP4)).toBeNull();
    // HEIC shares the ftyp box but is not a v1 format.
    const heic = bytesOf(
      [0x00, 0x00, 0x00, 0x18],
      [...'ftyp'].map((c) => c.charCodeAt(0)),
      [...'heic'].map((c) => c.charCodeAt(0)),
    );
    expect(detectMediaType(heic)).toBeNull();
  });

  it('incremental sha256 matches single-shot and the digest of the exact bytes', () => {
    const incremental = createIncrementalSha256();
    for (let i = 0; i < MP4.byteLength; i += 7) {
      incremental.update(MP4.subarray(i, i + 7));
    }
    expect(incremental.digestHex()).toBe(sha256Hex(MP4));
    expect(sha256Hex(MP4)).toBe(bytesToHex(nobleSha256(MP4)));
  });
});

describe('streaming ingest rejects before anything is committed', () => {
  it('rejects trailing/extra bytes beyond the declared count and writes no staging object', async () => {
    const stagingKey = `${STAGING_PREFIX}${crypto.randomUUID()}`;
    const outcome = await stageUpload(BUCKET(), {
      stream: chunkedStream(MP4, 1024),
      stagingKey,
      limits: { declaredBytes: MP4.byteLength - 5, maxBytes: 10 * MB },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.failure.reason === 'trailing_bytes') {
      expect(outcome.failure.declaredBytes).toBe(MP4.byteLength - 5);
      expect(outcome.failure.bytes).toBe(MP4.byteLength);
    } else {
      throw new Error(`expected trailing_bytes, got ${JSON.stringify(outcome)}`);
    }
    expect(await BUCKET().head(stagingKey)).toBeNull();
  });

  it('rejects bodies exceeding the hard cap even when the declaration lies', async () => {
    const stagingKey = `${STAGING_PREFIX}${crypto.randomUUID()}`;
    const outcome = await ingestStream(chunkedStream(MP4, 1024), {
      declaredBytes: 10 * MB,
      maxBytes: MP4.byteLength - 1,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.failure.reason === 'oversize') {
      expect(outcome.failure.limit).toBe(MP4.byteLength - 1);
    } else {
      throw new Error(`expected oversize, got ${JSON.stringify(outcome)}`);
    }
  });

  it('rejects wrong magic signatures before writing staging', async () => {
    const stagingKey = `${STAGING_PREFIX}${crypto.randomUUID()}`;
    const outcome = await stageUpload(BUCKET(), {
      stream: chunkedStream(NOT_MP4, 4),
      stagingKey,
      limits: { declaredBytes: NOT_MP4.byteLength, maxBytes: MB },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.failure.reason === 'invalid_signature') {
      // Fails as soon as the first full signature window (12 bytes) arrives.
      expect(outcome.failure.bytes).toBe(12);
    } else {
      throw new Error(`expected invalid_signature, got ${JSON.stringify(outcome)}`);
    }
    expect(await BUCKET().head(stagingKey)).toBeNull();
  });

  it('rejects short bodies (undershoot of the declared count) without commit', async () => {
    const stagingKey = `${STAGING_PREFIX}${crypto.randomUUID()}`;
    const outcome = await stageUpload(BUCKET(), {
      stream: chunkedStream(MP4.subarray(0, 10), 4),
      stagingKey,
      limits: { declaredBytes: MP4.byteLength, maxBytes: MB },
    });
    expect(outcome.ok).toBe(false);
    expect(await BUCKET().head(stagingKey)).toBeNull();
  });
});

describe('staging, finalization, and immutable write-once', () => {
  it('streams into staging with correct digest, then verifies and publishes once', async () => {
    const bucket = BUCKET();
    const stagingKey = `${STAGING_PREFIX}${crypto.randomUUID()}`;
    const finalKey = `materials/${sha256Hex(MP4)}`;
    expect(finalKey.startsWith(STAGING_PREFIX)).toBe(false);

    const outcome = await stageUpload(bucket, {
      stream: chunkedStream(MP4, 5),
      stagingKey,
      limits: { declaredBytes: MP4.byteLength, maxBytes: MB },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.stats.bytes).toBe(MP4.byteLength);
      expect(outcome.stats.sha256Hex).toBe(sha256Hex(MP4));
      expect(outcome.stats.mediaType).toBe<V1MediaType>('video/mp4');
    }

    // Staging exists; the final key is NOT reachable before finalization.
    expect((await bucket.head(stagingKey))?.size).toBe(MP4.byteLength);
    expect(await bucket.head(finalKey)).toBeNull();

    const finalized = await finalizeUpload(bucket, {
      stagingKey,
      finalKey,
      declared: { sha256Hex: sha256Hex(MP4), bytes: MP4.byteLength, mediaType: 'video/mp4' },
    });
    expect(finalized.ok).toBe(true);
    const strategy = finalized.ok ? finalized.writeOnceStrategy : null;
    expect(['conditional-copy', 'streaming-put-head-check']).toContain(strategy);

    // Final object is reachable with the exact declared bytes; immutable metadata.
    const stored = await bucket.get(finalKey);
    expect(stored).not.toBeNull();
    expect(stored!.size).toBe(MP4.byteLength);
    expect(stored!.httpMetadata?.contentType).toBe('video/mp4');
    const storedBytes = new Uint8Array(await stored!.arrayBuffer());
    expect(sha256Hex(storedBytes)).toBe(sha256Hex(MP4));

    // Rewrite attempt on the same final key is rejected and changes nothing.
    const rewrite = await finalizeUpload(bucket, {
      stagingKey,
      finalKey,
      declared: { sha256Hex: sha256Hex(MP4), bytes: MP4.byteLength, mediaType: 'video/mp4' },
    });
    expect(rewrite.ok).toBe(false);
    if (!rewrite.ok) expect(rewrite.failure.reason).toBe('final_conflict');
    const afterRewrite = await bucket.get(finalKey);
    const afterBytes = new Uint8Array(await afterRewrite!.arrayBuffer());
    expect(sha256Hex(afterBytes)).toBe(sha256Hex(MP4));
  });

  it('server-side verification rejects tampered staging before any final write', async () => {
    const bucket = BUCKET();
    const stagingKey = `${STAGING_PREFIX}${crypto.randomUUID()}`;
    // Stage one thing...
    const staged = await stageUpload(bucket, {
      stream: chunkedStream(PNG, 3),
      stagingKey,
      limits: { declaredBytes: PNG.byteLength, maxBytes: MB },
    });
    expect(staged.ok).toBe(true);

    // ...and claim another (wrong digest): finalize must refuse.
    const wrongHash = await finalizeUpload(bucket, {
      stagingKey,
      finalKey: `materials/${crypto.randomUUID()}`,
      declared: { sha256Hex: sha256Hex(JPEG), bytes: PNG.byteLength, mediaType: 'image/png' },
    });
    expect(wrongHash.ok).toBe(false);
    if (!wrongHash.ok) expect(wrongHash.failure.reason).toBe('hash_mismatch');

    // Wrong declared size also refuses (server verifies, never trusts).
    const wrongSize = await finalizeUpload(bucket, {
      stagingKey,
      finalKey: `materials/${crypto.randomUUID()}`,
      declared: { sha256Hex: sha256Hex(PNG), bytes: PNG.byteLength - 1, mediaType: 'image/png' },
    });
    expect(wrongSize.ok).toBe(false);
    if (!wrongSize.ok) expect(wrongSize.failure.reason).toBe('bytes_mismatch');
  });
});

describe('memory discipline on a simulated 50 MiB video', () => {
  it(
    'streams 50 MiB in bounded chunks: counters and hash match without full buffering',
    { timeout: 120_000 },
    async () => {
    const bucket = BUCKET();
    const total = 50 * MB;
    const chunkSize = 64 * 1024;

    // Independent expected digest: chunk-wise over the same generated pattern.
    const expected = nobleSha256.create();
    for (let sent = 0; sent < total; sent += chunkSize) {
      const size = Math.min(chunkSize, total - sent);
      const block = new Uint8Array(size);
      const header = bytesOf(
        [0x00, 0x00, 0x00, 0x18],
        [...'ftyp'].map((c) => c.charCodeAt(0)),
        [...'isom'].map((c) => c.charCodeAt(0)),
      );
      block.set(header, 0);
      expected.update(block);
    }
    const expectedHex = bytesToHex(expected.digest());

    const stagingKey = `${STAGING_PREFIX}${crypto.randomUUID()}`;
    const outcome = await stageUpload(bucket, {
      stream: sizedStream(total, chunkSize),
      stagingKey,
      limits: { declaredBytes: total, maxBytes: total },
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.stats.bytes).toBe(total);
      expect(outcome.stats.sha256Hex).toBe(expectedHex);
      expect(outcome.stats.mediaType).toBe<V1MediaType>('video/mp4');
      // The uploader only ever saw bounded chunks: proof it streamed instead
      // of buffering (largest single allocation equals the chunk size).
      expect(outcome.stats.maxChunkBytes).toBeLessThanOrEqual(chunkSize);
    }

    // Finalize is also streamed (verification pass + copy), never buffered.
    const finalKey = `materials/${expectedHex}`;
    const finalized = await finalizeUpload(bucket, {
      stagingKey,
      finalKey,
      declared: { sha256Hex: expectedHex, bytes: total, mediaType: 'video/mp4' },
    });
    expect(finalized.ok).toBe(true);
    const head = await bucket.head(finalKey);
    expect(head?.size).toBe(total);
  });
});

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
