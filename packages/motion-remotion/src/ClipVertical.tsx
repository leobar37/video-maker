/**
 * `clip-vertical`: the single-speaker vertical clip intent (1080×1920).
 *
 * A horizontal source video is adapted to the vertical canvas as three
 * SIBLING layers, never nested:
 *   1. a blurred backdrop of the same clip (small raster + scale, blurred and
 *      dimmed so the sharp layer reads on top) filling the whole canvas,
 *   2. the sharp foreground video shown at NATIVE resolution — the crop window
 *      maps 1:1 onto the canvas (`scale` is ALWAYS 1.0: zoom/upscale is
 *      prohibited by the clip design) and is positioned on the canvas while
 *      the camera plan slides it in `x(t)` (`planCamera`/`cameraAt` over
 *      `scene.track.interactions`), never stretching a single pixel,
 *   3. the burned-in subtitles from `scene.subtitleSegments` (whisper word
 *      timestamps clipped to the window), laid over the crop as a SIBLING
 *      overlay so camera motion can never touch the typography.
 *
 * This module also owns the shared clip primitives (`CropWindow`,
 * `clampCropWindow`, `nativeCropLayout`, `CroppedVideo`, `ClipSubtitles`,
 * `resolveClipMedia`, `VERTICAL_SAFE_ZONES`) that `ClipPodcast.tsx` reuses.
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
import { buildTimedSegments } from './subtitle-segments';
import type { FilmBranding, FilmScene } from './types';

/**
 * Safe-zone insets for the 1080×1920 vertical canvas, in CSS pixels. The
 * platform chrome (app header, caption/action rail, edge gestures) owns the
 * outer band, so every piece of clip typography stays inside these insets.
 */
export const VERTICAL_SAFE_ZONES = {
  top: 240,
  bottom: 220,
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
 * Native-resolution crop placement (Joya 2 — ZOOM PROHIBIDO).
 *
 * `scale` is ALWAYS 1.0: the crop window is taken from the source at native
 * pixels (never larger than the source, never larger than the canvas) and
 * positioned on the canvas; the blurred backdrop fills whatever is left. The
 * window slides horizontally around `focusX` (the camera plan's subject
 * focus) without ever exposing an out-of-frame edge.
 */
export interface NativeCropLayout {
  /** Always 1 — zero upscale, zero stretch (the tests pin `<= 1.0`). */
  scale: number;
  /** Native crop window over the source (source pixels). */
  crop: CropWindow;
  /** Placement of the crop on the canvas (canvas pixels). */
  position: { x: number; y: number };
  /** Placement size — always identical to `crop` (1:1 pixel mapping). */
  box: { width: number; height: number };
}

/**
 * The native crop layout of `source` inside `canvas`, centred on `focusX`
 * (source pixels). The window is as large as the canvas allows WITHOUT
 * upscaling (`min(canvas, source)` per dimension), so `scale` stays exactly
 * 1.0 and the blur backdrop owns the rest of the canvas. A focus near a source
 * edge keeps the window inside the frame (`clampCropWindow`); a focus at the
 * source centre is a plain centre placement.
 */
export function nativeCropLayout(
  source: Readonly<{ width: number; height: number }>,
  canvas: Readonly<{ width: number; height: number }>,
  focusX: number,
): NativeCropLayout {
  if (!Number.isFinite(canvas.width) || !Number.isFinite(canvas.height) || canvas.width <= 0 || canvas.height <= 0) {
    throw new Error(
      `nativeCropLayout: canvas must have positive finite dimensions ` +
        `(got ${String(canvas.width)}x${String(canvas.height)}).`,
    );
  }
  const width = Math.min(canvas.width, source.width);
  const height = Math.min(canvas.height, source.height);
  const crop = clampCropWindow(
    { x: focusX - width / 2, y: (source.height - height) / 2, width, height },
    source,
  );
  return {
    scale: 1,
    crop,
    position: {
      x: Math.round((canvas.width - crop.width) / 2),
      y: Math.round((canvas.height - crop.height) / 2),
    },
    box: { width: crop.width, height: crop.height },
  };
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
 * The sharp video layer at NATIVE resolution: the video renders at its
 * intrinsic pixel size (scale 1.0 — never stretched, never upscaled) and is
 * offset so `crop` lands exactly on the `position` box. The wrapping box owns
 * `overflow: hidden` — this renders only the positioned, MUTE video (audio
 * belongs to `Film`, never to a scene layer).
 */
export const CroppedVideo: React.FC<{
  src: string;
  source: Readonly<{ width: number; height: number }>;
  crop: Readonly<CropWindow>;
  position: Readonly<{ x: number; y: number }>;
}> = ({ src, source, crop, position }) => (
  <div
    style={{
      position: 'absolute',
      left: position.x,
      top: position.y,
      width: crop.width,
      height: crop.height,
      overflow: 'hidden',
    }}
  >
    <OffthreadVideo
      src={src}
      muted
      style={{
        position: 'absolute',
        width: source.width,
        height: source.height,
        left: -crop.x,
        top: -crop.y,
        maxWidth: 'none',
      }}
    />
  </div>
);

/** One burned-in subtitle phrase, in seconds from the scene start. */
export interface ClipSubtitleSegment {
  text: string;
  start: number;
  end: number;
}

/**
 * The subtitle segment on screen at `t` seconds (half-open `[start, end)`).
 * Pure, so the segment selection is unit-testable.
 */
export function activeSubtitleSegmentAt(
  segments: ReadonlyArray<ClipSubtitleSegment>,
  t: number,
): ClipSubtitleSegment | null {
  let active: ClipSubtitleSegment | null = null;
  for (const segment of segments) {
    if (t >= segment.start && t < segment.end) active = segment;
  }
  return active;
}

/**
 * Clip subtitles: the ONE active phrase of `scene.subtitleSegments` (whisper
 * word timestamps clipped to the window), rendered as a SIBLING overlay of the
 * video crops (typography is never scaled or cropped by the camera). The
 * styling is publication-grade: heavy white type with a dark stroke plus a
 * drop shadow and a soft scrim, always inside the vertical safe zone — and
 * sized so it reads over footage of any brightness. A brand accent bar sits
 * above the copy (the same keyline language as the crop frames).
 */
export const ClipSubtitles: React.FC<{
  segments: ReadonlyArray<ClipSubtitleSegment>;
  branding: FilmBranding;
  /** Bottom inset in px — keep the copy inside the vertical safe zone. */
  bottom: number;
}> = ({ segments, branding, bottom }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const active = activeSubtitleSegmentAt(segments, frame / fps);
  if (!active) return null;

  const enter = spring({
    frame: frame - Math.round(active.start * fps),
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
          padding: '10px 22px',
          borderRadius: 16,
          background: 'rgba(0, 0, 0, 0.38)',
          color: '#FFFFFF',
          fontSize: 48,
          fontWeight: 800,
          lineHeight: 1.14,
          letterSpacing: -0.5,
          textAlign: 'center',
          WebkitTextStroke: '1.5px rgba(0, 0, 0, 0.85)',
          textShadow: '0 3px 12px rgba(0, 0, 0, 0.85), 0 0 28px rgba(0, 0, 0, 0.55)',
        }}
      >
        {active.text}
      </div>
    </div>
  );
};

/**
 * The subtitle segments of a scene: the whisper-derived window segments win;
 * scenes without them fall back to the even narration timing so no clip is
 * ever silent on screen.
 */
export function sceneSubtitleSegments(
  scene: FilmScene,
  spanDurationInFrames: number,
  fps: number,
): ClipSubtitleSegment[] {
  if (scene.subtitleSegments && scene.subtitleSegments.length > 0) {
    return [...scene.subtitleSegments];
  }
  if (!scene.narration?.trim() || spanDurationInFrames <= 0 || fps <= 0) return [];
  return buildTimedSegments(scene.narration, spanDurationInFrames).map((segment) => ({
    text: segment.s,
    start: segment.start / fps,
    end: segment.end / fps,
  }));
}

/**
 * `clip-vertical` — single-subject vertical clip: blurred backdrop, the sharp
 * NATIVE crop window (zoom prohibited) with the brand keyline, safe-zoned
 * burned-in subtitles.
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
  // at its centre) resolves to `source.width / 2` — a plain centre placement.
  const focusX =
    plan && track && track.viewport.width > 0
      ? (cameraFocusX(cameraAt(plan, frame), track.viewport) / track.viewport.width) * source.width
      : source.width / 2;
  const layout = nativeCropLayout(source, { width, height }, focusX);

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {/* Blurred backdrop: the same clip at a SMALL raster scaled up (the blur
          is cheap at 1/4 size), blurred and dimmed — it fills whatever the
          native crop does not cover. */}
      <AbsoluteFill style={{ overflow: 'hidden' }}>
        <OffthreadVideo
          src={source.src}
          muted
          style={{
            width: '25%',
            height: '25%',
            objectFit: 'cover',
            filter: 'blur(12px) brightness(0.55)',
            transform: 'scale(4.6)',
            transformOrigin: 'center',
            maxWidth: 'none',
          }}
        />
      </AbsoluteFill>
      {/* Sharp foreground: the NATIVE crop window (scale 1.0) over the source. */}
      <AbsoluteFill style={{ overflow: 'hidden' }}>
        <CroppedVideo
          src={source.src}
          source={source}
          crop={layout.crop}
          position={layout.position}
        />
      </AbsoluteFill>
      {/* Brand keyline around the sharp window (same language as the duo). */}
      <div
        style={{
          position: 'absolute',
          left: layout.position.x,
          top: layout.position.y,
          width: layout.box.width,
          height: layout.box.height,
          border: `5px solid ${branding.accent}`,
          boxSizing: 'border-box',
          pointerEvents: 'none',
        }}
      />
      {/* Subtitles: SIBLING overlay, never a child of the crop layers. */}
      <ClipSubtitles
        segments={sceneSubtitleSegments(scene, span.durationInFrames, fps)}
        branding={branding}
        bottom={VERTICAL_SAFE_ZONES.bottom}
      />
    </AbsoluteFill>
  );
};

ClipVertical.supportedSources = ['clip'];
