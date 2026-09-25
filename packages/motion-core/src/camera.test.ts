import { describe, expect, test } from 'bun:test';

import {
  cameraAt,
  DEFAULT_CAMERA_PROFILE,
  frameOfTime,
  interactionsFromTimeline,
  planCamera,
  projectRect,
  REST_CAMERA,
  scaleForRect,
  type InteractionEvent,
  type PlanCameraInput,
} from './camera';
import { CAMERA_SPRING, springProgress, springValue } from './spring';

const VIEWPORT = { width: 1080, height: 1920 };
const PHONE_SPACE = { offsetX: 345, offsetY: 250, scale: 1 };

function click(t: number, target: string, bbox: InteractionEvent['bbox']): InteractionEvent {
  return { t, segmentId: `seg-${target}`, action: 'click', target, bbox };
}

const TRACK: InteractionEvent[] = [
  click(0.5, 'fila-1', { x: 40, y: 300, width: 310, height: 90 }),
  click(2.2, 'fila-2', { x: 40, y: 900, width: 310, height: 90 }),
];

const BASE_INPUT: PlanCameraInput = {
  interactions: TRACK,
  viewport: VIEWPORT,
  fps: 30,
  durationInFrames: 120,
  bounds: projectRect({ x: 0, y: 0, width: 390, height: 844 }, PHONE_SPACE),
};

describe('planCamera', () => {
  test('produces a serializable plan with a JSON round-trip', () => {
    const plan = planCamera(BASE_INPUT);
    const roundTripped = JSON.parse(JSON.stringify(plan));
    expect(roundTripped).toEqual(plan);
    // The plan is pure data: stages, states and metadata only.
    expect(plan.fps).toBe(30);
    expect(plan.durationInFrames).toBe(120);
    expect(plan.viewport).toEqual(VIEWPORT);
  });

  test('stages tile the whole scene without gaps or overlaps', () => {
    const plan = planCamera(BASE_INPUT);
    expect(plan.stages.length).toBeGreaterThan(0);
    expect(plan.stages[0]!.startFrame).toBe(0);
    for (let i = 1; i < plan.stages.length; i += 1) {
      expect(plan.stages[i]!.startFrame).toBe(plan.stages[i - 1]!.endFrame);
    }
    expect(plan.stages[plan.stages.length - 1]!.endFrame).toBe(120);
    plan.stages.forEach((stage) => {
      expect(stage.endFrame).toBeGreaterThan(stage.startFrame);
      // No `-0`: breaks deep equality on serialized plans.
      expect(Object.is(stage.from.x, -0)).toBe(false);
      expect(Object.is(stage.to.x, -0)).toBe(false);
    });
  });

  test('cameraAt is deterministic and finite on every frame', () => {
    const plan = planCamera(BASE_INPUT);
    for (let frame = 0; frame < 120; frame += 1) {
      const state = cameraAt(plan, frame);
      expect(Number.isFinite(state.scale)).toBe(true);
      expect(Number.isFinite(state.x)).toBe(true);
      expect(Number.isFinite(state.y)).toBe(true);
      expect(state.scale).toBeGreaterThanOrEqual(1);
    }
    // Frames outside the plan clamp to its ends.
    expect(cameraAt(plan, -10)).toEqual(plan.stages[0]!.from);
    expect(cameraAt(plan, 9999)).toEqual(plan.stages[plan.stages.length - 1]!.to);
  });

  test('identical input yields an identical plan (CLI and render agree)', () => {
    expect(planCamera(BASE_INPUT)).toEqual(planCamera(BASE_INPUT));
  });

  test('a track with no worth-moving target stays at rest', () => {
    const plan = planCamera({
      ...BASE_INPUT,
      // Full-viewport target = scenery: no crop allowance, no move.
      interactions: [click(0.5, 'escenario', { x: 0, y: 0, width: 1080, height: 1920 })],
    });
    expect(plan.stages.every((stage) => stage.from === REST_CAMERA || stage.from.scale === 1)).toBe(
      true,
    );
    expect(cameraAt(plan, 60)).toEqual(REST_CAMERA);
  });

  test('out-of-range interactions are ignored', () => {
    const plan = planCamera({
      ...BASE_INPUT,
      interactions: [click(500, 'fuera', { x: 40, y: 300, width: 310, height: 90 })],
    });
    expect(cameraAt(plan, 60)).toEqual(REST_CAMERA);
  });
});

describe('interactionsFromTimeline', () => {
  test('converts frame-indexed events to seconds and sorts them', () => {
    const adapted = interactionsFromTimeline({
      fps: 20,
      width: 390,
      height: 844,
      interactions: [
        {
          frame: 40,
          segmentId: 'b',
          action: 'type',
          target: 'input',
          bbox: { x: 1, y: 2, width: 3, height: 4 },
        },
        {
          frame: 10,
          segmentId: 'a',
          action: 'click',
          target: 'btn',
          bbox: { x: 5, y: 6, width: 7, height: 8 },
        },
      ],
    });

    expect(adapted.viewport).toEqual({ width: 390, height: 844 });
    expect(adapted.interactions.map((event) => event.t)).toEqual([0.5, 2]);
    expect(adapted.interactions[0]!.target).toBe('btn');
    // Bboxes are copied, never shared with the caller's input.
    expect(adapted.interactions[0]!.bbox).toEqual({ x: 5, y: 6, width: 7, height: 8 });
  });

  test('missing interactions read as an empty track', () => {
    const adapted = interactionsFromTimeline({ fps: 30, width: 390, height: 844 });
    expect(adapted.interactions).toEqual([]);
  });

  test('rejects invalid fps', () => {
    expect(() => interactionsFromTimeline({ fps: 0, width: 1, height: 1 })).toThrow();
    expect(() =>
      interactionsFromTimeline({ fps: Number.NaN, width: 1, height: 1 }),
    ).toThrow();
  });
});

describe('projection helpers', () => {
  test('projectRect maps capture space into composition space', () => {
    expect(projectRect({ x: 10, y: 20, width: 30, height: 40 }, PHONE_SPACE)).toEqual({
      x: 355,
      y: 270,
      width: 30,
      height: 40,
    });
  });

  test('scaleForRect frames targets without ever pulling back', () => {
    const profile = { ...DEFAULT_CAMERA_PROFILE };
    // Full-viewport target cannot be framed with padding: scenery, no zoom.
    expect(scaleForRect({ x: 0, y: 0, width: 1080, height: 1920 }, VIEWPORT, profile)).toBe(1);
    expect(scaleForRect({ x: 0, y: 0, width: 0, height: 0 }, VIEWPORT, profile)).toBe(1);
    // A small target gets framed with padding, clamped to the zoom ceiling.
    const zoomed = scaleForRect({ x: 400, y: 800, width: 90, height: 60 }, VIEWPORT, profile);
    expect(zoomed).toBeGreaterThanOrEqual(1);
    expect(zoomed).toBeLessThanOrEqual(profile.maxScale);
  });

  test('frameOfTime maps capture time through playback rate and offset', () => {
    expect(frameOfTime(1, 30)).toBe(30);
    expect(frameOfTime(1, 30, 2)).toBe(15);
    expect(frameOfTime(3, 30, 1, 2)).toBe(30);
  });
});

describe('shared spring', () => {
  test('springValue starts at 0 and approaches 1', () => {
    expect(springValue(0)).toBe(0);
    expect(springValue(-1)).toBe(0);
    const late = springValue(2);
    expect(late).toBeGreaterThan(0.99);
    expect(late).toBeLessThanOrEqual(1);
  });

  test('springProgress is normalised over its window', () => {
    expect(springProgress(0, 20, 30)).toBe(0);
    expect(springProgress(20, 20, 30)).toBe(1);
    expect(springProgress(30, 20, 30)).toBe(1);
    const mid = springProgress(10, 20, 30);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    // Critical damping never overshoots.
    expect(mid).toBeLessThanOrEqual(springProgress(15, 20, 30));
  });

  test('CAMERA_SPRING is critically damped', () => {
    expect(CAMERA_SPRING.damping).toBe(2 * Math.sqrt(CAMERA_SPRING.stiffness * CAMERA_SPRING.mass));
  });
});
