/**
 * `hydrate` — hash-verified restore of a project FROM a bundle (FR-012).
 *
 * Reads `<bundle>/MANIFEST.json`, verifies the seal in three layers before a
 * single byte is written to the target:
 *   1. manifest shape + rootHash recomputed from its own file list,
 *   2. every sealed file present in the bundle,
 *   3. every sealed file's sha256 AND byte length matching its entry.
 *
 * Any mismatch/missing file refuses the restore (exit != 0) and names every
 * offending path with expected vs actual — the target dir is left untouched.
 * Extra files in the bundle (not sealed by MANIFEST.json) are refused too.
 *
 * Restore is idempotent: files already matching their entry are left alone,
 * so running twice produces the same tree with no rewrites. MANIFEST.json is
 * NEVER written into the target project (reserved bundle-only name).
 */
import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveInsideProject, sha256File, sha256Hex } from '@videomaker/core';

import { PersistError } from './errors';
import {
  MANIFEST_NAME,
  parseManifest,
  type BundleFileEntry,
  type BundleManifest,
} from './manifest';
import { collectProjectFiles } from './walk';

export interface HydrateResult {
  bundleDir: string;
  targetDir: string;
  fileCount: number;
  totalBytes: number;
  /** Sealed files (re)written into the target. */
  restored: string[];
  /** Sealed files already matching their entry (idempotent re-run). */
  unchanged: string[];
}

/** Reads + validates the bundle seal (shape and self-consistent rootHash). */
export async function readBundleManifest(bundleDir: string): Promise<BundleManifest> {
  const sealPath = join(bundleDir, MANIFEST_NAME);
  let raw: string;
  try {
    raw = await fsp.readFile(sealPath, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PersistError(
        `${bundleDir}: no ${MANIFEST_NAME} — not a bundle directory (run \`vm bundle\` first).`,
      );
    }
    throw cause;
  }
  return parseManifest(raw, sealPath);
}

/**
 * Verifies every sealed file in the bundle (existence, sha256, bytes) and that
 * nothing unsealed hides in the bundle dir. Returns the verified bytes.
 * Throws one PersistError listing EVERY problem found.
 */
async function verifyBundleContents(
  bundleDir: string,
  manifest: BundleManifest,
): Promise<Map<string, Uint8Array>> {
  const sealed = new Map<string, BundleFileEntry>(manifest.files.map((file) => [file.path, file]));
  const problems: string[] = [];
  const bytes = new Map<string, Uint8Array>();

  for (const entry of manifest.files) {
    const source = await resolveInsideProject(bundleDir, ...entry.path.split('/'));
    let data: Uint8Array;
    try {
      data = await fsp.readFile(source);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        problems.push(`${entry.path}: missing from the bundle (MANIFEST.json seals ${entry.bytes} bytes).`);
        continue;
      }
      throw cause;
    }
    const actual = sha256Hex(data);
    if (actual !== entry.sha256) {
      problems.push(`${entry.path}: sha256 mismatch (manifest ${entry.sha256}, bundle ${actual}).`);
    } else if (data.byteLength !== entry.bytes) {
      problems.push(`${entry.path}: byte length mismatch (manifest ${entry.bytes}, bundle ${data.byteLength}).`);
    } else {
      bytes.set(entry.path, data);
    }
  }

  const bundleEntries = await collectProjectFiles(bundleDir);
  for (const extra of bundleEntries) {
    if (!sealed.has(extra.path) && extra.path !== MANIFEST_NAME) {
      problems.push(`${extra.path}: present in the bundle but not sealed by MANIFEST.json.`);
    }
  }

  if (problems.length > 0) {
    throw new PersistError(
      `Bundle verification failed for ${bundleDir} — nothing was restored:\n` +
        problems.map((problem) => `  - ${problem}`).join('\n'),
    );
  }
  return bytes;
}

/**
 * Restores the bundle's sealed files into `targetDir` (created if missing).
 * Verifies first, writes after: a tampered bundle leaves the target intact.
 */
export async function hydrateBundle(bundleDir: string, targetDir: string): Promise<HydrateResult> {
  const manifest = await readBundleManifest(bundleDir);
  const verified = await verifyBundleContents(bundleDir, manifest);

  await fsp.mkdir(targetDir, { recursive: true });
  const restored: string[] = [];
  const unchanged: string[] = [];
  for (const entry of manifest.files) {
    const dest = await resolveInsideProject(targetDir, ...entry.path.split('/'));
    let already = false;
    try {
      const existing = await fsp.stat(dest);
      already = existing.isFile() && (await sha256File(dest)) === entry.sha256;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
    if (already) {
      unchanged.push(entry.path);
      continue;
    }
    await fsp.mkdir(dirname(dest), { recursive: true });
    await fsp.writeFile(dest, verified.get(entry.path)!);
    restored.push(entry.path);
  }

  return {
    bundleDir,
    targetDir,
    fileCount: manifest.files.length,
    totalBytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
    restored,
    unchanged,
  };
}
