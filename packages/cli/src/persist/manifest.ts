/**
 * Bundle MANIFEST.json (FR-012): content-addressed inventory of one project.
 *
 * Shape (schemaVersion 1):
 *   { schemaVersion: 1, files: [{ path, sha256, bytes }], rootHash }
 *
 * `files` is sorted by `path` (`/` separators, project-relative). `rootHash`
 * is `sha256Hex` over the newline-joined file-hash list in that path order —
 * the "sorted file-hash list" of the bundle. `MANIFEST.json` never lists
 * itself; `MANIFEST_NAME` is reserved at a project root (`bundle` refuses a
 * project carrying its own, `hydrate` never writes one into the target).
 */
import { sha256Hex } from '@videomaker/core';

import { PersistError } from './errors';

export const MANIFEST_NAME = 'MANIFEST.json';
export const MANIFEST_SCHEMA_VERSION = 1;

/** One `files[]` entry of MANIFEST.json. */
export interface BundleFileEntry {
  /** Project-relative path, `/` separators. */
  path: string;
  /** Lowercase hex sha256 of the file content. */
  sha256: string;
  bytes: number;
}

/** MANIFEST.json of a bundle. Derived from content only — no clocks, no ids. */
export interface BundleManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  files: BundleFileEntry[];
  rootHash: string;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Validates a project-relative path for manifest use: relative, `/`
 * separators, no `.`/`..`/empty segments, no absolute or drive prefixes.
 */
export function assertSafeRelativePath(path: string): void {
  const unsafe =
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..');
  if (unsafe) {
    throw new PersistError(`${JSON.stringify(path)}: unsafe project-relative path in manifest.`);
  }
}

/**
 * rootHash over the path-sorted file-hash list: `files` ordered by `path`
 * ascending (code-unit order), their `sha256` values joined with `\n`, hashed.
 * An empty project hashes the empty string.
 */
export function computeRootHash(files: readonly BundleFileEntry[]): string {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256Hex(sorted.map((file) => file.sha256).join('\n'));
}

/** Canonical MANIFEST.json bytes: 2-space JSON + trailing newline. */
export function serializeManifest(manifest: BundleManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Validates untrusted MANIFEST.json content (from a bundle dir) into a
 * `BundleManifest`. Unknown extra fields are ignored; the required fields are
 * checked strictly, including path safety, hash shape, duplicate paths and
 * rootHash consistency.
 */
export function parseManifest(raw: string, source: string): BundleManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new PersistError(`${source}: MANIFEST.json is not valid JSON (${(cause as Error).message}).`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PersistError(`${source}: MANIFEST.json must be a JSON object.`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new PersistError(
      `${source}: MANIFEST.json schemaVersion must be ${MANIFEST_SCHEMA_VERSION} ` +
        `(got ${JSON.stringify(record.schemaVersion)}).`,
    );
  }
  if (!Array.isArray(record.files)) {
    throw new PersistError(`${source}: MANIFEST.json "files" must be an array.`);
  }
  const files: BundleFileEntry[] = [];
  const seen = new Set<string>();
  for (const [index, value] of record.files.entries()) {
    const where = `${source}: MANIFEST.json files[${index}]`;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new PersistError(`${where} must be an object.`);
    }
    const entry = value as Record<string, unknown>;
    const { path, sha256, bytes } = entry;
    if (typeof path !== 'string') throw new PersistError(`${where}.path must be a string.`);
    assertSafeRelativePath(path);
    if (seen.has(path)) {
      throw new PersistError(`${where}: duplicate path ${JSON.stringify(path)} in manifest.`);
    }
    seen.add(path);
    if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
      throw new PersistError(`${where}.sha256 must be a lowercase hex SHA-256.`);
    }
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) {
      throw new PersistError(`${where}.bytes must be a non-negative integer.`);
    }
    files.push({ path, sha256, bytes });
  }
  if (typeof record.rootHash !== 'string' || !SHA256_PATTERN.test(record.rootHash)) {
    throw new PersistError(`${source}: MANIFEST.json "rootHash" must be a lowercase hex SHA-256.`);
  }
  const rootHash = computeRootHash(files);
  if (rootHash !== record.rootHash) {
    throw new PersistError(
      `${source}: MANIFEST.json rootHash mismatch — manifest declares ${record.rootHash} but its ` +
        `file list hashes to ${rootHash}. The manifest was edited after sealing; re-bundle.`,
    );
  }
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, files, rootHash };
}
