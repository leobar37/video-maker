/**
 * Canonical path resolution under a trusted root (a projects root or a single
 * project directory).
 *
 * Every path handed to the pipeline is built from validated segments: absolute
 * segments, `.`/`..`, empty segments, backslashes and symlink escapes are
 * rejected with a typed `PathTraversalError`. Symlink checking walks the
 * existing prefix with `realpath`; missing trailing components are allowed only
 * under an already verified ancestor. This is a local-cooperation boundary, not
 * protection against hostile filesystem swaps.
 */
import { promises as fsp } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** A requested path tried to leave its root (absolute, `..` or symlink escape). */
export class PathTraversalError extends Error {
  constructor(
    message: string,
    /** The offending segment (or full requested fragment) as given by the caller. */
    public readonly segment: string,
  ) {
    super(message);
    this.name = 'PathTraversalError';
  }
}

function validateSegments(segments: readonly string[]): string[] {
  const parts: string[] = [];
  for (const segment of segments) {
    if (typeof segment !== 'string' || segment.length === 0) {
      throw new PathTraversalError('Empty path segment.', String(segment));
    }
    if (segment.includes('\0')) {
      throw new PathTraversalError('Path segment contains a null byte.', segment);
    }
    if (segment.includes('\\')) {
      throw new PathTraversalError(
        'Path segment contains a backslash; project paths use "/" separators.',
        segment,
      );
    }
    for (const part of segment.split('/')) {
      if (part === '' || part === '.' || part === '..') {
        throw new PathTraversalError(`Unsafe path segment ${JSON.stringify(part)}.`, segment);
      }
      if (isAbsolute(part) || /^[a-zA-Z]:/.test(part)) {
        throw new PathTraversalError('Absolute path segments are not allowed.', segment);
      }
      parts.push(part);
    }
  }
  return parts;
}

/**
 * Resolves `segments` inside `root`, rejecting anything that escapes it.
 * The root itself may be a symlink; every existing component below it may not
 * resolve outside of it. Returns an absolute path; the leaf does not need to
 * exist yet.
 */
async function resolveContained(root: string, segments: readonly string[]): Promise<string> {
  const parts = validateSegments(segments);
  // Canonicalize the root first so component checks compare like with like.
  const resolvedRoot = await fsp.realpath(resolve(root));
  let candidate = resolvedRoot;
  for (const part of parts) {
    candidate = join(candidate, part);
    let exists = true;
    try {
      await fsp.lstat(candidate);
    } catch (cause) {
      if (!(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT')) {
        throw cause;
      }
      exists = false;
    }
    if (!exists) {
      // Nothing exists below a missing component, so no symlink can hide there.
      continue;
    }
    let resolved: string;
    try {
      resolved = await fsp.realpath(candidate);
    } catch (cause) {
      // Dangling symlink: cannot prove it stays inside, so refuse it.
      throw new PathTraversalError(
        `Could not resolve project path component ${JSON.stringify(part)}.`,
        part,
      );
    }
    const inside = relative(resolvedRoot, resolved);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new PathTraversalError(
        `Path escapes the root through a symlink: ${JSON.stringify(part)}.`,
        part,
      );
    }
    candidate = resolved;
  }
  return candidate;
}

/**
 * Resolves project-relative `segments` under the canonical `projectsRoot`
 * (which must exist). With no segments the canonical root itself is returned.
 */
export async function resolveProjectPath(
  projectsRoot: string,
  ...segments: string[]
): Promise<string> {
  return resolveContained(projectsRoot, segments);
}

/**
 * Resolves `segments` inside a single project directory (which must exist).
 * Same containment rules as `resolveProjectPath`, scoped to the project.
 */
export async function resolveInsideProject(
  projectDir: string,
  ...segments: string[]
): Promise<string> {
  return resolveContained(projectDir, segments);
}
