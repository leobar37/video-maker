/**
 * Media types for the snapshot space: extension/filename inference plus a
 * bounded magic-byte sniffer. Signature checking is "when verifiable" — only
 * the sniffable set is enforced, never invented dimensions or metadata.
 */

const EXTENSION_MEDIA_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.svg': 'image/svg+xml',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.jsx': 'text/javascript',
  '.ts': 'text/x-typescript',
  '.tsx': 'text/x-typescript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.lock': 'text/plain',
};

/** Exact filenames whose media type is not derivable from the extension. */
const FILENAME_MEDIA_TYPES: Record<string, string> = {
  'package-lock.json': 'application/json',
  'npm-shrinkwrap.json': 'application/json',
  'bun.lock': 'text/plain',
  'bun.lockb': 'application/octet-stream',
  'yarn.lock': 'text/plain',
  'pnpm-lock.yaml': 'text/plain',
};

/** Media types this module can actually verify from leading bytes. */
/** Media types this module can actually verify from leading bytes. */
const SNIFFABLE_MEDIA_TYPES: Record<string, true> = {
  'image/png': true,
  'image/jpeg': true,
  'image/gif': true,
  'image/webp': true,
  'video/mp4': true,
  'image/svg+xml': true,
};

export function inferMediaTypeFromPath(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath;
  const byFilename = FILENAME_MEDIA_TYPES[base];
  if (byFilename !== undefined) return byFilename;
  const dot = base.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const byExtension = EXTENSION_MEDIA_TYPES[base.slice(dot).toLowerCase()];
  return byExtension ?? 'application/octet-stream';
}

function startsWithAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

/** Best-effort detection from leading bytes; `null` when unrecognized. */
export function sniffMediaType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && startsWithAscii(bytes, 1, 'PNG\r\n\x1a\n')) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 4 && startsWithAscii(bytes, 0, 'GIF8')) return 'image/gif';
  if (bytes.length >= 12 && startsWithAscii(bytes, 0, 'RIFF') && startsWithAscii(bytes, 8, 'WEBP')) return 'image/webp';
  if (bytes.length >= 12 && startsWithAscii(bytes, 4, 'ftyp')) return 'video/mp4';
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 512)).trimStart();
  if (head.startsWith('<') && head.includes('<svg')) return 'image/svg+xml';
  return null;
}

export interface SignatureMismatch {
  expected: string;
  detected: string | null;
}

/**
 * `null` when the declared media type is consistent (or not verifiable);
 * otherwise the mismatch evidence used to fail the snapshot.
 */
export function signatureMismatch(expected: string, bytes: Uint8Array): SignatureMismatch | null {
  if (!SNIFFABLE_MEDIA_TYPES[expected]) return null;
  const detected = sniffMediaType(bytes);
  if (detected === expected) return null;
  return { expected, detected };
}
