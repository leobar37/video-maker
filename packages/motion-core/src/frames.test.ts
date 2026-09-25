import { describe, expect, test } from 'bun:test';

import {
  coveringFrameCount,
  coverFinalSceneFrame,
  cumulativeSceneFrames,
  filmDurationInFrames,
  filmSceneFrames,
  sceneFinalBoundary,
} from './frames';

describe('sceneFinalBoundary', () => {
  test('round for non-avatar films', () => {
    expect(sceneFinalBoundary([{ source: 'motion' }, { source: 'demo-app' }])).toBe('round');
  });

  test('ceil when any scene is avatar', () => {
    expect(sceneFinalBoundary([{ source: 'motion' }, { source: 'avatar' }])).toBe('ceil');
    expect(sceneFinalBoundary([{ source: 'avatar' }])).toBe('ceil');
  });
});

describe('coveringFrameCount', () => {
  test('ceils fractional coverage', () => {
    expect(coveringFrameCount(1.01, 30)).toBe(31);
    expect(coveringFrameCount(1.5, 30)).toBe(45);
  });

  test('ignores float noise at exact integers', () => {
    // 0.3 * 30 = 8.999999999999998 in IEEE-754; the epsilon must not add a frame.
    expect(coveringFrameCount(0.3, 30)).toBe(9);
    expect(coveringFrameCount(2, 25)).toBe(50);
    expect(coveringFrameCount(6.6, 30)).toBe(198);
    expect(coveringFrameCount(0.8, 30)).toBe(24);
  });

  test('rejects non-positive durations and fps', () => {
    expect(() => coveringFrameCount(0, 30)).toThrow();
    expect(() => coveringFrameCount(1, 0)).toThrow();
    expect(() => coveringFrameCount(Number.NaN, 30)).toThrow();
    expect(() => coveringFrameCount(1, Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe('filmDurationInFrames', () => {
  test('rounds the total for legacy films', () => {
    expect(filmDurationInFrames([{ source: 'motion', durationInSeconds: 1 }], 30)).toBe(30);
    expect(filmDurationInFrames([{ source: 'motion', durationInSeconds: 0.5 }], 30)).toBe(15);
    // round(sum) may differ from sum(round): 3 x 0.25s = 0.75s -> 22.5 -> 23.
    expect(
      filmDurationInFrames(
        [
          { source: 'motion', durationInSeconds: 0.25 },
          { source: 'motion', durationInSeconds: 0.25 },
          { source: 'motion', durationInSeconds: 0.25 },
        ],
        30,
      ),
    ).toBe(23);
  });

  test('covers the total for avatar films', () => {
    // 0.81s * 30 = 24.3 frames: round -> 24 (loses samples), ceil -> 25.
    const scenes = [
      { source: 'avatar', durationInSeconds: 0.4 },
      { source: 'avatar', durationInSeconds: 0.41 },
    ];
    expect(filmDurationInFrames(scenes, 30)).toBe(25);
    expect(
      filmDurationInFrames(
        scenes.map((scene) => ({ ...scene, source: 'motion' })),
        30,
      ),
    ).toBe(24);
  });

  test('never returns less than one frame', () => {
    expect(filmDurationInFrames([{ source: 'motion', durationInSeconds: 0.001 }], 30)).toBe(1);
  });
});

describe('cumulativeSceneFrames', () => {
  test('chains cumulative boundaries without rounding drift', () => {
    // Per-scene rounding of 0.25s @ 30fps is 8f each (sum 24); the cumulative
    // boundaries land on 8/15/23 and the exact sum is 23 = round(0.75 * 30).
    expect(cumulativeSceneFrames([0.25, 0.25, 0.25], 30)).toEqual([8, 7, 8]);
    expect(filmSceneFrames([0.25, 0.25, 0.25], 30, 'scene')).toEqual([8, 8, 8]);
  });

  test('final boundary ceil keeps every sample of the total', () => {
    const frames = cumulativeSceneFrames([0.4, 0.41], 30, { finalBoundary: 'ceil' });
    expect(frames).toEqual([12, 13]);
    expect(frames.reduce((total, n) => total + n, 0)).toBe(coveringFrameCount(0.81, 30));
  });

  test('throws on sub-frame scenes instead of silently clamping', () => {
    expect(() => cumulativeSceneFrames([0.01, 1], 30)).toThrow(/no avanza/);
  });

  test('throws on invalid durations and fps', () => {
    expect(() => cumulativeSceneFrames([1], 0)).toThrow();
    expect(() => cumulativeSceneFrames([0, 1], 30)).toThrow();
    expect(() => cumulativeSceneFrames([-1, 1], 30)).toThrow();
    expect(() => cumulativeSceneFrames([Number.NaN], 30)).toThrow();
  });
});

describe('filmSceneFrames', () => {
  test('continuous mode uses cumulative boundaries', () => {
    expect(filmSceneFrames([0.25, 0.25, 0.25], 30, 'continuous')).toEqual([8, 7, 8]);
  });

  test('scene mode keeps historical per-scene rounding', () => {
    expect(filmSceneFrames([0.37, 0.37, 0.37], 30, 'scene')).toEqual([11, 11, 11]);
    expect(filmSceneFrames([0.01], 30, 'scene')).toEqual([1]);
    expect(filmSceneFrames([0.01], 30, 'scene', { finalBoundary: 'ceil' })).toEqual([1]);
  });
});

describe('coverFinalSceneFrame', () => {
  test('no-op unless the film ceils its final boundary', () => {
    const scenes = [
      { source: 'motion', durationInSeconds: 0.25 },
      { source: 'motion', durationInSeconds: 0.25 },
    ];
    expect(coverFinalSceneFrame(scenes, 30)).toBe(scenes);
  });

  test('pads only the final scene to cover the last frame', () => {
    const scenes = [
      { source: 'avatar', durationInSeconds: 0.4 },
      { source: 'avatar', durationInSeconds: 0.41 },
    ];
    const covered = coverFinalSceneFrame(scenes, 30);
    expect(covered[0]).toEqual(scenes[0]);
    // 25 frames cover 0.81s only as 25/30s; the tail is added to the last slot.
    expect(covered[1]!.durationInSeconds).toBeCloseTo(0.41 + (25 / 30 - 0.81), 10);
    // Internal cut unchanged: only the final visual slot gains < 1 frame.
    const frames = cumulativeSceneFrames(
      covered.map((scene) => scene.durationInSeconds),
      30,
      { finalBoundary: 'ceil' },
    );
    expect(frames).toEqual([12, 13]);
  });
});
