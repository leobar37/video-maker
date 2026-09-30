/**
 * `clip-vertical`: the single-speaker vertical clip intent (1080×1920).
 *
 * A horizontal source video is adapted to the vertical canvas as three
 * SIBLING layers, never nested:
 *   1. a blurred cover backdrop of the same clip (scale-to-cover, blurred and
 *      dimmed so the sharp layer reads on top),
 *   2. the sharp foreground video cropped to an ANIMATED crop window driven by
 *      the directed-camera plan (`planCamera`/`cameraAt` over
 *      `scene.track.interactions`) — no track, or a static plan, falls back to
 *      a plain centre crop,
 *   3. the burned-in subtitles from `scene.narration`, laid over the crop as a
 *      sibling overlay so camera scaling can never touch the typography.
 *
 * This module also owns the shared clip primitives (`CropWindow`,
 * `clampCropWindow`, `CroppedVideo`, `ClipSubtitles`, `resolveClipMedia`,
 * `VERTICAL_SAFE_ZONES`) that `ClipPodcast.tsx` reuses.
 */

import React from 'react';
import { AbsoluteFill, OffthreadVideo, spring, useCurrentFrame, useVideoConfig } from 'remotion';

import {
  cameraAt,
  planCamera,
  type CameraState,
  type Viewport,
} from '@videomaker/motion-core';

import type { AssetResolver } from './assets';
import type { SceneRendererComponent, SceneRenderProps } from './SceneRenderer';
import { activeSegmentAt, buildTimedSegments } from './subtitle-segments';
import type { FilmBranding, FilmScene } from './types';

/**
 * Safe-zone insets for the 1080×1920 vertical canvas, in CSS pixels. The
 * platform chrome (app header, caption/action rail, edge gestures) owns the
 * outer band, so every piece of clip typography stays inside these insets.
 */
export const VERTICAL_SAFE_ZONES = {
  top: 240,
  bottom: 420,
  left: 90,
  right: 90,
} as const;

/** A crop rectangle over the source video frame, in source pixels. */
export interface CropWindow {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Clamp a desired crop window inside a source frame so the crop can NEVER
 * expose an out-of-frame edge: the window is shrunk to the source when it is
 * too big, then slid inside `[0, width] × [0, height]`. Non-finite inputs are
 * treated as 0. Throws on a source without positive dimensions — without a
 * real frame there is no crop that could be shown.
 */
export function clampCropWindow(
  desired: Readonly<CropWindow>,
  source: Readonly<{ width: number; height: number }>,
): CropWindow {
  if (!Number.isFinite(source.width) || !Number.isFinite(source.height) || source.width <= 0 || source.height <= 0) {
    throw new Error(
      `clampCropWindow: source must have positive finite dimensions ` +
        `(got ${String(source.width)}x${String(source.height)}).`,
    );
  }
  const rawX = Number.isFinite(desired.x) ? desired.x : 0;
  const rawY = Number.isFinite(desired.y) ? desired.y : 0;
  const rawWidth = Number.isFinite(desired.width) ? desired.width : 0;
  const rawHeight = Number.isFinite(desired.height) ? desired.height : 0;
  const width = Math.min(Math.max(0, rawWidth), source.width);
  const height = Math.min(Math.max(0, rawHeight), source.height);
  return {
    x: Math.min(Math.max(0, rawX), source.width - width),
    y: Math.min(Math.max(0, rawY), source.height - height),
    width,
    height,
  };
}

/**
 * The cover crop window of `source` for a `canvas`-aspect viewport, centred on
 * `focusX` (source pixels). The window keeps the canvas aspect ratio and is as
 * large as the source allows — full height for a wide source, full width for a
 * tall one — so the video always fills the canvas with no letterbox. A focus
 * near an edge keeps the window inside the frame (`clampCropWindow`), and a
 * focus at the source centre is a plain centre crop (the static-plan fallback).
 */
export function coverCropWindow(
  source: Readonly<{ width: number; height: number }>,
  canvas: Readonly<{ width: number; height: number }>,
  focusX: number,
): CropWindow {
  if (!Number.isFinite(canvas.width) || !Number.isFinite(canvas.height) || canvas.width <= 0 || canvas.height <= 0) {
    throw new Error(
      `coverCropWindow: canvas must have positive finite dimensions ` +
        `(got ${String(canvas.width)}x${String(canvas.height)}).`,
    );
  }
  const aspect = canvas.width / canvas.height;
  let width = source.width;
  let height = width / aspect;
  if (height > source.height) {
    height = source.height;
    width = height * aspect;
  }
  return clampCropWindow(
    { x: focusX - width / 2, y: (source.height - height) / 2, width, height },
    source,
  );
}

/**
 * Horizontal focus point of a `cameraAt` state, in the plan's viewport space:
 * the centre of the visible window (`-x / scale … (-x + viewport.width) / scale`).
 * For a resting camera this is the viewport centre — the centre-crop fallback.
 */
export function cameraFocusX(state: CameraState, viewport: Viewport): number {
  return (viewport.width / 2 - state.x) / state.scale;
}

/**
 * Resolve the clip's video source and its intrinsic pixel size. A pre-resolved
 * `mediaSrc` wins over the manifest (`assets.resolve`); the crop math needs
 * the real frame size, taken from the manifest entry or from
 * `mediaWidth`/`mediaHeight` for hand-resolved URLs.
 */
export function resolveClipMedia(
  scene: FilmScene,
  assets: AssetResolver,
): { src: string; width: number; height: number } {
  const entry = scene.assetId ? assets.require(scene.assetId) : undefined;
  const src = scene.mediaSrc ?? (entry ? assets.resolve(entry.id).url : undefined);
  if (!src) {
    throw new Error(
      `CLIP_MEDIA_REQUIRED: scene "${scene.id}" needs a video source ` +
        `(mediaSrc or assetId) — clip intents crop real footage.`,
    );
  }
  const width = (entry && entry.width > 0 ? entry.width : undefined) ?? scene.mediaWidth ?? 0;
  const height = (entry && entry.height > 0 ? entry.height : undefined) ?? scene.mediaHeight ?? 0;
  if (!(width > 0) || !(height > 0)) {
    throw new Error(
      `CLIP_MEDIA_DIMENSIONS: scene "${scene.id}" has no intrinsic video size — ` +
        `set mediaWidth/mediaHeight (or use a manifest entry with dimensions) so the crop can be computed.`,
    );
  }
  return { src, width, height };
}

/**
 * The sharp video layer cropped to `crop` (source pixels) and scaled to fill
 * `box`: the crop maps 1:1 onto the box and the rest of the frame falls
 * outside it. The wrapping box owns `overflow: hidden` — this renders only the
 * positioned, MUTE video (audio belongs to `Film`, never to a scene layer).
 */
export const CroppedVideo: React.FC<{
  src: string;
  source: Readonly<{ width: number; height: number }>;
  crop: Readonly<CropWindow>;
  box: Readonly<{ width: number; height: number }>;
}> = ({ src, source, crop, box }) => {
  const scale =
    crop.width > 0 && crop.height > 0 ? Math.max(box.width / crop.width, box.height / crop.height) : 1;
  return (
    <OffthreadVideo
      src={src}
      muted
      style={{
        position: 'absolute',
        width: source.width * scale,
        height: source.height * scale,
        left: -crop.x * scale,
        top: -crop.y * scale,
        maxWidth: 'none',
      }}
    />
  );
};

/**
 * Clip subtitles: the ONE active phrase of `scene.narration`, rendered as a
 * SIBLING overlay of the video crops (typography is never scaled or cropped by
 * the camera). Timing comes from the pure `subtitle-segments` module — the
 * narration is split into phrases by `buildSegments` and each phrase gets its
 * half-open frame window from `buildTimedSegments`; the window containing the
 * current frame renders. White-on-video styling with a brand keyline keeps the
 * copy readable over footage of any brightness.
 */
export const ClipSubtitles: React.FC<{
  text?: string;
  /** Frames the narration voice occupies (the whole span of a trimmed clip). */
  voiceSpanFrames: number;
  branding: FilmBranding;
  /** Bottom inset in px — keep the copy inside the vertical safe zone. */
  bottom: number;
}> = ({ text, voiceSpanFrames, branding, bottom }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (!text?.trim()) return null;
  const active = activeSegmentAt(buildTimedSegments(text, voiceSpanFrames), frame);
  if (!active) return null;

  const enter = spring({
    frame: frame - active.start,
    fps,
    config: { damping: 18, mass: 0.6, stiffness: 170 },
    durationInFrames: 8,
  });

  return (
    <div
      style={{
        position: 'absolute',
        bottom,
        left: VERTICAL_SAFE_ZONES.left,
        right: VERTICAL_SAFE_ZONES.right,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        opacity: Math.max(0, Math.min(1, enter)),
        transform: `translateY(${(1 - enter) * 18}px)`,
        fontFamily: `${branding.fontDisplay}, system-ui, sans-serif`,
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
          color: '#FFFFFF',
          fontSize: 54,
          fontWeight: 800,
          lineHeight: 1.12,
          letterSpacing: -0.5,
          textAlign: 'center',
          textShadow: '0 2px 10px rgba(0, 0, 0, 0.65), 0 0 32px rgba(0, 0, 0, 0.45)',
        }}
      >
        {active.s}
      </div>
    </div>
  );
};

/**
 * `clip-vertical` — single-subject vertical clip: blurred cover backdrop,
 * sharp foreground with the animated crop window, safe-zoned subtitles.
 */
export const ClipVertical: SceneRendererComponent = ({
  scene,
  branding,
  assets,
  span,
}: SceneRenderProps) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const source = resolveClipMedia(scene, assets);

  const track = scene.track;
  const plan = React.useMemo(
    () =>
      track
        ? planCamera({
            interactions: track.interactions,
            viewport: track.viewport,
            fps,
            durationInFrames: span.durationInFrames,
            profile: scene.cameraProfile,
          })
        : null,
    [track, fps, span.durationInFrames, scene.cameraProfile],
  );

  // Crop x follows the directed camera: the focus point of the plan, mapped
  // from track-viewport space into source pixels. No track (or a plan resting
  // at its centre) resolves to `source.width / 2` — a plain centre crop.
  const focusX =
    plan && track && track.viewport.width > 0
      ? (cameraFocusX(cameraAt(plan, frame), track.viewport) / track.viewport.width) * source.width
      : source.width / 2;
  const crop = coverCropWindow(source, { width, height }, focusX);

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {/* Blurred cover backdrop: the same clip scaled to cover, blurred and
          dimmed (the overscan hides the blur bleeding at the edges). */}
      <AbsoluteFill style={{ overflow: 'hidden' }}>
        <OffthreadVideo
          src={source.src}
          muted
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            filter: 'blur(56px) brightness(0.55)',
            transform: 'scale(1.15)',
          }}
        />
      </AbsoluteFill>
      {/* Sharp foreground: the animated crop window over the source frame. */}
      <AbsoluteFill style={{ overflow: 'hidden' }}>
        <CroppedVideo src={source.src} source={source} crop={crop} box={{ width, height }} />
      </AbsoluteFill>
      {/* Subtitles: SIBLING overlay, never a child of the crop layers. */}
      <ClipSubtitles
        text={scene.narration}
        voiceSpanFrames={span.durationInFrames}
        branding={branding}
        bottom={VERTICAL_SAFE_ZONES.bottom}
      />
    </AbsoluteFill>
  );
};

ClipVertical.supportedSources = ['clip'];
