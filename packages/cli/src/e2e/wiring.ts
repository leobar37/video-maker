/**
 * Demo-project runtime wiring: `MediaCommandDeps` for a project whose
 * composition lives OUTSIDE a workspace package (bare `remotion`/`react`
 * imports resolve through the motion kit's node_modules, exactly like
 * `motion-still.ts` bundles it) and whose $0 music library lives inside the
 * project. Provider/credential seams stay the production ones: they resolve
 * lazily at submit time in run mode (NFR-002: planning never touches them).
 */
import { join, resolve } from 'node:path';

import {
  renderFilmStill,
  renderFilmVideo,
  type RenderFilmStillOptions,
  type RenderFilmVideoOptions,
} from '@videomaker/motion-remotion/render-adapter';

import { defaultMediaDeps, type MediaCommandDeps } from '../pipeline/deps';

import { demoMusicLibraryPaths } from './music-bed';

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..');
const KIT_NODE_MODULES = join(REPO_ROOT, 'packages', 'motion-remotion', 'node_modules');
const REPO_NODE_MODULES = join(REPO_ROOT, 'node_modules');

/** Structural slice of webpack's config this override touches. */
interface WebpackConfigLike {
  resolve?: { modules?: unknown[] };
  [key: string]: unknown;
}

/**
 * Webpack resolution shim for the demo composition: its bare imports must
 * resolve to the kit's node_modules (the demo project is not a workspace
 * package).
 */
export function demoWebpackOverride(config: WebpackConfigLike): WebpackConfigLike {
  return {
    ...config,
    resolve: {
      ...config.resolve,
      modules: [
        KIT_NODE_MODULES,
        REPO_NODE_MODULES,
        'node_modules',
        ...(config.resolve?.modules ?? []),
      ],
    },
  };
}

// `@remotion/bundler`'s `WebpackOverrideFn` config type is not resolvable from
// this package; the override is structural, so one bounded cast documents the
// seam instead of dragging webpack's types in.
const webpackOverride = demoWebpackOverride as unknown as RenderFilmVideoOptions['webpackOverride'];

/**
 * Production deps with the two demo seams injected: the render adapter gets
 * the bundling override (or the composition never bundles) and the music
 * library points at the project-local registry the $0 reuse path consumes.
 */
export function buildDemoMediaDeps(
  projectDir: string,
  out: (line: string) => void,
): MediaCommandDeps {
  return defaultMediaDeps({
    render: {
      renderVideo: (options: RenderFilmVideoOptions) =>
        renderFilmVideo({ ...options, webpackOverride }),
      renderStill: (options: RenderFilmStillOptions) =>
        renderFilmStill({ ...options, webpackOverride }),
    },
    musicLibrary: () => demoMusicLibraryPaths(projectDir),
    log: out,
  });
}
