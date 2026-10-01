/**
 * `@videomaker/dashboard` — the SINGLE read-only consumer of the studio
 * catalog (contracts.md §8). One Bun server + vanilla HTML/CSS/TS UI; no
 * renderer, no per-client HTML, no snapshot/R2/render logic duplicated here.
 *
 * Safety model (NFR-002 / NFR-006):
 * - URLs resolve files by DECLARED OUTPUT NAME against a VALIDATED sealed
 *   revision (manifest rootHash recomputed; file sha256/bytes re-checked;
 *   media type sniffed). Never arbitrary paths, never the mutable working
 *   dir, never `latest`.
 * - HTML/JS/SVG (and anything not explicitly inline-safe) is served as
 *   `attachment`; SVG is NEVER inlined as a document; raster images and
 *   mp4/webm render inline so the same gallery shows image/SVG/video.
 * - Restrictive CSP + `nosniff` everywhere; metadata only reaches the DOM
 *   through JSON + `textContent` (the static shell embeds no data).
 * - No mutating HTTP verb exists: non-GET/HEAD → 405.
 * - `/health` and local catalog reads never resolve credentials or storage.
 *   Remote sealed-file fallback requires an explicitly INJECTED storage.
 */
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  computeRevisionRootHash,
  OUTPUT_NAME_PATTERN,
  sha256Hex,
  StudioIdSchema,
  type RevisionManifest,
  type SnapshotFile,
  type StudioCatalog,
} from '@videomaker/schemas';
import {
  buildStudioCatalog,
  createStudioContext,
  diffAssetRevisions,
  getRevisionManifest,
  inspectCreativeAsset,
  isStudioServiceError,
  storageObjectKeyForSha,
  StudioServiceError,
} from '@videomaker/studio';
import type { StudioContext, StudioStorage } from '@videomaker/studio';

// ---------------------------------------------------------------------------
// Error → HTTP mapping (stable public codes, redacted details)
// ---------------------------------------------------------------------------

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  PATH_UNSAFE: 400,
  SECRET_PATH: 400,
  OUTPUT_MISSING: 404,
  HASH_MISMATCH: 409,
  CONFLICT: 409,
  STORAGE_UNAVAILABLE: 503,
  AUTH_REQUIRED: 503,
  RECIPE_FAILED: 500,
};

function fail(code: StudioServiceError['code'], message: string, details?: Record<string, unknown>): never {
  throw new StudioServiceError(code, message, details);
}

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

const BASE_SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
};

/** The UI shell: scripts/styles only from self; the app never embeds data. */
const UI_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
/** API JSON is never a document. */
const API_CSP = "default-src 'none'; frame-ancestors 'none'";
/** Sealed files: opaque even when navigated directly (subresources ignore it). */
const FILE_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

// ---------------------------------------------------------------------------
// Media disposition policy (single gallery for image/SVG/video, no per-brand code)
// ---------------------------------------------------------------------------

/** Media types safe to render inline in the gallery. Everything else —
 * SVG, HTML, JS, fonts, desconocidos — via exact download (attachment). */
const INLINE_MEDIA_TYPES: Record<string, true> = {
  'image/png': true,
  'image/jpeg': true,
  'image/gif': true,
  'image/webp': true,
  'image/avif': true,
  'video/mp4': true,
  'video/webm': true,
};

/** Best-effort magic-byte sniff of the types the dashboard can classify. */
export function sniffServedMediaType(bytes: Uint8Array): string | null {
  const ascii = (offset: number, text: string): boolean => {
    for (let index = 0; index < text.length; index += 1) {
      if (bytes[offset + index] !== text.charCodeAt(index)) return false;
    }
    return true;
  };
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 'PNG\r\n\x1a\n')) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 4 && ascii(0, 'GIF8')) return 'image/gif';
  if (bytes.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
  if (bytes.length >= 12 && ascii(4, 'ftyp')) {
    // ISOBMFF family: distinguish AVIF brands before the generic MP4 class.
    const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
    if (brand === 'avif' || brand === 'avis' || brand === 'mif1' || brand === 'msf1') return 'image/avif';
    return 'video/mp4';
  }
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 512)).trimStart();
  if (head.startsWith('<') && head.includes('<svg')) return 'image/svg+xml';
  return null;
}

/** Declared types whose bytes MUST carry a recognized, matching signature. */
const STRICT_VERIFIABLE_MEDIA_TYPES: Record<string, true> = {
  'image/png': true,
  'image/jpeg': true,
  'image/gif': true,
  'image/webp': true,
  'video/mp4': true,
  'image/svg+xml': true,
};

function charsetFor(mediaType: string): string | null {
  if (mediaType.startsWith('text/')) return 'utf-8';
  if (mediaType === 'application/json' || mediaType === 'image/svg+xml' || mediaType === 'application/xml') return 'utf-8';
  return null;
}

/** ASCII-safe download name: declared output name + the sealed path extension. */
export function sealedDownloadName(outputName: string, sealedPath: string): string {
  const extension = path.extname(sealedPath);
  return `${outputName}${extension}`.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

// ---------------------------------------------------------------------------
// Sealed-revision resolution (rootHash recomputed; sha256/bytes/type verified)
// ---------------------------------------------------------------------------

export interface SealedOutputRequest {
  projectId: string;
  assetId: string;
  revisionId: string;
  outputName: string;
}

export interface SealedOutput {
  bytes: Uint8Array;
  mediaType: string;
  disposition: 'inline' | 'attachment';
  filename: string;
  source: 'local' | 'storage';
}

function assertId(value: string, label: string): string {
  if (!StudioIdSchema.safeParse(value).success) {
    fail('INVALID_INPUT', `${label} debe ser un id kebab-case válido.`, { field: label });
  }
  return value;
}

function assertOutputName(value: string): string {
  if (!OUTPUT_NAME_PATTERN.test(value)) {
    fail('INVALID_INPUT', 'El nombre de output debe ser slug-like (sin /).', { outputName: value.slice(0, 60) });
  }
  return value;
}

/** Loads the manifest of a sealed revision and RECOMPUTES its rootHash. */
export async function loadSealedManifest(studio: StudioContext, request: Omit<SealedOutputRequest, 'outputName'>): Promise<RevisionManifest> {
  assertId(request.projectId, 'projectId');
  assertId(request.assetId, 'assetId');
  assertId(request.revisionId, 'revisionId');
  const manifest = await getRevisionManifest(studio, { projectId: request.projectId, assetId: request.assetId, revisionId: request.revisionId });
  // The ids are EXCLUDED from the rootHash payload: an edited manifest could
  // seal validly under a different identity. The served revision must be
  // EXACTLY the requested project/asset/revision, never another one.
  if (manifest.projectId !== request.projectId || manifest.assetId !== request.assetId || manifest.revisionId !== request.revisionId) {
    fail('HASH_MISMATCH', 'Los ids del manifest no coinciden con la revisión pedida (posible alteración); no se sirve.', {
      revisionId: request.revisionId,
    });
  }
  const recomputed = await computeRevisionRootHash(manifest);
  if (recomputed !== manifest.rootHash) {
    fail('HASH_MISMATCH', 'El manifest de la revisión no coincide con su rootHash (posible alteración); no se sirve.', {
      revisionId: request.revisionId,
    });
  }
  return manifest;
}

function sealedFilesDir(workspaceDir: string, projectId: string, assetId: string, revisionId: string): string {
  return path.join(path.resolve(workspaceDir), 'revisions', projectId, assetId, revisionId, 'files');
}

/**
 * Resolves a declared output of a VALIDATED sealed revision by NAME:
 * local sealed copy first (never the working dir), remote private object
 * (by content sha) only when a storage was explicitly injected. Bytes are
 * re-verified (length + sha256 + sniffable type) before they are ever served.
 */
export async function resolveSealedOutput(
  studio: StudioContext,
  storage: StudioStorage | undefined,
  request: SealedOutputRequest,
): Promise<SealedOutput> {
  assertOutputName(request.outputName);
  const manifest = await loadSealedManifest(studio, request);
  const ref = manifest.outputs.find((candidate) => candidate.name === request.outputName);
  if (ref === undefined) {
    fail('NOT_FOUND', 'El nombre pedido no es un output declarado de la revisión (nunca una ruta arbitraria).', {
      revisionId: request.revisionId,
      outputName: request.outputName,
    });
  }
  const file = manifest.files.find((candidate) => candidate.path === ref.path);
  if (file === undefined) {
    fail('NOT_FOUND', 'El manifest no contiene el archivo del output declarado (inconsistencia).', { path: ref.path });
  }
  const spec = manifest.assetSnapshot.outputs.find((candidate) => candidate.name === request.outputName);
  if (spec !== undefined && spec.mediaType !== file.mediaType) {
    fail('HASH_MISMATCH', 'El tipo declarado del output difiere del tipo sellado.', {
      declared: spec.mediaType,
      sealed: file.mediaType,
    });
  }

  const resolved = await sealedOutputBytes(studio, storage, request, file);
  const bytes = resolved.bytes;

  if (bytes.length !== file.bytes || (await sha256Hex(bytes)) !== file.sha256) {
    fail('HASH_MISMATCH', 'Los bytes sellados no coinciden con el manifest (corruptos o alterados); no se sirven.', {
      path: ref.path,
      revisionId: request.revisionId,
    });
  }
  // Type policy: a recognized-but-different signature ALWAYS rejects, and
  // strictly verifiable declared types (PNG/JPEG/GIF/WebP/MP4/SVG) must be
  // recognized — arbitrary bytes can never pass as those. AVIF/WebM without
  // a recognizable signature degrade to exact download (attachment fallback),
  // never a bogus classification; unknown formats stay attachment.
  const detected = sniffServedMediaType(bytes);
  const verified = detected === file.mediaType;
  if (!verified && (detected !== null || STRICT_VERIFIABLE_MEDIA_TYPES[file.mediaType] === true)) {
    fail('HASH_MISMATCH', 'Los bytes no corresponden al tipo sellado; no se sirven.', {
      declared: file.mediaType,
      detected,
    });
  }

  return {
    bytes,
    mediaType: file.mediaType,
    disposition: verified && INLINE_MEDIA_TYPES[file.mediaType] === true ? 'inline' : 'attachment',
    filename: sealedDownloadName(request.outputName, ref.path),
    source: resolved.source,
  };
}

/**
 * Rejects symlinked components between `base` and the target (parents of the
 * sealed tree: revision/, files/, output subdirs). A symlinked "sealed" path
 * must never be served, even when the bytes would match.
 */
async function assertRealComponentChain(base: string, segments: readonly string[]): Promise<void> {
  let current = base;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await lstat(current).catch(() => null);
    if (stat !== null && stat.isSymbolicLink()) {
      fail('PATH_UNSAFE', 'Un componente intermedio de la copia sellada es un symlink; no se sirve.', {
        path: path.relative(base, current),
      });
    }
  }
}

async function sealedOutputBytes(
  studio: StudioContext,
  storage: StudioStorage | undefined,
  request: SealedOutputRequest,
  file: SnapshotFile,
): Promise<{ bytes: Uint8Array; source: 'local' | 'storage' }> {
  const filesDir = sealedFilesDir(studio.workspaceDir, request.projectId, request.assetId, request.revisionId);
  const absolute = path.join(filesDir, file.path);
  // Belt and braces: the manifest schema already rejects unsafe paths, but
  // the served bytes must provably stay inside this revision's seal.
  const contained = path.relative(filesDir, absolute);
  if (contained.startsWith('..') || path.isAbsolute(contained)) {
    fail('PATH_UNSAFE', 'La ruta del output escapa del sello de la revisión.', { path: file.path });
  }
  // Symlinked parents (revision/, files/, output dirs) reject the file even
  // with byte-perfect content: the seal must be a real chain, not a link farm.
  await assertRealComponentChain(studio.workspaceDir, ['revisions', request.projectId, request.assetId, request.revisionId, 'files', ...file.path.split('/')]);
  const stat = await lstat(absolute).catch(() => null);
  if (stat !== null && stat.isSymbolicLink()) {
    fail('PATH_UNSAFE', 'El archivo sellado es un symlink; no se sirve.', { path: file.path });
  }
  if (stat !== null && stat.isFile()) {
    try {
      return { bytes: new Uint8Array(await readFile(absolute)), source: 'local' };
    } catch {
      // Unreadable local copy behaves as missing: the injected storage (if
      // any) is content-addressed and its bytes still get re-verified.
    }
  }
  // Sealed local copy missing: fall back ONLY to an injected private storage,
  // content-addressed by the manifest sha (no credentials resolved here).
  if (storage !== undefined) {
    const bytes = await storage.get(storageObjectKeyForSha(file.sha256));
    return { bytes, source: 'storage' };
  }
  fail('NOT_FOUND', 'La copia sellada local falta y no hay storage privado inyectado para resolverla.', {
    revisionId: request.revisionId,
    path: file.path,
  });
}

// ---------------------------------------------------------------------------
// HTTP app
// ---------------------------------------------------------------------------

export interface DashboardAppOptions {
  workspaceDir: string;
  /** Explicitly injected private storage for remote sealed-file fallback. */
  storage?: StudioStorage;
  /** UI static dir override (defaults to `../ui` next to this module). */
  uiDir?: string;
}

export interface DashboardApp {
  readonly studio: StudioContext;
  readonly storage: StudioStorage | undefined;
  fetch(request: Request): Promise<Response>;
}

interface UiAssets {
  html: string;
  js: string;
  css: string;
}

const UI_CONTENT_TYPES: Record<string, string> = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'styles.css': 'text/css; charset=utf-8',
};

function envelopeOk(data: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify({ schemaVersion: 1, ok: true, data })}\n`, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'content-security-policy': API_CSP, ...BASE_SECURITY_HEADERS, ...extraHeaders },
  });
}

function envelopeError(error: unknown, extraHeaders: Record<string, string> = {}): Response {
  if (isStudioServiceError(error)) {
    const status = STATUS_BY_CODE[error.code] ?? 500;
    return new Response(
      `${JSON.stringify({
        schemaVersion: 1,
        ok: false,
        error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) },
      })}\n`,
      { status, headers: { 'content-type': 'application/json; charset=utf-8', 'content-security-policy': API_CSP, ...BASE_SECURITY_HEADERS, ...extraHeaders } },
    );
  }
  // Unknown/unexpected: redacted. The server keeps running.
  return new Response(`${JSON.stringify({ schemaVersion: 1, ok: false, error: { code: 'INTERNAL', message: 'error interno (detalle redactado).' } })}\n`, {
    status: 500,
    headers: { 'content-type': 'application/json; charset=utf-8', 'content-security-policy': API_CSP, ...BASE_SECURITY_HEADERS, ...extraHeaders },
  });
}

export function createDashboardApp(options: DashboardAppOptions): DashboardApp {
  const studio = createStudioContext(options.workspaceDir);
  const uiDir = options.uiDir ?? path.join(import.meta.dir, 'ui');
  let uiAssets: Promise<UiAssets> | undefined;
  const ui = (): Promise<UiAssets> => {
    uiAssets ??= (async () => ({
      html: await readFile(path.join(uiDir, 'index.html'), 'utf8'),
      js: await readFile(path.join(uiDir, 'app.js'), 'utf8'),
      css: await readFile(path.join(uiDir, 'styles.css'), 'utf8'),
    }))();
    return uiAssets;
  };

  const optionalFilter = (params: URLSearchParams, name: string): string | undefined => {
    const raw = params.get(name);
    if (raw === null || raw.trim().length === 0) return undefined;
    return assertId(raw.trim(), `filter.${name}`);
  };

  const uiResponse = async (assetName: 'index.html' | 'app.js' | 'styles.css'): Promise<Response> => {
    const assets = await ui();
    const body = assetName === 'index.html' ? assets.html : assetName === 'app.js' ? assets.js : assets.css;
    return new Response(body, {
      status: 200,
      headers: { 'content-type': UI_CONTENT_TYPES[assetName]!, 'content-security-policy': UI_CSP, ...BASE_SECURITY_HEADERS },
    });
  };

  const sealedFileResponse = async (request: Request, segments: string[]): Promise<Response> => {
    const [, , projectId, assetId, revisionId, outputName] = segments;
    const sealed = await resolveSealedOutput(studio, options.storage, {
      projectId: String(projectId),
      assetId: String(assetId),
      revisionId: String(revisionId),
      outputName: String(outputName),
    });
    const forceDownload = new URL(request.url).searchParams.get('download') === '1';
    const disposition = forceDownload ? 'attachment' : sealed.disposition;
    const charset = charsetFor(sealed.mediaType);
    return new Response(sealed.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        'content-type': charset === null ? sealed.mediaType : `${sealed.mediaType}; charset=${charset}`,
        'content-disposition': `${disposition}; filename="${sealed.filename}"; filename*=UTF-8''${encodeURIComponent(sealed.filename)}`,
        'content-security-policy': FILE_CSP,
        ...BASE_SECURITY_HEADERS,
      },
    });
  };

  const handle = async (request: Request): Promise<Response> => {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      // True 405 (not the error-code mapping): read-only by construction.
      return new Response(
        `${JSON.stringify({
          schemaVersion: 1,
          ok: false,
          error: { code: 'INVALID_INPUT', message: 'El dashboard es solo lectura; no existen acciones mutadoras por HTTP.', details: { method } },
        })}\n`,
        { status: 405, headers: { 'content-type': 'application/json; charset=utf-8', allow: 'GET, HEAD', 'content-security-policy': API_CSP, ...BASE_SECURITY_HEADERS } },
      );
    }
    const url = new URL(request.url);
    let segments: string[];
    try {
      segments = url.pathname
        .split('/')
        .filter((segment) => segment.length > 0)
        .map((segment) => decodeURIComponent(segment));
    } catch {
      return envelopeError(fail('INVALID_INPUT', 'Ruta con escapes inválidos.'));
    }

    try {
      if (segments.length === 0 || (segments.length === 1 && segments[0] === 'index.html')) return await uiResponse('index.html');
      if (segments.length === 1 && (segments[0] === 'app.js' || segments[0] === 'styles.css')) {
        return await uiResponse(segments[0] as 'app.js' | 'styles.css');
      }
      if (segments.length === 1 && segments[0] === 'health') {
        // No credentials, no storage, no workspace scanning (NFR-002).
        return envelopeOk({ status: 'ok', readOnly: true });
      }
      if (segments[0] === 'api' && segments.length === 2 && segments[1] === 'catalog') {
        const catalog = await buildStudioCatalog(studio, {
          clientId: optionalFilter(url.searchParams, 'client'),
          projectId: optionalFilter(url.searchParams, 'project'),
          assetId: optionalFilter(url.searchParams, 'asset'),
          kind: url.searchParams.get('kind')?.trim() || undefined,
        });
        return envelopeOk(catalog satisfies StudioCatalog);
      }
      if (segments[0] === 'api' && segments[1] === 'assets' && segments.length === 4) {
        const inspection = await inspectCreativeAsset(studio, {
          projectId: assertId(segments[2]!, 'projectId'),
          assetId: assertId(segments[3]!, 'assetId'),
        });
        return envelopeOk(inspection);
      }
      if (segments[0] === 'api' && segments[1] === 'revisions' && segments.length === 5) {
        const manifest = await loadSealedManifest(studio, {
          projectId: segments[2]!,
          assetId: segments[3]!,
          revisionId: segments[4]!,
        });
        return envelopeOk(manifest);
      }
      if (segments[0] === 'api' && segments[1] === 'diff' && segments.length === 4) {
        const from = url.searchParams.get('from')?.trim() ?? '';
        const to = url.searchParams.get('to')?.trim() ?? '';
        if (from.length === 0 || to.length === 0) fail('INVALID_INPUT', 'Los parámetros from y to son obligatorios (revisiones a comparar).');
        const diff = await diffAssetRevisions(studio, {
          projectId: assertId(segments[2]!, 'projectId'),
          assetId: assertId(segments[3]!, 'assetId'),
          fromRevisionId: from,
          toRevisionId: to,
        });
        return envelopeOk(diff);
      }
      if (segments[0] === 'api' && segments[1] === 'files' && segments.length === 6) {
        return await sealedFileResponse(request, segments);
      }
      return envelopeError(fail('NOT_FOUND', 'Ruta desconocida del dashboard (solo lectura).', { path: url.pathname.slice(0, 80) }));
    } catch (error) {
      return envelopeError(error);
    }
  };

  return { studio, storage: options.storage, fetch: handle };
}

// ---------------------------------------------------------------------------
// Ephemeral server handle (tests start+stop; durable serving only on run())
// ---------------------------------------------------------------------------

export interface DashboardServerOptions extends DashboardAppOptions {
  /** `127.0.0.1` (default, interno), `localhost` (normalizado) o `0.0.0.0`. */
  host?: string;
  /** Default 0: puerto efímero asignado por el SO. */
  port?: number;
  /**
   * Modelo de acceso EXPLÍCITO: `internal` (default) o `trusted-tailnet`.
   * `0.0.0.0` REQUIRE `trusted-tailnet` — the permission is NEVER inferred
   * from the host. Unknown values are rejected before any bind.
   */
  access?: DashboardAccess;
}

export type DashboardAccess = 'internal' | 'trusted-tailnet';

export interface RunningDashboard {
  readonly port: number;
  readonly hostname: string;
  readonly access: DashboardAccess;
  stop(): Promise<void>;
}

export async function startDashboardServer(options: DashboardServerOptions): Promise<RunningDashboard> {
  // Normalize localhost BEFORE any policy check.
  const hostRaw = options.host ?? '127.0.0.1';
  if (hostRaw !== '127.0.0.1' && hostRaw !== 'localhost' && hostRaw !== '0.0.0.0') {
    fail('INVALID_INPUT', 'host de bind no soportado: 127.0.0.1 (interno), localhost u 0.0.0.0 (todas las interfaces).', { host: hostRaw });
  }
  const hostname = hostRaw === 'localhost' ? '127.0.0.1' : hostRaw;
  const access: DashboardAccess = options.access ?? 'internal';
  if (access !== 'internal' && access !== 'trusted-tailnet') {
    fail('INVALID_INPUT', 'access debe ser internal (default) o trusted-tailnet (explícito).', { access: String(options.access).slice(0, 30) });
  }
  // Explicit permission model: 0.0.0.0 (all interfaces) REQUIRES
  // trusted-tailnet; a loopback bind can never carry it. Decided BEFORE bind.
  if (hostname === '0.0.0.0' && access !== 'trusted-tailnet') {
    fail('INVALID_INPUT', 'Exponer en todas las interfaces exige access trusted-tailnet explícito (nunca se infiere del host; no es apto para Internet abierto).');
  }
  if (hostname === '127.0.0.1' && access === 'trusted-tailnet') {
    fail('INVALID_INPUT', 'access trusted-tailnet exige host 0.0.0.0 (un bind interno no genera enlace de usuario).');
  }
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('INVALID_INPUT', 'Puerto inválido.', { port });
  const app = createDashboardApp(options);
  const server = Bun.serve({
    hostname,
    port,
    fetch: (request) => app.fetch(request),
    error: (error) => envelopeError(error),
    idleTimeout: 30,
  });
  return {
    port: server.port ?? 0,
    hostname,
    access,
    stop: async () => {
      await server.stop(true);
    },
  };
}

// ---------------------------------------------------------------------------
// Re-exported URL/state helpers (serve state + Tailscale link) — ./tailscale.ts
// ---------------------------------------------------------------------------

export {
  dashboardServeStatePath,
  isTailscaleIpv4,
  probeDashboardHealth,
  probeListenerViaSs,
  readDashboardServeState,
  removeDashboardServeState,
  resolveDashboardUrl,
  tailscaleIpv4ViaCli,
  writeDashboardServeState,
} from './tailscale';
export type {
  DashboardServeState,
  DashboardUrlInput,
  DashboardUrlResult,
  HealthProbe,
  ListenerProbe,
  ListenerProbeInput,
  ListenerProbeResult,
  TailscaleIpv4Resolver,
} from './tailscale';
