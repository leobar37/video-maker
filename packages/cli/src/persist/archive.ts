/**
 * `archive` — separates versionable text from storage binaries (FR-012).
 *
 * The regenerable/large binaries (media extensions — see `./policy`) upload to
 * an `ObjectStore` under content-addressed keys; the project keeps only the
 * provenance manifest `qa/archive.json` (object key ↔ local path ↔ sha256).
 * Local files are never deleted — git tracking of binaries is the operator's
 * call; the manifest is what version control carries in their place.
 *
 * Key convention (pure content address): `<prefix>/<sha256[0:2]>/<sha256>`.
 * The key is derived from content alone: identical bytes at two paths share
 * one object and upload once. Uploads are idempotent via `head` — an object
 * already holding the right bytes is skipped, never re-sent.
 *
 * `qa/archive.json` is a content-derived snapshot (sorted by path, no
 * timestamps): re-running without changes rewrites nothing. plan mode shows
 * the upload plan (hashes + keys) with ZERO store/credential access.
 */
import { promises as fsp } from 'node:fs';

import { projectPaths, resolveInsideProject, sha256File } from '@videomaker/core';

import { PersistError } from './errors';
import { contentTypeFor, isArchivableBinary } from './policy';
import { collectProjectFiles } from './walk';
import type { ArchiveStorage } from './storage-seam';

/** Project-relative location of the provenance manifest (kept in the project). */
export const ARCHIVE_MANIFEST_REL = 'qa/archive.json';
export const ARCHIVE_MANIFEST_SCHEMA_VERSION = 1;
export const DEFAULT_KEY_PREFIX = 'objects';

/** One provenance record: object key ↔ local path ↔ sha256. */
export interface ArchiveObjectRecord {
  path: string;
  key: string;
  sha256: string;
  bytes: number;
}

/** `qa/archive.json` — snapshot of the project's archived binaries. */
export interface ArchiveManifest {
  schemaVersion: typeof ARCHIVE_MANIFEST_SCHEMA_VERSION;
  objects: ArchiveObjectRecord[];
}

/** A selected binary plus everything an upload needs. */
export interface ArchiveObjectPlan extends ArchiveObjectRecord {
  abs: string;
  contentType: string;
}

export interface ArchiveRunResult {
  objects: ArchiveObjectRecord[];
  /** Keys uploaded on this run. */
  uploaded: string[];
  /** Keys already present with matching bytes (idempotent skip). */
  skipped: string[];
  totalBytes: number;
  manifestPath: string;
  manifestWritten: boolean;
}

/** Content-addressed object key: a pure function of the sha256. */
export function archiveKeyFor(keyPrefix: string, sha256: string): string {
  return `${keyPrefix}/${sha256.slice(0, 2)}/${sha256}`;
}

/** Canonical `qa/archive.json` bytes: sorted by path, 2-space JSON + newline. */
export function serializeArchiveManifest(manifest: ArchiveManifest): string {
  const objects = [...manifest.objects].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return `${JSON.stringify({ schemaVersion: manifest.schemaVersion, objects }, null, 2)}\n`;
}

/**
 * Selects the project's archivable binaries and derives their keys. Local
 * disk only — safe for plan mode (no store, no credentials, no network).
 */
export async function computeArchiveInventory(
  projectDir: string,
  opts: { keyPrefix?: string } = {},
): Promise<ArchiveObjectPlan[]> {
  const keyPrefix = opts.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const collected = await collectProjectFiles(projectDir);
  const inventory: ArchiveObjectPlan[] = [];
  for (const file of collected) {
    if (!isArchivableBinary(file.path)) continue;
    const [sha256, stat] = await Promise.all([sha256File(file.abs), fsp.stat(file.abs)]);
    inventory.push({
      path: file.path,
      abs: file.abs,
      key: archiveKeyFor(keyPrefix, sha256),
      sha256,
      bytes: stat.size,
      contentType: contentTypeFor(file.path),
    });
  }
  return inventory;
}

/**
 * Uploads the inventory to the store (idempotent per content-addressed key)
 * and seals the provenance manifest into the project. The manifest is written
 * only after every upload is confirmed by the store's returned metadata.
 */
export async function runArchive(
  projectDir: string,
  storage: ArchiveStorage,
  opts: { keyPrefix?: string } = {},
): Promise<ArchiveRunResult> {
  const inventory = await computeArchiveInventory(projectDir, opts);
  const byKey = new Map<string, ArchiveObjectPlan>();
  for (const object of inventory) {
    if (!byKey.has(object.key)) byKey.set(object.key, object);
  }

  const uploaded: string[] = [];
  const skipped: string[] = [];
  for (const object of byKey.values()) {
    const existing = await storage.store.head(object.key, storage.ctx);
    if (existing) {
      assertStoredBytes(existing, object);
      skipped.push(object.key);
      continue;
    }
    const data = await fsp.readFile(object.abs);
    const meta = await storage.store.put(
      object.key,
      data,
      { contentType: object.contentType },
      storage.ctx,
    );
    assertStoredBytes(meta, object);
    uploaded.push(object.key);
  }

  const manifest: ArchiveManifest = {
    schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION,
    objects: inventory.map(({ path, key, sha256, bytes }) => ({ path, key, sha256, bytes })),
  };
  const manifestPath = await resolveInsideProject(
    projectDir,
    ...ARCHIVE_MANIFEST_REL.split('/'),
  );
  const manifestBytes = serializeArchiveManifest(manifest);
  let current: string | undefined;
  try {
    current = await fsp.readFile(manifestPath, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
  const manifestWritten = current !== manifestBytes;
  if (manifestWritten) {
    await fsp.mkdir(projectPaths(projectDir).qaDir, { recursive: true });
    await fsp.writeFile(manifestPath, manifestBytes, 'utf8');
  }

  return {
    objects: manifest.objects,
    uploaded,
    skipped,
    totalBytes: inventory.reduce((sum, object) => sum + object.bytes, 0),
    manifestPath,
    manifestWritten,
  };
}

/** The store must account for the exact bytes before provenance is sealed. */
function assertStoredBytes(
  meta: { key: string; bytes: number; sha256?: string },
  object: ArchiveObjectPlan,
): void {
  if (meta.bytes !== object.bytes) {
    throw new PersistError(
      `${object.path}: store reports ${meta.bytes} bytes for ${object.key} but the local file ` +
        `has ${object.bytes}. Upload/verify failed — qa/archive.json was not sealed.`,
    );
  }
  if (meta.sha256 !== undefined && meta.sha256 !== object.sha256) {
    throw new PersistError(
      `${object.path}: store reports sha256 ${meta.sha256} for ${object.key} but the local file ` +
        `hashes to ${object.sha256}. Upload/verify failed — qa/archive.json was not sealed.`,
    );
  }
}
