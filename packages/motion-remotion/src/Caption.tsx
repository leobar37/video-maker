import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

import type { FilmBranding } from './types';

/**
 * Lower-third caption — standard v1: no pill/box/border/shadow.
 * Ink text on the warm canvas with a short brand keyline above it. Spring
 * translateY on enter (28→0) and exit (0→22), no scale.
 */
export const Caption: React.FC<{
  text?: string;
  durationInFrames: number;
  branding: FilmBranding;
}> = ({ text, durationInFrames, branding }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (!text) return null;

  const enter = spring({
    frame,
    fps,
    config: { damping: 16, mass: 0.7, stiffness: 150 },
    durationInFrames: 16,
  });

  const exitStart = Math.max(0, durationInFrames - 16);
  const exit =
    frame > exitStart
      ? spring({
          frame: frame - exitStart,
          fps,
          config: { damping: 16, mass: 0.7, stiffness: 150 },
          durationInFrames: 14,
        })
      : 0;

  const translateY = interpolate(enter, [0, 1], [28, 0]) + interpolate(exit, [0, 1], [0, 22]);
  const opacity = Math.max(0, Math.min(1, enter - exit));

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 180,
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        opacity,
        transform: `translateY(${translateY}px)`,
        fontFamily: `${branding.fontDisplay}, system-ui, sans-serif`,
      }}
    >
      {/* Brand keyline */}
      <div
        style={{
          width: 64,
          height: 6,
          borderRadius: 3,
          background: branding.accent,
          marginBottom: 16,
        }}
      />
      <div
        style={{
          color: branding.ink,
          fontSize: 56,
          fontWeight: 800,
          letterSpacing: -0.5,
          whiteSpace: 'nowrap',
          textAlign: 'center',
        }}
      >
        {text}
      </div>
    </div>
  );
};
