import { describe, expect, test } from 'bun:test';
import type { FrameAnalysis } from '@videomaker/schemas';

import { planCamera } from './camera';
import {
  buildSoloCameraInput,
  framesToInteractions,
  splitSpeakerTracks,
  type FaceTrackFrame,
} from './face-track';

const VIEWPORT = { width: 1080, height: 1920 };
const FPS = 30;

// A full analysis entry is structurally assignable to `FaceTrackFrame`, so
// validated shards can be passed straight through.
const FULL_ANALYSIS = {
  schemaVersion: 1,
  frame_id: 'f-000001',
  t: 0.5,
  speakers: [
    { id: 'speaker-a', bbox: [100, 200, 300, 400] as [number, number, number, number], speaking: true },
  ],
  sceneCut: false,
  energy: 0.5,
  topic: 'intro',
  highlight: 0.4,
} satisfies FrameAnalysis;
const FROM_ANALYSIS: FaceTrackFrame = FULL_ANALYSIS;

describe('framesToInteractions', () => {
  test('maps normalized 0-1000 bboxes into viewport pixels', () => {
    const events = framesToInteractions([FROM_ANALYSIS], VIEWPORT, FPS);
    expect(events).toEqual([
      {
        t: 0.5,
        segmentId: 'f-000001',
        action: 'select',
        target: 'face=speaker-a',
        // [100, 200, 300, 400] of 1000 on a 1080x1920 viewport.
        bbox: { x: 108, y: 384, width: 324, height: 768 },
      },
    ]);
  });

  test('quantizes time onto the frame grid', () => {
    const events = framesToInteractions(
      [{ frame_id: 'f-000001', t: 1.02, speakers: [{ id: 'speaker-a', bbox: [0, 0, 10, 10], speaking: true }] }],
      VIEWPORT,
      FPS,
    );
    // Math.round(1.02 * 30) = frame 31, re-expressed in seconds.
    expect(events[0]!.t).toBe(31 / FPS);
  });

  test('emits at most one event per speaker per frame index', () => {
    // 1.00 * 30 = 30 and 1.01 * 30 = 30.3 → both quantize to frame 30.
    const events = framesToInteractions(
      [
        { frame_id: 'f-000001', t: 1.0, speakers: [{ id: 'speaker-a', bbox: [0, 0, 10, 10], speaking: true }] },
        { frame_id: 'f-000002', t: 1.01, speakers: [{ id: 'speaker-a', bbox: [0, 0, 20, 20], speaking: true }] },
      ],
      VIEWPORT,
      FPS,
    );
    expect(events.length).toBe(1);
    expect(events[0]!.segmentId).toBe('f-000001');
  });

  test('keeps distinct speakers at the same frame index apart', () => {
    const events = framesToInteractions(
      [
        {
          frame_id: 'f-000001',
          t: 1.0,
          speakers: [
            { id: 'speaker-a', bbox: [0, 0, 10, 10], speaking: true },
            { id: 'speaker-b', bbox: [500, 500, 10, 10], speaking: false },
          ],
        },
      ],
      VIEWPORT,
      FPS,
    );
    expect(events.map((event) => event.target)).toEqual(['face=speaker-a', 'face=speaker-b']);
    // Speaking faces are the focus targets; silent ones earn plain attention.
    expect(events.map((event) => event.action)).toEqual(['select', 'hover']);
  });

  test('drops empty boxes and tolerates empty input', () => {
    const events = framesToInteractions(
      [
        {
          frame_id: 'f-000001',
          t: 0,
          speakers: [
            { id: 'speaker-a', bbox: [10, 10, 0, 20], speaking: true },
            { id: 'speaker-b', bbox: [10, 10, 20, 0], speaking: true },
            { id: 'speaker-c', bbox: [10, 10, 20, 20], speaking: true },
          ],
        },
      ],
      VIEWPORT,
      FPS,
    );
    expect(events.map((event) => event.target)).toEqual(['face=speaker-c']);
    expect(framesToInteractions([], VIEWPORT, FPS)).toEqual([]);
  });
});

describe('buildSoloCameraInput', () => {
  test('builds a PlanCameraInput planCamera accepts without throwing', () => {
    const frames: FaceTrackFrame[] = [
      { frame_id: 'f-000001', t: 0, speakers: [{ id: 'speaker-a', bbox: [300, 300, 200, 200], speaking: true }] },
      { frame_id: 'f-000002', t: 2, speakers: [{ id: 'speaker-a', bbox: [310, 310, 200, 200], speaking: true }] },
    ];
    const input = buildSoloCameraInput(frames, VIEWPORT, FPS);
    expect(input.interactions.length).toBe(2);
    expect(input.viewport).toEqual(VIEWPORT);
    expect(input.fps).toBe(FPS);
    // Last sampled frame (index 60) plus one.
    expect(input.durationInFrames).toBe(61);
    expect(input.playbackRate).toBe(1);
    expect(input.captureStartSeconds).toBe(0);

    const plan = planCamera(input);
    expect(plan.durationInFrames).toBe(61);
    expect(Array.isArray(plan.stages)).toBe(true);
  });

  test('empty frames yield an empty, non-negative input', () => {
    const input = buildSoloCameraInput([], VIEWPORT, FPS);
    expect(input.interactions).toEqual([]);
    expect(input.durationInFrames).toBe(0);
  });
});

describe('splitSpeakerTracks', () => {
  test('splits A/B into top/bottom halves with y remapped', () => {
    const frames: FaceTrackFrame[] = [
      {
        frame_id: 'f-000001',
        t: 0,
        speakers: [
          { id: 'speaker-b', bbox: [500, 300, 200, 200], speaking: true },
          { id: 'speaker-a', bbox: [100, 200, 300, 400], speaking: false },
        ],
      },
    ];
    const { top, bottom } = splitSpeakerTracks(frames);
    // Lowest id goes to the top half: y 200 → 100 (in [0, 500]).
    expect(top).toEqual([
      {
        frame_id: 'f-000001',
        t: 0,
        speakers: [{ id: 'speaker-a', bbox: [100, 100, 300, 400], speaking: false }],
      },
    ]);
    // Second id to the bottom half: y 300 → 650 (in [500, 1000]).
    expect(bottom).toEqual([
      {
        frame_id: 'f-000001',
        t: 0,
        speakers: [{ id: 'speaker-b', bbox: [500, 650, 200, 200], speaking: true }],
      },
    ]);
  });

  test('split tracks land in the matching pixel half of the viewport', () => {
    const { top, bottom } = splitSpeakerTracks([
      {
        frame_id: 'f-000001',
        t: 0,
        speakers: [
          { id: 'speaker-a', bbox: [100, 200, 300, 400], speaking: true },
          { id: 'speaker-b', bbox: [500, 300, 200, 200], speaking: true },
        ],
      },
    ]);
    const [topEvent] = framesToInteractions(top, VIEWPORT, FPS);
    const [bottomEvent] = framesToInteractions(bottom, VIEWPORT, FPS);
    expect(topEvent!.bbox.y + topEvent!.bbox.height).toBeLessThanOrEqual(VIEWPORT.height / 2);
    expect(bottomEvent!.bbox.y).toBeGreaterThanOrEqual(VIEWPORT.height / 2);
  });

  test('sorts speaker ids globally, not per frame', () => {
    const { top, bottom } = splitSpeakerTracks([
      { frame_id: 'f-000001', t: 0, speakers: [{ id: 'zzz', bbox: [0, 0, 10, 10], speaking: true }] },
      { frame_id: 'f-000002', t: 1, speakers: [{ id: 'aaa', bbox: [0, 0, 10, 10], speaking: true }] },
    ]);
    expect(top.map((frame) => frame.speakers.map((s) => s.id))).toEqual([[], ['aaa']]);
    expect(bottom.map((frame) => frame.speakers.map((s) => s.id))).toEqual([['zzz'], []]);
  });

  test('drops speakers beyond the first two ids', () => {
    const { top, bottom } = splitSpeakerTracks([
      {
        frame_id: 'f-000001',
        t: 0,
        speakers: [
          { id: 'speaker-c', bbox: [0, 0, 10, 10], speaking: true },
          { id: 'speaker-b', bbox: [0, 0, 10, 10], speaking: true },
          { id: 'speaker-a', bbox: [0, 0, 10, 10], speaking: true },
        ],
      },
    ]);
    expect(top[0]!.speakers.map((s) => s.id)).toEqual(['speaker-a']);
    expect(bottom[0]!.speakers.map((s) => s.id)).toEqual(['speaker-b']);
  });

  test('empty frames pass through to both halves', () => {
    const frames: FaceTrackFrame[] = [
      { frame_id: 'f-000001', t: 0, speakers: [] },
      {
        frame_id: 'f-000002',
        t: 1,
        speakers: [
          { id: 'speaker-a', bbox: [100, 100, 50, 50], speaking: true },
          { id: 'speaker-b', bbox: [200, 200, 50, 50], speaking: false },
        ],
      },
      { frame_id: 'f-000003', t: 2, speakers: [] },
    ];
    const { top, bottom } = splitSpeakerTracks(frames);
    expect(top.map((frame) => [frame.frame_id, frame.t, frame.speakers.length])).toEqual([
      ['f-000001', 0, 0],
      ['f-000002', 1, 1],
      ['f-000003', 2, 0],
    ]);
    expect(bottom.map((frame) => [frame.frame_id, frame.t, frame.speakers.length])).toEqual([
      ['f-000001', 0, 0],
      ['f-000002', 1, 1],
      ['f-000003', 2, 0],
    ]);
  });

  test('empty input yields empty halves and input is left untouched', () => {
    expect(splitSpeakerTracks([])).toEqual({ top: [], bottom: [] });

    const frames: FaceTrackFrame[] = [
      {
        frame_id: 'f-000001',
        t: 0,
        speakers: [{ id: 'speaker-a', bbox: [100, 200, 300, 400], speaking: true }],
      },
    ];
    const before = structuredClone(frames);
    splitSpeakerTracks(frames);
    expect(frames).toEqual(before);
  });
});
