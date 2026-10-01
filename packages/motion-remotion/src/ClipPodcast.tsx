/**
 * `clip-podcast`: the two-speaker vertical clip intent (1080×1920).
 *
 * The canvas splits into TOP/BOTTOM halves; each half shows one face crop of
 * the SAME source video taken at NATIVE resolution (`scale` is ALWAYS 1.0:
 * zoom/upscale is prohibited by the clip design) and positioned in the upper
 * part of the half — the blurred backdrop fills the rest. Face boxes come from
 * `scene.faces` (normalized 0–1000) and each crop is smoothed over time by the
 * same directed-camera machinery used elsewhere (`planCamera`/`cameraAt` over
 * the face's own `scene.track.interactions` events). The face lands around the
 * upper third of its half so the bottom subtitle band NEVER covers a face.
 *
 * The ACTIVE speaker — the face whose `'select'` interaction is in effect at
 * the current frame (`framesToInteractions` marks speaking faces with
 * `'select'`) — renders in full colour with the brand keyline at full
 * strength; the other is dimmed with the same keyline muted (consistent brand
 * language across both clip intents). A single burned-in subtitle band sits at
 * the bottom, inside the vertical safe zone.
 */

import React from 'react';
import { AbsoluteFill, OffthreadVideo, useCurrentFrame, useVideoConfig } from 'remotion';

import {
  cameraAt,
  planCamera,
  type InteractionEvent,
} from '@videomaker/motion-core';

import {
  cameraFocusX,
  clampCropWindow,
  ClipSubtitles,
  CroppedVideo,
  resolveClipMedia,
  sceneSubtitleSegments,
  VERTICAL_SAFE_ZONES,
  type CropWindow,
  type NativeCropLayout,
} from './ClipVertical';
import type { SceneRendererComponent, SceneRenderProps } from './SceneRenderer';

/** Fraction of the half height the sharp window occupies (rest = blur-bg). */
const WINDOW_HEIGHT_RATIO = 0.62;
/** Fraction of the half width the window occupies (each half frames ONE face). */
const WINDOW_WIDTH_RATIO = 0.75;
/** Vertical inset of the window inside its half (px). */
const WINDOW_TOP_INSET = 24;
/** Where the estimated head sits inside its window (keeps heads in frame). */
const HEAD_ANCHOR_Y = 0.32;
/** Head band of a person box, as a fraction of the source height. */
const HEAD_BAND_RATIO = 0.11;

/** `target` prefix `framesToInteractions` stamps on face-driven events. */
const FACE_TARGET_PREFIX = 'face=';

/**
 * The active speaker at `frame`: the face whose latest `'select'` interaction
 * at or before `frame` names it (events are frame-quantized by
 * `framesToInteractions`, and a selection holds until the next one). Falls
 * back to the FIRST face when the track has no selection in effect — and to
 * `null` when there are no faces at all.
 */
export function activeSpeakerId(
  faces: ReadonlyArray<{ id: string }>,
  interactions: ReadonlyArray<InteractionEvent> | undefined,
  frame: number,
  fps: number,
): string | null {
  if (faces.length === 0) return null;
  if (interactions && fps > 0) {
    let bestFrame = -Infinity;
    let bestId: string | null = null;
    for (const event of interactions) {
      if (event.action !== 'select' || !event.target.startsWith(FACE_TARGET_PREFIX)) continue;
      const eventFrame = Math.round(event.t * fps);
      if (eventFrame > frame || eventFrame < bestFrame) continue;
      const id = event.target.slice(FACE_TARGET_PREFIX.length);
      if (!faces.some((face) => face.id === id)) continue;
      bestFrame = eventFrame;
      bestId = id;
    }
    if (bestId !== null) return bestId;
  }
  return faces[0]!.id;
}

/**
 * Native crop placement for one face's half of the duo layout (zoom
 * prohibited: `scale` is always 1.0).
 *
 * `bbox` is the face box in normalized 0–1000 `[x, y, w, h]` over the source
 * frame (`ClipFace.bbox` semantics); `half` is the pixel size of the half
 * canvas and `top` its canvas offset. The window is as large as the half's
 * upper band allows WITHOUT upscaling (`min(half, source)` per dimension,
 * height further capped by `WINDOW_HEIGHT_RATIO` of the half so the lower
 * band stays blur-bg for the subtitles), centred horizontally on `focus` —
 * the smoothed face centre in source pixels from the camera track — or on the
 * face itself without tracking, with the face anchored at `FACE_ANCHOR_Y` of
 * the window. The result is always clamped inside the source frame
 * (`clampCropWindow`).
 */
export function halfCropLayout(
  bbox: readonly [number, number, number, number],
  source: Readonly<{ width: number; height: number }>,
  half: Readonly<{ width: number; height: number }>,
  top: number,
  focus?: Readonly<{ x: number; y: number }>,
): NativeCropLayout {
  if (!(half.width > 0) || !(half.height > 0)) {
    throw new Error(
      `halfCropLayout: half must have positive dimensions ` +
        `(got ${String(half.width)}x${String(half.height)}).`,
    );
  }
  const [x, y, w, h] = bbox;
  const faceWidth = (w / 1000) * source.width;
  const faceHeight = (h / 1000) * source.height;
  const centerX = focus?.x ?? (x / 1000) * source.width + faceWidth / 2;

  // Head-safe vertical anchor: vision models return either FACE boxes or full
  // PERSON boxes; the head sits at the TOP of a person box. Estimate the head
  // centre as the box top plus at most half the box height (true for face
  // boxes) capped at `HEAD_BAND_RATIO` of the source height (the head band of
  // a person box) — then keep that point at `HEAD_ANCHOR_Y` of the window so
  // heads NEVER leave the frame (a torso/legs crop means the anchor missed).
  // The camera track smooths X only; Y always comes from this estimate.
  const boxTopY = (y / 1000) * source.height;
  const headCenterY =
    boxTopY + Math.min(faceHeight * 0.5, source.height * HEAD_BAND_RATIO);

  const width = Math.min(Math.round(half.width * WINDOW_WIDTH_RATIO), source.width);
  const height = Math.min(Math.round(half.height * WINDOW_HEIGHT_RATIO), source.height);
  const crop = clampCropWindow(
    {
      x: centerX - width / 2,
      y: headCenterY - HEAD_ANCHOR_Y * height,
      width,
      height,
    },
    source,
  );
  return {
    scale: 1,
    crop,
    position: {
      x: Math.round((half.width - crop.width) / 2),
      y: top + WINDOW_TOP_INSET,
    },
    box: { width: crop.width, height: crop.height },
  };
}

/**
 * `clip-podcast` — duo layout: one NATIVE face crop per canvas half (zoom
 * prohibited), the active speaker emphasized (full colour + brand keyline),
 * one burned-in subtitle band clear of both faces.
 */
export const ClipPodcast: SceneRendererComponent = ({
  scene,
  branding,
  assets,
  span,
}: SceneRenderProps) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const source = resolveClipMedia(scene, assets);

  const faces = scene.faces ?? [];
  if (faces.length < 2) {
    throw new Error(
      `CLIP_DUO_FACES: intent "clip-podcast" needs exactly two faces ` +
        `(scene "${scene.id}" carries ${faces.length}). ` +
        `Fall back to "clip-vertical" in clip-ranges when the layout is unstable.`,
    );
  }

  const halfSize = { width, height: height / 2 };
  const track = scene.track;

  // Each half smooths its own face track through the same camera planner: the
  // face's `select`/`hover` events carry its per-sample box, and `cameraAt`
  // turns the plan into a focus point that keeps the crop from jumping between
  // sampled detections. No track / no events for the face → the static
  // `scene.faces` box drives the crop.
  const halves = React.useMemo(
    () =>
      faces.slice(0, 2).map((face) => {
        const events =
          track?.interactions.filter((event) => event.target === `${FACE_TARGET_PREFIX}${face.id}`) ??
          [];
        return {
          face,
          plan:
            track && events.length > 0
              ? planCamera({
                  interactions: events,
                  viewport: track.viewport,
                  fps,
                  durationInFrames: span.durationInFrames,
                  profile: scene.cameraProfile,
                })
              : null,
        };
      }),
    [faces, track, fps, span.durationInFrames, scene.cameraProfile],
  );

  const speakerId = activeSpeakerId(faces, track?.interactions, frame, fps);

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {/* Blurred backdrop over the whole canvas (small raster + scale): it
          fills everything the two native windows leave uncovered. */}
      <AbsoluteFill style={{ overflow: 'hidden' }}>
        <OffthreadVideo
          src={source.src}
          muted
          style={{
            width: '25%',
            height: '25%',
            objectFit: 'cover',
            filter: 'blur(12px) brightness(0.5)',
            transform: 'scale(4.6)',
            transformOrigin: 'center',
            maxWidth: 'none',
          }}
        />
      </AbsoluteFill>
      {halves.map(({ face, plan }, index) => {
        let focus: { x: number; y: number } | undefined;
        if (plan && track && track.viewport.width > 0 && track.viewport.height > 0) {
          const state = cameraAt(plan, frame);
          focus = {
            x: (cameraFocusX(state, track.viewport) / track.viewport.width) * source.width,
            y:
              ((track.viewport.height / 2 - state.y) / state.scale / track.viewport.height) *
              source.height,
          };
        }
        const layout = halfCropLayout(
          face.bbox,
          source,
          halfSize,
          index * halfSize.height,
          focus,
        );
        const active = face.id === speakerId;
        return (
          <React.Fragment key={face.id}>
            <div
              style={{
                position: 'absolute',
                inset: 0,
                overflow: 'hidden',
                // Active speaker: full colour. The other is dimmed so the eye
                // stays on whoever is talking (emphasis NEVER zooms).
                filter: active ? 'none' : 'saturate(0.35) brightness(0.62)',
              }}
            >
              <CroppedVideo
                src={source.src}
                source={source}
                crop={layout.crop}
                position={layout.position}
              />
            </div>
            {/* Consistent brand keyline around the sharp window; muted for the
                inactive speaker, full strength for the active one. */}
            <div
              style={{
                position: 'absolute',
                left: layout.position.x,
                top: layout.position.y,
                width: layout.box.width,
                height: layout.box.height,
                border: `5px solid ${branding.accent}`,
                opacity: active ? 1 : 0.4,
                boxSizing: 'border-box',
                pointerEvents: 'none',
              }}
            />
          </React.Fragment>
        );
      })}
      {/* Single subtitle band over the bottom blur band, inside the safe zone
          and clear of both faces (windows keep faces in the upper third). */}
      <ClipSubtitles
        segments={sceneSubtitleSegments(scene, span.durationInFrames, fps)}
        branding={branding}
        bottom={VERTICAL_SAFE_ZONES.bottom}
      />
    </AbsoluteFill>
  );
};

ClipPodcast.supportedSources = ['clip'];
