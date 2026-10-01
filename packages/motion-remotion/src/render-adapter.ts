/**
 * Render adapter: encapsulates `bundle` → `selectComposition` → `renderMedia`
 * (h264) and `renderStill` from `@remotion/bundler` + `@remotion/renderer`.
 *
 * The video and the still paths share `selectFilmComposition` (same entry
 * point, same public dir, same webpack overrides, same input props), so a
 * still is guaranteed to sample the SAME composition the full render produces.
 * Loudness normalization is NOT part of rendering: it is a separate optional
 * stage (`AudioNormalizationOptions.enabled` gates it) run after `renderMedia`
 * through the injectable ffmpeg seam in `./loudness`.
 *
 * Node/Bun-side module: never imported by compositions (the barrel only
 * re-exports its types).
 */

import { bundle, type WebpackOverrideFn } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import type { VideoConfig } from 'remotion';

import {
  normalizeAudioLoudness,
  type AudioNormalizationOptions,
  type AudioNormalizationResult,
} from './loudness';

export const DEFAULT_COMPOSITION_ID = 'Film';

export interface FilmBundleOptions {
  /** Absolute path to the Remotion root entry (the module calling `registerRoot`). */
  entryPoint: string;
  /** Composition public directory (static assets). Injectable per project. */
  publicDir?: string;
  /** Webpack overrides merged into the Remotion bundle config. */
  webpackOverride?: WebpackOverrideFn;
  onBundleProgress?: (progress: number) => void;
}

export interface FilmCompositionOptions extends FilmBundleOptions {
  /** Composition id; defaults to `Film`. */
  compositionId?: string;
  /** Remotion input props (must be JSON-serializable). */
  inputProps?: Record<string, unknown>;
  /**
   * Expected composition length from the caller's shared timing plan. When
   * set, the adapter verifies `calculateMetadata` produced exactly these
   * frames BEFORE rendering — the still and video paths then provably consume
   * the same scene boundaries.
   */
  expectedDurationInFrames?: number;
}

export interface RenderFilmVideoOptions extends FilmCompositionOptions {
  /** Final mp4 path (h264/yuv420p). */
  outputLocation: string;
  concurrency?: number | null;
  /**
   * Per-frame `delayRender` budget (Remotion defaults to 30s). The clip
   * layouts decode several video layers per frame; the default aborts
   * mid-render and restarts the whole job, which dominated wall time.
   */
  timeoutInMilliseconds?: number;
  /**
   * Frame transfer format. Remotion defaults to lossless `png`, which is slow
   * to encode for 1080x1920 frames; `jpeg` is markedly faster and the frames
   * are re-encoded to h264 right after.
   */
  imageFormat?: 'png' | 'jpeg';
  jpegQuality?: number;
  /**
   * `OffthreadVideo` decode cache. A clip reuses ONE source file across every
   * frame, so a larger cache avoids re-decoding the same content.
   */
  offthreadVideoCacheSizeInBytes?: number;
  /**
   * Optional post-render loudness stage. The `enabled` flag is the gate:
   * omitted or false = the render is returned untouched.
   */
  audioNormalization?: AudioNormalizationOptions;
  onRenderProgress?: (progress: number) => void;
}

export interface RenderFilmStillOptions extends FilmCompositionOptions {
  /** Final PNG path. */
  output: string;
  /** Absolute composition frame to sample. */
  frame: number;
  /** Same `delayRender` budget as the video path (Remotion default is 30s). */
  timeoutInMilliseconds?: number;
}

export interface FilmRenderResult {
  serveUrl: string;
  composition: VideoConfig;
  outputLocation: string;
  audioNormalization: AudioNormalizationResult | null;
}

export interface FilmStillResult {
  serveUrl: string;
  composition: VideoConfig;
  output: string;
}

/** Bundle the composition once (webpack). */
export async function bundleFilm(options: FilmBundleOptions): Promise<{ serveUrl: string }> {
  const serveUrl = await bundle({
    entryPoint: options.entryPoint,
    publicDir: options.publicDir,
    webpackOverride: options.webpackOverride,
    onProgress: options.onBundleProgress,
  });
  return { serveUrl };
}

/**
 * Bundle + select the composition (running its `calculateMetadata`). Shared by
 * the video and the still paths — this is what makes them consume identical
 * scene boundaries.
 */
export async function selectFilmComposition(
  options: FilmCompositionOptions,
): Promise<{ serveUrl: string; composition: VideoConfig }> {
  const { serveUrl } = await bundleFilm(options);
  const composition = await selectComposition({
    serveUrl,
    id: options.compositionId ?? DEFAULT_COMPOSITION_ID,
    inputProps: options.inputProps,
  });
  if (
    options.expectedDurationInFrames !== undefined &&
    composition.durationInFrames !== options.expectedDurationInFrames
  ) {
    throw new Error(
      `FRAME_MATH_MISMATCH: composition reports ${composition.durationInFrames} frames but ` +
        `the shared timing plan expects ${options.expectedDurationInFrames}.`,
    );
  }
  return { serveUrl, composition };
}

/** Full render: shared pipeline → `renderMedia` (h264) → optional loudness stage. */
export async function renderFilmVideo(
  options: RenderFilmVideoOptions,
): Promise<FilmRenderResult> {
  const { serveUrl, composition } = await selectFilmComposition(options);
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    pixelFormat: 'yuv420p',
    outputLocation: options.outputLocation,
    inputProps: options.inputProps,
    concurrency: options.concurrency ?? null,
    timeoutInMilliseconds: options.timeoutInMilliseconds,
    imageFormat: options.imageFormat ?? 'png',
    jpegQuality: options.jpegQuality,
    offthreadVideoCacheSizeInBytes: options.offthreadVideoCacheSizeInBytes,
    onProgress: options.onRenderProgress
      ? ({ progress }) => options.onRenderProgress?.(progress)
      : undefined,
  });

  const audioNormalization = options.audioNormalization
    ? await normalizeAudioLoudness(options.outputLocation, options.audioNormalization)
    : null;

  return {
    serveUrl,
    composition,
    outputLocation: options.outputLocation,
    audioNormalization,
  };
}

/** Still render: the same pipeline up to `selectComposition`, then `renderStill`. */
export async function renderFilmStill(
  options: RenderFilmStillOptions,
): Promise<FilmStillResult> {
  const { serveUrl, composition } = await selectFilmComposition(options);
  await renderStill({
    composition,
    serveUrl,
    output: options.output,
    frame: options.frame,
    inputProps: options.inputProps,
    timeoutInMilliseconds: options.timeoutInMilliseconds,
  });
  return { serveUrl, composition, output: options.output };
}
