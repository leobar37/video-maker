/**
 * Tailnet ingest server (operator order 2026-10-06; contratos aditivos §10 ·
 * customer-assets-requests): large-file takes (~500MB) over the Tailscale
 * tailnet, chunked and resumable, bound to the link's asset — NO app login.
 *
 * Trust model (operator-confirmed): the tailnet is an already-authenticated
 * network (WireGuard device identity), so the listener binds the Tailscale
 * IPv4 ONLY — never 0.0.0.0/:: (no LAN exposure) and never loopback in the
 * serve command (tests bind 127.0.0.1 explicitly). The capability token still
 * scopes every byte to its asset (defense in depth): every request resolves
 * the token through the PORTAL guest view `GET {portalOrigin}/api/v1/a/:token`
 * (short timeout; 200 + `state: 'open'` + unexpired required; the binding is
 * cached ~60s). A binding sent by the uploader is ALWAYS ignored — the only
 * recorded binding is the portal view snapshot. Bytes NEVER traverse
 * Cloudflare and never reach the portal: landed files are NOT portal
 * materials; they enter Studio via `portal-asset-ingest-pull`.
 *
 * Protocol (all responses `no-store`; errors use the portal envelope):
 * - `GET  /subir/:token` → binding + caps + staged offset (resume probe).
 * - `PUT  /subir/:token` → one chunk (`Content-Range: bytes s-e/total` or
 *   `?offset=`); appends to the per-token staging file; answers the received
 *   offset; offset mismatch is 409; caps: 32MiB/chunk, 5GiB/take.
 * - `POST /subir/:token/complete` `{bytes, sha256?}` → verifies the assembled
 *   size, computes SHA-256 (streamed), requires MP4 (`ftyp`) and lands
 *   `.tmp/portal-ingest/<tokenHash>/<takeId>.mp4` + `.manifest.json`
 *   atomically (rename). Complete is idempotent: replaying with the same
 *   `sha256` returns the landed manifest (`idempotent: true`) and removes
 *   leftover staging.
 */
import { mkdir, open, readFile, rename, rm, stat, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import net from 'node:net';
import { join, resolve } from 'node:path';

import { StudioServiceError } from '@videomaker/studio';
import { isRecord } from '@videomaker/core';
import type { TailnetIngestBinding, TailnetIngestChunkResult, TailnetIngestCompleteResult, TailnetIngestManifest, TailnetIngestView } from '@videomaker/customer-assets';

/* ---------------------------------------------------------------------------
 * Protocol constants (single source of truth for server, CLI and docs)
 * ------------------------------------------------------------------------- */

/** Default listen port; serve refuses (CONFLICT) when it is already taken. */
export const INGEST_DEFAULT_PORT = 8787;
/** Max bytes accepted per PUT chunk (413 above). */
export const INGEST_CHUNK_CAP_BYTES = 32 * 1_048_576;
/** Max assembled bytes per take (413 above). */
export const INGEST_TOTAL_CAP_BYTES = 5 * 1_073_741_824;
/** Portal binding cache TTL: at most ~60s of open-state staleness. */
export const INGEST_BINDING_TTL_MS = 60_000;
/** Short timeout for the portal guest-view validation call. */
export const INGEST_VALIDATE_TIMEOUT_MS = 4_000;
/** Landing dir (relative to the serve cwd); gitignored; NOT portal materials. */
export const INGEST_DEFAULT_DIR = '.tmp/portal-ingest';

const HEX_64 = /^[0-9a-f]{64}$/;
const SHA_8 = /^take-[0-9a-f]{8}$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function fail(code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'PATH_UNSAFE', message: string, details?: Record<string, unknown>): never {
  throw new StudioServiceError(code, message, details);
}

/** Sync digest (Bun runtime): token → staged/landing path keys. */
export function sha256HexSync(text: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(text);
  return hasher.digest('hex');
}

/** True for a plausible tailscale/loopback IPv4 host; false for 0.0.0.0/:: */
export function isBindableIpv4(host: string): boolean {
  const match = IPV4.exec(host);
  if (match === null) return false;
  return match.slice(1).every((octet) => Number.parseInt(octet, 10) <= 255);
}

/** `http(s)` origin check (no path) for portal origin + manifest ingestOrigin. */
function isValidHttpOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------------
 * Landed-take manifest: validation + scan (shared with the ingest pull)
 * ------------------------------------------------------------------------- */

/** Link-state domain as a static lookup table (§10 manifest validation). */
const LINK_STATE_DOMAIN: Record<string, true> = {
  open: true,
  used: true,
  closed: true,
  expired: true,
};

/** Reads a string field with an explicit runtime guard. */
function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Validates an unknown landed manifest against the §10 shape. Returns null
 * (never throws) so the pull can name the offending file in its own error.
 */
export function parseLandedManifest(value: unknown): TailnetIngestManifest | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== 1 || value.source !== 'tailnet-ingest') return null;
  const takeId = stringField(value, 'takeId');
  const tokenHash = stringField(value, 'tokenHash');
  const sha256 = stringField(value, 'sha256');
  const receivedAt = stringField(value, 'receivedAt');
  const ingestOrigin = stringField(value, 'ingestOrigin');
  const bytes = numberField(value, 'bytes');
  if (takeId === null || SHA_8.test(takeId) === false) return null;
  if (tokenHash === null || HEX_64.test(tokenHash) === false) return null;
  if (sha256 === null || HEX_64.test(sha256) === false) return null;
  if (receivedAt === null || Number.isNaN(Date.parse(receivedAt))) return null;
  if (ingestOrigin === null || isValidHttpOrigin(ingestOrigin) === false) return null;
  if (bytes === null || !Number.isInteger(bytes) || bytes <= 0) return null;
  if (value.mediaType !== 'video/mp4') return null;
  const binding = value.binding;
  if (!isRecord(binding)) return null;
  const assetTitle = stringField(binding, 'assetTitle');
  const projectTitle = stringField(binding, 'projectTitle');
  const state = stringField(binding, 'state');
  const expiresAt = numberField(binding, 'expiresAt');
  const quota = binding.quota;
  if (assetTitle === null || projectTitle === null) return null;
  if (state === null || LINK_STATE_DOMAIN[state] !== true) return null;
  if (expiresAt === null || !Number.isInteger(expiresAt)) return null;
  if (!isRecord(quota)) return null;
  const limitBytes = numberField(quota, 'limitBytes');
  const remainingBytes = numberField(quota, 'remainingBytes');
  if (limitBytes === null || remainingBytes === null) return null;
  return {
    schemaVersion: 1,
    source: 'tailnet-ingest',
    takeId,
    tokenHash,
    binding: {
      assetTitle,
      projectTitle,
      state: state as TailnetIngestBinding['state'],
      expiresAt,
      quota: { limitBytes, remainingBytes },
    },
    sha256,
    bytes,
    mediaType: 'video/mp4',
    receivedAt,
    ingestOrigin,
  };
}

/** One landed take on disk: validated manifest + sibling bytes path. */
export interface LandedTake {
  tokenHash: string;
  /** Absolute directory holding the take (`.tmp/portal-ingest/<tokenHash>`). */
  dir: string;
  manifestPath: string;
  bytesPath: string;
  manifest: TailnetIngestManifest;
}

/**
 * Scans the landing dir for takes. Only `<64-hex>/<take-*.manifest.json>`
 * entries are considered (the hash-named layout is server-owned); a manifest
 * that fails validation is a hard INVALID_INPUT (loud, never silently
 * skipped). `tokenPrefix` filters by tokenHash prefix.
 */
export async function listLandedTakes(ingestDir: string, options: { tokenPrefix?: string } = {}): Promise<LandedTake[]> {
  const root = resolve(ingestDir);
  let tokenDirs: string[];
  try {
    tokenDirs = await readdir(root, { withFileTypes: true }).then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  } catch {
    return [];
  }
  const prefix = options.tokenPrefix ?? '';
  if (prefix.length > 0 && HEX_64.test(prefix) === false && prefix.length < 8) {
    fail('INVALID_INPUT', '--token espera un prefijo del tokenHash (mínimo 8 caracteres hex).', { tokenPrefix: prefix });
  }
  const takes: LandedTake[] = [];
  for (const tokenHash of tokenDirs) {
    if (HEX_64.test(tokenHash) === false) continue;
    if (prefix.length > 0 && tokenHash.startsWith(prefix) === false) continue;
    const dir = join(root, tokenHash);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.endsWith('.manifest.json') === false) continue;
      const manifestPath = join(dir, file);
      let parsed: TailnetIngestManifest | null = null;
      try {
        parsed = parseLandedManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
      } catch {
        parsed = null;
      }
      if (parsed === null) {
        fail('INVALID_INPUT', 'El manifest de una toma landed no cumple el contrato §10; corregilo o borralo (nunca se importa a ciegas).', { path: manifestPath });
      }
      const bytesPath = join(dir, `${parsed.takeId}.mp4`);
      const kind = await stat(bytesPath).then((info) => info.isFile(), () => null);
      if (kind === null) {
        fail('INVALID_INPUT', 'El manifest de una toma landed no tiene sus bytes al lado; par parcial nunca se importa.', { path: bytesPath });
      }
      if (parsed.tokenHash !== tokenHash) {
        fail('INVALID_INPUT', 'El tokenHash del manifest no coincide con el directorio landing.', { path: manifestPath });
      }
      takes.push({ tokenHash, dir, manifestPath, bytesPath, manifest: parsed });
    }
  }
  takes.sort((a, b) => (a.manifest.receivedAt < b.manifest.receivedAt ? -1 : a.manifest.receivedAt > b.manifest.receivedAt ? 1 : a.manifest.takeId < b.manifest.takeId ? -1 : 1));
  return takes;
}

/* ---------------------------------------------------------------------------
 * Tailscale discovery (serve/mint); injectable for hermetic tests
 * ------------------------------------------------------------------------- */

function isTruthyIPv4(value: string): boolean {
  return isBindableIpv4(value) && value !== '0.0.0.0';
}

/** Default resolver: `tailscale ip -4` (first IPv4), validated. */
async function defaultTailscaleIpv4(): Promise<string> {
  const output = await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile('tailscale', ['ip', '-4'], { timeout: 5_000 }, (error, stdout) => {
      if (error !== null) rejectPromise(error);
      else resolvePromise(stdout);
    });
  });
  const ip = output.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? '';
  if (isTruthyIPv4(ip) === false) {
    fail('INVALID_INPUT', '`tailscale ip -4` no devolvió una IPv4 utilizable; ¿está corriendo tailscale en esta máquina?', { salida: ip.slice(0, 64) });
  }
  return ip;
}

let tailscaleIpv4Resolver: () => Promise<string> = defaultTailscaleIpv4;

/** TEST SEAM: swaps the tailscale resolver (pass null to restore). */
export function setTailscaleIpv4ResolverForTests(resolver: (() => Promise<string>) | null): void {
  tailscaleIpv4Resolver = resolver ?? defaultTailscaleIpv4;
}

/** Resolves the tailscale IPv4 this machine advertises (never 0.0.0.0). */
export function resolveTailscaleIpv4(): Promise<string> {
  return tailscaleIpv4Resolver();
}

/** Best-effort TCP probe (mint --tailnet warns when the port is not up). */
export async function probeTcpPort(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const socket = net.connect({ host, port });
    const settle = (result: boolean): void => {
      socket.destroy();
      resolvePromise(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/**
 * Parses `ss -tlnp` output into listen addresses (`<host>:<port>`), used to
 * PROVE the ingest listener never binds 0.0.0.0/::.
 */
export function parseSsListenLines(output: string): Array<{ host: string; port: number }> {
  const listeners: Array<{ host: string; port: number }> = [];
  for (const line of output.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] !== 'LISTEN' || parts.length < 4) continue;
    const local = parts[3]!;
    const separator = local.lastIndexOf(':');
    if (separator <= 0) continue;
    const host = local.slice(0, separator);
    const port = Number.parseInt(local.slice(separator + 1), 10);
    if (Number.isInteger(port)) listeners.push({ host: host.replace(/^\[|\]$/g, ''), port });
  }
  return listeners;
}

/* ---------------------------------------------------------------------------
 * The server
 * ------------------------------------------------------------------------- */

export interface IngestServerOptions {
  /** Portal origin used ONLY for guest-view token validation. */
  portalOrigin: string;
  /** Landing root (absolute or relative to cwd; default `.tmp/portal-ingest`). */
  ingestDir: string;
  /** Explicit bind host: tailscale IPv4 in serve; loopback ONLY in tests. */
  bindHost: string;
  /** Default 8787; 0 = ephemeral (tests only). */
  port?: number;
  /** Fetch override for portal validation calls (tests). */
  fetchImpl?: typeof fetch;
  /** Override of the ~60s binding cache TTL (tests). */
  bindingTtlMs?: number;
  /** Override of the chunk/total caps (tests use tiny values). */
  chunkCapBytes?: number;
  totalCapBytes?: number;
}

export interface IngestServer {
  host: string;
  port: number;
  /** `http://<host>:<port>` — the base the minted tailnetUrl points at. */
  origin: string;
  /** Absolute landing root. */
  ingestDir: string;
  stop(): Promise<void>;
}

/** Per-token in-memory state: binding cache + declared total + write lock. */
interface TokenState {
  binding: TailnetIngestBinding;
  /** Present only when the portal view exposes it (never in v1). */
  linkId?: string;
  cachedAt: number;
  declaredTotal: number | null;
  lock: Promise<unknown>;
}

/** Typed HTTP failure mapped to the portal-style envelope by the fetch handler. */
class IngestHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageText: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(messageText);
  }
}

/** Portal-style error envelope (the SDK maps it to ApiClientError). */
function errorResponse(status: number, code: string, message: string, details?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({ error: { code, message, requestId: `ing-${sha256HexSync(message).slice(0, 8)}`, ...(details !== undefined ? { details } : {}) } }),
    { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
  );
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

/** Serializes writes per token (single-writer staging per capability). */
async function withTokenLock<T>(state: TokenState, task: () => Promise<T>): Promise<T> {
  const previous = state.lock;
  let release: () => void = () => undefined;
  state.lock = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  try {
    await previous;
    return await task();
  } finally {
    release();
  }
}

/**
 * Creates the ingest server. The bind host is validated HERE (never
 * 0.0.0.0/::, must be a concrete IPv4 or explicit loopback/localhost for
 * tests) and the default port is check-free-or-fail: Bun.serve's EADDRINUSE
 * is surfaced as a typed CONFLICT with an actionable message.
 */
export async function createIngestServer(options: IngestServerOptions): Promise<IngestServer> {
  const host = options.bindHost;
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (host === '0.0.0.0' || host === '::') {
    fail('INVALID_INPUT', 'El ingest NUNCA escucha en 0.0.0.0 ni ::; pasá la IPv4 de tailscale (`tailscale ip -4`).', { bindHost: host });
  }
  if (isTruthyIPv4(host) === false && isLoopback === false) {
    fail('INVALID_INPUT', 'El bind host debe ser la IPv4 de tailscale (o loopback explícito SOLO en tests); jamás 0.0.0.0, :: ni un host arbitrario.', { bindHost: host });
  }
  if (isValidHttpOrigin(options.portalOrigin) === false) {
    fail('INVALID_INPUT', 'El origen del portal debe ser un origen http(s) válido.', { origin: options.portalOrigin });
  }
  const portalOrigin = new URL(options.portalOrigin).origin;
  const ingestDir = resolve(options.ingestDir);
  const chunkCap = options.chunkCapBytes ?? INGEST_CHUNK_CAP_BYTES;
  const totalCap = options.totalCapBytes ?? INGEST_TOTAL_CAP_BYTES;
  const ttl = options.bindingTtlMs ?? INGEST_BINDING_TTL_MS;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const tokens = new Map<string, TokenState>();
  const stagingDir = join(ingestDir, '.staging');
  // Real port after Bun.serve (0 → ephemeral); used for manifest ingestOrigin.
  let boundPort = options.port ?? INGEST_DEFAULT_PORT;

  const stagingPathOf = (tokenHash: string): string => join(stagingDir, `${tokenHash}.bin`);
  const landingDirOf = (tokenHash: string): string => join(ingestDir, tokenHash);

  async function stagedSize(tokenHash: string): Promise<number> {
    try {
      return (await stat(stagingPathOf(tokenHash))).size;
    } catch {
      return 0;
    }
  }

  /**
   * Resolves the token through the PORTAL guest view (short timeout). 404 or
   * any non-200 is the same neutral invalidity; `state !== 'open'` or an
   * already-passed expiresAt is a 409. Only OPEN bindings are cached (~60s).
   */
  async function resolveBinding(rawToken: string): Promise<{ tokenHash: string; binding: TailnetIngestBinding; linkId?: string }> {
    if (typeof rawToken !== 'string' || rawToken.length < 8 || rawToken.length > 512) {
      throw new IngestHttpError(404, 'not_found', 'Este enlace no es válido o ha vencido.');
    }
    const tokenHash = sha256HexSync(rawToken);
    const cached = tokens.get(tokenHash);
    if (cached !== undefined && Date.now() - cached.cachedAt < ttl) {
      return { tokenHash, binding: cached.binding };
    }
    let response: Response;
    try {
      response = await doFetch(`${portalOrigin}/api/v1/a/${encodeURIComponent(rawToken)}`, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(INGEST_VALIDATE_TIMEOUT_MS),
      });
    } catch {
      // Portal unreachable: NEVER degrade into accepting bytes unvalidated.
      throw new IngestHttpError(503, 'portal_unavailable', 'El portal no validó el token a tiempo; reintentá (nunca se aceptan bytes sin validación).');
    }
    if (response.status === 404) {
      throw new IngestHttpError(404, 'not_found', 'Este enlace no es válido o ha vencido.');
    }
    if (response.ok === false) {
      throw new IngestHttpError(503, 'portal_unavailable', `El portal respondió ${response.status} validando el token; reintentá.`);
    }
    let view: unknown;
    try {
      view = await response.json();
    } catch {
      throw new IngestHttpError(503, 'portal_unavailable', 'La vista del portal no es JSON válido; reintentá.');
    }
    const binding = (() => {
      if (!isRecord(view)) return null;
      const assetTitle = stringField(view, 'assetTitle');
      const projectTitle = stringField(view, 'projectTitle');
      const state = stringField(view, 'state');
      const expiresAt = numberField(view, 'expiresAt');
      const quota = view.quota;
      if (assetTitle === null || projectTitle === null || state === null || expiresAt === null || !isRecord(quota)) return null;
      const limitBytes = numberField(quota, 'limitBytes');
      const remainingBytes = numberField(quota, 'remainingBytes');
      if (limitBytes === null || remainingBytes === null) return null;
      if (LINK_STATE_DOMAIN[state] !== true) return null;
      return {
        assetTitle,
        projectTitle,
        state: state as TailnetIngestBinding['state'],
        expiresAt,
        quota: { limitBytes, remainingBytes },
      } satisfies TailnetIngestBinding;
    })();
    if (binding === null) {
      throw new IngestHttpError(503, 'portal_unavailable', 'La vista del portal no tiene la forma esperada; reintentá.');
    }
    if (binding.state !== 'open') {
      throw new IngestHttpError(409, 'conflict', `Este enlace está ${binding.state} y no acepta subidas.`);
    }
    if (binding.expiresAt <= Date.now()) {
      throw new IngestHttpError(409, 'conflict', 'Este enlace venció y no acepta subidas.');
    }
    // Additive forward-compat: a future portal view MAY expose the link id;
    // the v1 view never does (§3 minimal view), so it stays optional and the
    // tokenHash stays the provenance join key.
    const linkId = isRecord(view) ? stringField(view, 'linkId') ?? undefined : undefined;
    tokens.set(tokenHash, { binding, linkId, cachedAt: Date.now(), declaredTotal: cached?.declaredTotal ?? null, lock: cached?.lock ?? Promise.resolve() });
    return { tokenHash, binding, linkId };
  }

  function parseOffset(url: URL, contentRange: string | null, bodyLength: number, currentSize: number): { offset: number; total: number | null } {
    let headerOffset: number | null = null;
    let headerEnd: number | null = null;
    let total: number | null = null;
    if (contentRange !== null) {
      // HTTP grammar: `bytes <start>-<end>/<total>` (also tolerating `bytes=`, as
      // some clients emit the equals form).
      const match = /^bytes[=\s]+(\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange.trim());
      if (match === null) {
        throw new IngestHttpError(400, 'bad_request', 'Content-Range debe tener la forma bytes=<start>-<end>/<total>.');
      }
      headerOffset = Number.parseInt(match[1]!, 10);
      headerEnd = Number.parseInt(match[2]!, 10);
      total = match[3] === '*' ? null : Number.parseInt(match[3]!, 10);
      if (headerEnd < headerOffset) {
        throw new IngestHttpError(400, 'bad_request', 'Content-Range con end < start.');
      }
      if (headerEnd - headerOffset + 1 !== bodyLength) {
        throw new IngestHttpError(400, 'bad_request', 'Content-Range no cubre exactamente el cuerpo del chunk.', { declared: headerEnd - headerOffset + 1, body: bodyLength });
      }
    }
    const queryOffset = url.searchParams.get('offset');
    let offset = headerOffset;
    if (queryOffset !== null) {
      const parsedQuery = Number.parseInt(queryOffset, 10);
      if (Number.isInteger(parsedQuery) === false || parsedQuery < 0) {
        throw new IngestHttpError(400, 'bad_request', '?offset debe ser un entero >= 0.');
      }
      if (offset !== null && offset !== parsedQuery) {
        throw new IngestHttpError(400, 'bad_request', '?offset y Content-Range.start discrepan.');
      }
      offset = parsedQuery;
    }
    if (offset === null) offset = currentSize;
    return { offset, total };
  }

  async function handleChunk(rawToken: string, request: Request, url: URL): Promise<Response> {
    const { tokenHash } = await resolveBinding(rawToken);
    const state = tokens.get(tokenHash)!;
    return await withTokenLock(state, async () => {
      const body = new Uint8Array(await request.arrayBuffer());
      if (body.length > chunkCap) {
        throw new IngestHttpError(413, 'payload_too_large', `El chunk excede el tope de ${chunkCap} bytes.`, { chunkCap });
      }
      const currentSize = await stagedSize(tokenHash);
      const { offset, total } = parseOffset(url, request.headers.get('content-range'), body.length, currentSize);
      if (total !== null) {
        if (state.declaredTotal !== null && state.declaredTotal !== total) {
          throw new IngestHttpError(409, 'conflict', 'El total de la toma cambió entre chunks; reanudá con el total original.', { esperado: state.declaredTotal, recibido: total });
        }
        if (total > totalCap) {
          throw new IngestHttpError(413, 'payload_too_large', `La toma excede el tope total de ${totalCap} bytes.`, { totalCap, total });
        }
        state.declaredTotal = total;
      }
      if (offset > currentSize) {
        throw new IngestHttpError(409, 'conflict', 'Offset adelantado: el server aún no recibió esos bytes.', { received: currentSize, offset });
      }
      if (offset + body.length > totalCap) {
        throw new IngestHttpError(413, 'payload_too_large', `La toma excede el tope total de ${totalCap} bytes.`, { totalCap });
      }
      await mkdir(stagingDir, { recursive: true });
      const handle = await open(stagingPathOf(tokenHash), 'a+');
      try {
        if (offset < currentSize) await handle.truncate(offset);
        await handle.writeFile(body);
      } finally {
        await handle.close();
      }
      const received = await stagedSize(tokenHash);
      const result: TailnetIngestChunkResult = { received, chunkSize: chunkCap, maxBytes: totalCap };
      return jsonResponse(200, result);
    });
  }

  async function handleView(rawToken: string): Promise<Response> {
    const { tokenHash, binding } = await resolveBinding(rawToken);
    const received = await stagedSize(tokenHash);
    const view: TailnetIngestView = { binding, chunkSize: chunkCap, maxBytes: totalCap, received };
    return jsonResponse(200, view);
  }

  async function handleComplete(rawToken: string, request: Request): Promise<Response> {
    const { tokenHash, binding, linkId } = await resolveBinding(rawToken);
    const state = tokens.get(tokenHash)!;
    return await withTokenLock(state, async () => {
      let body: unknown;
      try {
        body = JSON.parse(await request.text());
      } catch {
        throw new IngestHttpError(400, 'bad_request', 'El cuerpo de complete debe ser JSON {bytes, sha256?}.');
      }
      const declaredBytes = isRecord(body) ? numberField(body, 'bytes') : null;
      const replaySha = isRecord(body) ? stringField(body, 'sha256') : null;
      if (declaredBytes === null || !Number.isInteger(declaredBytes) || declaredBytes < 0) {
        throw new IngestHttpError(400, 'bad_request', 'complete requiere {bytes: <entero >= 0>}.');
      }
      const landingDir = landingDirOf(tokenHash);
      const stagingPath = stagingPathOf(tokenHash);

      // Idempotent replay WITHOUT staging: the sha256 names the landed take.
      if (declaredBytes === 0 && replaySha !== null && HEX_64.test(replaySha)) {
        const replayManifestPath = join(landingDir, `take-${replaySha.slice(0, 8)}.manifest.json`);
        const existing = await readFile(replayManifestPath, 'utf8').then((text) => parseLandedManifest(JSON.parse(text)), () => null);
        if (existing !== null && existing.sha256 === replaySha) {
          const result: TailnetIngestCompleteResult = { ...existing, idempotent: true };
          return jsonResponse(200, result);
        }
      }

      const currentSize = await stagedSize(tokenHash);
      if (currentSize === 0) {
        throw new IngestHttpError(409, 'conflict', 'No hay bytes staged para este token; subí chunks antes de complete.');
      }
      if (declaredBytes !== currentSize) {
        throw new IngestHttpError(409, 'conflict', 'El tamaño declarado no coincide con los bytes staged.', { received: currentSize, declarado: declaredBytes });
      }

      // Streamed SHA-256 (the take can be hundreds of MB — never buffer it).
      const hasher = new Bun.CryptoHasher('sha256');
      const file = Bun.file(stagingPath);
      const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      const isMp4 = head.length >= 8 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70;
      if (isMp4 === false) {
        throw new IngestHttpError(415, 'unsupported_media_type', 'Solo tomas MP4 (átomo ftyp) por ahora; los bytes staged se conservan para reintentar.');
      }
      const byteStream = file.stream() as unknown as AsyncIterable<Uint8Array>;
      for await (const chunk of byteStream) {
        hasher.update(chunk);
      }
      const sha256 = hasher.digest('hex');
      const takeId = `take-${sha256.slice(0, 8)}`;

      await mkdir(landingDir, { recursive: true });
      const manifestPath = join(landingDir, `${takeId}.manifest.json`);

      // Content-addressed idempotency: the SAME take never lands twice.
      const alreadyLanded = await readFile(manifestPath, 'utf8').then((text) => parseLandedManifest(JSON.parse(text)), () => null);
      if (alreadyLanded !== null) {
        if (alreadyLanded.sha256 !== sha256) {
          throw new IngestHttpError(409, 'conflict', 'Un take distinto ya ocupa ese id de contenido; nunca se sobrescribe.');
        }
        await rm(stagingPath, { force: true });
        tokens.delete(tokenHash);
        const replayed: TailnetIngestCompleteResult = { ...alreadyLanded, idempotent: true };
        return jsonResponse(200, replayed);
      }

      const manifest: TailnetIngestManifest = {
        schemaVersion: 1,
        source: 'tailnet-ingest',
        takeId,
        tokenHash,
        ...(linkId !== undefined ? { linkId } : {}),
        binding,
        sha256,
        bytes: currentSize,
        mediaType: 'video/mp4',
        receivedAt: new Date().toISOString(),
        ingestOrigin: `http://${host}:${boundPort}`,
      };
      const takePath = join(landingDir, `${takeId}.mp4`);

      // Atomic landing: rename within the same tree; manifest after bytes.
      await rename(stagingPath, takePath);
      const tempManifest = `${manifestPath}.tmp-${crypto.randomUUID()}`;
      await writeFile(tempManifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      await rename(tempManifest, manifestPath);
      tokens.delete(tokenHash);
      const result: TailnetIngestCompleteResult = { ...manifest, idempotent: false };
      return jsonResponse(201, result);
    });
  }

  let server: Bun.Server<undefined>;
  try {
    server = Bun.serve({
      hostname: host,
      port: options.port ?? INGEST_DEFAULT_PORT,
      idleTimeout: 255,
      maxRequestBodySize: chunkCap,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url);
        const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
        try {
          // Path: /subir/:token[/complete] — anything else is the same 404.
          if (segments[0] !== 'subir' || segments.length < 2 || segments.length > 3) {
            return errorResponse(404, 'not_found', 'Ruta inexistente; usá /subir/<token>.');
          }
          const rawToken = decodeURIComponent(segments[1]!);
          if (request.method === 'GET' && segments.length === 2) return await handleView(rawToken);
          if (request.method === 'PUT' && segments.length === 2) return await handleChunk(rawToken, request, url);
          if (request.method === 'POST' && segments.length === 3 && segments[2] === 'complete') return await handleComplete(rawToken, request);
          return errorResponse(404, 'not_found', 'Ruta o método inexistente para /subir/<token>.');
        } catch (error) {
          if (error instanceof IngestHttpError) {
            return errorResponse(error.status, error.code, error.messageText, error.details);
          }
          const message = error instanceof Error ? error.message : String(error);
          return errorResponse(500, 'internal', message.slice(0, 200));
        }
      },
    });
  } catch (error) {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    if (code === 'EADDRINUSE') {
      fail('CONFLICT', `El puerto ${options.port ?? INGEST_DEFAULT_PORT} ya está ocupado; elegí otro con --ingest-port (falla fuerte, nunca comparte puerto).`, { port: options.port ?? INGEST_DEFAULT_PORT });
    }
    throw error;
  }
  // Bun types the listener port as optional; a live server always has one.
  boundPort = server.port ?? 0;

  return {
    host,
    port: boundPort,
    origin: `http://${host}:${boundPort}`,
    ingestDir,
    async stop(): Promise<void> {
      await server.stop(true);
    },
  };
}

/* ---------------------------------------------------------------------------
 * Serve presentation (shared by the CLI spec)
 * ------------------------------------------------------------------------- */

/** Human banner of a running ingest server (no secrets: base URL + caps). */
export function formatIngestServeBanner(input: { origin: string; bindHost: string; ingestDir: string; port: number }): string[] {
  const absoluteDir = resolve(input.ingestDir);
  return [
    `ingest tailnet escuchando en ${input.origin}/subir/<token> (bind ${input.bindHost}; NUNCA 0.0.0.0)`,
    `landing: ${absoluteDir} (gitignored; NO son materiales del portal: entran a Studio con portal-asset-ingest-pull)`,
    `chunks: ${INGEST_CHUNK_CAP_BYTES} bytes por PUT · tope ${INGEST_TOTAL_CAP_BYTES} bytes por toma · reanudable por offset (409 si adelantás)`,
    'recordatorio ACL: el dispositivo invitado necesita permiso tailnet para alcanzar este puerto; sin login, el token del link es la capacidad',
  ];
}
