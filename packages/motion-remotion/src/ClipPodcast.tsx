/**
 * `clip-podcast`: the two-speaker vertical clip intent (1080×1920).
 *
 * The canvas splits into TOP/BOTTOM halves, each showing one face crop of the
 * SAME source video (two `OffthreadVideo` layers with identical timing and
 * distinct crop windows — no extra re-encode). Face boxes come from
 * `scene.faces` (normalized 0–1000), and each crop is smoothed over time by
 * the same directed-camera machinery used elsewhere (`planCamera`/`cameraAt`
 * over the face's own `scene.track.interactions` events). The ACTIVE speaker —
 * the face whose `'select'` interaction is in effect at the current frame
 * (`framesToInteractions` marks speaking faces with `'select'`) — renders in
 * full colour with a brand keyline; the other is dimmed. A single subtitle
 * band sits at the bottom, inside the vertical safe zone.
 */

import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';

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
  VERTICAL_SAFE_ZONES,
  type CropWindow,
} from './ClipVertical';
import type { SceneRendererComponent, SceneRenderProps } from './SceneRenderer';

/** Multiplier turning a face box into the crop height (context around it). */
const FACE_CONTEXT_RATIO = 3;
/** Floor for that crop height, as a fraction of the source frame height. */
const MIN_CROP_HEIGHT_RATIO = 0.25;

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
 * Crop window showing one face's half of the duo layout.
 *
 * `bbox` is the face box in normalized 0–1000 `[x, y, w, h]` over the source
 * frame (`ClipFace.bbox` semantics); `half` is the pixel size of the half
 * canvas. The window keeps the half's aspect ratio (so the crop fills the half
 * with no letterbox), is tall enough to give the face context
 * (`FACE_CONTEXT_RATIO` face heights, floored at `MIN_CROP_HEIGHT_RATIO` of
 * the source) and is centred on `focus` — the smoothed face centre in source
 * pixels from the camera track — or on the face itself without tracking. The
 * result is always clamped inside the source frame (`clampCropWindow`).
 */
export function halfCropWindow(
  bbox: readonly [number, number, number, number],
  source: Readonly<{ width: number; height: number }>,
  half: Readonly<{ width: number; height: number }>,
  focus?: Readonly<{ x: number; y: number }>,
): CropWindow {
  if (!(half.width > 0) || !(half.height > 0)) {
    throw new Error(
      `halfCropWindow: half must have positive dimensions ` +
        `(got ${String(half.width)}x${String(half.height)}).`,
    );
  }
  const [x, y, w, h] = bbox;
  const faceWidth = (w / 1000) * source.width;
  const faceHeight = (h / 1000) * source.height;
  const centerX = focus?.x ?? (x / 1000) * source.width + faceWidth / 2;
  const centerY = focus?.y ?? (y / 1000) * source.height + faceHeight / 2;

  const aspect = half.width / half.height;
  let height = Math.min(
    source.height,
    Math.max(faceHeight * FACE_CONTEXT_RATIO, source.height * MIN_CROP_HEIGHT_RATIO),
  );
  let width = height * aspect;
  if (width > source.width) {
    width = source.width;
    height = width / aspect;
  }
  return clampCropWindow(
    { x: centerX - width / 2, y: centerY - height / 2, width, height },
    source,
  );
}

/**
 * `clip-podcast` — duo layout: one face crop per canvas half, the active
 * speaker emphasized (full colour + brand keyline), one subtitle band.
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
        const crop = halfCropWindow(face.bbox, source, halfSize, focus);
        const active = face.id === speakerId;
        return (
          <div
            key={face.id}
            style={{
              position: 'absolute',
              top: index * halfSize.height,
              left: 0,
              width: halfSize.width,
              height: halfSize.height,
              overflow: 'hidden',
              // Active speaker: full colour plus the brand keyline. The other
              // half is dimmed so the eye stays on whoever is talking.
              filter: active ? 'none' : 'saturate(0.35) brightness(0.62)',
              border: active ? `6px solid ${branding.accent}` : '6px solid transparent',
              boxSizing: 'border-box',
            }}
          >
            <CroppedVideo src={source.src} source={source} crop={crop} box={halfSize} />
          </div>
        );
      })}
      {/* Single subtitle band over the bottom half, inside the safe zone. */}
      <ClipSubtitles
        text={scene.narration}
        voiceSpanFrames={span.durationInFrames}
        branding={branding}
        bottom={VERTICAL_SAFE_ZONES.bottom}
      />
    </AbsoluteFill>
  );
};

ClipPodcast.supportedSources = ['clip'];
