/**
 * Pure face-track → camera-input conversion for clip verticals.
 *
 * The analysis shard records one `FrameAnalysis` per sampled frame with the
 * speakers' faces in normalized 0–1000 coordinates. This module turns those
 * detections into the `InteractionEvent[]` that `planCamera` consumes, so the
 * camera of a clip can follow the active speaker with the exact same planning
 * math used for recorded UI captures. No React, no ffmpeg, no I/O: every
 * function is deterministic and total (empty input yields empty output).
 *
 * DUO split: `splitSpeakerTracks` partitions one shared detection track into
 * two independent per-speaker tracks — speaker A stacked on the top half of
 * the frame, speaker B on the bottom half — each ready to feed its own camera
 * plan for the stacked podcast layout.
 */
import type { FrameAnalysis } from '@videomaker/schemas';

import type { InteractionEvent, PlanCameraInput, Rect, Viewport } from './camera';

/**
 * One sampled frame of face detections. Structurally a subset of
 * `FrameAnalysis` (`@videomaker/schemas`): a full analysis entry is assignable
 * to this type, so validated shards can be passed in directly.
 *
 * Bounding boxes are `[x, y, w, h]` in normalized 0–1000 coordinates.
 */
export type FaceTrackFrame = Pick<FrameAnalysis, 'frame_id' | 't' | 'speakers'>;

/** Highest normalized coordinate: 0–1000 maps onto the viewport axis. */
const NORMALIZED_MAX = 1000;

/** Normalized y of the line splitting the frame into top and bottom halves. */
const HALF_NORMALIZED = NORMALIZED_MAX / 2;

/**
 * Map one normalized 0–1000 `[x, y, w, h]` box onto viewport CSS pixels.
 * Components scale independently per axis, so boxes keep their proportions
 * whatever the viewport aspect ratio.
 */
function bboxToRect(bbox: FaceTrackFrame['speakers'][number]['bbox'], viewport: Viewport): Rect {
  const [x, y, width, height] = bbox;
  return {
    x: (x / NORMALIZED_MAX) * viewport.width,
    y: (y / NORMALIZED_MAX) * viewport.height,
    width: (width / NORMALIZED_MAX) * viewport.width,
    height: (height / NORMALIZED_MAX) * viewport.height,
  };
}

/**
 * Convert face detections into camera focus events.
 *
 * One event per (speaker, frame) with a non-empty bbox. Boxes are mapped from
 * normalized 0–1000 coordinates to viewport pixels; times are quantized onto
 * the frame grid (`Math.round(t * fps)`) and re-expressed in seconds, so every
 * event lands exactly on a frame boundary and `planCamera`'s own time → frame
 * mapping round-trips without drift. At most one event per speaker per frame
 * index: detection jitter between two samples of the same frame cannot produce
 * duplicate camera beats.
 *
 * Action semantics for camera focus (`InteractionAction` has no dedicated
 * `focus` value): a `speaking` face is the focus target and earns `select`
 * (chosen by the analysis as the subject to frame); a detected but silent face
 * earns `hover` (visible in the shot, but not what the camera is called to
 * frame). `target` is `face=<speaker id>` for traceability, `segmentId` is the
 * `frame_id` that produced the event.
 */
export function framesToInteractions(
  frames: FaceTrackFrame[],
  viewport: Viewport,
  fps: number,
): InteractionEvent[] {
  if (frames.length === 0 || !(fps > 0)) return [];

  const interactions: InteractionEvent[] = [];
  const emitted = new Set<string>();
  for (const frame of frames) {
    const frameIndex = Math.round(frame.t * fps);
    for (const speaker of frame.speakers) {
      const [, , width, height] = speaker.bbox;
      // Empty boxes carry no framing information; skip them.
      if (width <= 0 || height <= 0) continue;
      const key = `${speaker.id}@${frameIndex}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      interactions.push({
        t: frameIndex / fps,
        segmentId: frame.frame_id,
        action: speaker.speaking ? 'select' : 'hover',
        target: `face=${speaker.id}`,
        bbox: bboxToRect(speaker.bbox, viewport),
      });
    }
  }
  return interactions;
}

/**
 * Build the `PlanCameraInput` for a solo clip's face track: the focus events
 * plus the fixed planning fields, derived from the frames themselves.
 * `durationInFrames` covers the last sampled frame (quantized index + 1);
 * `playbackRate` and `captureStartSeconds` are neutral — face timestamps are
 * already scene time.
 */
export function buildSoloCameraInput(
  frames: FaceTrackFrame[],
  viewport: Viewport,
  fps: number,
): PlanCameraInput {
  let durationInFrames = 0;
  for (const frame of frames) {
    durationInFrames = Math.max(durationInFrames, Math.round(frame.t * fps) + 1);
  }
  return {
    interactions: framesToInteractions(frames, viewport, fps),
    viewport,
    fps,
    durationInFrames,
    playbackRate: 1,
    captureStartSeconds: 0,
  };
}

/**
 * Shift one speaker's box into its assigned half of the frame.
 *
 * The vertical axis is remapped by halving — `y' = y / 2 + halfOffset` — which
 * sends the full 0–1000 range onto `[0, 500]` (the TOP half of the viewport,
 * i.e. `[0, viewport.height / 2]` in pixels) for the first speaker and onto
 * `[500, 1000]` (the BOTTOM half) for the second, with `halfOffset` of 0 and
 * 500 respectively. `x`, `w` and `h` pass through unchanged.
 */
function placeSpeaker(
  speaker: FaceTrackFrame['speakers'][number],
  halfOffset: number,
): FaceTrackFrame['speakers'][number] {
  const [x, y, width, height] = speaker.bbox;
  return {
    ...speaker,
    bbox: [x, y / 2 + halfOffset, width, height],
  };
}

/**
 * DUO split: partition one shared detection track into two per-speaker tracks
 * for the stacked layout — the lowest speaker id (e.g. `speaker-a`) on the top
 * half, the second lowest (e.g. `speaker-b`) on the bottom half, each with its
 * boxes remapped into its half. Ids are collected and sorted globally, so a
 * frame that shows only one speaker still assigns it to the correct half.
 *
 * Every input frame appears in BOTH halves with its `frame_id` and `t`
 * preserved; frames with no speakers (or none of the two tracked speakers)
 * pass through with an empty `speakers` array in both halves, so empty windows
 * stay frame-aligned. Extra speakers beyond the first two are dropped.
 */
export function splitSpeakerTracks(frames: FaceTrackFrame[]): {
  top: FaceTrackFrame[];
  bottom: FaceTrackFrame[];
} {
  const ids = [...new Set(frames.flatMap((frame) => frame.speakers.map((s) => s.id)))].sort();
  const topId = ids[0];
  const bottomId = ids[1];

  const top: FaceTrackFrame[] = [];
  const bottom: FaceTrackFrame[] = [];
  for (const frame of frames) {
    top.push({
      ...frame,
      speakers: frame.speakers
        .filter((speaker) => speaker.id === topId)
        .map((speaker) => placeSpeaker(speaker, 0)),
    });
    bottom.push({
      ...frame,
      speakers: frame.speakers
        .filter((speaker) => speaker.id === bottomId)
        .map((speaker) => placeSpeaker(speaker, HALF_NORMALIZED)),
    });
  }
  return { top, bottom };
}
