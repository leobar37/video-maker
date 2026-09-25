import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

import type { FilmBranding } from './types';
import { activeSegmentAt, buildTimedSegments } from './subtitle-segments';

/**
 * Burned-in TikTok subtitles, synced to the voice. The narration is broken into
 * short phrases (on punctuation, then wrapped to ~30 chars — see
 * `subtitle-segments.ts`) and each phrase is given a time slice proportional to
 * its length across the *real* narration duration (audioDurationSeconds), which
 * starts at frame 0 of the scene. Style follows the standard: no pill/box, ink
 * on canvas, display font 800, with a short brand keyline under the active
 * line.
 */

export const Subtitles: React.FC<{
  text?: string;
  audioDurationSeconds?: number;
  durationInSeconds: number;
  branding: FilmBranding;
  bottom?: number | string;
}> = ({
  text,
  audioDurationSeconds,
  durationInSeconds,
  branding,
  bottom = 'var(--subtitle-bottom, 170px)',
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (!text?.trim()) return null;

  // Spread over the narration length (voice from frame 0); fall back to scene.
  const spanFrames = Math.max(1, Math.round((audioDurationSeconds ?? durationInSeconds) * fps));

  // The ONE active phrase: its window contains the frame. Windows tile the
  // span without gaps or overlaps (see `subtitle-segments.ts`), so consecutive
  // phrases never co-render; after the voice ends the last phrase stays on
  // screen through the scene tail.
  const active = activeSegmentAt(buildTimedSegments(text, spanFrames), frame);
  if (!active) return null;

  const localFrame = frame - active.start;
  const enter = spring({
    frame: localFrame,
    fps,
    config: { damping: 18, mass: 0.6, stiffness: 170 },
    durationInFrames: 8,
  });
  const translateY = interpolate(enter, [0, 1], [18, 0]);
  const opacity = Math.max(0, Math.min(1, enter));

  return (
    <div
      style={{
        position: 'absolute',
        bottom,
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        opacity,
        transform: `translateY(${translateY}px)`,
        fontFamily: `${branding.fontDisplay}, system-ui, sans-serif`,
        paddingLeft: 80,
        paddingRight: 80,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          width: 56,
          height: 6,
          borderRadius: 3,
          background: branding.accent,
          marginBottom: 14,
        }}
      />
      <div
        style={{
          color: branding.ink,
          fontSize: 54,
          fontWeight: 800,
          lineHeight: 1.1,
          letterSpacing: -0.5,
          textAlign: 'center',
          textShadow: '0 2px 14px rgba(28, 25, 23, 0.14)',
        }}
      >
        {active.s}
      </div>
    </div>
  );
};
