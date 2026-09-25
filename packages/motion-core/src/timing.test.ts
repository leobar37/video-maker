import { describe, expect, test } from 'bun:test';

import { filmDurationInFrames } from './frames';
import { filmTimingPlan, resolveTimingMode, type TimingInput } from './timing';

const CONTINUOUS_INPUT: TimingInput = {
  fps: 30,
  scenes: [
    { source: 'motion', durationInSeconds: 2.5 },
    { source: 'motion', durationInSeconds: 2.5 },
  ],
  narration: { durationSeconds: 5 },
};

describe('resolveTimingMode', () => {
  test('narration implies continuous', () => {
    expect(resolveTimingMode(CONTINUOUS_INPUT)).toBe('continuous');
    expect(resolveTimingMode({ fps: 30, scenes: [{ durationInSeconds: 1 }] })).toBe('scene');
  });

  test('explicit mode wins over the narration implication', () => {
    expect(resolveTimingMode({ ...CONTINUOUS_INPUT, timingMode: 'scene' })).toBe('scene');
    expect(
      resolveTimingMode({ fps: 30, scenes: [{ durationInSeconds: 1 }], timingMode: 'continuous' }),
    ).toBe('continuous');
  });
});

describe('filmTimingPlan — continuous narration timing', () => {
  test('spans chain exactly: no gaps, no overlaps', () => {
    const plan = filmTimingPlan(CONTINUOUS_INPUT);
    expect(plan.timingMode).toBe('continuous');
    expect(plan.spans[0]!.startFrame).toBe(0);
    for (let i = 1; i < plan.spans.length; i += 1) {
      expect(plan.spans[i]!.startFrame).toBe(plan.spans[i - 1]!.endFrame);
    }
    expect(plan.spans[plan.spans.length - 1]!.endFrame).toBe(plan.totalFrames);
  });

  test('every scene gets at least one frame and durations match spans', () => {
    const plan = filmTimingPlan(CONTINUOUS_INPUT);
    plan.spans.forEach((span, index) => {
      expect(span.index).toBe(index);
      expect(span.durationInFrames).toBeGreaterThan(0);
      expect(span.endFrame - span.startFrame).toBe(span.durationInFrames);
      expect(span.durationInFrames).toBe(plan.sceneFrames[index]);
    });
  });

  test('exact chaining survives fractional durations (no drift)', () => {
    const plan = filmTimingPlan({
      fps: 30,
      scenes: [
        { durationInSeconds: 0.25 },
        { durationInSeconds: 0.25 },
        { durationInSeconds: 0.25 },
      ],
      timingMode: 'continuous',
    });
    expect(plan.sceneFrames).toEqual([8, 7, 8]);
    expect(plan.totalFrames).toBe(23);
  });

  test('total frames equal the shared filmDurationInFrames authority', () => {
    const plan = filmTimingPlan(CONTINUOUS_INPUT);
    expect(plan.totalFrames).toBe(
      filmDurationInFrames(
        CONTINUOUS_INPUT.scenes.map((scene) => ({
          source: scene.source ?? '',
          durationInSeconds: scene.durationInSeconds,
        })),
        30,
      ),
    );

    const avatarPlan = filmTimingPlan({
      fps: 30,
      scenes: [
        { source: 'avatar', durationInSeconds: 0.4 },
        { source: 'avatar', durationInSeconds: 0.41 },
      ],
      narration: { durationSeconds: 0.81 },
    });
    expect(avatarPlan.finalBoundary).toBe('ceil');
    expect(avatarPlan.totalFrames).toBe(25);
  });

  test('narration plays once: end frame follows the final boundary', () => {
    expect(filmTimingPlan(CONTINUOUS_INPUT).narrationEndFrame).toBe(150);

    // Legacy round boundary: the master stops at round(duration * fps).
    const legacy = filmTimingPlan({
      fps: 30,
      scenes: [
        { source: 'motion', durationInSeconds: 2 },
        { source: 'motion', durationInSeconds: 2 },
      ],
      narration: { durationSeconds: 3.5 },
      timingMode: 'scene',
    });
    expect(legacy.narrationEndFrame).toBe(105);

    // ceil boundary: the master covers every frame of the composition.
    const avatar = filmTimingPlan({
      fps: 30,
      scenes: [
        { source: 'avatar', durationInSeconds: 0.4 },
        { source: 'avatar', durationInSeconds: 0.41 },
      ],
      narration: { durationSeconds: 0.81 },
    });
    expect(avatar.narrationEndFrame).toBe(avatar.totalFrames);

    expect(filmTimingPlan({ fps: 30, scenes: [{ durationInSeconds: 1 }] }).narrationEndFrame).toBe(
      null,
    );
  });

  test('rejects invalid input', () => {
    expect(() => filmTimingPlan({ fps: 0, scenes: [{ durationInSeconds: 1 }] })).toThrow();
    expect(() => filmTimingPlan({ fps: 30, scenes: [] })).toThrow();
    expect(() => filmTimingPlan({ fps: 30, scenes: [{ durationInSeconds: 0 }] })).toThrow();
    expect(() =>
      filmTimingPlan({
        fps: 30,
        scenes: [{ durationInSeconds: 1 }],
        narration: { durationSeconds: -1 },
      }),
    ).toThrow();
  });
});
