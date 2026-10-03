import { constants, type BigIntStats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';

export type ReviewPreviewMediaType =
  | 'text/html'
  | 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/avif'
  | 'video/mp4' | 'video/webm';

const MEDIA_EXTENSIONS: Record<ReviewPreviewMediaType, readonly string[]> = {
  'text/html': ['.html', '.htm'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
  'image/avif': ['.avif'],
  'video/mp4': ['.mp4'],
  'video/webm': ['.webm'],
};

export interface ReviewPreviewFile {
  /** Exact canonical URL under /review/, including the filename. */
  readonly route: string;
  /** Exact root-relative final file; no directories or discovery. */
  readonly path: string;
  readonly mediaType: ReviewPreviewMediaType;
}
export interface ReviewPreviewConfig {
  readonly rootDir: string;
  readonly files: readonly ReviewPreviewFile[];
}
export type ReviewPreviewHandler = (request: Request) => Promise<Response>;

const PRIVATE_COMPONENT = /(?:^|[._-])(?:private|src|source|sources|raw|original|originals|transcript|transcripts|transcription|transcriptions|journal|journals|intent|intents|credential|credentials|secret|secrets|token|tokens)(?:$|[._-])/i;
const REVIEW_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  // Final HTML may style itself, but cannot execute scripts or read the API.
  'content-security-policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; sandbox",
};

function safeSegments(value: string): boolean {
  return /^[a-zA-Z0-9_./-]+$/.test(value) && value.split('/').every((segment) => (
    segment.length > 0 && !segment.startsWith('.') && !PRIVATE_COMPONENT.test(segment)
  ));
}

/** Serve a fresh, already validated byte snapshot. Range never skips validation.
 * No validator is emitted: If-Range therefore conservatively returns full bytes.
 * HEAD ignores Range and reports full representation headers, without a body. */
export function createByteResponse(
  request: Request,
  bytes: Uint8Array,
  headers: HeadersInit,
  allowVideoRange = false,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('content-length', String(bytes.byteLength));
  if (allowVideoRange) responseHeaders.set('accept-ranges', 'bytes');
  if (request.method.toUpperCase() === 'HEAD') return new Response(null, { headers: responseHeaders });

  const range = request.headers.get('range');
  if (!allowVideoRange || range === null || request.headers.has('if-range')) {
    return new Response(bytes as unknown as BodyInit, { headers: responseHeaders });
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  let start = 0;
  let end = bytes.byteLength - 1;
  let valid = match !== null && bytes.byteLength > 0 && (match[1] !== '' || match[2] !== '');
  if (valid && match !== null) {
    if (match[1] === '') {
      const suffix = Number(match[2]);
      valid = Number.isSafeInteger(suffix) && suffix > 0;
      start = Math.max(0, bytes.byteLength - suffix);
    } else {
      start = Number(match[1]);
      const requestedEnd = match[2] === '' ? end : Number(match[2]);
      valid = Number.isSafeInteger(start) && Number.isSafeInteger(requestedEnd)
        && start < bytes.byteLength && requestedEnd >= start;
      end = Math.min(end, requestedEnd);
    }
  }
  if (!valid) {
    responseHeaders.set('content-range', `bytes */${bytes.byteLength}`);
    responseHeaders.set('content-length', '0');
    return new Response(null, { status: 416, headers: responseHeaders });
  }
  responseHeaders.set('content-range', `bytes ${start}-${end}/${bytes.byteLength}`);
  responseHeaders.set('content-length', String(end - start + 1));
  return new Response(bytes.slice(start, end + 1) as unknown as BodyInit, { status: 206, headers: responseHeaders });
}

function unavailable(request: Request, status = 404): Response {
  const bytes = new TextEncoder().encode(status === 405 ? 'Method not allowed.\n' : 'Not found.\n');
  return new Response(request.method.toUpperCase() === 'HEAD' ? null : bytes, {
    status,
    headers: {
      ...REVIEW_HEADERS,
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(bytes.byteLength),
      ...(status === 405 ? { allow: 'GET, HEAD' } : {}),
    },
  });
}

/** Resolve each child relative to its still-open parent, never by reopening an
 * absolute path. The proc fd indirection is intentional; O_NOFOLLOW protects the
 * child component, and identity checks reject observed ancestor replacements. */
async function readPinnedFile(absolute: string): Promise<Uint8Array> {
  if (process.platform !== 'linux'
    || !Number.isInteger(constants.O_DIRECTORY) || !Number.isInteger(constants.O_NOFOLLOW)
    || !Number.isInteger(constants.O_NONBLOCK)) throw new Error('Preview filesystem unavailable');
  const components = absolute.slice(1).split('/');
  if (!absolute.startsWith('/') || components.some((component) => (
    component.length === 0 || component.startsWith('.') || PRIVATE_COMPONENT.test(component)
  ))) throw new Error('Unsafe preview path');

  const handles: FileHandle[] = [];
  const pinned: { link: string; stat: BigIntStats; directory: boolean }[] = [];
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const verify = async () => {
    for (const entry of pinned) {
      const current = await fs.lstat(entry.link, { bigint: true });
      if (current.isSymbolicLink() || current.dev !== entry.stat.dev || current.ino !== entry.stat.ino
        || (entry.directory ? !current.isDirectory() : !current.isFile())) {
        throw new Error('Preview path changed');
      }
    }
  };
  try {
    let parent = await fs.open('/', directoryFlags);
    handles.push(parent);
    const rootStat = await parent.stat({ bigint: true });
    if (!rootStat.isDirectory()) throw new Error('Invalid filesystem root');
    pinned.push({ link: '/', stat: rootStat, directory: true });
    for (const [index, component] of components.entries()) {
      const directory = index < components.length - 1;
      const link = `/proc/self/fd/${parent.fd}/${component}`;
      const observed = await fs.lstat(link, { bigint: true });
      if (observed.isSymbolicLink() || (directory ? !observed.isDirectory() : !observed.isFile())) {
        throw new Error('Invalid preview component');
      }
      const child = await fs.open(link, directory ? directoryFlags
        : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      handles.push(child);
      const actual = await child.stat({ bigint: true });
      if (observed.dev !== actual.dev || observed.ino !== actual.ino
        || (directory ? !actual.isDirectory() : !actual.isFile())) {
        throw new Error('Preview component changed');
      }
      pinned.push({ link, stat: actual, directory });
      parent = child;
    }
    await verify();
    const bytes = new Uint8Array(await parent.readFile());
    await verify();
    return bytes;
  } finally {
    // Settle every close even if another close rejects.
    const closed = await Promise.allSettled(handles.reverse().map((handle) => handle.close()));
    if (closed.some((result) => result.status === 'rejected')) throw new Error('Preview close failed');
  }
}

/** HTML only: canonical declared links cannot navigate outside this preview.
 * Wildcard handling also covers SVG/MathML href and namespaced attributes. */
async function reviewHtml(bytes: Uint8Array, files: ReadonlyMap<string, Readonly<ReviewPreviewFile>>): Promise<Uint8Array> {
  const rewriter = new HTMLRewriter().on('*', {
    element(element) {
      const tag = element.tagName.toLowerCase();
      const attributes = [...element.attributes];
      // noscript parsing differs when scripts are disabled by the sandbox.
      // Remove it outright, plus all directives including encoded refresh values.
      if (tag === 'base' || tag === 'noscript' || (tag === 'meta'
        && attributes.some(([name]) => name.toLowerCase() === 'http-equiv'))) {
        element.remove();
        return;
      }
      const html = element.namespaceURI === 'http://www.w3.org/1999/xhtml';
      // A foreign anchor could acquire an href through declarative SVG animation.
      // Unwrap it rather than discarding its text/graphics.
      if (!html && (tag === 'a' || tag === 'area')) element.removeAndKeepContent();
      const hrefs = attributes.filter(([name]) => name.toLowerCase() === 'href');
      const href = hrefs.length === 1 ? hrefs[0]?.[1] : undefined;
      for (const [name] of attributes) {
        const attribute = name.toLowerCase();
        if (attribute === 'href') {
          element.removeAttribute(name);
        } else if (['xlink:href', 'xml:base', 'ping', 'target', 'formtarget', 'attributionsrc'].includes(attribute)) {
          element.removeAttribute(name);
        }
      }
      if (html && (tag === 'a' || tag === 'area') && href !== undefined && files.has(href)) {
        element.setAttribute('href', href);
      }
    },
  });
  // Consume the rewritten body before constructing GET or HEAD headers. Parser
  // and stream errors propagate to the handler's uniform 404, never raw HTML.
  return new Uint8Array(await rewriter.transform(new Response(bytes as unknown as BodyInit, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })).arrayBuffer());
}

/** Opt-in read-only preview; copies declarations once and never scans a tree.
 * Unsafe declarations, missing files and filesystem errors are uniformly 404.
 * Linux proc fd traversal pins each ancestor; unsupported filesystems fail closed. */
export function createReviewPreviewHandler(config: ReviewPreviewConfig): ReviewPreviewHandler {
  const rootDir = path.resolve(config.rootDir);
  const files = new Map<string, Readonly<ReviewPreviewFile>>();
  const duplicateRoutes = new Set<string>();
  for (const declaration of config.files) {
    const file = Object.freeze({ route: declaration.route, path: declaration.path, mediaType: declaration.mediaType });
    const extensions: readonly string[] | undefined = Object.hasOwn(MEDIA_EXTENSIONS, file.mediaType)
      ? MEDIA_EXTENSIONS[file.mediaType] : undefined;
    if (!file.route.startsWith('/review/') || !safeSegments(file.route.slice(1)) || !safeSegments(file.path)
      || extensions === undefined || !extensions.includes(path.extname(file.path).toLowerCase())
      || !extensions.includes(path.extname(file.route).toLowerCase())) continue;
    if (files.has(file.route) || duplicateRoutes.has(file.route)) {
      files.delete(file.route);
      duplicateRoutes.add(file.route);
    } else files.set(file.route, file);
  }

  return async (request) => {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return unavailable(request, 405);
    try {
      const pathname = new URL(request.url).pathname;
      // No percent decoding, slash collapsing, aliases or case normalization.
      const file = files.get(pathname);
      if (file === undefined) return unavailable(request);
      const absolute = path.join(rootDir, file.path);
      const relative = path.relative(rootDir, absolute);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return unavailable(request);
      const snapshot = await readPinnedFile(absolute);
      const bytes = file.mediaType === 'text/html' ? await reviewHtml(snapshot, files) : snapshot;
      return createByteResponse(request, bytes, {
        ...REVIEW_HEADERS,
        'content-type': file.mediaType === 'text/html' ? 'text/html; charset=utf-8' : file.mediaType,
      }, file.mediaType.startsWith('video/'));
    } catch {
      return unavailable(request);
    }
  };
}
