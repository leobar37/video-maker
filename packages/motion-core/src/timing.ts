/**
 * Timing contracts for a film: how scene durations in seconds become the
 * exact frame spans every consumer (sequencer, video render, still render)
 * shares. Pure arithmetic — no React, no Remotion, no I/O.
 *
 * Two timing contracts:
 *   - `'continuous'` derives scene frames from cumulative boundaries (cuts on
 *     rounded timestamps, sum == the film's total frame count). This is the
 *     contract for continuous narration: ONE master audio track plays across
 *     the whole sequence and the cuts must chain exactly, with no gaps and no
 *     overlaps, so the narration never drifts against the visuals.
 *   - `'scene'` keeps the historical per-scene rounding
 *     (`Math.max(1, Math.round(d * fps))`).
 *
 * `filmTimingPlan` is the single authority both the render and the still path
 * consume; `stillTimingInput` derives a no-audio input for stills so both
 * paths compute IDENTICAL scene boundaries.
 */

import {
  filmSceneFrames,
  sceneFinalBoundary,
  type FinalBoundary,
} from './frames';

export type TimingMode = 'scene' | 'continuous';

/** Minimum timing input for one scene: what drives its frame count. */
export interface TimingScene {
  /** Total on-screen duration of the scene in seconds. */
  durationInSeconds: number;
  /**
   * Scene source tag. `'avatar'` scenes opt the film into `ceil` final
   * boundary semantics (see `sceneFinalBoundary`); any other value keeps the
   * historical `round` boundary. Optional here; typed `FilmSceneSource` in
   * the Remotion layer.
   */
  source?: string;
}

export interface TimingNarration {
  /** Real duration of the continuous narration master, in seconds. */
  durationSeconds: number;
}

export interface TimingInput {
  fps: number;
  scenes: readonly TimingScene[];
  /**
   * Explicit timing contract. Omitted: `'continuous'` when a narration master
   * is present, `'scene'` otherwise.
   */
  timingMode?: TimingMode;
  /**
   * Continuous narration master. Present = it plays exactly ONCE across the
   * whole sequence and per-scene audio must be omitted.
   */
  narration?: TimingNarration | null;
}

/** Half-open frame span `[startFrame, endFrame)` of one scene. */
export interface SceneSpan {
  /** Index of the scene in input order. */
  index: number;
  /** Inclusive start frame. */
  startFrame: number;
  /** Exclusive end frame. */
  endFrame: number;
  durationInFrames: number;
}

export interface TimingPlan {
  /** Resolved contract (explicit or implied by narration). */
  timingMode: TimingMode;
  finalBoundary: FinalBoundary;
  /** Per-scene frame counts, in input order. */
  sceneFrames: number[];
  /** Spans chain exactly: `spans[i].endFrame === spans[i + 1].startFrame`. */
  spans: SceneSpan[];
  totalFrames: number;
  /**
   * Frame at which the narration master stops. Equals `totalFrames` when the
   * final boundary is `ceil` (preserve every PCM sample), otherwise
   * `max(1, round(durationSeconds * fps))`. `null` when there is no narration.
   */
  narrationEndFrame: number | null;
}

/** Resolved timing contract: explicit wins; narration implies `'continuous'`. */
export function resolveTimingMode(input: TimingInput): TimingMode {
  return input.timingMode ?? (input.narration ? 'continuous' : 'scene');
}

/**
 * The single frame-math authority for a film. Validates the input, then
 * derives per-scene frames, exact-chaining spans, the total frame count and
 * the narration stop frame from the shared `frames` math.
 *
 * Throws on invalid fps/durations (see `cumulativeSceneFrames`) and on an
 * empty film — a composition needs at least one scene to be meaningful.
 */
export function filmTimingPlan(input: TimingInput): TimingPlan {
  const { fps, scenes } = input;
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`filmTimingPlan: fps inválido (${fps}).`);
  }
  if (scenes.length === 0) {
    throw new Error('filmTimingPlan: el film no tiene escenas.');
  }
  scenes.forEach((scene, index) => {
    if (!Number.isFinite(scene.durationInSeconds) || scene.durationInSeconds <= 0) {
      throw new Error(
        `filmTimingPlan: duración inválida en la escena ${index} (${scene.durationInSeconds}s).`,
      );
    }
  });
  if (input.narration !== undefined && input.narration !== null) {
    const seconds = input.narration.durationSeconds;
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(`filmTimingPlan: duración de narración inválida (${seconds}s).`);
    }
  }

  const timingMode = resolveTimingMode(input);
  const finalBoundary = sceneFinalBoundary(
    scenes.map((scene) => ({ source: scene.source ?? '' })),
  );
  const sceneFrames = filmSceneFrames(
    scenes.map((scene) => scene.durationInSeconds),
    fps,
    timingMode,
    { finalBoundary },
  );

  const spans: SceneSpan[] = [];
  let cursor = 0;
  sceneFrames.forEach((durationInFrames, index) => {
    const startFrame = cursor;
    cursor += durationInFrames;
    spans.push({ index, startFrame, endFrame: cursor, durationInFrames });
  });
  const totalFrames = cursor;

  const narrationEndFrame = input.narration
    ? finalBoundary === 'ceil'
      ? totalFrames
      : Math.max(1, Math.round(input.narration.durationSeconds * fps))
    : null;

  return { timingMode, finalBoundary, sceneFrames, spans, totalFrames, narrationEndFrame };
}

/**
 * Derive the still-render timing input from the full-render input.
 *
 * A still plays no audio, so the narration master is dropped — but the timing
 * contract (explicit or implied) is preserved, which guarantees the still and
 * the full render consume IDENTICAL scene boundaries.
 */
export function stillTimingInput(input: TimingInput): TimingInput {
  return {
    fps: input.fps,
    scenes: input.scenes,
    timingMode: resolveTimingMode(input),
    narration: null,
  };
}
