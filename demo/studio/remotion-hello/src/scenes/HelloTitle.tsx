import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

export interface HelloTitleProps {
  line: string;
}

/** Pure-motion title scene: typography and spring only, no media, no AI. */
export const HelloTitle: React.FC<HelloTitleProps> = ({ line }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const entrance = spring({ frame, fps, config: { damping: 200 } });
  const exit = interpolate(frame, [70, 90], [0, -60], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ backgroundColor: '#101418', justifyContent: 'center', alignItems: 'center' }}>
      <h1
        style={{
          color: '#f5f2ea',
          fontFamily: 'Georgia, serif',
          fontSize: 72,
          margin: 0,
          textAlign: 'center',
          transform: `translateY(${(1 - entrance) * 40 + exit}px)`,
          opacity: interpolate(frame, [0, 15], [0, 1], { extrapolateRight: 'clamp' }),
        }}
      >
        {line}
      </h1>
    </AbsoluteFill>
  );
};
