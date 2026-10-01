/**
 * Workspace layout (contracts.md §4) and path-safety helpers. Every join
 * starts from kebab-validated ids, and every declared relative path is
 * re-validated with `isSafeRelativePath` plus a containment check before it
 * touches the filesystem.
 */
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

import { isSafeRelativePath } from '@videomaker/schemas';

import { fail } from './errors';

export function workspaceRoot(ctx: { workspaceDir: string }): string {
  return path.resolve(ctx.workspaceDir);
}

/** True when `candidateDir` equals or lives inside `parentDir` (no `..` escape). */
export function isInsideDir(parentDir: string, candidateDir: string): boolean {
  const rel = path.relative(path.resolve(parentDir), path.resolve(candidateDir));
  if (rel === '') return true;
  const first = rel.split(path.sep)[0];
  return first !== '..' && first !== undefined && !path.isAbsolute(rel);
}

/** Resolve a declared relative path inside `baseDir`, rejecting escapes. */
export function resolveInsideDir(baseDir: string, relPath: string, label: string): string {
  if (!isSafeRelativePath(relPath)) {
    fail('PATH_UNSAFE', `Ruta insegura declarada para ${label}.`, { path: relPath });
  }
  const abs = path.resolve(baseDir, relPath);
  if (!isInsideDir(baseDir, abs)) {
    fail('PATH_UNSAFE', `Ruta de ${label} escapa del directorio base.`, { path: relPath });
  }
  return abs;
}

export type PathKind = 'missing' | 'file' | 'directory' | 'symlink' | 'special';

/** lstat-based classification; symlinks are reported, never followed. */
export async function describePathKind(absPath: string): Promise<PathKind> {
  let stats;
  try {
    stats = await lstat(absPath);
  } catch {
    return 'missing';
  }
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  return 'special';
}

/**
 * Reject symlinked (or non-directory) intermediate components of a declared
 * file path: lstat on the final file would silently follow symlinked parents.
 */
export async function assertNoSymlinkComponents(baseDir: string, relPath: string, label: string): Promise<void> {
  const parts = relPath.replace(/\/+$/, '').split('/').filter((segment) => segment.length > 0);
  let current = path.resolve(baseDir);
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = path.join(current, parts[index] as string);
    const kind = await describePathKind(current);
    if (kind === 'missing') {
      fail('NOT_FOUND', `Componente ausente en la ruta de ${label} (la ruta declarada no existe).`, {
        path: relPath,
        component: parts[index],
      });
    }
    if (kind === 'symlink') {
      fail('PATH_UNSAFE', `Componente simbólico en la ruta de ${label}.`, { path: relPath, component: parts[index] });
    }
    if (kind !== 'directory') {
      fail('PATH_UNSAFE', `Componente inesperado (no directorio) en la ruta de ${label}.`, {
        path: relPath,
        component: parts[index],
      });
    }
  }
}
// ---------------------------------------------------------------------------

export function clientsRoot(root: string): string {
  return path.join(root, 'clients');
}
export function clientDir(root: string, clientId: string): string {
  return path.join(clientsRoot(root), clientId);
}
export function clientFile(root: string, clientId: string): string {
  return path.join(clientDir(root, clientId), 'client.json');
}
export function presetVersionsRoot(root: string, presetId: string): string {
  return path.join(root, 'presets', presetId, 'versions');
}
export function presetVersionDir(root: string, presetId: string, versionId: string): string {
  return path.join(presetVersionsRoot(root, presetId), versionId);
}
export function presetFile(root: string, presetId: string, versionId: string): string {
  return path.join(presetVersionDir(root, presetId, versionId), 'preset.json');
}
export function presetsRoot(root: string): string {
  return path.join(root, 'presets');
}
export function projectDir(root: string, projectId: string): string {
  return path.join(root, 'projects', projectId);
}
export function projectFile(root: string, projectId: string): string {
  return path.join(projectDir(root, projectId), 'project.json');
}
export function projectsRoot(root: string): string {
  return path.join(root, 'projects');
}
export function assetsRoot(root: string, projectId: string): string {
  return path.join(projectDir(root, projectId), 'assets');
}
export function assetDir(root: string, projectId: string, assetId: string): string {
  return path.join(assetsRoot(root, projectId), assetId);
}
export function assetFile(root: string, projectId: string, assetId: string): string {
  return path.join(assetDir(root, projectId, assetId), 'asset.json');
}
export function revisionsRoot(root: string, projectId: string, assetId: string): string {
  return path.join(root, 'revisions', projectId, assetId);
}
export function revisionDir(root: string, projectId: string, assetId: string, revisionId: string): string {
  return path.join(revisionsRoot(root, projectId, assetId), revisionId);
}
export function manifestFileOf(root: string, projectId: string, assetId: string, revisionId: string): string {
  return path.join(revisionDir(root, projectId, assetId, revisionId), 'manifest.json');
}
/** Sibling staging dir (same filesystem) so publishing is one atomic rename. */
export function stagingRevisionDir(root: string, projectId: string, assetId: string, revisionId: string): string {
  return path.join(revisionsRoot(root, projectId, assetId), `.staging-${revisionId}`);
}
export function checkpointsRoot(root: string, projectId: string): string {
  return path.join(root, 'checkpoints', projectId);
}
export function checkpointFileOf(root: string, projectId: string, checkpointId: string): string {
  return path.join(checkpointsRoot(root, projectId), `${checkpointId}.json`);
}
export function receiptFileOf(root: string, projectId: string, assetId: string, revisionId: string): string {
  return path.join(root, '.vm', 'receipts', projectId, assetId, `${revisionId}.json`);
}
/** Directory names pruned while expanding declared source/input directories. */
export const EXCLUDED_DIR_NAMES: Record<string, true> = {
  node_modules: true,
  '.git': true,
  '.vm': true,
  __pycache__: true,
  '.cache': true,
};
/** Regenerable junk files pruned from directory expansion. */
export const EXCLUDED_FILE_NAMES: Record<string, true> = { '.DS_Store': true, 'Thumbs.db': true };
export function assetLockFile(root: string, projectId: string, assetId: string): string {
  return path.join(root, '.vm', 'locks', `${projectId}--${assetId}.lock`);
}


export async function listDirNames(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export async function pathExists(absPath: string): Promise<boolean> {
  return (await describePathKind(absPath)) !== 'missing';
}
