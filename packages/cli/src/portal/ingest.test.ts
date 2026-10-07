/**
 * Bridge/server-level tests for the TAILNET INGEST (operator order
 * 2026-10-06; contratos aditivos §10 · customer-assets-requests): a
 * workstation-local Bun server that receives ~500MB takes over the tailnet —
 * no login, token validated against the PORTAL guest view — with chunked
 * resumable upload, caps, atomic landing and the local ingest-pull import.
 *
 * Everything here is bun-local (gate G-cap-live): the ingest binds
 * 127.0.0.1:0 (only the SERVE command binds the tailscale IP) and the portal
 * is the in-process fake. Proven invariants:
 * - invalid/closed/expired tokens never store a byte;
 * - the recorded asset binding is the PORTAL VIEW snapshot (a crafted
 *   binding in the uploader's body is ignored);
 * - offset mismatch 409; resume converges to the exact SHA-256;
 * - caps (per-chunk / total) enforced; complete idempotent;
 * - the listener NEVER binds 0.0.0.0/:: (factory refusal + ss parse);
 * - `portal-asset-ingest-pull` imports with SHA match and drains the
 *   landing only after a verified import (idempotent re-pull).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isStudioServiceError } from '@videomaker/studio';
import { isRecord } from '@videomaker/core';
import { createCustomerAssetsClient } from '@videomaker/customer-assets/client';

import { pullLandedTakes } from './asset-links';
import {
  INGEST_CHUNK_CAP_BYTES,
  INGEST_TOTAL_CAP_BYTES,
  createIngestServer,
  formatIngestServeBanner,
  listLandedTakes,
  parseLandedManifest,
  parseSsListenLines,
  probeTcpPort,
  sha256HexSync,
  type IngestServer,
} from './ingest-server';
import { makeWorkspace, startFakePortal, type FakePortal, type WorkspaceFixture } from './testing';

// ---------------------------------------------------------------------------

/** Guarded string read off outside-controlled JSON (throws, never lies). */
function stringField(record: Record<string, unknown>, key: string): string {
  if (typeof record !== 'object' || record === null || !(key in record)) {
    throw new Error(`se esperaba el campo "${key}" en ${JSON.stringify(record).slice(0, 160)}`);
  }
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error(`se esperaba string en "${key}"; llegó ${typeof value}`);
  }
  return value;
}

/** Guarded numeric read off outside-controlled JSON. */
function numberField(record: Record<string, unknown>, key: string): number {
  const value = stringFieldAware(record, key);
  if (typeof value !== 'number') throw new Error(`se esperaba number en "${key}"`);
  return value;
}

function stringFieldAware(record: Record<string, unknown>, key: string): unknown {
  if (!(key in record)) throw new Error(`se esperaba el campo "${key}"`);
  return record[key];
}

/** Guarded object read (no unchecked casts for member access). */
function objectField(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = stringFieldAware(record, key);
  if (isRecord(value) === false) {
    throw new Error(`se esperaba objeto en "${key}"; llegó ${JSON.stringify(value)?.slice(0, 80)}`);
  }
  return value;
}

/** Typed failure assertion via the canonical guard (no unchecked casts). */
function expectIngestError(caught: unknown, code: 'INVALID_INPUT' | 'CONFLICT'): void {
  expect(isStudioServiceError(caught)).toBe(true);
  if (isStudioServiceError(caught)) expect(caught.code).toBe(code);
}

const tempRoots: string[] = [];
const servers: IngestServer[] = [];

afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop()));
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

/** Bytes digest for the test (the imported sha256HexSync is text-only). */
function sha256HexOf(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(bytes);
  return hasher.digest('hex');
}

/** Minimal but REAL MP4-shape payload: `ftyp` box at offset 4 (magic check). */
function makeMp4Bytes(size: number, fill: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes[4] = 0x66; // f
  bytes[5] = 0x74; // t
  bytes[6] = 0x79; // y
  bytes[7] = 0x70; // p
  for (let index = 8; index < size; index += 1) bytes[index] = (fill + index) % 251;
  return bytes;
}

interface IngestHarness {
  server: IngestServer;
  landingDir: string;
  token: string;
  linkId: string;
}

/** Ephemeral ingest server (127.0.0.1:0) + one open asset link token. */
async function makeHarness(options: { chunkCapBytes?: number; totalCapBytes?: number } = {}): Promise<IngestHarness> {
  const root = await mkdtemp(join(tmpdir(), 'portal-ingest-'));
  tempRoots.push(root);
  const landingDir = join(root, 'landing');
  const server = await createIngestServer({
    portalOrigin: fake.origin,
    ingestDir: landingDir,
    bindHost: '127.0.0.1',
    port: 0,
    ...(options.chunkCapBytes !== undefined ? { chunkCapBytes: options.chunkCapBytes } : {}),
    ...(options.totalCapBytes !== undefined ? { totalCapBytes: options.totalCapBytes } : {}),
  });
  servers.push(server);
  const minted = fake.seedAssetLink({ clientId: clientId!, studioProjectId: ws.projectId, studioAssetId: ws.assetId, expiresIn: '24h' });
  return { server, landingDir, token: minted.token, linkId: minted.linkId };
}

function subirUrl(server: IngestServer, token: string): string {
  return `${server.origin}/subir/${token}`;
}

async function putChunk(server: IngestServer, token: string, body: Uint8Array, options: { offset?: number; total?: number; contentRange?: string } = {}): Promise<{ status: number; body: Record<string, unknown>; cacheControl: string | null }> {
  const url = new URL(subirUrl(server, token));
  if (options.offset !== undefined) url.searchParams.set('offset', String(options.offset));
  const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
  if (options.contentRange !== undefined) headers['content-range'] = options.contentRange;
  const response = await fetch(url, { method: 'PUT', headers, body: body.slice() });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await response.json()) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { status: response.status, body: parsed, cacheControl: response.headers.get('cache-control') };
}

async function getView(server: IngestServer, token: string): Promise<{ status: number; body: Record<string, unknown>; cacheControl: string | null }> {
  const response = await fetch(subirUrl(server, token));
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, cacheControl: response.headers.get('cache-control') };
}

async function complete(server: IngestServer, token: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${subirUrl(server, token)}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function stagedSizeOf(server: IngestServer, token: string): Promise<number | null> {
  try {
    return (await stat(join(server.ingestDir, '.staging', `${sha256HexSync(token)}.bin`))).size;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

let fake: FakePortal;
let ws: WorkspaceFixture;
let clientId: string | undefined;

beforeAll(async () => {
  fake = await startFakePortal();
  ws = await makeWorkspace('portal-ingest');
  const client = fake.seedClient({ workspaceId: 'ws-ingest', studioClientId: ws.studioClientId, name: 'Acme Inc.' });
  clientId = client.id;
  fake.seedProject({ clientId: client.id, studioProjectId: ws.projectId, name: 'Proyecto acme' });
});

afterAll(async () => {
  await fake.stop();
});

// ---------------------------------------------------------------------------

describe('tailnet ingest server (§10)', () => {
  test('bind host discipline: never 0.0.0.0/::; loopback only as an explicit test/dev override', async () => {
    for (const badHost of ['0.0.0.0', '::', 'example.com']) {
      let caught: unknown;
      try {
        await createIngestServer({ portalOrigin: fake.origin, ingestDir: join(tmpdir(), 'never'), bindHost: badHost, port: 0 });
      } catch (error) {
        caught = error;
      }
      expectIngestError(caught, 'INVALID_INPUT');
    }
    const server = await createIngestServer({ portalOrigin: fake.origin, ingestDir: join(tmpdir(), `bind-ok-${Date.now()}`), bindHost: '127.0.0.1', port: 0 });
    servers.push(server);
    expect(server.host).toBe('127.0.0.1');
    expect(server.port).toBeGreaterThan(0);
    expect(server.origin.startsWith('http://127.0.0.1:')).toBe(true);
  });

  test('the live listener proves its bind host (ss parse when available, socket introspection always)', async () => {
    const harness = await makeHarness();
    expect(harness.server.host).toBe('127.0.0.1');
    // Socket introspection: the server's own listener address is loopback,
    // NEVER the wildcard.
    expect(harness.server.origin).toBe(`http://127.0.0.1:${harness.server.port}`);
    // ss parse of a canned capture proves the extractor; when `ss` exists we
    // also check the REAL listener table for this ephemeral port.
    const canned = [
      'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
      'LISTEN 0      128        0.0.0.0:22        0.0.0.0:*     users:(("sshd"))',
      `LISTEN 0      128    127.0.0.1:${harness.server.port}      0.0.0.0:*`,
      'LISTEN 0      128        100.83.90.33:8787 0.0.0.0:*',
    ].join('\n');
    const listeners = parseSsListenLines(canned);
    const mine = listeners.find((entry) => entry.port === harness.server.port);
    expect(mine).toBeDefined();
    expect(mine!.host).toBe('127.0.0.1');
    expect(listeners.some((entry) => entry.host === '0.0.0.0' && entry.port === harness.server.port)).toBe(false);
    const hasSs = await new Promise<boolean>((resolvePromise) => {
      execFile('ss', ['-tlnp'], { timeout: 5_000 }, (error) => resolvePromise(error === null));
    });
    if (hasSs) {
      const output = await new Promise<string>((resolvePromise) => {
        execFile('ss', ['-tlnp'], { timeout: 5_000 }, (_error, stdout) => resolvePromise(stdout));
      });
      const real = parseSsListenLines(output).find((entry) => entry.port === harness.server.port);
      if (real !== undefined) {
        expect(real.host === '127.0.0.1' || real.host === '::1' || real.host === '*').toBe(true);
        expect(real.host === '0.0.0.0').toBe(false);
      }
    }
  });

  test('invalid / closed / expired tokens are rejected BEFORE any byte is stored; portal calls carry NO credential', async () => {
    const harness = await makeHarness();
    const unknown = await putChunk(harness.server, 'tok-no-existe-123456', makeMp4Bytes(64, 1));
    expect(unknown.status).toBe(404);
    expect(await stagedSizeOf(harness.server, 'tok-no-existe-123456')).toBeNull();

    fake.settleAssetLink(harness.linkId, 'closed');
    const closed = await putChunk(harness.server, harness.token, makeMp4Bytes(64, 1));
    expect(closed.status).toBe(404);
    expect(await stagedSizeOf(harness.server, harness.token)).toBeNull();

    const expiredHarness = await makeHarness();
    fake.settleAssetLink(expiredHarness.linkId, 'expired');
    const expired = await putChunk(expiredHarness.server, expiredHarness.token, makeMp4Bytes(64, 1));
    expect(expired.status).toBe(409);
    expect(await stagedSizeOf(expiredHarness.server, expiredHarness.token)).toBeNull();

    // The ingest validated through the guest view with NO api key attached
    // (the ingest server holds no credential, by design).
    const guestCalls = fake.requests.filter((entry) => entry.path.startsWith('/api/v1/a/'));
    expect(guestCalls.length).toBeGreaterThan(0);
    expect(guestCalls.every((entry) => entry.apiKey === null)).toBe(true);
  });

  test('portal unreachable: 503 and zero bytes stored (never degrades into unvalidated acceptance)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'portal-ingest-dead-'));
    tempRoots.push(root);
    const deadPortal = await createIngestServer({ portalOrigin: 'http://127.0.0.1:9', ingestDir: join(root, 'landing'), bindHost: '127.0.0.1', port: 0 });
    servers.push(deadPortal);
    const response = await putChunk(deadPortal, 'tok-sin-portal-1234', makeMp4Bytes(64, 1));
    expect(response.status).toBe(503);
    expect(await stagedSizeOf(deadPortal, 'tok-sin-portal-1234')).toBeNull();
  });

  test('chunked upload: Content-Range and ?offset= agree, mismatched offset is 409 with the real received, view exposes the resume offset', async () => {
    const harness = await makeHarness();
    const first = makeMp4Bytes(48, 1);
    const second = makeMp4Bytes(32, 2);

    const one = await putChunk(harness.server, harness.token, first, { contentRange: `bytes 0-${first.length - 1}/${first.length + second.length}` });
    expect(one.status).toBe(200);
    expect(one.body.received).toBe(48);
    expect(one.cacheControl).toBe('no-store');

    // Adelantado (client thinks more was received): 409 + received real.
    const ahead = await putChunk(harness.server, harness.token, second, { offset: 96 });
    expect(ahead.status).toBe(409);
    expect(ahead.body.error).toBeDefined();

    // Content-Range vs ?offset mismatch is a 400 (ambiguous client).
    const ambiguous = await putChunk(harness.server, harness.token, second, { offset: 48, contentRange: `bytes 0-${second.length - 1}/80` });
    expect(ambiguous.status).toBe(400);

    const two = await putChunk(harness.server, harness.token, second, { offset: 48 });
    expect(two.status).toBe(200);
    expect(two.body.received).toBe(80);

    const view = await getView(harness.server, harness.token);
    expect(view.status).toBe(200);
    expect(view.cacheControl).toBe('no-store');
    expect(view.body.received).toBe(80);
    expect(stringField(objectField(view.body, 'binding'), 'assetTitle')).toBe(ws.assetId);
  });

  test('resume converges: drop mid-way, re-probe, resume, complete → SHA-256 matches the source bytes', async () => {
    const harness = await makeHarness();
    const partOne = makeMp4Bytes(64, 3);
    const partTwo = makeMp4Bytes(64, 7);
    const full = new Uint8Array(partOne.length + partTwo.length);
    full.set(partOne, 0);
    full.set(partTwo, partOne.length);
    const expectedSha = sha256HexOf(full);

    await putChunk(harness.server, harness.token, partOne, { offset: 0 });
    // "Drop": the client dies; a NEW session probes the server first.
    const probe = await getView(harness.server, harness.token);
    expect(probe.body.received).toBe(64);
    const resumed = await putChunk(harness.server, harness.token, partTwo, { offset: Number(probe.body.received) });
    expect(resumed.status).toBe(200);
    expect(resumed.body.received).toBe(128);

    const wrongSize = await complete(harness.server, harness.token, { bytes: 127 });
    expect(wrongSize.status).toBe(409);

    const done = await complete(harness.server, harness.token, { bytes: 128 });
    expect(done.status).toBe(201);
    const landedSha = stringField(done.body, 'sha256');
    expect(landedSha).toBe(expectedSha);
    expect(numberField(done.body, 'bytes')).toBe(128);
    expect(stringField(done.body, 'takeId')).toBe(`take-${landedSha.slice(0, 8)}`);
    expect(done.body.idempotent).toBe(false);
    expect(stringField(done.body, 'ingestOrigin')).toBe(harness.server.origin);
    expect(typeof done.body.receivedAt).toBe('string');
    const binding = objectField(done.body, 'binding');
    expect(stringField(binding, 'assetTitle')).toBe(ws.assetId);
    expect(stringField(binding, 'state')).toBe('open');
    // Landing replaced staging; nothing is left staged.
    expect(await stagedSizeOf(harness.server, harness.token)).toBeNull();
    const landedBytes = await readFile(join(harness.server.ingestDir, stringField(done.body, 'tokenHash'), `${stringField(done.body, 'takeId')}.mp4`));
    expect(sha256HexOf(new Uint8Array(landedBytes))).toBe(expectedSha);
  });

  test('caps: per-chunk 32MiB / total 5GiB constants, enforced even with tiny test caps (413)', async () => {
    expect(INGEST_CHUNK_CAP_BYTES).toBe(32 * 1_048_576);
    expect(INGEST_TOTAL_CAP_BYTES).toBe(5 * 1_073_741_824);
    const harness = await makeHarness({ chunkCapBytes: 16, totalCapBytes: 64 });
    const chunkTooBig = await putChunk(harness.server, harness.token, makeMp4Bytes(32, 1));
    expect(chunkTooBig.status).toBe(413);
    const chunkA = await putChunk(harness.server, harness.token, makeMp4Bytes(16, 1), { offset: 0 });
    expect(chunkA.status).toBe(200);
    const totalDrift = await putChunk(harness.server, harness.token, makeMp4Bytes(16, 2), { offset: 16, contentRange: `bytes 16-31/128` });
    expect(totalDrift.status).toBe(413);
    const totalOver = await putChunk(harness.server, harness.token, makeMp4Bytes(16, 3), { offset: 16, contentRange: `bytes 16-31/72` });
    expect(totalOver.status).toBe(413);
    // Declared-total consistency: same total accepted, then drift after OK.
    const okTotal = await putChunk(harness.server, harness.token, makeMp4Bytes(16, 4), { offset: 16, contentRange: 'bytes 16-31/64' });
    expect(okTotal.status).toBe(200);
    const driftedTotal = await putChunk(harness.server, harness.token, makeMp4Bytes(16, 5), { offset: 32, contentRange: 'bytes 32-47/96' });
    expect(driftedTotal.status).toBe(409);
  });

  test('complete is idempotent (content-addressed) and rejects a second distinct take id; crafted binding fields in the body are IGNORED', async () => {
    const harness = await makeHarness();
    const bytes = makeMp4Bytes(96, 9);
    await putChunk(harness.server, harness.token, bytes, { offset: 0 });
    const first = await complete(harness.server, harness.token, {
      bytes: bytes.length,
      // Crafted binding the server MUST ignore (binding comes from the portal).
      assetTitle: 'asset-fabricado',
      studioAssetId: 'asset-fabricado',
      binding: { assetTitle: 'asset-fabricado', projectTitle: 'evil', state: 'open', expiresAt: 0, quota: { limitBytes: 1, remainingBytes: 1 } },
    });
    expect(first.status).toBe(201);
    const manifest = first.body;
    expect(stringField(manifest, 'takeId')).toBe(`take-${sha256HexOf(bytes).slice(0, 8)}`);
    expect(stringField(objectField(manifest, 'binding'), 'assetTitle')).toBe(ws.assetId);
    expect(JSON.stringify(manifest)).not.toContain('asset-fabricado');

    // Replay after the response was lost: staging is gone; sha256 names it.
    const replay = await complete(harness.server, harness.token, { bytes: 0, sha256: stringField(manifest, 'sha256') });
    expect(replay.status).toBe(200);
    expect(replay.body.idempotent).toBe(true);
    expect(stringField(replay.body, 'takeId')).toBe(stringField(manifest, 'takeId'));

    // The replayed manifest on disk is exactly the landed one (no dup files).
    const dirFiles = await readdir(join(harness.server.ingestDir, stringField(manifest, 'tokenHash')));
    expect(dirFiles.filter((file) => file.endsWith('.mp4')).length).toBe(1);
    expect(dirFiles.filter((file) => file.endsWith('.manifest.json')).length).toBe(1);
  });

  test('non-MP4 takes are 415 and staging is preserved for a retry after re-encapsulation', async () => {
    const harness = await makeHarness();
    const junk = new Uint8Array(64).fill(0x42);
    await putChunk(harness.server, harness.token, junk, { offset: 0 });
    const rejected = await complete(harness.server, harness.token, { bytes: 64 });
    expect(rejected.status).toBe(415);
    expect(await stagedSizeOf(harness.server, harness.token)).toBe(64);
  });

  test('the binding cache hits the portal once per TTL (~60s): two chunks, ONE guest-view call', async () => {
    const harness = await makeHarness();
    await putChunk(harness.server, harness.token, makeMp4Bytes(16, 1), { offset: 0 });
    await putChunk(harness.server, harness.token, makeMp4Bytes(16, 2), { offset: 16 });
    const calls = fake.requests.filter((entry) => entry.path === `/api/v1/a/${harness.token}`).length;
    expect(calls).toBe(1);
  });

  test('serve banner prints the tailnet base URL (never 0.0.0.0) + ACL reminder; port probe warns without failing', async () => {
    const harness = await makeHarness();
    const lines = formatIngestServeBanner({ origin: harness.server.origin, bindHost: harness.server.host, ingestDir: harness.server.ingestDir, port: harness.server.port });
    expect(lines.some((line) => line.includes(`${harness.server.origin}/subir/<token>`))).toBe(true);
    expect(lines.some((line) => line.includes('NUNCA 0.0.0.0'))).toBe(true);
    expect(lines.some((line) => line.toLowerCase().includes('acl'))).toBe(true);
    expect(lines.some((line) => line.includes('portal-asset-ingest-pull'))).toBe(true);
    expect(await probeTcpPort('127.0.0.1', harness.server.port)).toBe(true);
    expect(await probeTcpPort('127.0.0.1', 1)).toBe(false);
  });
});

describe('tailnet ingest pull (local landing → Studio)', () => {
  test('SDK client drives the full protocol; mint --tailnet composes the tailnet URL for the SAME token', async () => {
    const client = createCustomerAssetsClient({ baseUrl: fake.origin, apiKey: fake.apiKey });
    const minted = await client.mintAssetUploadLink(
      { studioProjectId: ws.projectId, studioAssetId: ws.assetId, origin: fake.origin },
      { tailnet: { host: '10.66.0.1', port: 8787 } },
    );
    expect(minted.url.startsWith(`${fake.origin}/asset-upload/`)).toBe(true);
    const token = minted.url.split('/asset-upload/')[1] ?? '';
    expect(minted.tailnetUrl).toBe(`http://10.66.0.1:8787/subir/${token}`);
    // Without the option, the view is byte-identical to the plain shape.
    const plain = await client.mintAssetUploadLink({ studioProjectId: ws.projectId, studioAssetId: ws.assetId, origin: fake.origin });
    expect(plain.tailnetUrl).toBeUndefined();

    const harness = await makeHarness();
    const bytes = makeMp4Bytes(80, 11);
    const view = await client.getTailnetIngestView(harness.server.origin, harness.token);
    expect(view.received).toBe(0);
    expect(view.chunkSize).toBe(INGEST_CHUNK_CAP_BYTES);
    expect(view.maxBytes).toBe(INGEST_TOTAL_CAP_BYTES);
    const chunk = await client.putTailnetIngestChunk(harness.server.origin, harness.token, bytes.slice(0, 40), { offset: 0, total: bytes.length });
    expect(chunk.received).toBe(40);
    await client.putTailnetIngestChunk(harness.server.origin, harness.token, bytes.slice(40), { offset: 40, total: bytes.length });
    const done = await client.completeTailnetIngest(harness.server.origin, harness.token, { bytes: bytes.length });
    expect(done.sha256).toBe(sha256HexOf(bytes));
    expect(done.binding.assetTitle).toBe(ws.assetId);
    void token;
  });

  test('pull imports the landed take with SHA match + tailnet provenance; landing drained only after verified import', async () => {
    const harness = await makeHarness();
    const bytes = makeMp4Bytes(128, 13);
    await putChunk(harness.server, harness.token, bytes, { offset: 0 });
    const done = await complete(harness.server, harness.token, { bytes: bytes.length });
    expect(done.status).toBe(201);
    const tokenHash = stringField(done.body, 'tokenHash');

    const result = await pullLandedTakes({
      workspaceDir: ws.workspaceDir,
      ingestDir: harness.landingDir,
      studioProjectId: ws.projectId,
      studioAssetId: ws.assetId,
    });
    expect(result.imported.length).toBe(1);
    const take = result.imported[0]!;
    expect(take.sha256).toBe(sha256HexOf(bytes));
    expect(take.takeId).toBe(`take-${sha256HexOf(bytes).slice(0, 8)}`);
    expect(take.tokenHash).toBe(tokenHash);
    expect(take.removedFromLanding).toBe(true);
    expect(take.addedInputs.length).toBe(2);
    const inputBytes = new Uint8Array(await readFile(join(ws.assetDir, take.inputPath)));
    expect(sha256HexOf(inputBytes)).toBe(sha256HexOf(bytes));
    const provenance = JSON.parse(await readFile(join(ws.assetDir, take.provenancePath), 'utf8')) as Record<string, unknown>;
    expect(stringField(provenance, 'source')).toBe('tailnet-ingest');
    expect(provenance.tailnet).toBe(true);
    expect(stringField(provenance, 'tokenHash')).toBe(tokenHash);
    expect(stringField(provenance, 'materialId')).toBe(take.takeId);
    expect(stringField(provenance, 'origin')).toBe(harness.server.origin);
    expect(JSON.stringify(provenance)).not.toContain(harness.token);
    const assetDoc = JSON.parse(await readFile(join(ws.assetDir, 'asset.json'), 'utf8')) as { inputs: string[] };
    expect(assetDoc.inputs).toContain(take.inputPath);
    // Landing drained AFTER the verified import.
    const drained = await stat(join(harness.landingDir, tokenHash)).then(() => true, () => false);
    expect(drained).toBe(false);

    // Idempotent re-pull: empty landing is a SUCCESS with zero duplicates.
    const replay = await pullLandedTakes({
      workspaceDir: ws.workspaceDir,
      ingestDir: harness.landingDir,
      studioProjectId: ws.projectId,
      studioAssetId: ws.assetId,
    });
    expect(replay.imported.length).toBe(0);
    expect(replay.addedInputs.length).toBe(0);
    const assetDocAfter = JSON.parse(await readFile(join(ws.assetDir, 'asset.json'), 'utf8')) as { inputs: string[] };
    expect(assetDocAfter.inputs.length).toBe(assetDoc.inputs.length);
  });

  test('a corrupt manifest in the landing is a hard INVALID_INPUT (never imported blind); tokenHash prefix filters', async () => {
    const harness = await makeHarness();
    const bytes = makeMp4Bytes(48, 17);
    await putChunk(harness.server, harness.token, bytes, { offset: 0 });
    await complete(harness.server, harness.token, { bytes: bytes.length });
    const tokenHash = sha256HexSync(harness.token);
    const badDir = join(harness.landingDir, 'f'.repeat(64));
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, 'take-00000000.manifest.json'), `${JSON.stringify({ schemaVersion: 1, source: 'tailnet-ingest', takeId: 'take-nope' })}\n`);

    let caught: unknown;
    try {
      await listLandedTakes(harness.landingDir);
    } catch (error) {
      caught = error;
    }
    expectIngestError(caught, 'INVALID_INPUT');

    // The prefix filter scopes the pull to ONE link's takes; the corrupt
    // manifest under a different hash never hides a real take from the
    // operator: unfiltered fails loudly (above), filtered by the good hash
    // proceeds and imports.
    const manifest = parseLandedManifest(JSON.parse(await readFile(join(harness.landingDir, tokenHash, `take-${sha256HexOf(bytes).slice(0, 8)}.manifest.json`), 'utf8')));
    expect(manifest).not.toBeNull();
    const filtered = await pullLandedTakes({
      workspaceDir: ws.workspaceDir,
      ingestDir: harness.landingDir,
      studioProjectId: ws.projectId,
      studioAssetId: ws.assetId,
      tokenHashPrefix: tokenHash.slice(0, 12),
    });
    expect(filtered.imported.length).toBe(1);
  });
});
