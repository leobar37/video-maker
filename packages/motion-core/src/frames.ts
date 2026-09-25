/**
 * Pure frame math shared by the Remotion `Film` sequencer and the render
 * pipeline (video/still offset math). No React/Remotion imports on purpose.
 */

export type FinalBoundary = 'round' | 'ceil';

/** Avatar projects preserve the entire master; existing non-avatar timelines stay unchanged. */
export function sceneFinalBoundary(scenes: readonly { source: string }[]): FinalBoundary {
  return scenes.some((scene) => scene.source === 'avatar') ? 'ceil' : 'round';
}

/** Ignore only floating-point noise near an integer, never a meaningful audio sample. */
export function coveringFrameCount(seconds: number, fps: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(fps) || fps <= 0) {
    throw new Error('coveringFrameCount: duración/fps inválidos.');
  }
  const frames = seconds * fps;
  const epsilon = Number.EPSILON * Math.max(1, Math.abs(frames)) * 8;
  return Math.ceil(frames - epsilon);
}

/** Shared Root calculateMetadata authority; preserves the historical round for legacy. */
export function filmDurationInFrames(
  scenes: readonly { source: string; durationInSeconds: number }[],
  fps: number,
): number {
  const seconds = scenes.reduce((total, scene) => total + scene.durationInSeconds, 0);
  return sceneFinalBoundary(scenes) === 'ceil'
    ? Math.max(1, coveringFrameCount(seconds, fps))
    : Math.max(1, Math.round(seconds * fps));
}

/** Render-only final-frame coverage, including older Roots that round sum(props).
 * Never modifies semantic audio bindings or prepared source assets. Internal cuts
 * remain unchanged; only the final visual slot gains less than one frame. */
export function coverFinalSceneFrame<T extends { source: string; durationInSeconds: number }>(
  scenes: T[],
  fps: number,
): T[] {
  if (sceneFinalBoundary(scenes) !== 'ceil') return scenes;
  const seconds = scenes.reduce((total, scene) => total + scene.durationInSeconds, 0);
  const paddingSeconds = Math.max(0, coveringFrameCount(seconds, fps) / fps - seconds);
  return scenes.map((scene, index) =>
    index === scenes.length - 1
      ? { ...scene, durationInSeconds: scene.durationInSeconds + paddingSeconds }
      : scene,
  );
}

/**
 * Internal cuts round cumulative boundaries, eliminating per-scene rounding drift.
 * The final boundary defaults to round(total * fps); avatar projects opt into ceil
 * so the composition and its single master Audio retain every real PCM sample.
 *
 * Used by continuous narration mode; legacy per-scene mode keeps its
 * historical `Math.max(1, Math.round(d * fps))` behavior.
 *
 * Throws on invalid input (non-positive fps/durations) and on a scene whose
 * cumulative boundary does not advance at least one frame — a sub-frame scene
 * would break the exact-sum guarantee, and silently clamping it to 1 frame
 * would be a false claim. Normal flows (timings > 0.05s, fps ≥ 1) always
 * advance.
 */
export function cumulativeSceneFrames(
  durationsSeconds: number[],
  fps: number,
  options: { finalBoundary?: FinalBoundary } = {},
): number[] {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`cumulativeSceneFrames: fps inválido (${fps}).`);
  }
  const frames: number[] = [];
  let previousBoundary = 0;
  let accumulatedSeconds = 0;
  durationsSeconds.forEach((duration, index) => {
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error(
        `cumulativeSceneFrames: duración inválida en la escena ${index} (${duration}s).`,
      );
    }
    accumulatedSeconds += duration;
    const boundary =
      options.finalBoundary === 'ceil' && index === durationsSeconds.length - 1
        ? coveringFrameCount(accumulatedSeconds, fps)
        : Math.round(accumulatedSeconds * fps);
    if (boundary <= previousBoundary) {
      throw new Error(
        `cumulativeSceneFrames: la escena ${index} (${duration}s, acumulado ` +
          `${accumulatedSeconds.toFixed(3)}s) no avanza ni 1 frame a ${fps}fps ` +
          `(boundary ${boundary} <= ${previousBoundary}). Una escena sub-frame rompería ` +
          `la suma exacta; acortá el video o subí el fps.`,
      );
    }
    frames.push(boundary - previousBoundary);
    previousBoundary = boundary;
  });
  return frames;
}

/** Per-scene frame counts for a whole film, choosing the math by timing
 *  contract: cumulative boundaries for `'continuous'`, the historical
 *  per-scene rounding for `'scene'`. */
export function filmSceneFrames(
  durationsSeconds: number[],
  fps: number,
  timingMode: 'scene' | 'continuous',
  options: { finalBoundary?: FinalBoundary } = {},
): number[] {
  if (timingMode === 'continuous') return cumulativeSceneFrames(durationsSeconds, fps, options);
  return durationsSeconds.map((d) => Math.max(1, Math.round(d * fps)));
}
