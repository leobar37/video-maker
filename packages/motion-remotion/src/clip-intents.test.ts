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

import { activeSpeakerId, halfCropLayout } from './ClipPodcast';
import {
  activeSubtitleSegmentAt,
  clampCropWindow,
  nativeCropLayout,
  sceneSubtitleSegments,
  VERTICAL_SAFE_ZONES,
  type CropWindow,
} from './ClipVertical';
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

describe('nativeCropLayout (zoom prohibited)', () => {
  const source = { width: 1920, height: 1080 };
  const canvas = { width: 1080, height: 1920 };

  test('the scale NEVER exceeds 1.0 (property cases)', () => {
    const sources = [
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
      { width: 640, height: 360 },
      { width: 1080, height: 1920 },
      { width: 400, height: 3000 },
    ];
    for (const candidate of sources) {
      for (const focusX of [-5000, 0, candidate.width / 2, candidate.width, 5000, Number.NaN]) {
        const layout = nativeCropLayout(candidate, canvas, focusX);
        expect(layout.scale).toBeLessThanOrEqual(1);
        expect(layout.scale).toBe(1);
        expect(layout.crop.width).toBeLessThanOrEqual(Math.min(candidate.width, canvas.width));
        expect(layout.crop.height).toBeLessThanOrEqual(Math.min(candidate.height, canvas.height));
        expect(layout.box.width).toBe(layout.crop.width);
        expect(layout.box.height).toBe(layout.crop.height);
        expect(layout.position.x).toBeGreaterThanOrEqual(0);
        expect(layout.position.y).toBeGreaterThanOrEqual(0);
        expect(layout.position.x + layout.box.width).toBeLessThanOrEqual(canvas.width);
        expect(layout.position.y + layout.box.height).toBeLessThanOrEqual(canvas.height);
      }
    }
  });

  test('a 1080p source lands as a 1080x1080 native window centred on the canvas', () => {
    const layout = nativeCropLayout(source, canvas, source.width / 2);
    expect(layout.crop).toEqual({ x: 420, y: 0, width: 1080, height: 1080 });
    expect(layout.position).toEqual({ x: 0, y: 420 });
    expect(layout.scale).toBe(1);
  });

  test('the window follows x(t) but never exposes frame edges', () => {
    for (const focusX of [-5000, 0, 1920, 5000, Number.NaN]) {
      const { crop } = nativeCropLayout(source, canvas, focusX);
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.width).toBeLessThanOrEqual(source.width);
      expect(crop.y + crop.height).toBeLessThanOrEqual(source.height);
    }
    expect(nativeCropLayout(source, canvas, 400).crop.x).toBe(0);
    expect(nativeCropLayout(source, canvas, 1520).crop.x).toBe(840);
  });

  test('a source smaller than the canvas is shown 1:1 — never upscaled', () => {
    const layout = nativeCropLayout({ width: 640, height: 360 }, canvas, 320);
    expect(layout.scale).toBe(1);
    expect(layout.crop).toEqual({ x: 0, y: 0, width: 640, height: 360 });
    expect(layout.position).toEqual({ x: 220, y: 780 });
  });

  test('a canvas without positive dimensions throws', () => {
    expect(() =>
      nativeCropLayout(source, { width: 0, height: 1920 }, 50),
    ).toThrow('nativeCropLayout');
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

describe('halfCropLayout (zoom prohibited)', () => {
  const half = { width: 1080, height: 960 };
  const source = { width: 1920, height: 1080 };

  test('the scale NEVER exceeds 1.0 and the window fits source and half', () => {
    const boxes: Array<[number, number, number, number]> = [
      [250, 250, 500, 500],
      [0, 0, 100, 100],
      [900, 800, 100, 150],
    ];
    for (const bbox of boxes) {
      for (const focus of [undefined, { x: 960, y: 540 }, { x: -100, y: 5000 }]) {
        const layout = halfCropLayout(bbox, source, half, 960, focus);
        expect(layout.scale).toBeLessThanOrEqual(1);
        expect(layout.scale).toBe(1);
        expect(layout.crop.width).toBeLessThanOrEqual(
          Math.min(Math.round(half.width * 0.75), source.width),
        );
        expect(layout.crop.height).toBeLessThanOrEqual(
          Math.min(Math.round(half.height * 0.62), source.height),
        );
        expect(layout.crop.x).toBeGreaterThanOrEqual(0);
        expect(layout.crop.y).toBeGreaterThanOrEqual(0);
        expect(layout.crop.x + layout.crop.width).toBeLessThanOrEqual(source.width);
        expect(layout.crop.y + layout.crop.height).toBeLessThanOrEqual(source.height);
      }
    }
  });

  test('the estimated head sits at the upper anchor of its window (subs stay clear)', () => {
    const layout = halfCropLayout([250, 250, 500, 500], source, half, 0);
    expect(layout.crop.height).toBe(Math.round(960 * 0.62));
    expect(layout.crop.width).toBe(Math.round(1080 * 0.75));
    // Head centre estimate = box top + min(half box, 11% of source height).
    const headCenterY = 270 + Math.min(270, 1080 * 0.11);
    expect(headCenterY - layout.crop.y).toBeCloseTo(0.32 * layout.crop.height, 0);
    expect(layout.position).toEqual({ x: 135, y: 24 });
    expect(layout.position.y + layout.box.height).toBeLessThan(half.height);
    // The bottom half's window bottom stays above the subtitle safe band.
    const bottom = halfCropLayout([250, 250, 500, 500], source, half, 960);
    expect(bottom.position.y + bottom.box.height).toBeLessThanOrEqual(
      1920 - VERTICAL_SAFE_ZONES.bottom - 120,
    );
  });

  test('PERSON boxes keep the head in frame (regression: torso/legs crops)', () => {
    // The clip-01 bug: the model returned full-body boxes ([110,115,260,875])
    // and the old face-centre anchor cut every head off the window.
    const layout = halfCropLayout([110, 115, 260, 875], source, half, 0);
    const headTopPx = (115 / 1000) * 1080;
    // The head band (box top) must land INSIDE the window, near the top.
    expect(layout.crop.y).toBeLessThanOrEqual(headTopPx);
    expect(headTopPx - layout.crop.y).toBeLessThan(0.25 * layout.crop.height);
    // And the window never drops below the legs-free upper body (no feet).
    expect(layout.crop.y).toBeGreaterThanOrEqual(0);
  });

  test('the camera focus slides the window without exposing edges', () => {
    const layout = halfCropLayout([400, 400, 200, 200], source, half, 960, { x: 0, y: 0 });
    expect(layout.crop.x).toBe(0);
    expect(layout.crop.x + layout.crop.width).toBeLessThanOrEqual(1920);
    expect(layout.crop.y + layout.crop.height).toBeLessThanOrEqual(1080);
  });

  test('a degenerate half size throws', () => {
    expect(() =>
      halfCropLayout([0, 0, 100, 100], { width: 1000, height: 1000 }, { width: 0, height: 960 }, 0),
    ).toThrow('halfCropLayout');
  });
});

describe('subtitles from whisper word timings', () => {
  const segments = [
    { text: 'hola', start: 0.5, end: 1.5 },
    { text: 'mundo', start: 1.5, end: 2.5 },
  ];

  test('activeSubtitleSegmentAt picks the half-open segment on screen', () => {
    expect(activeSubtitleSegmentAt(segments, 0.4)).toBeNull();
    expect(activeSubtitleSegmentAt(segments, 0.5)?.text).toBe('hola');
    expect(activeSubtitleSegmentAt(segments, 1.5)?.text).toBe('mundo');
    expect(activeSubtitleSegmentAt(segments, 2.5)).toBeNull();
    expect(activeSubtitleSegmentAt([], 1)).toBeNull();
  });

  test('scene segments win over the narration fallback (no clip is ever silent)', () => {
    const withWords: FilmScene = {
      ...CLIP_SINGLE,
      subtitleSegments: segments,
      narration: 'otro texto',
    };
    expect(sceneSubtitleSegments(withWords, 90, 30)).toEqual(segments);
    const fallback = sceneSubtitleSegments({ ...CLIP_SINGLE, narration: 'una frase' }, 90, 30);
    expect(fallback).toHaveLength(1);
    expect(fallback[0]?.text).toBe('una frase');
    expect(sceneSubtitleSegments({ ...CLIP_SINGLE }, 90, 30)).toEqual([]);
  });
});
