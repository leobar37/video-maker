/**
 * Exclusion + selection policy for portable persistence (FR-012).
 *
 * EXCLUSION POLICY (documented contract — `bundle` never packs these):
 * - dependency trees: any path segment named `node_modules`.
 * - caches / build output: segments `.cache`, `.turbo`, `.git`, `dist`, or any
 *   segment starting with `dist-`.
 * - lockfiles: any file segment ending in `.lock`, plus `bun.lockb`.
 * - temp files: file segments ending in `.tmp` or matching `*.tmp-<digits>`,
 *   and `.DS_Store`.
 *
 * These are all REGENERABLE — restoring them is a reinstall/rebuild away — so
 * they are skipped silently and stay out of MANIFEST.json.
 *
 * SECRET POLICY (stricter): paths that look like secrets/credentials are
 * REFUSED with an actionable error, never silently dropped — an operator must
 * decide what to do with them before anything is packaged or archived.
 *
 * ARCHIVE SELECTION: `archive` uploads the regenerable/large binaries — files
 * with a media binary extension (video/audio/image). Those bloat version
 * control but are cheap to re-upload; their provenance lives in `qa/archive.json`.
 */
import { extname } from 'node:path';

import { PersistError } from './errors';

/** Directory-like segments that make any path regenerable. */
const EXCLUDED_DIR_SEGMENTS: Record<string, true> = {
  node_modules: true,
  '.cache': true,
  '.turbo': true,
  '.git': true,
  dist: true,
};

/** Temp/lockfile patterns (last segment only). */
function isTempSegment(segment: string): boolean {
  return (
    segment === '.DS_Store' ||
    segment === 'bun.lockb' ||
    segment.endsWith('.lock') ||
    segment.endsWith('.tmp') ||
    /\.tmp-\d+$/.test(segment)
  );
}

/** True when `rel` (project-relative, `/` separators) is a regenerable to skip. */
export function isExcludedPath(rel: string): boolean {
  return rel
    .split('/')
    .some(
      (segment) =>
        EXCLUDED_DIR_SEGMENTS[segment] === true ||
        segment.startsWith('dist-') ||
        isTempSegment(segment),
    );
}

/** Secret-looking path segments: refused, never packed, never uploaded. */
function isSecretSegment(segment: string): boolean {
  return (
    /^\.env/i.test(segment) ||
    /^(\.git|\.ssh|\.aws|\.gnupg|\.config|\.npmrc|\.netrc|\.pypirc)$/i.test(segment) ||
    /^(credentials|secrets?)(\.|$)/i.test(segment) ||
    /^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/i.test(segment) ||
    /\.(pem|key|p12|pfx|jks|keystore|crt|cer)$/i.test(segment)
  );
}

/**
 * Refuses paths that look like secrets/credentials. Conservative on purpose:
 * a false positive is an operator decision, a false positive *silence* is a leak.
 */
export function assertNotSecretPath(rel: string): void {
  const offending = rel.split('/').find(isSecretSegment);
  if (offending !== undefined) {
    throw new PersistError(
      `${rel}: looks like a secret/credential path and is refused. Move it out of the ` +
        'project (or rename it) before bundling/archiving — persistence never packages secrets.',
    );
  }
}

/** Media binary extensions `archive` uploads (regenerable/large binaries). */
export const ARCHIVABLE_EXTENSIONS = [
  '.mp4',
  '.webm',
  '.mov',
  '.mkv',
  '.mp3',
  '.wav',
  '.m4a',
  '.flac',
  '.ogg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
] as const;

const ARCHIVABLE_BY_EXTENSION: Record<string, true> = Object.fromEntries(
  ARCHIVABLE_EXTENSIONS.map((extension) => [extension, true]),
);

/** True when `rel` is a binary media artifact eligible for object storage. */
export function isArchivableBinary(rel: string): boolean {
  return ARCHIVABLE_BY_EXTENSION[extname(rel).toLowerCase()] === true;
}

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** Content type for an upload key, derived from the file extension. */
export function contentTypeFor(rel: string): string {
  return CONTENT_TYPES[extname(rel).toLowerCase()] ?? 'application/octet-stream';
}
