/**
 * Project walk for persistence: collects regular files under a project dir,
 * applying the documented exclusion policy (`./policy`) and refusing symlinks
 * and secret-looking paths with actionable errors.
 */
import { promises as fsp } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { PersistError } from './errors';
import { assertNotSecretPath, isExcludedPath } from './policy';

/** One collected file: project-relative `path` (`/` separators) + absolute path. */
export interface CollectedFile {
  path: string;
  abs: string;
}

/**
 * Recursively collects the project's regular files, sorted by `path`.
 * Excluded directories are not descended into; excluded files are skipped.
 * Symlinks, sockets etc. are refused — a bundle must reflect real bytes.
 */
export async function collectProjectFiles(projectDir: string): Promise<CollectedFile[]> {
  const root = projectDir;
  const out: CollectedFile[] = [];

  const visit = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new PersistError(`Project directory does not exist: ${root}`);
      }
      throw cause;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (isExcludedPath(rel)) continue;
      assertNotSecretPath(rel);
      if (entry.isSymbolicLink()) {
        throw new PersistError(
          `${abs}: symlinks are refused in persistence (the bundle must reflect real bytes). ` +
            'Replace it with a real file/directory and re-run.',
        );
      }
      if (entry.isDirectory()) {
        await visit(abs);
      } else if (entry.isFile()) {
        out.push({ path: rel, abs });
      } else {
        throw new PersistError(`${abs}: unsupported file type (only regular files/directories).`);
      }
    }
  };

  await visit(root);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
