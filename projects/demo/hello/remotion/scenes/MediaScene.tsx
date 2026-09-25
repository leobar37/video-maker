import React from 'react';
import {
  Img,
  OffthreadVideo,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

import { BrandBackground, Caption, Subtitles, type SceneRenderProps } from '../kit';
import { bottomLineFor } from '../bottom-copy';

/**
 * Media scene: resolves its media through the film's `AssetResolver` (by
 * manifest id — no `staticFile` literals, no `getStaticFiles()` scanning) and
 * frames it as a soft-shadowed card. Still assets render as an image, video
 * assets (capture clips staged by the pipeline) as an offthread video; the
 * manifest's intrinsic size and hash are read from the resolved entry.
 */
export const MediaScene: React.FC<SceneRenderProps> = ({ scene, branding, assets, span }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (!scene.assetId) {
    throw new Error(
      `MEDIA_ASSET_MISSING: scene "${scene.id}" must set FilmScene.assetId to a manifest id ` +
        `from FilmProps.assets. Known ids: ${
          assets.list().map((entry) => entry.id).join(', ') || '(none)'
        }.`,
    );
  }
  const { entry, url } = assets.resolve(scene.assetId);
  // Video entries carry a real duration (or a video extension when the probe
  // reports none); everything else is a still and renders as an image. The
  // capture clip outlives any scene span, so the video never runs out.
  const isVideo = entry.duration > 0 || /\.(mp4|mov|webm|m4v)$/i.test(entry.src);

  const enter = spring({
    frame,
    fps,
    config: { damping: 17, mass: 0.7, stiffness: 150 },
    durationInFrames: 20,
  });
  const scale = interpolate(enter, [0, 1], [0.96, 1]);

  const cardSize = 620;

  return (
    <BrandBackground branding={branding}>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            position: 'relative',
            opacity: enter,
            transform: `scale(${scale})`,
          }}
        >
          {/* Brand halo — accent, never a wash */}
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              width: cardSize * 1.35,
              height: cardSize * 1.35,
              transform: 'translate(-50%, -50%)',
              borderRadius: '50%',
              background: `radial-gradient(circle, ${branding.glow} 0%, transparent 68%)`,
              filter: 'blur(46px)',
            }}
          />
          <div
            style={{
              position: 'relative',
              width: cardSize,
              height: cardSize,
              borderRadius: 44,
              overflow: 'hidden',
              boxShadow:
                '0 55px 110px rgba(28, 25, 23, 0.35), 0 18px 44px rgba(28, 25, 23, 0.22)',
              background: '#ffffff',
            }}
          >
            {isVideo ? (
              <OffthreadVideo
                src={url}
                muted
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <Img
                src={url}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            )}
          </div>
          {/* Manifest chip: id + intrinsic size, straight from the entry */}
          <div
            style={{
              position: 'absolute',
              bottom: -64,
              left: '50%',
              transform: 'translateX(-50%)',
              whiteSpace: 'nowrap',
              fontFamily: `${branding.fontBody}, system-ui, sans-serif`,
              fontSize: 26,
              fontWeight: 600,
              letterSpacing: 0.4,
              color: branding.ink,
              opacity: 0.72,
            }}
          >
            {entry.id} · {entry.width}×{entry.height} · sha {entry.sha256.slice(0, 8)}
          </div>
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
