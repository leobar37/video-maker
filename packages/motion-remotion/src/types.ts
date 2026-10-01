/**
 * Film contracts shared by the sequencer, the scene registry and project
 * compositions. Serializable on purpose: `FilmProps` travels as Remotion
 * `inputProps` between the CLI and the renderer as plain JSON.
 */

import type {
  CameraProfile,
  InteractionEvent,
  TimingMode,
  Viewport,
} from '@videomaker/motion-core';

import type { AssetManifestEntry } from './assets';
import type { BrandTokens } from './brand';

export type FilmSceneSource = 'demo-app' | 'motion' | 'fal-video' | 'avatar' | 'clip';

/**
 * One scene of a film. `intent` selects the renderer from the scene registry
 * (`registerScene`); `source` keeps the timing semantics (`'avatar'` ceils the
 * final frame boundary — see `@videomaker/motion-core`).
 *
 * Media is referenced either by manifest id (`assetId`, resolved through the
 * film's `AssetResolver`) or by a pre-resolved URL (`mediaSrc`). Scenes render
 * visuals only — `Film` owns all audio so a master can never be duplicated.
 */
export interface FilmScene {
  id: string;
  /** Registry key: which registered renderer draws this scene. */
  intent: string;
  source: FilmSceneSource;
  /** Short lower-third copy (rendered with `Caption`). */
  caption?: string;
  /** Narration text (used for on-screen copy and burned-in subtitles). */
  narration?: string;
  /** Total on-screen duration of the scene in seconds (drives frame count). */
  durationInSeconds: number;
  /** Primary media, by `AssetResolver` manifest id. */
  assetId?: string;
  /** Primary media as an already-resolved URL (alternative to `assetId`). */
  mediaSrc?: string;
  /** Real duration of the media, in seconds (playback-rate fitting). */
  mediaDurationSeconds?: number;
  mediaWidth?: number;
  mediaHeight?: number;
  /** Per-scene narration audio. Forbidden when `FilmProps.narration` is set. */
  audioSrc?: string;
  /** Real duration of the per-scene narration WAV, in seconds. */
  audioDurationSeconds?: number;
  /**
   * Directed-camera track for a captured surface, adapted from a capture
   * timeline via `interactionsFromTimeline`. `viewport` must match the CSS
   * viewport the capture was recorded at.
   */
  track?: { viewport: Viewport; interactions: InteractionEvent[] };
  /** Optional per-scene override for directed camera framing. */
  cameraProfile?: Partial<CameraProfile>;
  /**
   * Clip layout, consumed by clip intents only (`clip-vertical` takes
   * `'single'`, `clip-podcast` takes `'duo'`); ignored by every other intent.
   */
  layout?: 'single' | 'duo';
  /**
   * Face boxes from the clip analysis, consumed by clip intents only
   * (`clip-podcast` crops each half of the duo to one face). Bounding boxes
   * are `[x, y, w, h]` in normalized 0–1000 coordinates over the source
   * video frame; `presence` is the fraction of the clip the face is visible.
   * Ignored by every other intent.
   */
  faces?: ReadonlyArray<{
    id: string;
    bbox: [number, number, number, number];
    presence?: number;
  }>;
  /**
   * Burned-in subtitle segments for clip intents, in SECONDS relative to the
   * scene start: whisper `word_timestamps` clipped to the clip window and
   * packed into phrases (`subtitle-words`). Consumed by `clip-vertical` /
   * `clip-podcast` so the copy always follows the real speech timing.
   */
  subtitleSegments?: ReadonlyArray<{ text: string; start: number; end: number }>;
}

/** Scenes consume the film's brand tokens (warm canvas, accent, fonts). */
export type FilmBranding = BrandTokens;

/** The continuous narration master: ONE source played ONCE across the film. */
export interface FilmNarration {
  /** staticFile-relative path of the narration master (e.g. a WAV). */
  src: string;
  /** Real duration of the master, in seconds. */
  durationSeconds: number;
}

export type FilmProps = {
  width: number;
  height: number;
  fps: number;
  branding: FilmBranding;
  scenes: FilmScene[];
  /**
   * Continuous narration mode: ONE master narration source for the whole
   * video. Film plays it exactly once across the visual sequence and
   * per-scene `audioSrc` must be omitted. Legacy mode leaves this undefined
   * and every scene carries its own `audioSrc`.
   */
  narration?: FilmNarration;
  /**
   * Timing contract, SEPARATE from audio playback: `'continuous'` derives
   * scene frames from cumulative boundaries (cuts on rounded timestamps,
   * exact chaining); `'scene'` keeps legacy per-scene rounding. Still renders
   * pass `'continuous'` WITHOUT narration (a still plays no audio) so their
   * frame math matches the full render. Omitted with `narration` present also
   * implies `'continuous'` (backwards compatible).
   */
  timingMode?: TimingMode;
  /** Serializable asset manifest; scenes reference entries via `assetId`. */
  assets?: AssetManifestEntry[];
};
