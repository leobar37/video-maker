import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';

import {
  cameraAt,
  planCamera,
  projectRect,
  type CameraPlan,
  type CameraProfile,
  type InteractionEvent,
  type SpaceTransform,
  type Viewport,
} from '@videomaker/motion-core';

/** A capture's interaction track (seconds-based, see `interactionsFromTimeline`). */
export interface DemoCameraTrack {
  viewport: Viewport;
  interactions: InteractionEvent[];
}

export interface DemoCameraProps {
  track: DemoCameraTrack;
  /**
   * Where the captured surface lands on the composition canvas — e.g.
   * `phoneScreenSpace()` from `PhoneMock.tsx`. Bboxes are projected through
   * this before planning, and the projected capture rect becomes `bounds`.
   */
  space: SpaceTransform;
  /** Same value the scene passes to `PhoneMock`'s `OffthreadVideo`. */
  playbackRate?: number;
  /** Capture-time offset of this scene's first frame (chunked captures). */
  captureStartSeconds?: number;
  profile?: Partial<CameraProfile>;
  children: React.ReactNode;
}

/**
 * Applies the directed camera plan to whatever scene content is passed as
 * `children` — the whole scene (background, halo, phone mock) scales and
 * travels together in composition coordinates, it does not crop inside the
 * device screen. `children` growing past the frame edge on a push-in is the
 * intended look, not a bug.
 *
 * Text overlays (wordmark, captions) must be rendered as SIBLINGS of
 * `DemoCamera`, never as `children` — the camera layer is not where
 * typography lives.
 */
export const DemoCamera: React.FC<DemoCameraProps> = ({
  track,
  space,
  playbackRate,
  captureStartSeconds,
  profile,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();

  const bounds = React.useMemo(
    () =>
      projectRect({ x: 0, y: 0, width: track.viewport.width, height: track.viewport.height }, space),
    [space.offsetX, space.offsetY, space.scale, track.viewport.width, track.viewport.height],
  );

  const plan: CameraPlan = React.useMemo(
    () =>
      planCamera({
        interactions: track.interactions.map((interaction) => ({
          ...interaction,
          bbox: projectRect(interaction.bbox, space),
        })),
        viewport: { width, height },
        bounds,
        fps,
        durationInFrames,
        playbackRate,
        captureStartSeconds,
        profile,
      }),
    [
      track,
      space.offsetX,
      space.offsetY,
      space.scale,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      width,
      height,
      fps,
      durationInFrames,
      playbackRate,
      captureStartSeconds,
      profile,
    ],
  );

  const camera = cameraAt(plan, frame);

  return (
    <AbsoluteFill
      style={{
        transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`,
        transformOrigin: '0 0',
      }}
    >
      {children}
    </AbsoluteFill>
  );
};
