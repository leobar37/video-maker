import React from 'react';
import {
  AbsoluteFill,
  Audio,
  interpolate,
  Series,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

import { filmTimingPlan } from '@videomaker/motion-core';

import { AssetResolver } from './assets';
import { SceneRenderer, type SceneRendererComponent } from './SceneRenderer';
import type { FilmBranding, FilmProps, FilmScene } from './types';

/**
 * Wraps a scene with a gentle opacity/scale ramp at its first and last few
 * frames — reads as a soft cross-dip between scenes without touching the
 * summed-duration math in Root's calculateMetadata.
 */
const SceneTransition: React.FC<{
  durationInFrames: number;
  isFirst: boolean;
  isLast: boolean;
  children: React.ReactNode;
}> = ({ durationInFrames, isFirst, isLast, children }) => {
  const frame = useCurrentFrame();
  const rampFrames = Math.max(4, Math.min(12, Math.floor(durationInFrames / 6)));
  const enterOpacity = isFirst
    ? 1
    : interpolate(frame, [0, rampFrames], [0.55, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });
  const exitOpacity = isLast
    ? 1
    : interpolate(frame, [durationInFrames - rampFrames, durationInFrames - 1], [1, 0.55], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });
  const enterScale = isFirst
    ? 1
    : interpolate(frame, [0, rampFrames], [0.985, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });
  const exitScale = isLast
    ? 1
    : interpolate(frame, [durationInFrames - rampFrames, durationInFrames - 1], [1, 0.985], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });
  return (
    <AbsoluteFill
      style={{
        opacity: Math.min(enterOpacity, exitOpacity),
        transform: `scale(${Math.min(enterScale, exitScale)})`,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

/**
 * Sequencer: every scene back to back, exact-chaining frame spans from the
 * shared timing plan (`filmTimingPlan`), soft transitions at the cuts and the
 * audio master played exactly once.
 *
 * Audio semantics — never duplicated:
 *   - `FilmProps.narration` = ONE continuous narration master played across
 *     the whole sequence (frame 0 → its stop frame). Per-scene `audioSrc` must
 *     be omitted in this mode (enforced below).
 *   - Legacy mode: each scene's own `audioSrc` plays inside its sequence.
 *
 * Scene visuals come from the scene registry (`SceneRenderer`, dispatch by
 * `scene.intent`) unless a `SceneView` renderer is injected explicitly.
 */
export const Film: React.FC<FilmProps & { SceneView?: SceneRendererComponent }> = ({
  branding,
  scenes,
  narration,
  timingMode,
  assets: assetManifest,
  SceneView,
}) => {
  const { fps, durationInFrames: compositionFrames } = useVideoConfig();
  const assets = React.useMemo(
    () => new AssetResolver(assetManifest ?? [], { toUrl: staticFile }),
    [assetManifest],
  );

  if (narration && scenes.some((scene) => scene.audioSrc)) {
    throw new Error(
      'DUPLICATE_AUDIO: FilmProps.narration plays the continuous master once; ' +
        'per-scene audioSrc must be omitted in continuous narration mode.',
    );
  }

  const plan = filmTimingPlan({
    fps,
    scenes: scenes.map((scene) => ({
      durationInSeconds: scene.durationInSeconds,
      source: scene.source,
    })),
    timingMode,
    narration: narration ? { durationSeconds: narration.durationSeconds } : null,
  });

  if (scenes.some((scene) => scene.source === 'avatar')) {
    if (plan.timingMode !== 'continuous' || !narration) {
      throw new Error(
        'AVATAR_TIMING_UNSUPPORTED: avatar scenes require continuous timing and a single ' +
          'FilmProps.narration master (the audio-driven footage must never be re-timed).',
      );
    }
    if (compositionFrames !== plan.totalFrames) {
      throw new Error(
        'AVATAR_FRAMES_MISMATCH: Root.calculateMetadata must derive durationInFrames from ' +
          'the shared frame math (filmTimingPlan / filmDurationInFrames) to preserve the ' +
          'full tail of the master.',
      );
    }
  }

  const SceneViewComponent = SceneView ?? SceneRenderer;

  return (
    <AbsoluteFill>
      {/* Continuous narration: the master voice plays ONCE across the whole
          sequence (frame 0, full duration). Per-scene Audio stays suppressed
          because narration mode forbids scene.audioSrc (checked above). */}
      {narration ? (
        <Audio src={staticFile(narration.src)} endAt={plan.narrationEndFrame ?? plan.totalFrames} />
      ) : null}
      <Series>
        {scenes.map((scene: FilmScene, index: number) => {
          const span = plan.spans[index]!;
          return (
            <Series.Sequence
              key={scene.id}
              durationInFrames={span.durationInFrames}
              style={
                scene.source === 'avatar'
                  ? // CSS custom property: subtitles sit higher over avatar footage.
                    ({ '--subtitle-bottom': '400px' } as React.CSSProperties)
                  : undefined
              }
            >
              {!narration && scene.audioSrc ? (
                <Audio src={staticFile(scene.audioSrc)} />
              ) : null}
              <SceneTransition
                durationInFrames={span.durationInFrames}
                isFirst={index === 0}
                isLast={index === scenes.length - 1}
              >
                <SceneViewComponent
                  scene={scene}
                  branding={branding}
                  assets={assets}
                  span={span}
                />
              </SceneTransition>
            </Series.Sequence>
          );
        })}
      </Series>
    </AbsoluteFill>
  );
};
