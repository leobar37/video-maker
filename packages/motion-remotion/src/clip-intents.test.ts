/**
 * Clip intents: still/render frame-math parity for BOTH layouts (single +
 * duo), the clip intent registry, and the pure crop/speaker helpers.
 *
 * The parity cases follow `@videomaker/motion-core`'s `render-parity.test.ts`:
 * the still path (no audio) and the full render path must consume IDENTICAL
 * scene boundaries for `source: 'clip'` scenes, whatever the layout — the
 * still of a clip lands on the same frame the render shows.
 */

import { afterEach, describe, expect, test } from 'bun:test';

import {
  filmTimingPlan,
  stillTimingInput,
  type InteractionEvent,
  type TimingInput,
} from '@videomaker/motion-core';

import { activeSpeakerId, halfCropWindow } from './ClipPodcast';
import { clampCropWindow, coverCropWindow, type CropWindow } from './ClipVertical';
import { registerClipIntents } from './clip-intents';
import { getSceneRenderer, registeredSceneIntents, unregisterScene } from './SceneRenderer';
import type { FilmScene } from './types';

/** One clip of the `clip-vertical` intent: single layout, one face. */
const CLIP_SINGLE: FilmScene = {
  id: 'clip-single',
  intent: 'clip-vertical',
  source: 'clip',
  durationInSeconds: 21.4,
  layout: 'single',
  faces: [{ id: 'a', bbox: [400, 250, 200, 300], presence: 0.98 }],
};

/** One clip of the `clip-podcast` intent: duo layout, two faces. */
const CLIP_DUO: FilmScene = {
  id: 'clip-duo',
  intent: 'clip-podcast',
  source: 'clip',
  durationInSeconds: 42.7,
  layout: 'duo',
  faces: [
    { id: 'a', bbox: [80, 220, 180, 260], presence: 0.95 },
    { id: 'b', bbox: [520, 240, 190, 270], presence: 0.9 },
  ],
};

/**
 * The timing input a clip render builds from its scenes — the exact mapping
 * `Film` performs (`{ durationInSeconds, source }`). `layout`/`faces` live on
 * `FilmScene` and must never perturb the frame math.
 */
function clipTimingInput(
  scenes: FilmScene[],
  extra?: Pick<TimingInput, 'timingMode' | 'narration'>,
): TimingInput {
  return {
    fps: 30,
    scenes: scenes.map((scene) => ({
      durationInSeconds: scene.durationInSeconds,
      source: scene.source,
    })),
    ...extra,
  };
}

/** Still plan == render plan, frame for frame (see render-parity in core). */
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

describe('clip still-vs-render frame math parity', () => {
  test('clip-vertical single scene (legacy per-scene timing)', () => {
    expectIdenticalBoundaries(clipTimingInput([CLIP_SINGLE]));
  });

  test('clip-vertical single scene (continuous narration master)', () => {
    expectIdenticalBoundaries(
      clipTimingInput([CLIP_SINGLE], { narration: { durationSeconds: 21.4 } }),
    );
  });

  test('clip-podcast duo scene (legacy per-scene timing)', () => {
    expectIdenticalBoundaries(clipTimingInput([CLIP_DUO]));
  });

  test('clip-podcast duo + fractional durations (rounding-sensitive boundaries)', () => {
    expectIdenticalBoundaries(
      clipTimingInput([CLIP_SINGLE, CLIP_DUO], {
        narration: { durationSeconds: 64.1 },
      }),
    );
  });
});

describe('registerClipIntents', () => {
  afterEach(() => {
    unregisterScene('clip-vertical');
    unregisterScene('clip-podcast');
  });

  test('registers both intents restricted to the clip source', () => {
    registerClipIntents();

    expect(registeredSceneIntents()).toEqual(
      expect.arrayContaining(['clip-vertical', 'clip-podcast']),
    );

    const vertical = getSceneRenderer('clip-vertical');
    expect(vertical).toBeDefined();
    expect(vertical?.supportedSources).toEqual(['clip']);

    const podcast = getSceneRenderer('clip-podcast');
    expect(podcast).toBeDefined();
    expect(podcast?.supportedSources).toEqual(['clip']);
  });
});

describe('clampCropWindow', () => {
  test('never exposes frame edges (property cases)', () => {
    // Deterministic LCG: the property must hold for arbitrary windows and
    // sources, without flaky randomness.
    let seed = 0x5eed;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };

    for (let i = 0; i < 250; i++) {
      const source = { width: 1 + rand() * 3839, height: 1 + rand() * 2159 };
      const desired: CropWindow = {
        x: (rand() - 0.5) * 8000,
        y: (rand() - 0.5) * 8000,
        width: (rand() - 0.2) * 6000,
        height: (rand() - 0.2) * 6000,
      };
      const crop = clampCropWindow(desired, source);

      expect(crop.width).toBeGreaterThanOrEqual(0);
      expect(crop.height).toBeGreaterThanOrEqual(0);
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.width).toBeLessThanOrEqual(source.width);
      expect(crop.y + crop.height).toBeLessThanOrEqual(source.height);
    }
  });

  test('oversized windows shrink to the source and slide inside it', () => {
    expect(clampCropWindow({ x: -500, y: 300, width: 2000, height: 4000 }, { width: 1920, height: 1080 })).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
  });

  test('non-finite inputs are treated as 0', () => {
    expect(
      clampCropWindow(
        { x: Number.NaN, y: Number.POSITIVE_INFINITY, width: 100, height: Number.NaN },
        { width: 1000, height: 1000 },
      ),
    ).toEqual({ x: 0, y: 0, width: 100, height: 0 });
  });

  test('a source without positive dimensions throws', () => {
    expect(() => clampCropWindow({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 1080 })).toThrow(
      'clampCropWindow',
    );
  });
});

describe('coverCropWindow', () => {
  const source = { width: 1920, height: 1080 };
  const canvas = { width: 1080, height: 1920 };

  test('a static plan is a centre crop (canvas aspect, source middle)', () => {
    const crop = coverCropWindow(source, canvas, source.width / 2);
    expect(crop.height).toBe(1080);
    expect(crop.width).toBeCloseTo(1080 * (canvas.width / canvas.height));
    expect(crop.x).toBeCloseTo((source.width - crop.width) / 2);
    expect(crop.y).toBe(0);
    expect(crop.width / crop.height).toBeCloseTo(canvas.width / canvas.height);
  });

  test('edge focus points never expose frame edges', () => {
    for (const focusX of [-5000, 0, 1920, 5000, Number.NaN]) {
      const crop = coverCropWindow(source, canvas, focusX);
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.width).toBeLessThanOrEqual(source.width);
      expect(crop.y + crop.height).toBeLessThanOrEqual(source.height);
    }
  });
});

describe('activeSpeakerId', () => {
  const faces = [{ id: 'a' }, { id: 'b' }];

  test('falls back to the first face without a track', () => {
    expect(activeSpeakerId(faces, undefined, 120, 30)).toBe('a');
  });

  test('falls back to the first face when no selection is in effect', () => {
    const events: InteractionEvent[] = [
      { t: 1.0, segmentId: 'f-000001', action: 'hover', target: 'face=b', bbox: { x: 0, y: 0, width: 1, height: 1 } },
      { t: 3.0, segmentId: 'f-000003', action: 'select', target: 'face=unknown', bbox: { x: 0, y: 0, width: 1, height: 1 } },
    ];
    expect(activeSpeakerId(faces, events, 45, 30)).toBe('a');
  });

  test('the select event in effect at the frame wins', () => {
    const events: InteractionEvent[] = [
      { t: 1.0, segmentId: 'f-000001', action: 'select', target: 'face=a', bbox: { x: 0, y: 0, width: 1, height: 1 } },
      { t: 2.0, segmentId: 'f-000002', action: 'select', target: 'face=b', bbox: { x: 0, y: 0, width: 1, height: 1 } },
    ];
    // Frame 30 = t 1.0s: a speaks; the selection holds until the next one.
    expect(activeSpeakerId(faces, events, 30, 30)).toBe('a');
    expect(activeSpeakerId(faces, events, 45, 30)).toBe('a');
    expect(activeSpeakerId(faces, events, 60, 30)).toBe('b');
  });

  test('future selections never apply; empty faces are null', () => {
    const events: InteractionEvent[] = [
      { t: 5.0, segmentId: 'f-000005', action: 'select', target: 'face=b', bbox: { x: 0, y: 0, width: 1, height: 1 } },
    ];
    expect(activeSpeakerId(faces, events, 30, 30)).toBe('a');
    expect(activeSpeakerId([], events, 30, 30)).toBeNull();
  });
});

describe('halfCropWindow', () => {
  const half = { width: 1080, height: 960 };

  test('maps a normalized face box to source pixels and keeps the half aspect', () => {
    const crop = halfCropWindow([250, 250, 500, 500], { width: 2000, height: 1000 }, half);
    // Face box [500, 250, 1000, 500] px, centred on (1000, 500).
    expect(crop.width / crop.height).toBeCloseTo(half.width / half.height);
    expect(crop.x + crop.width / 2).toBeCloseTo(1000);
    expect(crop.y + crop.height / 2).toBeCloseTo(500);
    expect(crop.x).toBeGreaterThanOrEqual(0);
    expect(crop.y).toBeGreaterThanOrEqual(0);
    expect(crop.x + crop.width).toBeLessThanOrEqual(2000);
    expect(crop.y + crop.height).toBeLessThanOrEqual(1000);
  });

  test('an edge face is clamped inside the source frame', () => {
    const crop = halfCropWindow([0, 0, 500, 500], { width: 1920, height: 1080 }, half);
    expect(crop.x).toBe(0);
    expect(crop.y).toBe(0);
    expect(crop.width / crop.height).toBeCloseTo(half.width / half.height);
    expect(crop.x + crop.width).toBeLessThanOrEqual(1920);
  });

  test('the smoothed camera focus overrides the static face centre', () => {
    const crop = halfCropWindow([400, 400, 200, 200], { width: 2000, height: 2000 }, half, {
      x: 900,
      y: 1000,
    });
    expect(crop.x + crop.width / 2).toBeCloseTo(900);
    expect(crop.y + crop.height / 2).toBeCloseTo(1000);
    // A focus near an edge slides the window inside the frame instead.
    const clamped = halfCropWindow([400, 400, 200, 200], { width: 2000, height: 2000 }, half, {
      x: 0,
      y: 0,
    });
    expect(clamped.x).toBe(0);
    expect(clamped.y).toBe(0);
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(2000);
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(2000);
  });

  test('tiny faces keep a context-sized crop around their centre', () => {
    const crop = halfCropWindow([450, 450, 20, 20], { width: 2000, height: 1000 }, half);
    // Face is 20px tall (box [900, 450, 40, 20] px); the crop floor is 25%
    // of the source height.
    expect(crop.height).toBeCloseTo(250);
    expect(crop.x + crop.width / 2).toBeCloseTo(920);
    expect(crop.y + crop.height / 2).toBeCloseTo(460);
  });

  test('a degenerate half size throws', () => {
    expect(() =>
      halfCropWindow([0, 0, 100, 100], { width: 1000, height: 1000 }, { width: 0, height: 960 }),
    ).toThrow('halfCropWindow');
  });
});
