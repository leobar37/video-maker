/**
 * Directed camera — data contracts and planning.
 *
 * Turns a recorded interaction track into a frame-accurate camera plan: where
 * the camera is on every frame of a scene, and why. Pure and deterministic —
 * the same input always yields the same plan, so a planning CLI can print it
 * and the renderer can execute it with no risk of drift. `CameraPlan` is plain
 * serializable data on purpose: plans travel between processes as JSON and
 * both sides consume byte-identical output.
 *
 * The hard parts solved here, once:
 *   - converting a DOM bbox into a scale + translation that frames it without
 *     ever exposing the edges of the capture;
 *   - merging interactions that happen close together so the camera makes one
 *     considered move instead of several nervous ones;
 *   - starting the move BEFORE the click lands, which is what makes it read as
 *     intentional rather than reactive;
 *   - bridging two nearby targets with a single travel instead of a pointless
 *     zoom-out / zoom-in.
 */

import { springProgress, CAMERA_SPRING, type SpringConfig } from './spring';

/** Rectangle in CSS pixels, relative to the captured viewport's top-left. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Viewport of the captured app, in CSS pixels (e.g. 390x844). */
export interface Viewport {
  width: number;
  height: number;
}

/**
 * Placement of the captured surface inside the composition: where its
 * top-left corner sits, and how much it is scaled to fill the device screen.
 */
export interface SpaceTransform {
  offsetX: number;
  offsetY: number;
  scale: number;
}

export type InteractionAction = 'click' | 'type' | 'hover' | 'select' | 'scroll';

/**
 * A single interaction recorded during capture.
 *
 * `t` is measured in seconds from frame 0 of the raw capture — NOT of the
 * final scene. `planCamera` maps capture time to scene frames using the
 * scene's `playbackRate` and `captureStartSeconds`.
 */
export interface InteractionEvent {
  t: number;
  segmentId: string;
  action: InteractionAction;
  /** Human-readable target, e.g. `testId=btn-agregar`. Used for traceability. */
  target: string;
  bbox: Rect;
}

/**
 * Camera transform, applied as `translate(x, y) scale(scale)` with
 * `transform-origin: 0 0` on the captured surface.
 *
 * `x`/`y` are in captured-viewport CSS pixels. This model is exact and
 * clampable: screen position of a point p is `p * scale + (x, y)`.
 */
export interface CameraState {
  scale: number;
  x: number;
  y: number;
}

export type CameraStageKind = 'idle' | 'approach' | 'hold' | 'travel' | 'release';

/**
 * A contiguous range of frames with a single camera behaviour.
 *
 * `idle` and `hold` are static (`from` equals `to`); `approach`, `travel` and
 * `release` are spring-interpolated from `from` to `to`.
 */
export interface CameraStage {
  kind: CameraStageKind;
  /** Inclusive. */
  startFrame: number;
  /** Exclusive. */
  endFrame: number;
  from: CameraState;
  to: CameraState;
  /** Targets driving this stage; empty for `idle`. */
  targets: string[];
  /** Segment ids driving this stage; empty for `idle`. */
  segmentIds: string[];
}

/** Serializable output of `planCamera`, consumed by CLI and renderer alike. */
export interface CameraPlan {
  fps: number;
  durationInFrames: number;
  viewport: Viewport;
  stages: CameraStage[];
}

/**
 * Tunables for the camera. Defaults live in `DEFAULT_CAMERA_PROFILE` and are
 * calibrated for COMPOSITION space (the whole scene scales and travels as
 * one), not for cropping inside the device screen.
 */
export interface CameraProfile {
  /** Extra breathing room around the bbox, as a fraction of its size. */
  paddingRatio: number;
  /** Hard ceiling on zoom. Never exceeded, however small the target. */
  maxScale: number;
  /** Below this, the move is not worth making and the camera stays idle. */
  minScale: number;
  /** Seconds spent moving in, BEFORE the interaction lands. */
  approachSeconds: number;
  /** Seconds the camera stays put after the last interaction of a group. */
  holdSeconds: number;
  /** Seconds spent returning to rest. */
  releaseSeconds: number;
  /**
   * Two interactions closer than this (in seconds) are candidates for merging
   * into a single move instead of two consecutive zooms.
   */
  mergeWindowSeconds: number;
  /**
   * Guard on merging, expressed as a RATIO rather than an absolute zoom.
   *
   * Merging is refused when the combined shot would give up too much of the
   * tightest zoom the group had earned on its own: a merged scale below
   * `tightest * mergeScaleRetention` means the close-up that mattered is being
   * sacrificed to accommodate a neighbour.
   *
   * Relative on purpose. An absolute threshold silently changes meaning with
   * the coordinate space — calibrated against a 390x844 capture it let an
   * entire 1080x1920 scene collapse into a single shot.
   */
  mergeScaleRetention: number;
  /**
   * Fraction of a target that must stay on screen when the camera has to crop
   * it. Most tappable elements in a mobile UI are full-width rows, which can
   * never be framed whole with padding; without a crop allowance the camera
   * would simply never move on a real app.
   */
  minVisibleRatio: number;
  /**
   * A target covering more of the viewport than this is treated as scenery,
   * not as an element, and gets no crop allowance. Stops a full-page scroll
   * from being "zoomed into" by shaving its edges.
   */
  maxTargetAreaRatio: number;
}

export const DEFAULT_CAMERA_PROFILE: CameraProfile = {
  paddingRatio: 0.18,
  maxScale: 2.4,
  minScale: 1.08,
  approachSeconds: 0.45,
  holdSeconds: 0.6,
  releaseSeconds: 0.35,
  mergeWindowSeconds: 1.2,
  mergeScaleRetention: 0.75,
  // Tuned against a real row layout: cropping may eat the element's outer
  // margin, never its content. At 0.82 the label and the price on a full-width
  // row were both clipped; 0.94 keeps them intact while still pushing in.
  minVisibleRatio: 0.94,
  maxTargetAreaRatio: 0.5,
};

/** Camera at rest: no zoom, no translation. */
export const REST_CAMERA: CameraState = { scale: 1, x: 0, y: 0 };

export interface PlanCameraInput {
  interactions: InteractionEvent[];
  viewport: Viewport;
  fps: number;
  durationInFrames: number;
  /**
   * Speed the capture is played back at in this scene. Interaction timestamps
   * live in capture time; the scene may compress it.
   */
  playbackRate?: number;
  /** Capture-time offset of the scene's first frame. */
  captureStartSeconds?: number;
  /**
   * Region the camera must stay inside once it is close enough to fit within
   * it — normally the captured surface projected onto the canvas. Omit to
   * clamp to the scene instead.
   */
  bounds?: Rect;
  profile?: Partial<CameraProfile>;
}

/** Scene frame that a capture-time timestamp lands on. */
export function frameOfTime(
  t: number,
  fps: number,
  playbackRate = 1,
  captureStartSeconds = 0,
): number {
  return Math.round(((t - captureStartSeconds) / playbackRate) * fps);
}

/** Smallest rectangle containing both inputs. */
export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Move a rectangle from capture coordinates into composition coordinates.
 *
 * The camera plans in the space it will actually move: the whole scene scales
 * and travels as one, so a target recorded at 390x844 has to be expressed
 * where it really lands on the 1080x1920 canvas.
 */
export function projectRect(rect: Rect, transform: SpaceTransform): Rect {
  return {
    x: transform.offsetX + rect.x * transform.scale,
    y: transform.offsetY + rect.y * transform.scale,
    width: rect.width * transform.scale,
    height: rect.height * transform.scale,
  };
}

/**
 * Zoom that frames `rect`.
 *
 * Preferred framing shows the whole target with padding. When that is
 * impossible — the common case on mobile, where most tappable elements span
 * nearly the full width — the camera is allowed to crop the target down to
 * `minVisibleRatio` rather than give up and stay flat.
 *
 * The crop allowance applies only to element-sized targets: anything covering
 * more than `maxTargetAreaRatio` of the viewport is scenery, and shaving its
 * edges would zoom into nothing in particular.
 *
 * Never returns less than 1. The camera zooms in or stays put; it never pulls
 * back past the natural framing and reveals the edge of the capture.
 */
export function scaleForRect(rect: Rect, viewport: Viewport, profile: CameraProfile): number {
  if (rect.width <= 0 || rect.height <= 0) return 1;

  const padded = 1 + 2 * profile.paddingRatio;
  const fit = Math.min(
    viewport.width / (rect.width * padded),
    viewport.height / (rect.height * padded),
  );
  if (!Number.isFinite(fit)) return 1;
  if (fit >= 1) return Math.min(profile.maxScale, fit);

  const areaRatio = (rect.width * rect.height) / (viewport.width * viewport.height);
  if (areaRatio > profile.maxTargetAreaRatio) return 1;

  const cropped = Math.min(
    viewport.width / (rect.width * profile.minVisibleRatio),
    viewport.height / (rect.height * profile.minVisibleRatio),
  );
  if (!Number.isFinite(cropped)) return 1;
  return Math.min(profile.maxScale, Math.max(1, cropped));
}

/**
 * Keep the visible window inside the interesting content on one axis.
 *
 * When the window is small enough to fit inside `bounds`, it is held there —
 * this is what stops a push-in on an edge control from centring it and
 * filling half the frame with empty canvas. When the window is wider than
 * `bounds`, there is nothing to hold it to, so it falls back to staying
 * within the scene itself.
 *
 * Returns the translation for the axis.
 */
function clampAxis(
  rawTranslation: number,
  scale: number,
  viewportSize: number,
  boundsStart: number,
  boundsSize: number,
): number {
  const windowSize = viewportSize / scale;
  const fitsInBounds = windowSize <= boundsSize;

  const minStart = fitsInBounds ? boundsStart : 0;
  const maxStart = fitsInBounds ? boundsStart + boundsSize - windowSize : viewportSize - windowSize;

  const start = Math.min(maxStart, Math.max(minStart, -rawTranslation / scale));
  // `-0` renders the same but breaks equality on serialized plans.
  return start === 0 ? 0 : -start * scale;
}

/**
 * Camera that centres `rect`, clamped so the frame is always filled with
 * content worth looking at.
 *
 * `bounds` marks that content — typically the captured surface inside the
 * device mockup. Without it the camera clamps to the scene, which is correct
 * but lets a push-in on an edge element expose the canvas around the device.
 */
export function cameraForRect(
  rect: Rect,
  viewport: Viewport,
  profile: CameraProfile,
  bounds?: Rect,
): CameraState {
  const scale = scaleForRect(rect, viewport, profile);
  if (scale <= 1) return { ...REST_CAMERA };

  const area = bounds ?? { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const rawX = viewport.width / 2 - (rect.x + rect.width / 2) * scale;
  const rawY = viewport.height / 2 - (rect.y + rect.height / 2) * scale;

  return {
    scale,
    x: clampAxis(rawX, scale, viewport.width, area.x, area.width),
    y: clampAxis(rawY, scale, viewport.height, area.y, area.height),
  };
}

/** A set of interactions the camera treats as a single move. */
export interface InteractionGroup {
  interactions: InteractionEvent[];
  bbox: Rect;
  /** Tightest zoom any member of the group would have earned on its own. */
  tightestScale: number;
}

/**
 * Collapse interactions that belong to the same beat.
 *
 * Two consecutive interactions merge when they are close in time and either:
 *   - the newcomer adds nothing to the group's area, meaning it lands on the
 *     element already being framed (typing a word, tapping twice); or
 *   - the combined shot keeps most of the tightest zoom the group had earned.
 *
 * The second condition is what stops a whole flow from collapsing into one
 * static wide shot: accommodating a neighbour must not throw away the close-up
 * that made the move worth doing. It is expressed as a ratio, so it means the
 * same thing whatever coordinate space the plan runs in.
 *
 * The first condition has to come first, because a target too wide to zoom
 * into at all would otherwise fail the guard and split one keystroke run into
 * dozens of moves.
 */
export function groupInteractions(
  interactions: InteractionEvent[],
  viewport: Viewport,
  profile: CameraProfile,
): InteractionGroup[] {
  const sorted = [...interactions].sort((a, b) => a.t - b.t);
  const groups: InteractionGroup[] = [];

  for (const interaction of sorted) {
    const ownScale = scaleForRect(interaction.bbox, viewport, profile);
    const current = groups[groups.length - 1];
    if (!current) {
      groups.push({
        interactions: [interaction],
        bbox: interaction.bbox,
        tightestScale: ownScale,
      });
      continue;
    }

    const last = current.interactions[current.interactions.length - 1]!;
    const withinWindow = interaction.t - last.t <= profile.mergeWindowSeconds;
    const merged = unionRect(current.bbox, interaction.bbox);

    const currentArea = current.bbox.width * current.bbox.height;
    const mergedArea = merged.width * merged.height;
    // Same element, not a new one: the union barely grows.
    const sameTarget = currentArea > 0 && mergedArea <= currentArea * 1.02;

    const tightest = Math.max(current.tightestScale, ownScale);
    const keepsTheShot =
      scaleForRect(merged, viewport, profile) >= tightest * profile.mergeScaleRetention;

    if (withinWindow && (sameTarget || keepsTheShot)) {
      current.interactions.push(interaction);
      current.bbox = merged;
      current.tightestScale = tightest;
    } else {
      groups.push({
        interactions: [interaction],
        bbox: interaction.bbox,
        tightestScale: ownScale,
      });
    }
  }

  return groups;
}

interface Shot {
  state: CameraState;
  holdStart: number;
  holdEnd: number;
  targets: string[];
  segmentIds: string[];
}

function pushStage(stages: CameraStage[], stage: CameraStage): void {
  if (stage.endFrame <= stage.startFrame) return;
  stages.push(stage);
}

/**
 * Build the frame-by-frame camera plan for one scene.
 *
 * Shots that would overlap in time are bridged by a single `travel`; shots far
 * enough apart get a proper `release` to rest, an `idle`, and a fresh
 * `approach`.
 */
export function planCamera(input: PlanCameraInput): CameraPlan {
  const profile: CameraProfile = { ...DEFAULT_CAMERA_PROFILE, ...input.profile };
  const { viewport, fps, durationInFrames } = input;
  const playbackRate = input.playbackRate ?? 1;
  const captureStartSeconds = input.captureStartSeconds ?? 0;

  const approachFrames = Math.max(1, Math.round(profile.approachSeconds * fps));
  const holdFrames = Math.max(1, Math.round(profile.holdSeconds * fps));
  const releaseFrames = Math.max(1, Math.round(profile.releaseSeconds * fps));

  const inRange = input.interactions.filter((interaction) => {
    const frame = frameOfTime(interaction.t, fps, playbackRate, captureStartSeconds);
    return frame >= 0 && frame < durationInFrames;
  });

  const shots: Shot[] = [];
  for (const group of groupInteractions(inRange, viewport, profile)) {
    const state = cameraForRect(group.bbox, viewport, profile, input.bounds);
    // A move this small is not worth making; leave the camera alone.
    if (state.scale < profile.minScale) continue;

    const first = group.interactions[0]!;
    const last = group.interactions[group.interactions.length - 1]!;
    const holdStart = frameOfTime(first.t, fps, playbackRate, captureStartSeconds);
    const holdEnd = Math.min(
      durationInFrames,
      frameOfTime(last.t, fps, playbackRate, captureStartSeconds) + holdFrames,
    );

    const previous = shots[shots.length - 1];
    // Non-merged shots must not overlap: truncate the earlier hold rather than
    // letting two camera positions claim the same frame.
    const start = previous ? Math.max(holdStart, previous.holdEnd) : holdStart;
    if (previous && previous.holdEnd > holdStart) previous.holdEnd = holdStart;
    if (start >= holdEnd) continue;

    shots.push({
      state,
      holdStart: start,
      holdEnd,
      targets: [...new Set(group.interactions.map((i) => i.target))],
      segmentIds: [...new Set(group.interactions.map((i) => i.segmentId))],
    });
  }

  const stages: CameraStage[] = [];
  let cursor = 0;
  let currentState: CameraState = { ...REST_CAMERA };

  for (const shot of shots) {
    const gap = shot.holdStart - cursor;
    if (gap > 0) {
      const atRest = currentState.scale === 1;
      const needed = (atRest ? 0 : releaseFrames) + approachFrames;

      if (gap >= needed && !atRest) {
        // Room to breathe: settle back to rest, wait, then move in.
        const releaseEnd = cursor + releaseFrames;
        pushStage(stages, {
          kind: 'release',
          startFrame: cursor,
          endFrame: releaseEnd,
          from: currentState,
          to: { ...REST_CAMERA },
          targets: [],
          segmentIds: [],
        });
        pushStage(stages, {
          kind: 'idle',
          startFrame: releaseEnd,
          endFrame: shot.holdStart - approachFrames,
          from: { ...REST_CAMERA },
          to: { ...REST_CAMERA },
          targets: [],
          segmentIds: [],
        });
        pushStage(stages, {
          kind: 'approach',
          startFrame: shot.holdStart - approachFrames,
          endFrame: shot.holdStart,
          from: { ...REST_CAMERA },
          to: shot.state,
          targets: shot.targets,
          segmentIds: shot.segmentIds,
        });
      } else if (atRest) {
        const approachStart = Math.max(cursor, shot.holdStart - approachFrames);
        pushStage(stages, {
          kind: 'idle',
          startFrame: cursor,
          endFrame: approachStart,
          from: { ...REST_CAMERA },
          to: { ...REST_CAMERA },
          targets: [],
          segmentIds: [],
        });
        pushStage(stages, {
          kind: 'approach',
          startFrame: approachStart,
          endFrame: shot.holdStart,
          from: { ...REST_CAMERA },
          to: shot.state,
          targets: shot.targets,
          segmentIds: shot.segmentIds,
        });
      } else {
        // Too tight to return to rest: go straight from one target to the next.
        pushStage(stages, {
          kind: 'travel',
          startFrame: cursor,
          endFrame: shot.holdStart,
          from: currentState,
          to: shot.state,
          targets: shot.targets,
          segmentIds: shot.segmentIds,
        });
      }
    }

    pushStage(stages, {
      kind: 'hold',
      startFrame: shot.holdStart,
      endFrame: shot.holdEnd,
      from: shot.state,
      to: shot.state,
      targets: shot.targets,
      segmentIds: shot.segmentIds,
    });

    cursor = shot.holdEnd;
    currentState = shot.state;
  }

  if (cursor < durationInFrames) {
    if (currentState.scale !== 1) {
      const releaseEnd = Math.min(durationInFrames, cursor + releaseFrames);
      pushStage(stages, {
        kind: 'release',
        startFrame: cursor,
        endFrame: releaseEnd,
        from: currentState,
        to: { ...REST_CAMERA },
        targets: [],
        segmentIds: [],
      });
      cursor = releaseEnd;
    }
    pushStage(stages, {
      kind: 'idle',
      startFrame: cursor,
      endFrame: durationInFrames,
      from: { ...REST_CAMERA },
      to: { ...REST_CAMERA },
      targets: [],
      segmentIds: [],
    });
  }

  return { fps, durationInFrames, viewport, stages };
}

/** Camera transform on a given frame. Frames outside the plan clamp to its ends. */
export function cameraAt(
  plan: CameraPlan,
  frame: number,
  config: SpringConfig = CAMERA_SPRING,
): CameraState {
  if (plan.stages.length === 0) return { ...REST_CAMERA };

  const first = plan.stages[0]!;
  if (frame < first.startFrame) return { ...first.from };

  const stage =
    plan.stages.find((s) => frame >= s.startFrame && frame < s.endFrame) ??
    plan.stages[plan.stages.length - 1]!;

  if (frame >= stage.endFrame) return { ...stage.to };
  if (stage.kind === 'idle' || stage.kind === 'hold') return { ...stage.to };

  const progress = springProgress(
    frame - stage.startFrame,
    stage.endFrame - stage.startFrame,
    plan.fps,
    config,
  );

  return {
    scale: stage.from.scale + (stage.to.scale - stage.from.scale) * progress,
    x: stage.from.x + (stage.to.x - stage.from.x) * progress,
    y: stage.from.y + (stage.to.y - stage.from.y) * progress,
  };
}

/**
 * Timeline adapter.
 *
 * Capture timelines stamp `interactions[]` in FRAMES of the raw capture
 * (`frame: number`, an index into the recorder's frame list, local to the
 * timeline chunk that produced it). `planCamera` consumes `InteractionEvent[]`
 * where `t` is capture-time SECONDS. This block is the single place that
 * bridges the two: `t = frame / fps`.
 *
 * Deliberately duck-typed against the recorder's raw capture-timeline shape
 * instead of importing a recorder package: the video pipeline must stay usable
 * without the recorder installed. `RawTimeline` below documents the exact
 * fields this adapter reads. Reusable from both Node-side tooling (reading a
 * timeline off disk) and Remotion components (given an already-parsed object)
 * — this module has no I/O and no framework dependency, same as the rest of
 * the camera code.
 */

/** One `interactions[]` entry as a capture timeline emits it. */
export interface RawTimelineInteraction {
  /** Frame index into the capture, local to the timeline chunk. */
  frame: number;
  segmentId: string;
  action: InteractionAction;
  target: string;
  bbox: Rect;
}

/** The slice of a capture timeline this adapter needs. */
export interface RawTimeline {
  /** Capture frame rate — what `frame` is counted in. */
  fps: number;
  /** Capture viewport, CSS pixels (matches the bbox coordinate space). */
  width: number;
  height: number;
  /**
   * Optional/absent on older or hand-written timelines. Treated as an empty
   * track, not an error: a capture with no recorded interactions is valid
   * (e.g. a scene that only plays back, never directs the camera).
   */
  interactions?: RawTimelineInteraction[];
}

/** Result of adapting a raw timeline: ready for `planCamera`'s `interactions` + `viewport`. */
export interface AdaptedTrack {
  viewport: Viewport;
  interactions: InteractionEvent[];
}

/**
 * Convert a timeline's frame-indexed `interactions[]` into the
 * capture-second `InteractionEvent[]` that `planCamera` expects.
 *
 * `segmentId`, `action`, `target` and `bbox` pass through unchanged — only
 * the time axis is converted, and by construction (`bbox` is a plain object
 * literal in the raw shape too) neither array nor the bbox objects are
 * shared with the caller's input.
 *
 * Interactions are returned in ascending `t` order regardless of the input
 * order, since `planCamera` assumes a chronological track.
 */
export function interactionsFromTimeline(timeline: RawTimeline): AdaptedTrack {
  if (!Number.isFinite(timeline.fps) || timeline.fps <= 0) {
    throw new Error(`interactionsFromTimeline: invalid fps (${String(timeline.fps)})`);
  }

  const viewport: Viewport = { width: timeline.width, height: timeline.height };
  const raw = timeline.interactions ?? [];

  const interactions: InteractionEvent[] = raw
    .map((event) => ({
      t: event.frame / timeline.fps,
      segmentId: event.segmentId,
      action: event.action,
      target: event.target,
      bbox: { ...event.bbox },
    }))
    .sort((a, b) => a.t - b.t);

  return { viewport, interactions };
}
