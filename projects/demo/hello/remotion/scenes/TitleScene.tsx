import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

import { BrandBackground, Caption, Subtitles, type SceneRenderProps } from '../kit';
import { bottomLineFor } from '../bottom-copy';

/**
 * Pure-motion scene: brand lockup and tagline springing in over the warm
 * canvas. No media, no captures — timing and typography only.
 */
export const TitleScene: React.FC<SceneRenderProps> = ({ scene, branding, span }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({
    frame,
    fps,
    config: { damping: 18, mass: 0.7, stiffness: 140 },
    durationInFrames: 22,
  });
  const scale = interpolate(enter, [0, 1], [0.94, 1]);
  const translateY = interpolate(enter, [0, 1], [36, 0]);

  return (
    <BrandBackground branding={branding}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 28,
          opacity: enter,
          transform: `translateY(${translateY}px) scale(${scale})`,
          fontFamily: `${branding.fontDisplay}, system-ui, sans-serif`,
        }}
      >
        <div
          style={{
            color: branding.ink,
            fontSize: 112,
            fontWeight: 800,
            letterSpacing: -2,
            textAlign: 'center',
          }}
        >
          {branding.brandName}
        </div>
        <div style={{ width: 96, height: 8, borderRadius: 4, background: branding.accent }} />
        <div style={{ color: branding.ink, fontSize: 44, fontWeight: 500, opacity: 0.82 }}>
          {branding.tagline}
        </div>
      </div>
      {/* ONE bottom safe-zone line (see `bottom-copy.ts`): burned subtitles own
          the zone while the narration speaks — rendering `Caption` alongside
          `Subtitles` stacks two texts on top of each other. */}
      {bottomLineFor(scene) === 'subtitles' ? (
        <Subtitles
          text={scene.narration}
          audioDurationSeconds={scene.audioDurationSeconds ?? scene.durationInSeconds}
          durationInSeconds={scene.durationInSeconds}
          branding={branding}
        />
      ) : (
        <Caption text={scene.caption} durationInFrames={span.durationInFrames} branding={branding} />
      )}
    </BrandBackground>
  );
};
