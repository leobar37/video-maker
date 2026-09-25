/**
 * Shared scalar validators used by the versioned contracts. These encode the
 * hash/commit/slug/URL patterns the pipeline must enforce everywhere so a
 * malformed digest can never pass as evidence (FR-011).
 */
import { z } from 'zod';

/** Lowercase slug: `^[a-z0-9][a-z0-9-]*$`. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** Lowercase hexadecimal sha256 digest (64 chars). */
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
/** Short-or-full hexadecimal git commit SHA. */
export const COMMIT_PATTERN = /^[a-f0-9]{7,40}$/;
/** Catalog entry id: `<producto>/<slug>` (letters, digits, `.`, `_`, `-`). */
export const CATALOG_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;
/** Stable id of a pending human decision. */
export const WAITING_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/;

/** A sha256 digest: lowercase hex, exactly 64 characters. */
export const Sha256Schema = z
  .string()
  .regex(SHA256_PATTERN, 'Debe ser un hash sha256 hexadecimal de 64 caracteres.');

/** ISO-8601 timestamp accepted by `Date.parse`. */
export const IsoTimestampSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Debe ser una fecha ISO-8601 válida.');

/** True only for well-formed `http://` or `https://` URLs. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Public `http(s)` URL (media, pull request, cover). */
export const HttpUrlSchema = z
  .string()
  .refine(isHttpUrl, 'Debe ser una URL http:// o https:// válida.');
