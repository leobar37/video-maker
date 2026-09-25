import { describe, expect, test } from 'bun:test';

import { filmDurationInFrames } from './frames';
import { filmTimingPlan, stillTimingInput, type TimingInput } from './timing';

/**
 * Still-vs-render parity: the still path (no audio) and the full render path
 * must consume IDENTICAL scene boundaries. Both derive their input from the
 * same `TimingInput` through `stillTimingInput`, and both compute their plan
 * with `filmTimingPlan` — the shared frame math. These tests prove the two
 * plans agree frame-for-frame for every timing contract.
 */
function expectIdenticalBoundaries(renderInput: TimingInput): void {
  const renderPlan = filmTimingPlan(renderInput);
  const stillPlan = filmTimingPlan(stillTimingInput(renderInput));

  // Audio is the ONLY difference: a still plays none.
  expect(stillPlan.narrationEndFrame).toBeNull();

  expect(stillPlan.timingMode).toBe(renderPlan.timingMode);
  expect(stillPlan.finalBoundary).toBe(renderPlan.finalBoundary);
  expect(stillPlan.sceneFrames).toEqual(renderPlan.sceneFrames);
  expect(stillPlan.spans).toEqual(renderPlan.spans);
  expect(stillPlan.totalFrames).toBe(renderPlan.totalFrames);
}

describe('still-vs-render frame math parity', () => {
  test('continuous narration film', () => {
    expectIdenticalBoundaries({
      fps: 30,
      scenes: [
        { source: 'motion', durationInSeconds: 3 },
        { source: 'motion', durationInSeconds: 3 },
      ],
      narration: { durationSeconds: 6 },
    });
  });

  test('fractional durations (rounding-sensitive boundaries)', () => {
    expectIdenticalBoundaries({
      fps: 30,
      scenes: [
        { source: 'motion', durationInSeconds: 0.25 },
        { source: 'motion', durationInSeconds: 0.25 },
        { source: 'motion', durationInSeconds: 0.25 },
      ],
      narration: { durationSeconds: 0.75 },
    });
  });

  test('legacy per-scene timing mode', () => {
    expectIdenticalBoundaries({
      fps: 25,
      scenes: [
        { source: 'demo-app', durationInSeconds: 2.4 },
        { source: 'fal-video', durationInSeconds: 1.2 },
      ],
      timingMode: 'scene',
    });
  });

  test('avatar film (ceil final boundary)', () => {
    expectIdenticalBoundaries({
      fps: 30,
      scenes: [
        { source: 'avatar', durationInSeconds: 0.4 },
        { source: 'avatar', durationInSeconds: 0.41 },
      ],
      narration: { durationSeconds: 0.81 },
    });
  });

  test('stills land inside the same composition frame count as the render', () => {
    const input: TimingInput = {
      fps: 30,
      scenes: [
        { source: 'motion', durationInSeconds: 3 },
        { source: 'motion', durationInSeconds: 3 },
      ],
      narration: { durationSeconds: 6 },
    };
    const plan = filmTimingPlan(stillTimingInput(input));
    expect(plan.totalFrames).toBe(
      filmDurationInFrames(
        input.scenes.map((scene) => ({
          source: scene.source ?? '',
          durationInSeconds: scene.durationInSeconds,
        })),
        30,
      ),
    );
    // A sample frame picked from the plan is always renderable by renderStill.
    const sampleFrame = Math.floor(plan.totalFrames / 2);
    expect(sampleFrame).toBeGreaterThanOrEqual(0);
    expect(sampleFrame).toBeLessThan(plan.totalFrames);
    const scene = plan.spans.find((span) => sampleFrame >= span.startFrame && sampleFrame < span.endFrame);
    expect(scene).toBeDefined();
  });
});
