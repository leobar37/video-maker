/**
 * `@videomaker/motion-remotion`: the Remotion motion kit.
 *
 * Sequencer (`Film`), scene registry (`SceneRenderer` + `registerScene`),
 * subtitle/caption primitives, device + camera primitives, brand tokens,
 * asset resolution and background helpers. Bespoke scene authoring stays
 * project code — the kit provides primitives and safe zones only.
 *
 * Node-side render tooling lives on subpaths so compositions never bundle it:
 *   - `@videomaker/motion-remotion/render-adapter`
 *   - `@videomaker/motion-remotion/loudness`
 */
export * from './assets';
export * from './background';
export * from './brand';
export * from './Caption';
export * from './DemoCamera';
export * from './Film';
export * from './PhoneMock';
export * from './SceneRenderer';
export * from './subtitle-segments';
export * from './Subtitles';
export * from './types';

// Type-only surface of the render pipeline (functions live on the subpath).
export type {
  FilmBundleOptions,
  FilmCompositionOptions,
  FilmRenderResult,
  FilmStillResult,
  RenderFilmStillOptions,
  RenderFilmVideoOptions,
} from './render-adapter';
export type {
  AudioNormalizationOptions,
  AudioNormalizationResult,
  ComplianceStats,
  CorrectionDecision,
  FfmpegResult,
  FfmpegRunner,
  LoudnessGate,
  LoudnormStats,
} from './loudness';
