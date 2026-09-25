import React from 'react';
import { interpolate, OffthreadVideo, useCurrentFrame } from 'remotion';

import type { SpaceTransform, Viewport } from '@videomaker/motion-core';

export const PHONE = {
  top: 250,
  totalHeight: 1340,
  bezel: 16,
  radius: 62,
  screenAspect: 390 / 844,
};

/**
 * Where the captured surface (the device screen, inside the bezel) lands on
 * the composition canvas, for a phone mock rendered at `PHONE`'s fixed
 * geometry and horizontally centred. Used by `DemoCamera` to project capture
 * bboxes (and to compute `bounds`) into composition coordinates. Scale is
 * derived from the actual capture `viewport` width, not the hardcoded
 * `screenAspect`, so it stays correct if a capture is not exactly 390x844.
 */
export function phoneScreenSpace(compositionWidth: number, viewport: Viewport): SpaceTransform {
  const screenHeight = PHONE.totalHeight - PHONE.bezel * 2;
  const screenWidth = screenHeight * (viewport.width / viewport.height);
  const totalWidth = screenWidth + PHONE.bezel * 2;
  const left = (compositionWidth - totalWidth) / 2;
  return {
    offsetX: left + PHONE.bezel,
    offsetY: PHONE.top + PHONE.bezel,
    scale: screenWidth / viewport.width,
  };
}

/**
 * Pure-CSS phone mock (rounded shell, notch, shadow) with the capture inside.
 * Adds a slow zoom + pan drift over the scene's lifetime so the frame never
 * feels static, while keeping the app content fully readable. Set `drift` to
 * `false` when a `DemoCamera` is already directing the shot — layering the
 * ambient drift under a directed move fights it instead of adding life.
 *
 * `src` must already be a playable URL (resolve it through the film's
 * `AssetResolver`, or Remotion's `staticFile`).
 */
export const PhoneMock: React.FC<{
  src: string;
  playbackRate: number;
  durationInFrames: number;
  /** Brand accent used for the halo behind the phone (rgba color). */
  haloColor: string;
  /** Defaults to `true` — unchanged behaviour for scenes with no directed camera. */
  drift?: boolean;
}> = ({ src, playbackRate, durationInFrames, haloColor, drift = true }) => {
  const frame = useCurrentFrame();
  const screenHeight = PHONE.totalHeight - PHONE.bezel * 2;
  const screenWidth = screenHeight * PHONE.screenAspect;
  const totalWidth = screenWidth + PHONE.bezel * 2;

  const progress = durationInFrames > 0 ? Math.min(1, frame / durationInFrames) : 0;
  const driftScale = drift ? interpolate(progress, [0, 1], [1, 1.045]) : 1;
  const driftY = drift ? interpolate(progress, [0, 1], [0, -16]) : 0;

  return (
    <div
      style={{
        position: 'absolute',
        top: PHONE.top,
        left: '50%',
        width: totalWidth,
        height: PHONE.totalHeight,
        transform: 'translateX(-50%)',
      }}
    >
      {/* Brand halo — the brand color lives here, not in the scene background */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          width: totalWidth * 1.15,
          height: PHONE.totalHeight * 1.15,
          transform: `translate(-50%, -50%) scale(${driftScale})`,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${haloColor} 0%, transparent 68%)`,
          filter: 'blur(40px)',
          zIndex: 0,
        }}
      />
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          width: '100%',
          height: '100%',
          borderRadius: PHONE.radius,
          background: 'linear-gradient(160deg, #1f2937 0%, #0b1220 100%)',
          padding: PHONE.bezel,
          boxShadow:
            '0 55px 110px rgba(28, 25, 23, 0.42), 0 18px 44px rgba(28, 25, 23, 0.30), inset 0 0 0 2px rgba(255,255,255,0.06)',
          transform: `scale(${driftScale}) translateY(${driftY}px)`,
        }}
      >
        <div
          style={{
            position: 'relative',
            width: screenWidth,
            height: screenHeight,
            borderRadius: PHONE.radius - PHONE.bezel,
            overflow: 'hidden',
            background: '#ffffff',
          }}
        >
          <OffthreadVideo
            src={src}
            playbackRate={playbackRate}
            muted
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
          {/* Notch */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: '50%',
              transform: 'translateX(-50%)',
              width: screenWidth * 0.34,
              height: 26,
              background: '#0b1220',
              borderBottomLeftRadius: 16,
              borderBottomRightRadius: 16,
            }}
          />
        </div>
      </div>
    </div>
  );
};
