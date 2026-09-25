/**
 * `bundle` — content-addressed project packaging (FR-012).
 *
 * Walks the project (documented exclusion policy, see `./policy`), hashes
 * every file and writes a bundle directory:
 *
 *   <out>/MANIFEST.json          — { schemaVersion, files[], rootHash }
 *   <out>/<project-relative...>  — byte-identical copies
 *
 * Default output dir: `<project>/../bundles/<slug>-<rootHashPrefix>/` with
 * `slug` = sanitized basename of the project and `rootHashPrefix` = first 12
 * hex chars of `rootHash`. `--out` overrides it and must live OUTSIDE the
 * project (a bundle nested in its subject would pollute the next walk).
 *
 * MANIFEST.json is written LAST: its presence marks a complete bundle. A
 * re-run over an identical bundle is a no-op; a dir holding a DIFFERENT
 * bundle (or unsealed content) is refused, never clobbered.
 *
 * Everything here is local disk I/O — no network, no credential resolution.
 */
import { promises as fsp } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { sha256File } from '@videomaker/core';

import { PersistError } from './errors';
import {
  computeRootHash,
  MANIFEST_NAME,
  MANIFEST_SCHEMA_VERSION,
  parseManifest,
  serializeManifest,
  type BundleFileEntry,
  type BundleManifest,
} from './manifest';
import { collectProjectFiles } from './walk';

/** Files + rootHash of one project: the pure input to a bundle. */
export interface BundleInventory {
  files: BundleFileEntry[];
  rootHash: string;
  totalBytes: number;
}

export interface BundleBuildResult {
  outDir: string;
  manifest: BundleManifest;
  fileCount: number;
  totalBytes: number;
  /** True when the bundle already existed byte-identical; nothing was rewritten. */
  reused: boolean;
  /** Paths actually (re)written on this run, project-relative. */
  written: string[];
}

/** File names safe for a default bundle dir slug; anything else becomes `-`. */
export function sanitizeSlug(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Default bundle dir: `<project>/../bundles/<slug>-<rootHashPrefix>/`. */
export function defaultBundleDir(projectDir: string, rootHash: string): string {
  const slug = sanitizeSlug(basename(projectDir));
  if (!slug) {
    throw new PersistError(`${projectDir}: cannot derive a bundle slug from the project path.`);
  }
  return join(dirname(projectDir), 'bundles', `${slug}-${rootHash.slice(0, 12)}`);
}

/**
 * Hashes every collected project file into a `BundleInventory`. Refuses a
 * project carrying a root MANIFEST.json (reserved bundle name — its own seal
 * would be unverifiable against it).
 */
export async function computeBundleInventory(projectDir: string): Promise<BundleInventory> {
  const collected = await collectProjectFiles(projectDir);
  const files: BundleFileEntry[] = [];
  let totalBytes = 0;
  for (const file of collected) {
    if (file.path === MANIFEST_NAME) {
      throw new PersistError(
        `${file.abs}: "${MANIFEST_NAME}" at the project root is reserved for bundle seals. ` +
          'Rename it (e.g. project-manifest.json) and re-run.',
      );
    }
    const [sha256, stat] = await Promise.all([sha256File(file.abs), fsp.stat(file.abs)]);
    files.push({ path: file.path, sha256, bytes: stat.size });
    totalBytes += stat.size;
  }
  return { files, rootHash: computeRootHash(files), totalBytes };
}

/** Refuses an output dir that would overlap its subject project. */
function assertOutsideProject(projectDir: string, outDir: string): void {
  const projectAbs = resolve(projectDir);
  const outAbs = resolve(outDir);
  const outInsideProject = relative(projectAbs, outAbs);
  const projectInsideOut = relative(outAbs, projectAbs);
  const escapes = (rel: string) => rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || resolve(rel) === rel;
  if (!escapes(outInsideProject) || !escapes(projectInsideOut)) {
    throw new PersistError(
      `${outDir}: bundle output must live outside the project directory (${projectDir}) — ` +
        'a bundle nested in its subject would pollute the next walk.',
    );
  }
}

/** Copies one file into the bundle unless an identical copy already exists. */
async function ensureCopy(src: string, dest: string, expectedSha256: string): Promise<boolean> {
  try {
    const existing = await fsp.stat(dest);
    if (existing.isFile() && (await sha256File(dest)) === expectedSha256) return false;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
  await fsp.mkdir(dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);
  return true;
}

/**
 * Builds the bundle directory for `projectDir` (inventory + copies + sealed
 * MANIFEST.json). Idempotent: an identical existing bundle is left untouched.
 */
export async function buildBundle(
  projectDir: string,
  opts: { outDir?: string } = {},
): Promise<BundleBuildResult> {
  const inventory = await computeBundleInventory(projectDir);
  const outDir = resolve(opts.outDir ?? defaultBundleDir(projectDir, inventory.rootHash));
  assertOutsideProject(projectDir, outDir);

  const manifest: BundleManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    files: inventory.files,
    rootHash: inventory.rootHash,
  };
  const manifestBytes = serializeManifest(manifest);

  let sealed: BundleManifest | undefined;
  let outEntries: string[] = [];
  try {
    outEntries = await fsp.readdir(outDir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
  if (outEntries.length > 0) {
    const sealPath = join(outDir, MANIFEST_NAME);
    let sealRaw: string | undefined;
    try {
      sealRaw = await fsp.readFile(sealPath, 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
    if (sealRaw === undefined) {
      throw new PersistError(
        `${outDir}: not empty and has no ${MANIFEST_NAME} (a half-written bundle?). Remove it ` +
          'or pass another --out; persistence never clobbers unsealed content.',
      );
    }
    sealed = parseManifest(sealRaw, sealPath);
    if (serializeManifest(sealed) !== manifestBytes) {
      throw new PersistError(
        `${outDir}: already holds a different bundle (rootHash ${sealed.rootHash}, this run ` +
          `is ${inventory.rootHash}). Choose another --out; bundles are immutable.`,
      );
    }
  }

  const written: string[] = [];
  for (const file of inventory.files) {
    const dest = await resolveSafeOutput(outDir, file.path);
    if (await ensureCopy(join(projectDir, file.path), dest, file.sha256)) written.push(file.path);
  }
  const sealPath = join(outDir, MANIFEST_NAME);
  let sealCurrent: string | undefined;
  try {
    sealCurrent = await fsp.readFile(sealPath, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
  if (sealCurrent !== manifestBytes) {
    await fsp.writeFile(sealPath, manifestBytes, 'utf8');
    written.push(MANIFEST_NAME);
  }

  return {
    outDir,
    manifest,
    fileCount: inventory.files.length,
    totalBytes: inventory.totalBytes,
    reused: sealed !== undefined && written.length === 0,
    written,
  };
}

/** Dest path for a manifest entry, kept strictly under `outDir`. */
async function resolveSafeOutput(outDir: string, relPath: string): Promise<string> {
  const dest = join(outDir, ...relPath.split('/'));
  const inside = relative(outDir, dest);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || resolve(inside) === inside) {
    throw new PersistError(`${relPath}: manifest path escapes the bundle output dir.`);
  }
  return dest;
}
