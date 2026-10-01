/**
 * `clip-frames` pipeline (part 1/4): pure sampling/sharding determinism plus
 * the thin runner driven by a fake `ProcessRunner` — no real ffmpeg, no
 * network. Only the sha256 hashing and the manifest writes touch disk (temp
 * dirs).
 */
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';

import { loadProject, type Project } from '@videomaker/core';
import type { FfmpegResult, FfmpegRunner } from '@videomaker/motion-remotion/loudness';
import type { ProcessResult, ProcessRunner } from '@videomaker/providers';
import {
  ClipRangeSchema,
  SCORING_PRESETS,
  type ClipRange,
  type ClipSocial,
  type FrameAnalysis,
  type FrameSpeaker,
  type ScoringPreset,
} from '@videomaker/schemas';

import {
  buildCandidates,
  buildClipCards,
  buildClipFilmProps,
  buildShardsManifest,
  buildWindowShards,
  buildCriticState,
  compactCandidatesForReview,
  downloadClipSource,
  explainCandidate,
  applyCriticVerdicts,
  selectDistinctSpans,
  truncateTranscriptSlice,
  REVIEW_CANDIDATE_LIMIT,
  REVIEW_STATE_CHAR_BUDGET,
  isRemoteSource,
  locateAt,
  parseCriticResponse,
  planStripGrid,
  polishRanges,
  probeSource,
  proposeWindows,
  renderClipsDashboard,
  renderStripGrid,
  resolveFrameAt,
  runClipFrames,
  runClipFramesKeys,
  runClipPolish,
  sampleFrames,
  sampleKeyFrames,
  scoreWindow,
  socialFallback,
  transcribeToTranscript,
  trimClipMedia,
  windowSignals,
  type ClipDashboardCard,
  type ClipWord,
  type FrameEntry,
  type ProposedWindow,
  type ShardsManifest,
} from './clip';
import { makeTestProject } from './test-support';

/** SHA-256 of the three bytes `abc` (fixed digest, no self-comparison). */
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

/** Fake ffprobe output: 1080×1920 @ 30 fps, 5.2 s. */
const PROBE_JSON = JSON.stringify({
  streams: [{ width: 1080, height: 1920, r_frame_rate: '30/1' }],
  format: { duration: '5.2' },
});

interface RecordedCall {
  command: string;
  args: string[];
}

function fakeProcess(
  handle: (command: string, args: string[]) => ProcessResult,
): { runner: ProcessRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    runner: {
      async run(command, args) {
        calls.push({ command, args: [...args] });
        return handle(command, args);
      },
    },
  };
}

interface RunnerOverrides {
  probeStdout?: string;
  probeCode?: number;
  probeStderr?: string;
  ffmpegCode?: number;
  ffmpegStderr?: string;
}

function mediaRunner(overrides: RunnerOverrides = {}): {
  runner: ProcessRunner;
  calls: RecordedCall[];
} {
  return fakeProcess((command) => {
    if (command === 'ffprobe') {
      return {
        code: overrides.probeCode ?? 0,
        stdout: overrides.probeStdout ?? PROBE_JSON,
        stderr: overrides.probeStderr ?? '',
      };
    }
    return {
      code: overrides.ffmpegCode ?? 0,
      stdout: '',
      stderr: overrides.ffmpegStderr ?? '',
    };
  });
}

/** `f-000001`-style ids for the inclusive range [from, to] (1-based). */
function idRange(from: number, to: number): string[] {
  return Array.from(
    { length: to - from + 1 },
    (_, index) => `f-${String(from + index).padStart(6, '0')}`,
  );
}

/** Every referenced frame exists in the manifest and is analyzable exactly once. */
function assertShardsCoverFrames(frames: FrameEntry[], shards: ShardsManifest): void {
  const known = new Set(frames.map((frame) => frame.frame_id));
  const analyzable: string[] = [];
  for (const shard of shards.shards) {
    const context = new Set(shard.contextOnlyFrameIds);
    for (const id of [...shard.frameIds, ...shard.contextOnlyFrameIds]) {
      expect(known.has(id)).toBe(true);
    }
    for (const id of shard.frameIds) {
      if (!context.has(id)) analyzable.push(id);
    }
  }
  expect(analyzable.length).toBe(frames.length);
  expect([...analyzable].sort()).toEqual(frames.map((frame) => frame.frame_id).sort());
}

describe('sampleFrames', () => {
  test('numbers frames f-000001… over the grid + scene cuts, sorted by t', () => {
    const frames = sampleFrames({
      durationSeconds: 5.2,
      fps: 30,
      frameEverySeconds: 1,
      sceneCutTimes: [4.4, 2.5],
    });
    expect(frames).toEqual([
      { frame_id: 'f-000001', t: 0, path: 'clips/frames/f-000001.jpg', rol: 'key' },
      { frame_id: 'f-000002', t: 1, path: 'clips/frames/f-000002.jpg', rol: 'key' },
      { frame_id: 'f-000003', t: 2, path: 'clips/frames/f-000003.jpg', rol: 'key' },
      { frame_id: 'f-000004', t: 2.5, path: 'clips/frames/f-000004.jpg', rol: 'key' },
      { frame_id: 'f-000005', t: 3, path: 'clips/frames/f-000005.jpg', rol: 'key' },
      { frame_id: 'f-000006', t: 4, path: 'clips/frames/f-000006.jpg', rol: 'key' },
      { frame_id: 'f-000007', t: 4.4, path: 'clips/frames/f-000007.jpg', rol: 'key' },
      { frame_id: 'f-000008', t: 5, path: 'clips/frames/f-000008.jpg', rol: 'key' },
    ]);
  });

  test('defaults frameEverySeconds to 1 and collapses cuts on the same frame', () => {
    const frames = sampleFrames({
      durationSeconds: 3.5,
      fps: 30,
      sceneCutTimes: [1, 1.01, 2.012],
    });
    expect(frames.map((frame) => frame.t)).toEqual([0, 1, 2, 3]);
  });

  test('drops scene cuts at or beyond durationSeconds', () => {
    const frames = sampleFrames({
      durationSeconds: 3,
      fps: 30,
      frameEverySeconds: 1,
      sceneCutTimes: [2.5, 3, 9],
    });
    expect(frames.map((frame) => frame.t)).toEqual([0, 1, 2, 2.5]);
  });

  test('is deterministic: same input ⇒ byte-identical frames', () => {
    const options = {
      durationSeconds: 12.3,
      fps: 25,
      frameEverySeconds: 2,
      sceneCutTimes: [7.5, 3.25, 7.5],
    };
    expect(JSON.stringify(sampleFrames(options))).toBe(JSON.stringify(sampleFrames(options)));
  });

  test('rejects garbage options and scene cuts', () => {
    expect(() => sampleFrames({ durationSeconds: 5, fps: 0 })).toThrow(/fps/);
    expect(() => sampleFrames({ durationSeconds: Number.NaN, fps: 30 })).toThrow(
      /durationSeconds/,
    );
    expect(() =>
      sampleFrames({ durationSeconds: 5, fps: 30, frameEverySeconds: 0 }),
    ).toThrow(/frameEverySeconds/);
    expect(() => sampleFrames({ durationSeconds: 5, fps: 30, sceneCutTimes: [-1] })).toThrow(
      /sceneCutTimes/,
    );
    expect(() =>
      sampleFrames({ durationSeconds: 5, fps: 30, sceneCutTimes: [Number.NaN] }),
    ).toThrow(/sceneCutTimes/);
  });
});

describe('buildShardsManifest', () => {
  const frames = sampleFrames({
    durationSeconds: 140,
    fps: 30,
    frameEverySeconds: 1,
    sceneCutTimes: [],
  });

  test('shards analyzable frames and carries 5 context frames into later shards', () => {
    const manifest = buildShardsManifest(frames);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.shardSize).toBe(60);
    expect(manifest.shards.map((shard) => shard.id)).toEqual([
      'shard-001',
      'shard-002',
      'shard-003',
    ]);
    expect(manifest.shards.map((shard) => shard.prevSummary)).toEqual(['', '', '']);

    const [first, second, third] = manifest.shards;
    expect(first.contextOnlyFrameIds).toEqual([]);
    expect(first.frameIds).toEqual(idRange(1, 60));

    expect(second.contextOnlyFrameIds).toEqual(idRange(56, 60));
    expect(second.frameIds).toEqual(idRange(56, 120));

    expect(third.contextOnlyFrameIds).toEqual(idRange(116, 120));
    expect(third.frameIds).toEqual([...idRange(116, 120), ...idRange(121, 140)]);
  });

  test('covers every frame exactly once as analyzable; all ids exist in frames.json', () => {
    assertShardsCoverFrames(frames, buildShardsManifest(frames));
  });

  test('is deterministic: same input ⇒ byte-identical shards', () => {
    const a = buildShardsManifest(frames);
    const b = buildShardsManifest(frames);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('carries all previous frames when the previous shard is shorter than contextFrames', () => {
    const short = sampleFrames({
      durationSeconds: 4,
      fps: 30,
      frameEverySeconds: 1,
      sceneCutTimes: [],
    });
    const manifest = buildShardsManifest(short, 3, 5);
    expect(manifest.shards).toEqual([
      {
        id: 'shard-001',
        frameIds: idRange(1, 3),
        contextOnlyFrameIds: [],
        prevSummary: '',
      },
      {
        id: 'shard-002',
        frameIds: idRange(1, 4),
        contextOnlyFrameIds: idRange(1, 3),
        prevSummary: '',
      },
    ]);
  });

  test('rejects invalid sizes, duplicate ids and non-canonical frame ids', () => {
    expect(() => buildShardsManifest(frames, 0)).toThrow(/shardSize/);
    expect(() => buildShardsManifest(frames, 60, -1)).toThrow(/contextFrames/);
    expect(() => buildShardsManifest([frames[0], frames[0]])).toThrow(/duplicate frame_id/);
    expect(() => buildShardsManifest([{ ...frames[0], frame_id: 'x-1' }])).toThrow(/frame_id/);
  });
});

describe('probeSource', () => {
  test('probes width/height/duration/fps and hashes the file offline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-probe-'));
    const srcPath = join(dir, 'source.mp4');
    await writeFile(srcPath, 'abc');
    const { runner, calls } = mediaRunner();

    await expect(probeSource(runner, srcPath)).resolves.toEqual({
      durationSeconds: 5.2,
      width: 1080,
      height: 1920,
      fps: 30,
      sha256: SHA256_ABC,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('ffprobe');
    expect(calls[0].args[calls[0].args.length - 1]).toBe(srcPath);
  });

  test('parses fractional rates and falls back to avg_frame_rate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-probe-'));
    const srcPath = join(dir, 'source.mp4');
    await writeFile(srcPath, 'abc');
    const fractional = mediaRunner({
      probeStdout: JSON.stringify({
        streams: [{ width: 1280, height: 720, r_frame_rate: '30000/1001' }],
        format: { duration: '10' },
      }),
    });
    const probe = await probeSource(fractional.runner, srcPath);
    expect(probe.fps).toBeCloseTo(29.97002997, 6);

    const fallback = mediaRunner({
      probeStdout: JSON.stringify({
        streams: [{ width: 1280, height: 720, r_frame_rate: '0/0', avg_frame_rate: '25/1' }],
        format: { duration: '10' },
      }),
    });
    expect((await probeSource(fallback.runner, srcPath)).fps).toBe(25);
  });

  test('rejects URL sources with an actionable yt-dlp error before any process run', async () => {
    const { runner, calls } = mediaRunner();
    await expect(
      probeSource(runner, 'https://www.youtube.com/watch?v=abc123'),
    ).rejects.toThrow(/yt-dlp/);
    await expect(
      probeSource(runner, 'https://www.youtube.com/watch?v=abc123'),
    ).rejects.toThrow(/local file/i);
    expect(calls).toHaveLength(0);
  });

  test('rejects ffprobe failures and malformed or incomplete output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-probe-'));
    const srcPath = join(dir, 'source.mp4');
    await writeFile(srcPath, 'abc');

    await expect(
      probeSource(mediaRunner({ probeCode: 1, probeStderr: 'no such file' }).runner, srcPath),
    ).rejects.toThrow(/ffprobe failed/);
    await expect(
      probeSource(mediaRunner({ probeStdout: 'not json' }).runner, srcPath),
    ).rejects.toThrow(/invalid JSON/);
    await expect(
      probeSource(
        mediaRunner({
          probeStdout: JSON.stringify({ streams: [], format: { duration: '5' } }),
        }).runner,
        srcPath,
      ),
    ).rejects.toThrow(/no usable video stream/);
    await expect(
      probeSource(
        mediaRunner({
          probeStdout: JSON.stringify({
            streams: [{ width: 1080, height: 1920, r_frame_rate: '30/1' }],
            format: {},
          }),
        }).runner,
        srcPath,
      ),
    ).rejects.toThrow(/no usable duration/);
    await expect(
      probeSource(
        mediaRunner({
          probeStdout: JSON.stringify({
            streams: [{ width: 1080, height: 1920, r_frame_rate: '0/0' }],
            format: { duration: '5' },
          }),
        }).runner,
        srcPath,
      ),
    ).rejects.toThrow(/no usable frame rate/);
  });
});

describe('runClipFrames', () => {
  async function sourceIn(dir: string): Promise<string> {
    const srcPath = join(dir, 'source.mp4');
    await writeFile(srcPath, 'abc');
    return srcPath;
  }

  const options = {
    frameEverySeconds: 2,
    sceneCutTimes: [3.5],
    shardSize: 2,
    contextFrames: 1,
  };

  test('extracts each sampled frame and writes source/frames/shards manifests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-frames-'));
    const srcPath = await sourceIn(dir);
    const { runner, calls } = mediaRunner();

    const result = await runClipFrames(runner, dir, { srcPath, ...options });

    expect(result.frames.frames.map((frame) => frame.frame_id)).toEqual([
      'f-000001',
      'f-000002',
      'f-000003',
      'f-000004',
    ]);
    expect(result.frames.frames.map((frame) => frame.t)).toEqual([0, 2, 3.5, 4]);
    expect(result.shards).toEqual({
      schemaVersion: 1,
      shardSize: 2,
      shards: [
        {
          id: 'shard-001',
          frameIds: ['f-000001', 'f-000002'],
          contextOnlyFrameIds: [],
          prevSummary: '',
        },
        {
          id: 'shard-002',
          frameIds: ['f-000002', 'f-000003', 'f-000004'],
          contextOnlyFrameIds: ['f-000002'],
          prevSummary: '',
        },
      ],
    });
    assertShardsCoverFrames(result.frames.frames, result.shards);

    const source = JSON.parse(await readFile(join(dir, 'clips', 'source.json'), 'utf8'));
    expect(source).toEqual({
      schemaVersion: 1,
      path: srcPath,
      durationSeconds: 5.2,
      width: 1080,
      height: 1920,
      fps: 30,
      sha256: SHA256_ABC,
    });
    expect(JSON.parse(await readFile(join(dir, 'clips', 'frames.json'), 'utf8'))).toEqual(
      result.frames,
    );
    expect(JSON.parse(await readFile(join(dir, 'clips', 'shards.json'), 'utf8'))).toEqual(
      result.shards,
    );

    const extractions = calls.filter((call) => call.command === 'ffmpeg');
    expect(extractions).toHaveLength(4);
    extractions.forEach((call, index) => {
      const seekAt = call.args.indexOf('-ss');
      expect(seekAt).toBeGreaterThan(-1);
      expect(call.args[seekAt + 1]).toBe(String(result.frames.frames[index].t));
      expect(call.args[call.args.length - 1]).toBe(
        join(dir, 'clips', 'frames', `f-00000${index + 1}.jpg`),
      );
    });
  });

  test('is deterministic: same source facts + flags ⇒ identical manifests', async () => {
    const firstDir = await mkdtemp(join(tmpdir(), 'vm-clip-det-a-'));
    const secondDir = await mkdtemp(join(tmpdir(), 'vm-clip-det-b-'));
    const first = await runClipFrames(mediaRunner().runner, firstDir, {
      srcPath: await sourceIn(firstDir),
      ...options,
    });
    const second = await runClipFrames(mediaRunner().runner, secondDir, {
      srcPath: await sourceIn(secondDir),
      ...options,
    });

    expect(first.shards).toEqual(second.shards);
    expect(JSON.stringify(first.shards)).toBe(JSON.stringify(second.shards));
    expect(JSON.stringify(first.frames)).toBe(JSON.stringify(second.frames));
    assertShardsCoverFrames(first.frames.frames, first.shards);
  });

  test('fetches URL sources with yt-dlp into clips/source.mp4 and records sourceUrl', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-url-'));
    const url = 'https://www.youtube.com/watch?v=abc123';
    const { runner, calls } = fakeProcess((command, args) => {
      if (command === 'yt-dlp') {
        writeFileSync(args[args.indexOf('-o') + 1], 'downloaded');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (command === 'ffprobe') {
        return { code: 0, stdout: PROBE_JSON, stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    const result = await runClipFrames(runner, dir, { srcPath: url, ...options });

    const ytdlp = calls.find((call) => call.command === 'yt-dlp');
    expect(ytdlp?.args).toContain(url);
    expect(ytdlp?.args).toContain(join(dir, 'clips', 'source.mp4'));
    expect(calls[0]?.command).toBe('yt-dlp');
    const source = JSON.parse(await readFile(join(dir, 'clips', 'source.json'), 'utf8'));
    expect(source.sourceUrl).toBe(url);
    expect(source.path).toBe(join(dir, 'clips', 'source.mp4'));
    expect(result.frames.frames.map((frame) => frame.t)).toEqual([0, 2, 3.5, 4]);
  });

  test('yt-dlp failures are actionable and skip probing entirely', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-url-fail-'));
    const { runner, calls } = fakeProcess((command) => {
      if (command === 'yt-dlp') {
        return { code: 1, stdout: '', stderr: 'video unavailable' };
      }
      return { code: 0, stdout: PROBE_JSON, stderr: '' };
    });
    await expect(
      runClipFrames(runner, dir, {
        srcPath: 'https://www.youtube.com/watch?v=abc123',
        ...options,
      }),
    ).rejects.toThrow(/yt-dlp failed .*exit 1.*video unavailable/s);
    expect(calls.map((call) => call.command)).toEqual(['yt-dlp']);
  });

  test('downloadClipSource rejects non-URL input without touching processes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-dl-'));
    const { runner, calls } = fakeProcess(() => ({ code: 0, stdout: '', stderr: '' }));
    await expect(downloadClipSource(runner, dir, 'local.mp4')).rejects.toThrow(/http\(s\) URL/);
    expect(calls).toHaveLength(0);
    expect(isRemoteSource('https://example.com/v')).toBe(true);
    expect(isRemoteSource('/tmp/v.mp4')).toBe(false);
  });

  test('surfaces ffmpeg extraction failures naming the frame', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-ffmpeg-'));
    const srcPath = await sourceIn(dir);
    const { runner } = mediaRunner({ ffmpegCode: 1, ffmpegStderr: 'boom' });
    await expect(runClipFrames(runner, dir, { srcPath, ...options })).rejects.toThrow(
      /f-000001/,
    );
  });
});

// ---------------------------------------------------------------------------
// Part 2/4 — scoring and candidate aggregation: transcript heuristics, the
// six signals, the weighted score, candidate aggregation and the audit
// rendering. Offline fixtures only.
// ---------------------------------------------------------------------------

/** Words from a text run: each token lasts `wordSeconds`, then `gapSeconds`. */
function wordStream(
  text: string,
  startAt = 0,
  wordSeconds = 0.3,
  gapSeconds = 0.1,
): ClipWord[] {
  const words: ClipWord[] = [];
  const step = wordSeconds + gapSeconds;
  const tokens = text.split(/\s+/).filter((token) => token.length > 0);
  tokens.forEach((word, index) => {
    const start = Math.round((startAt + index * step) * 10_000) / 10_000;
    words.push({
      word,
      start,
      end: Math.round((start + wordSeconds) * 10_000) / 10_000,
    });
  });
  return words;
}

function speaker(
  id: string,
  speaking = false,
  bbox: [number, number, number, number] = [100, 100, 200, 200],
): FrameSpeaker {
  return { id, bbox, speaking };
}

function analysisFrame(
  index: number,
  speakers: FrameSpeaker[],
  overrides: Partial<FrameAnalysis> = {},
): FrameAnalysis {
  return {
    schemaVersion: 1,
    frame_id: `f-${String(index + 1).padStart(6, '0')}`,
    t: index,
    speakers,
    sceneCut: false,
    energy: 0.5,
    topic: 'intro',
    highlight: 0.5,
    ...overrides,
  };
}

/** Sparse intro, then `How?` opens the good part (hook fixture). */
const HOOK_WORDS: ClipWord[] = [
  ...wordStream('one two three four five six', 0, 0.4, 0.6),
  ...wordStream('How? yeah okay well sure fine great', 6, 0.4, 0.6),
];

/** 20 packed words at 0.3 s spacing (dense-speech + burst fixture). */
const DENSE_WORDS: ClipWord[] = wordStream(
  'a b c d e f g h i j k l m n o p q r s t',
  0,
  0.25,
  0.05,
);

/** Slow talk around one fast cluster (burst fixture). */
const BURST_WORDS: ClipWord[] = [
  { word: 'intro', start: 0, end: 0.3 },
  { word: 'talk', start: 1.8, end: 2.1 },
  ...wordStream('ba bb bc bd be bf', 4, 0.25, 0.05),
  { word: 'tail', start: 9, end: 9.3 },
  { word: 'end', start: 10.8, end: 11.1 },
];

/** Two turns (pause-split), each opened by a hook cue. */
const TWO_TURN_WORDS: ClipWord[] = [
  ...wordStream('How? yeah okay well sure fine great ends.', 0, 0.4, 0.6),
  ...wordStream('Why? yeah okay well sure fine great stops.', 30, 0.4, 0.6),
];

/** Preset fixture A: highlight+hook heavy, low density/emotion/novelty/closure. */
const PRESET_WORDS_A: ClipWord[] = [
  { word: 'How?', start: 0, end: 0.5 },
  { word: 'we', start: 5, end: 5.4 },
  { word: 'do', start: 10, end: 10.4 },
  { word: 'it', start: 15, end: 15.4 },
];
const PRESET_FRAMES_A: FrameAnalysis[] = [
  analysisFrame(0, [], { t: 1, highlight: 0.9, energy: 0.1, topic: 'intro' }),
  analysisFrame(1, [], { t: 2, highlight: 1, energy: 0.1, topic: 'intro' }),
];

/** Preset fixture B: density+emotion heavy, low highlight/hook/novelty/closure. */
const PRESET_WORDS_B: ClipWord[] = Array.from({ length: 30 }, (_, index) => ({
  word: 'yeah',
  start: index / 3,
  end: index / 3 + 0.3,
}));
const PRESET_FRAMES_B: FrameAnalysis[] = [
  analysisFrame(0, [speaker('speaker-a', true)], {
    t: 1,
    highlight: 0.1,
    energy: 0.9,
    topic: 'intro',
  }),
  analysisFrame(1, [speaker('speaker-a', true)], {
    t: 2,
    highlight: 0.1,
    energy: 1,
    topic: 'intro',
  }),
];

/** Preset fixture C: novelty+closure heavy, low highlight/hook/density/emotion. */
const PRESET_WORDS_C: ClipWord[] = [
  { word: 'The', start: 0, end: 0.4 },
  { word: 'new', start: 4, end: 4.4 },
  { word: 'chapter', start: 8, end: 8.4 },
  { word: 'begins.', start: 12, end: 12.4 },
];
const PRESET_FRAMES_C: FrameAnalysis[] = [
  analysisFrame(0, [], {
    t: 1,
    highlight: 0.1,
    energy: 0.1,
    topic: 'reveal',
    sceneCut: true,
  }),
  analysisFrame(1, [], {
    t: 2,
    highlight: 0.1,
    energy: 0.1,
    topic: 'reveal',
    sceneCut: true,
  }),
];

const PREVIOUS_TOPICS = { topics: ['intro'] };

describe('proposeWindows', () => {
  test('returns [] for an empty transcript', () => {
    expect(proposeWindows([])).toEqual([]);
    expect(proposeWindows([], { minSeconds: 4, maxSeconds: 20 })).toEqual([]);
  });

  test('proposes a window opening at a hook cue with its local preScore', () => {
    expect(proposeWindows(HOOK_WORDS, { minSeconds: 4, maxSeconds: 20 })).toEqual([
      {
        id: 'win-01',
        start: 6,
        end: 12.4,
        preScore: 0.8094,
        reason: 'opens with a hook cue',
      },
    ]);
  });

  test('proposes dense speech without gaps as its own window', () => {
    expect(proposeWindows(DENSE_WORDS, { minSeconds: 4, maxSeconds: 20 })).toEqual([
      {
        id: 'win-01',
        start: 0,
        end: 5.95,
        preScore: 0.5,
        reason: 'dense speech without gaps',
      },
    ]);
  });

  test('proposes a fast-paced burst inside a slower turn', () => {
    expect(proposeWindows(BURST_WORDS, { minSeconds: 4, maxSeconds: 20 })).toEqual([
      {
        id: 'win-01',
        start: 4,
        end: 11.1,
        preScore: 0.2676,
        reason: 'fast-paced burst',
      },
    ]);
  });

  test('clamps windows to maxSeconds and drops tails shorter than minSeconds', () => {
    const clamped = proposeWindows(DENSE_WORDS, { minSeconds: 1, maxSeconds: 3 });
    expect(clamped).toEqual([
      { id: 'win-01', start: 0, end: 3, preScore: 0.4, reason: 'dense speech without gaps' },
    ]);
    expect(clamped[0].end - clamped[0].start).toBeLessThanOrEqual(3);
    expect(
      proposeWindows(wordStream('How? yeah', 0, 0.3, 0.2), { minSeconds: 4, maxSeconds: 20 }),
    ).toEqual([]);
  });

  test('numbers windows win-01… sorted by start, deterministically', () => {
    const options = { minSeconds: 4, maxSeconds: 20 };
    const first = proposeWindows(TWO_TURN_WORDS, options);
    expect(first.map((window) => window.id)).toEqual(['win-01', 'win-02']);
    expect(first.map((window) => window.start)).toEqual([0, 30]);
    expect(first.map((window) => window.reason)).toEqual([
      'opens with a hook cue',
      'opens with a hook cue',
    ]);
    expect(JSON.stringify(proposeWindows(TWO_TURN_WORDS, options))).toBe(
      JSON.stringify(first),
    );
  });

  test('rejects invalid bounds, malformed times and out-of-order words', () => {
    expect(() => proposeWindows([], { minSeconds: 0 })).toThrow(/minSeconds/);
    expect(() => proposeWindows([], { maxSeconds: Number.NaN })).toThrow(/maxSeconds/);
    expect(() => proposeWindows([], { minSeconds: 10, maxSeconds: 5 })).toThrow(
      /maxSeconds/,
    );
    expect(() => proposeWindows([{ word: 'x', start: 2, end: 1 }])).toThrow(
      /start <= end/,
    );
    expect(() =>
      proposeWindows([
        { word: 'a', start: 2, end: 2.5 },
        { word: 'b', start: 1, end: 1.5 },
      ]),
    ).toThrow(/chronological/);
  });
});

describe('windowSignals', () => {
  test('computes the documented formulas on a full fixture', () => {
    expect(windowSignals(PRESET_FRAMES_A, PRESET_WORDS_A, PREVIOUS_TOPICS)).toEqual({
      highlight: 0.95,
      hook: 1,
      density: 0.0346,
      emotion: 0,
      novelty: 0,
      closure: 0,
    });
  });

  test('hook: full credit in the first 3s, half for a later cue, none without', () => {
    const laterCue: ClipWord[] = [
      { word: 'stuff', start: 0, end: 0.3 },
      { word: 'Why?', start: 10, end: 10.4 },
    ];
    expect(windowSignals([], PRESET_WORDS_A).hook).toBe(1);
    expect(windowSignals([], laterCue).hook).toBe(0.5);
    expect(windowSignals([], PRESET_WORDS_B).hook).toBe(0);
  });

  test('density compares words/sec to 3 wps and penalizes gaps over 1s', () => {
    const packed = wordStream('ba bb bc bd', 0, 0.25, 0.05);
    const gapped: ClipWord[] = [
      { word: 'ba', start: 0, end: 0.3 },
      { word: 'bb', start: 0.5, end: 0.8 },
      { word: 'bc', start: 4, end: 4.3 },
      { word: 'bd', start: 4.5, end: 4.8 },
    ];
    const packedDensity = windowSignals([], packed).density;
    expect(packedDensity).toBe(1);
    expect(windowSignals([], gapped).density).toBeCloseTo(0.2222, 4);
    expect(windowSignals([], gapped).density).toBeLessThan(packedDensity);
  });

  test('emotion is the speaking ratio times the mean energy', () => {
    const frames = [
      analysisFrame(0, [speaker('speaker-a', true)], { t: 0, energy: 0.5 }),
      analysisFrame(1, [], { t: 1, energy: 1 }),
    ];
    expect(windowSignals(frames, []).emotion).toBe(0.375);
  });

  test('novelty compares scene cuts and topics against previous topics', () => {
    expect(windowSignals(PRESET_FRAMES_C, PRESET_WORDS_C, PREVIOUS_TOPICS).novelty).toBe(1);
    expect(windowSignals(PRESET_FRAMES_C, PRESET_WORDS_C).novelty).toBe(0.75);
  });

  test('closure is 1 only when the last word ends a written sentence', () => {
    expect(windowSignals([], PRESET_WORDS_C).closure).toBe(1);
    expect(windowSignals([], PRESET_WORDS_A).closure).toBe(0);
  });

  test('empty inputs yield zeroed signals plus the novelty baseline', () => {
    expect(windowSignals([], [])).toEqual({
      highlight: 0,
      hook: 0,
      density: 0,
      emotion: 0,
      novelty: 0.25,
      closure: 0,
    });
  });

  test('rejects malformed word times', () => {
    expect(() => windowSignals([], [{ word: 'x', start: 2, end: 1 }])).toThrow(
      /windowSignals/,
    );
  });
});

describe('scoreWindow', () => {
  test('weights the six signals and keeps the raw breakdown auditable', () => {
    const { score, breakdown } = scoreWindow(
      PRESET_FRAMES_A,
      PRESET_WORDS_A,
      {
        highlight: 1,
        hook: 1,
        density: 1,
        emotion: 1,
        novelty: 1,
        closure: 1,
      },
      PREVIOUS_TOPICS,
    );
    expect(breakdown).toEqual({
      highlight: 0.95,
      hook: 1,
      density: 0.0346,
      emotion: 0,
      novelty: 0,
      closure: 0,
    });
    // Equal weights ⇒ the plain mean of the six signals.
    expect(score).toBe(0.3308);
  });

  test('each SCORING_PRESETS ranking matches its documented favorites', () => {
    const cases = [
      { name: 'A', frames: PRESET_FRAMES_A, words: PRESET_WORDS_A },
      { name: 'B', frames: PRESET_FRAMES_B, words: PRESET_WORDS_B },
      { name: 'C', frames: PRESET_FRAMES_C, words: PRESET_WORDS_C },
    ];
    const scoresFor = (preset: ScoringPreset): number[] =>
      cases.map(
        (entry) =>
          scoreWindow(entry.frames, entry.words, SCORING_PRESETS[preset], PREVIOUS_TOPICS)
            .score,
      );
    const rankFor = (preset: ScoringPreset): string[] =>
      cases
        .map((entry, index) => ({ name: entry.name, score: scoresFor(preset)[index] }))
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.name);

    // A is highlight+hook heavy, B density+emotion, C novelty+closure.
    expect(scoresFor('viral')).toEqual([0.5325, 0.2786, 0.2335]);
    expect(scoresFor('podcast')).toEqual([0.2155, 0.5439, 0.2663]);
    expect(scoresFor('educational')).toEqual([0.2128, 0.247, 0.5611]);
    expect(rankFor('viral')).toEqual(['A', 'B', 'C']);
    expect(rankFor('podcast')).toEqual(['B', 'C', 'A']);
    expect(rankFor('educational')).toEqual(['C', 'B', 'A']);
  });

  test('clamps the weighted average to 0-1 and rejects degenerate weights', () => {
    expect(scoreWindow([], [], SCORING_PRESETS.viral).score).toBe(0.0286);
    expect(() =>
      scoreWindow([], [], {
        highlight: 0,
        hook: 0,
        density: 0,
        emotion: 0,
        novelty: 0,
        closure: 0,
      }),
    ).toThrow(/sum/);
    expect(() => scoreWindow([], [], { ...SCORING_PRESETS.viral, hook: -1 })).toThrow(
      /"hook"/,
    );
    expect(() =>
      scoreWindow([], [], { ...SCORING_PRESETS.viral, hook: Number.NaN }),
    ).toThrow(/"hook"/);
  });
});

describe('socialFallback', () => {
  test('templates title, the seconds range and hashtags from the topic', () => {
    expect(
      socialFallback('The Secret Of Great Editing And Pacing And Rhythm', 12.5, 40),
    ).toEqual({
      title: 'The Secret Of Great Editing And Pacing And',
      description: 'Clip from 12.5s to 40s.',
      hashtags: ['the', 'secret', 'of'],
    });
  });

  test('handles a topic without usable words', () => {
    expect(socialFallback('   ', 0, 5)).toEqual({
      title: 'Clip highlight',
      description: 'Clip from 0s to 5s.',
      hashtags: ['clip'],
    });
  });

  test('strips accents and non-alnum characters from hashtags', () => {
    expect(socialFallback('Cómo editar rápido!', 1, 2).hashtags).toEqual([
      'como',
      'editar',
      'rapido',
    ]);
  });

  test('dedupes hashtags and caps them at three', () => {
    expect(socialFallback('edit edit editing edit more words', 0, 1).hashtags).toEqual([
      'edit',
      'editing',
      'more',
    ]);
  });
});

describe('buildCandidates', () => {
  const options = { minDurationSeconds: 4, maxDurationSeconds: 20 };

  test('duo only for exactly 2 faces with presence >= 0.8 (0.8/0.9)', () => {
    const frames = Array.from({ length: 10 }, (_, k) => {
      const speakers: FrameSpeaker[] = [];
      if (k < 8) speakers.push(speaker('speaker-a'));
      if (k >= 1) speakers.push(speaker('speaker-b', false, [500, 100, 200, 200]));
      return analysisFrame(k, speakers, { t: 0.5 + 0.5 * k });
    });
    const [candidate] = buildCandidates({
      words: DENSE_WORDS,
      analyses: frames,
      weights: SCORING_PRESETS.viral,
      options,
    });
    expect(candidate.layout).toBe('duo');
    expect(candidate.faces).toEqual([
      { id: 'speaker-b', bbox: [500, 100, 200, 200], presence: 0.9 },
      { id: 'speaker-a', bbox: [100, 100, 200, 200], presence: 0.8 },
    ]);
  });

  test('two faces at presence 0.7 stay single', () => {
    const frames = Array.from({ length: 10 }, (_, k) => {
      const speakers: FrameSpeaker[] = [];
      if (k < 7) speakers.push(speaker('speaker-a'));
      if (k >= 3) speakers.push(speaker('speaker-b', false, [500, 100, 200, 200]));
      return analysisFrame(k, speakers, { t: 0.5 + 0.5 * k });
    });
    const [candidate] = buildCandidates({
      words: DENSE_WORDS,
      analyses: frames,
      weights: SCORING_PRESETS.viral,
      options,
    });
    expect(candidate.layout).toBe('single');
    expect(candidate.faces.map((face) => face.presence)).toEqual([0.7, 0.7]);
  });

  test('three faces stay single even when two are highly present', () => {
    const frames = Array.from({ length: 10 }, (_, k) => {
      const speakers: FrameSpeaker[] = [];
      if (k < 8) speakers.push(speaker('speaker-a'));
      if (k >= 1) speakers.push(speaker('speaker-b', false, [500, 100, 200, 200]));
      if (k >= 5) speakers.push(speaker('speaker-c', false, [300, 400, 200, 200]));
      return analysisFrame(k, speakers, { t: 0.5 + 0.5 * k });
    });
    const [candidate] = buildCandidates({
      words: DENSE_WORDS,
      analyses: frames,
      weights: SCORING_PRESETS.viral,
      options,
    });
    expect(candidate.layout).toBe('single');
    expect(candidate.faces).toHaveLength(3);
  });

  test('one face stays single and keeps the median bbox', () => {
    const frames = Array.from({ length: 10 }, (_, k) =>
      analysisFrame(k, [speaker('speaker-a', false, [100 + 20 * k, 100, 200, 200])], {
        t: 0.5 + 0.5 * k,
      }),
    );
    const [candidate] = buildCandidates({
      words: DENSE_WORDS,
      analyses: frames,
      weights: SCORING_PRESETS.viral,
      options,
    });
    expect(candidate.layout).toBe('single');
    expect(candidate.faces).toEqual([
      { id: 'speaker-a', bbox: [190, 100, 200, 200], presence: 1 },
    ]);
  });

  test('ranks by score desc, numbers clip-01… and templates the social fallback', () => {
    const analyses: FrameAnalysis[] = [
      analysisFrame(0, [], { t: 1, highlight: 1, topic: 'first topic' }),
      analysisFrame(1, [], { t: 2, highlight: 1, topic: 'first topic' }),
      analysisFrame(2, [], { t: 3, highlight: 1, topic: 'first topic' }),
      analysisFrame(3, [], { t: 4, highlight: 1, topic: 'first topic' }),
      analysisFrame(4, [], { t: 31, highlight: 0.1, topic: 'second topic' }),
      analysisFrame(5, [], { t: 32, highlight: 0.1, topic: 'second topic' }),
      analysisFrame(6, [], { t: 33, highlight: 0.1, topic: 'second topic' }),
      analysisFrame(7, [], { t: 34, highlight: 0.1, topic: 'second topic' }),
    ];
    const candidates = buildCandidates({
      words: TWO_TURN_WORDS,
      analyses,
      weights: SCORING_PRESETS.viral,
      options,
    });
    expect(
      candidates.map((candidate) => ({
        id: candidate.id,
        start: candidate.start,
        end: candidate.end,
        score: candidate.score,
      })),
    ).toEqual([
      { id: 'clip-01', start: 0, end: 7.4, score: 0.6983 },
      { id: 'clip-02', start: 30, end: 37.4, score: 0.4412 },
    ]);
    expect(candidates[0].breakdown).toEqual({
      highlight: 1,
      hook: 1,
      density: 0.3604,
      emotion: 0,
      novelty: 0.25,
      closure: 1,
    });
    expect(candidates[0].social).toEqual({
      title: 'first topic',
      description: 'Clip from 0s to 7.4s.',
      hashtags: ['first', 'topic'],
    });
    expect(candidates[1].social).toEqual({
      title: 'second topic',
      description: 'Clip from 30s to 37.4s.',
      hashtags: ['second', 'topic'],
    });
  });

  test('is deterministic and emits schema-valid ClipRange documents', () => {
    const input = {
      words: TWO_TURN_WORDS,
      analyses: [
        analysisFrame(0, [], { t: 1, highlight: 1, topic: 'first topic' }),
        analysisFrame(4, [], { t: 31, highlight: 0.1, topic: 'second topic' }),
      ],
      weights: SCORING_PRESETS.viral,
      options,
    };
    const first = buildCandidates(input);
    const second = buildCandidates(input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    for (const candidate of first) {
      expect(() => ClipRangeSchema.parse(candidate)).not.toThrow();
    }
  });

  test('honors socialDrafts by window id and by clip id', () => {
    const draft: ClipSocial = {
      title: 'Custom draft',
      description: 'Custom description',
      hashtags: ['custom'],
    };
    const base = {
      words: TWO_TURN_WORDS,
      analyses: [
        analysisFrame(0, [], { t: 1, highlight: 1, topic: 'first topic' }),
        analysisFrame(4, [], { t: 31, highlight: 0.1, topic: 'second topic' }),
      ],
      weights: SCORING_PRESETS.viral,
      options,
    };
    const byWindow = buildCandidates({ ...base, socialDrafts: { 'win-01': draft } });
    expect(byWindow[0].social).toEqual(draft);
    const byClip = buildCandidates({ ...base, socialDrafts: { 'clip-02': draft } });
    expect(byClip[1].social).toEqual(draft);
  });

  test('filters by minScore keeping contiguous ids, and validates options', () => {
    const base = {
      words: TWO_TURN_WORDS,
      analyses: [
        analysisFrame(0, [], { t: 1, highlight: 1, topic: 'first topic' }),
        analysisFrame(4, [], { t: 31, highlight: 0.1, topic: 'second topic' }),
      ],
      weights: SCORING_PRESETS.viral,
    };
    const filtered = buildCandidates({
      ...base,
      options: { ...options, minScore: 0.5 },
    });
    expect(filtered.map((candidate) => candidate.id)).toEqual(['clip-01']);
    expect(filtered[0].start).toBe(0);
    expect(() =>
      buildCandidates({ ...base, options: { ...options, minScore: -1 } }),
    ).toThrow(/minScore/);
  });
});

describe('explainCandidate', () => {
  const candidate: ClipRange = {
    schemaVersion: 1,
    id: 'clip-01',
    start: 0,
    end: 30,
    score: 0.6571,
    breakdown: {
      highlight: 0.8,
      hook: 1,
      density: 0.5,
      emotion: 0,
      novelty: 0.25,
      closure: 1,
    },
    layout: 'single',
    faces: [],
    social: { title: 'Topic', description: 'Clip from 0s to 30s.', hashtags: ['topic'] },
  };

  test('renders the golden signal-by-signal breakdown', () => {
    expect(explainCandidate([candidate], 'clip-01', SCORING_PRESETS.viral)).toBe(
      [
        'Candidate "clip-01"',
        '  highlight: 0.8000 × 1.0000 → 0.2286',
        '  hook: 1.0000 × 0.9000 → 0.2571',
        '  density: 0.5000 × 0.4000 → 0.0571',
        '  emotion: 0.0000 × 0.5000 → 0.0000',
        '  novelty: 0.2500 × 0.4000 → 0.0286',
        '  closure: 1.0000 × 0.3000 → 0.0857',
        '  total: 0.6571',
      ].join('\n'),
    );
  });

  test('falls back to unit weights when none are provided', () => {
    expect(explainCandidate([candidate], 'clip-01')).toContain('  total: 0.6571');
    expect(explainCandidate([candidate], 'clip-01')).toContain(
      '  highlight: 0.8000 × 1.0000 → 0.1333',
    );
  });

  test('throws an error naming the id when the candidate is unknown', () => {
    expect(() => explainCandidate([candidate], 'clip-99')).toThrow(/clip-99/);
    expect(() => explainCandidate([], 'clip-99')).toThrow(/clip-99/);
  });
});

// ---------------------------------------------------------------------------
// Part 3/4 — transcription (local whisper) and silence polish: whisper
// `segments[].words` parsing on the source clock, phoneme-exact trimming,
// gap splitting and the `runClipPolish` file layer. Fake `ProcessRunner` +
// temp dirs only: no real whisper, no ffmpeg, no network.
// ---------------------------------------------------------------------------

/** whisper JSON fixture: word timestamps on the source clock with silences. */
const WHISPER_OUTPUT = {
  language: 'spanish',
  segments: [
    {
      start: 12.1,
      end: 13.2,
      text: ' hola mundo',
      words: [
        { word: ' hola', start: 12.34, end: 12.74 },
        { word: ' mundo', start: 12.8, end: 13.15 },
      ],
    },
    {
      start: 40,
      end: 41,
      text: ' adiós',
      words: [{ word: ' adiós', start: 40.05, end: 40.5 }],
    },
    { start: 50, end: 50.5, text: '' },
  ],
};

/** The same words normalized: the `t` clock is copied unchanged. */
const WHISPER_WORDS: ClipWord[] = [
  { word: ' hola', start: 12.34, end: 12.74 },
  { word: ' mundo', start: 12.8, end: 13.15 },
  { word: ' adiós', start: 40.05, end: 40.5 },
];

/** Silence fixture: a 5 s and an 11 s pause inside one candidate range. */
const SILENCE_WORDS: ClipWord[] = [
  { word: 'hello', start: 2.0, end: 2.4 },
  { word: 'world', start: 2.6, end: 3.0 },
  { word: 'again', start: 8.0, end: 8.4 },
  { word: 'yes', start: 8.6, end: 9.0 },
  { word: 'end', start: 20.0, end: 20.4 },
];

interface WhisperCall {
  command: string;
  args: string[];
  outputPath: string;
}

/**
 * Fake whisper CLI: records the call and mimics the real binary by writing
 * `--output_dir/<input basename>.json` (or garbage / nothing when asked).
 */
function whisperRunner(options: {
  code?: number;
  stderr?: string;
  stdout?: string;
  document?: unknown;
  garbage?: string;
}): { runner: ProcessRunner; calls: WhisperCall[] } {
  const calls: WhisperCall[] = [];
  return {
    calls,
    runner: {
      async run(command, args) {
        const dirIndex = args.indexOf('--output_dir');
        const input = args[0] ?? '';
        const outputPath = join(
          dirIndex === -1 ? '' : args[dirIndex + 1] ?? '',
          `${basename(input, extname(input))}.json`,
        );
        calls.push({ command, args: [...args], outputPath });
        if (options.document !== undefined) {
          await writeFile(outputPath, JSON.stringify(options.document));
        } else if (options.garbage !== undefined) {
          await writeFile(outputPath, options.garbage);
        }
        return {
          code: options.code ?? 0,
          stdout: options.stdout ?? '',
          stderr: options.stderr ?? '',
        };
      },
    },
  };
}

/** Full `ClipRange` fixture; only id/start/end vary between polish cases. */
function clipRangeFixture(id: string, start: number, end: number): ClipRange {
  const social: ClipSocial = {
    title: 'Fixture title',
    description: 'Fixture description.',
    hashtags: ['fixture'],
  };
  return {
    schemaVersion: 1,
    id,
    start,
    end,
    score: 0.9,
    breakdown: {
      highlight: 1,
      hook: 1,
      density: 1,
      emotion: 1,
      novelty: 1,
      closure: 1,
    },
    layout: 'single',
    faces: [],
    social,
  };
}

describe('transcribeToTranscript', () => {
  test('runs local whisper with word timestamps and maps segments[].words unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-transcribe-'));
    const { runner, calls } = whisperRunner({ document: WHISPER_OUTPUT });

    const document = await transcribeToTranscript(runner, dir, { language: 'spanish' });

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('whisper');
    expect(calls[0].args[0]).toBe(join(dir, 'clips', 'source.mp4'));
    expect(calls[0].args).toContain('--model');
    expect(calls[0].args).toContain('base');
    expect(calls[0].args).toContain('--output_format');
    expect(calls[0].args).toContain('json');
    expect(calls[0].args).toContain('--word_timestamps');
    expect(calls[0].args).toContain('True');
    expect(calls[0].args).toContain('--language');
    expect(calls[0].args).toContain('spanish');
    // whisper is pointed at a dedicated dir so it cannot clobber source.json.
    expect(calls[0].args).toContain(join(dir, 'clips', 'whisper'));
    expect(calls[0].outputPath).toBe(join(dir, 'clips', 'whisper', 'source.json'));

    // The `t` clock is whisper's own: no offset math anywhere.
    expect(document).toEqual({ schemaVersion: 1, language: 'spanish', words: WHISPER_WORDS });
    expect(JSON.parse(await readFile(join(dir, 'clips', 'transcript.json'), 'utf8'))).toEqual(
      document,
    );
  });

  test('honors whisperBin and sourcePath, and falls back to options.language', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-transcribe-lang-'));
    const srcPath = join(dir, 'audio.wav');
    await writeFile(srcPath, 'abc');
    const { runner, calls } = whisperRunner({ document: { segments: [] } });

    const document = await transcribeToTranscript(runner, dir, {
      sourcePath: srcPath,
      whisperBin: 'whisper-ctranslate2',
      language: 'french',
    });

    expect(calls[0].command).toBe('whisper-ctranslate2');
    expect(calls[0].args[0]).toBe(srcPath);
    expect(calls[0].outputPath).toBe(join(dir, 'clips', 'whisper', 'audio.json'));
    expect(document).toEqual({ schemaVersion: 1, language: 'french', words: [] });
  });

  test('writes an empty words document when whisper output carries no words', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-transcribe-empty-'));
    const { runner } = whisperRunner({
      document: { language: 'en', segments: [{ start: 0, end: 1, text: '' }] },
    });

    const document = await transcribeToTranscript(runner, dir);

    expect(document).toEqual({ schemaVersion: 1, language: 'en', words: [] });
    expect(JSON.parse(await readFile(join(dir, 'clips', 'transcript.json'), 'utf8'))).toEqual(
      document,
    );
  });

  test('falls back to the stdout document when whisper writes no output file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-transcribe-stdout-'));
    const { runner } = whisperRunner({ stdout: JSON.stringify(WHISPER_OUTPUT) });

    const document = await transcribeToTranscript(runner, dir);

    expect(document.words).toEqual(WHISPER_WORDS);
  });

  test('throws an actionable error on a nonzero whisper exit and writes nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-transcribe-fail-'));
    const { runner } = whisperRunner({ code: 1, stderr: 'CUDA out of memory' });

    await expect(transcribeToTranscript(runner, dir)).rejects.toThrow(/whisper failed/);
    await expect(readFile(join(dir, 'clips', 'transcript.json'), 'utf8')).rejects.toThrow();
  });

  test('throws on garbage whisper output and never invents words', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-transcribe-garbage-'));
    const garbage = whisperRunner({ garbage: 'this is not json at all' });
    await expect(transcribeToTranscript(garbage.runner, dir)).rejects.toThrow(
      /no parseable JSON/,
    );

    const noSegments = whisperRunner({ document: { text: 'hola' } });
    await expect(transcribeToTranscript(noSegments.runner, dir)).rejects.toThrow(/segments/);

    const badWord = whisperRunner({
      document: { segments: [{ words: [{ word: 'hola', start: 'x', end: 1 }] }] },
    });
    await expect(transcribeToTranscript(badWord.runner, dir)).rejects.toThrow(
      /malformed word entry/,
    );
    await expect(readFile(join(dir, 'clips', 'transcript.json'), 'utf8')).rejects.toThrow();
  });
});

describe('polishRanges', () => {
  test('trims to the phonemes ± 200 ms and splits gaps over 2 s (-b, -c)', () => {
    const base = clipRangeFixture('clip-01', 0, 30);

    const polished = polishRanges([base], SILENCE_WORDS);

    expect(polished.map((part) => part.id)).toEqual(['clip-01', 'clip-01-b', 'clip-01-c']);
    expect(polished).toHaveLength(3);
    expect(polished[0].start).toBeCloseTo(1.8, 10);
    expect(polished[0].end).toBeCloseTo(3.2, 10);
    expect(polished[1].start).toBeCloseTo(7.8, 10);
    expect(polished[1].end).toBeCloseTo(9.2, 10);
    expect(polished[2].start).toBeCloseTo(19.8, 10);
    expect(polished[2].end).toBeCloseTo(20.6, 10);
    for (const part of polished) {
      // Every parent field except id/start/end is copied verbatim.
      expect({ ...part, id: '', start: 0, end: 0 }).toEqual({ ...base, id: '', start: 0, end: 0 });
      expect(part.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  test('keeps one part when interior gaps stay at or below maxGapSeconds', () => {
    const base = clipRangeFixture('clip-02', 0, 20);
    const words: ClipWord[] = [
      { word: 'one', start: 1.0, end: 1.5 },
      { word: 'two', start: 3.5, end: 4.0 },
      { word: 'three', start: 5.5, end: 6.0 },
    ];

    const polished = polishRanges([base], words);

    expect(polished).toHaveLength(1);
    expect(polished[0].id).toBe('clip-02');
    expect(polished[0].start).toBeCloseTo(0.8, 10);
    expect(polished[0].end).toBeCloseTo(6.2, 10);
  });

  test('honors custom marginSeconds and maxGapSeconds', () => {
    const base = clipRangeFixture('clip-03', 0, 30);
    const words: ClipWord[] = [
      { word: 'one', start: 10.0, end: 10.5 },
      { word: 'two', start: 15.0, end: 15.5 },
    ];

    const trimmed = polishRanges([base], words, { marginSeconds: 0.5, maxGapSeconds: 6 });
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0].start).toBeCloseTo(9.5, 10);
    expect(trimmed[0].end).toBeCloseTo(16.0, 10);

    const split = polishRanges([base], words, { marginSeconds: 0.5, maxGapSeconds: 4 });
    expect(split.map((part) => part.id)).toEqual(['clip-03', 'clip-03-b']);
    expect(split[1].start).toBeCloseTo(14.5, 10);
    expect(split[1].end).toBeCloseTo(16.0, 10);
  });

  test('drops ranges without words inside and ignores words outside', () => {
    const silent = clipRangeFixture('clip-04', 40, 50);
    const near = clipRangeFixture('clip-05', 10, 20);
    const outside: ClipWord[] = [
      { word: 'outside-before', start: 8.0, end: 8.5 },
      { word: 'outside-after', start: 21.0, end: 21.5 },
    ];

    expect(polishRanges([silent, near], outside)).toEqual([]);
  });

  test('removes every range when the transcript carries no words', () => {
    expect(polishRanges([clipRangeFixture('clip-06', 0, 10)], [])).toEqual([]);
  });

  test('is deterministic and never mutates its inputs', () => {
    const ranges = [clipRangeFixture('clip-07', 0, 30), clipRangeFixture('clip-08', 30, 45)];
    const words: ClipWord[] = [...SILENCE_WORDS, { word: 'next', start: 31.0, end: 31.4 }];
    const rangesBefore = JSON.stringify(ranges);
    const wordsBefore = JSON.stringify(words);

    const first = polishRanges(ranges, words);
    const second = polishRanges(ranges, words);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(ranges)).toBe(rangesBefore);
    expect(JSON.stringify(words)).toBe(wordsBefore);
  });

  test('clamps trimming to the parent bounds', () => {
    const overlapStart = clipRangeFixture('clip-09', 10, 20);
    const overlapEnd = clipRangeFixture('clip-10', 30, 40);
    const words: ClipWord[] = [
      { word: 'straddle-in', start: 9.5, end: 10.5 },
      { word: 'next', start: 10.6, end: 11.4 },
      { word: 'late', start: 38.0, end: 38.5 },
      { word: 'straddle-out', start: 39.8, end: 40.5 },
    ];

    const polished = polishRanges([overlapStart, overlapEnd], words);

    expect(polished).toHaveLength(2);
    expect(polished[0].start).toBe(10);
    expect(polished[0].end).toBeCloseTo(11.6, 10);
    expect(polished[1].start).toBeCloseTo(37.8, 10);
    expect(polished[1].end).toBe(40);
  });

  test('rejects invalid options and malformed words', () => {
    const base = clipRangeFixture('clip-11', 0, 10);
    expect(() => polishRanges([base], SILENCE_WORDS, { marginSeconds: -0.1 })).toThrow(
      /marginSeconds/,
    );
    expect(() => polishRanges([base], SILENCE_WORDS, { maxGapSeconds: 0 })).toThrow(
      /maxGapSeconds/,
    );
    expect(() => polishRanges([base], [{ word: 'x', start: 1, end: 0.5 }])).toThrow(
      /malformed/,
    );
  });
});

describe('runClipPolish', () => {
  async function polishProject(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-polish-'));
    await mkdir(join(dir, 'clips'), { recursive: true });
    return dir;
  }

  async function writePolishInputs(dir: string): Promise<void> {
    await writeFile(
      join(dir, 'clips', 'source.json'),
      JSON.stringify({ schemaVersion: 1, path: 'clips/source.mp4', sha256: SHA256_ABC }),
    );
    await writeFile(
      join(dir, 'clips', 'candidates.json'),
      JSON.stringify([clipRangeFixture('clip-01', 0, 30)]),
    );
    await writeFile(
      join(dir, 'clips', 'transcript.json'),
      JSON.stringify({ schemaVersion: 1, language: 'es', words: SILENCE_WORDS }),
    );
  }

  test('polishes candidates.json into decisions-ready.json and returns the document', async () => {
    const dir = await polishProject();
    await writePolishInputs(dir);

    const document = await runClipPolish(dir);

    expect(document.schemaVersion).toBe(1);
    expect(document.sourceSha256).toBe(SHA256_ABC);
    expect(document.backend).toBe('omp');
    expect(document.ranges.map((range) => range.id)).toEqual([
      'clip-01',
      'clip-01-b',
      'clip-01-c',
    ]);
    expect(document.ranges[0].start).toBeCloseTo(1.8, 10);
    expect(document.ranges[2].end).toBeCloseTo(20.6, 10);
    expect(JSON.parse(await readFile(join(dir, 'clips', 'decisions-ready.json'), 'utf8'))).toEqual(
      document,
    );
    // Deterministic: polishing twice is byte-identical.
    expect(JSON.stringify(await runClipPolish(dir))).toBe(JSON.stringify(document));
  });

  test('honors marginSeconds, maxGapSeconds and backend options', async () => {
    const dir = await polishProject();
    await writePolishInputs(dir);

    const document = await runClipPolish(dir, {
      marginSeconds: 0.5,
      maxGapSeconds: 1,
      backend: 'jev',
    });

    expect(document.backend).toBe('jev');
    expect(document.ranges.map((range) => range.id)).toEqual([
      'clip-01',
      'clip-01-b',
      'clip-01-c',
    ]);
    expect(document.ranges[0].start).toBeCloseTo(1.5, 10);
    expect(document.ranges[0].end).toBeCloseTo(3.5, 10);
  });

  test('missing or garbage inputs throw errors naming the command that fixes them', async () => {
    const dir = await polishProject();
    await expect(runClipPolish(dir)).rejects.toThrow(/clip-ranges/);

    await writeFile(join(dir, 'clips', 'candidates.json'), '{"oops": true}');
    await expect(runClipPolish(dir)).rejects.toThrow(/clip-ranges/);

    await writeFile(join(dir, 'clips', 'candidates.json'), 'not json');
    await expect(runClipPolish(dir)).rejects.toThrow(/not valid JSON/);

    await writeFile(
      join(dir, 'clips', 'candidates.json'),
      JSON.stringify([clipRangeFixture('clip-01', 0, 30)]),
    );
    await expect(runClipPolish(dir)).rejects.toThrow(/clip-transcribe/);

    await writeFile(
      join(dir, 'clips', 'transcript.json'),
      JSON.stringify({ schemaVersion: 1, language: null, words: SILENCE_WORDS }),
    );
    await expect(runClipPolish(dir)).rejects.toThrow(/clip-frames/);

    await writeFile(join(dir, 'clips', 'source.json'), JSON.stringify({ schemaVersion: 1 }));
    await expect(runClipPolish(dir)).rejects.toThrow(/clip-frames/);
  });
});

// ---------------------------------------------------------------------------
// Part 4/4 — exact location tools and the read-only local dashboard: canonical
// `t`/`frame_id` addressing with the round-trip invariant, neighbor and
// transcript windows, strip-grid layout + the thin ffmpeg tile runner, and the
// HTML-escaped offline dashboard. Fake `ProcessRunner` + temp dirs only: no
// real ffmpeg, no network.
// ---------------------------------------------------------------------------

/** Locate fixture: a 1 s grid to t=4, then a jump to t=10. */
const LOCATE_FRAMES: FrameEntry[] = [
  { frame_id: 'f-000001', t: 0, path: 'clips/frames/f-000001.jpg', rol: 'key' },
  { frame_id: 'f-000002', t: 1, path: 'clips/frames/f-000002.jpg', rol: 'key' },
  { frame_id: 'f-000003', t: 2, path: 'clips/frames/f-000003.jpg', rol: 'key' },
  { frame_id: 'f-000004', t: 3, path: 'clips/frames/f-000004.jpg', rol: 'key' },
  { frame_id: 'f-000005', t: 4, path: 'clips/frames/f-000005.jpg', rol: 'key' },
  { frame_id: 'f-000006', t: 10, path: 'clips/frames/f-000006.jpg', rol: 'key' },
];

/** Transcript slice around t=2 (default window ±10 s ⇒ [-8, 12]). */
const LOCATE_WORDS: ClipWord[] = [
  { word: 'first', start: 0, end: 0.4 },
  { word: 'middle', start: 5, end: 5.4 },
  { word: 'edge', start: 11.6, end: 12.4 }, // overlaps the window ⇒ in
  { word: 'late', start: 12.1, end: 12.5 }, // starts past the window ⇒ out
  { word: 'far', start: 20, end: 20.4 },
];

/** Analyses inside (f-000001, f-000003) and outside (f-000006) ±2 s. */
const LOCATE_ANALYSES: FrameAnalysis[] = [
  analysisFrame(0, [], { t: 0 }),
  analysisFrame(2, [], { t: 2 }),
  analysisFrame(5, [], { t: 10 }),
];

describe('resolveFrameAt', () => {
  test('resolves t, numeric t strings and frame_id to the same frame (round-trip)', () => {
    for (const frame of LOCATE_FRAMES) {
      const byId = resolveFrameAt(LOCATE_FRAMES, frame.frame_id);
      expect(byId).toEqual(frame);
      expect(resolveFrameAt(LOCATE_FRAMES, frame.t)).toEqual(byId);
      expect(resolveFrameAt(LOCATE_FRAMES, String(frame.t))).toEqual(byId);
    }
  });

  test('picks the nearest t and breaks distance ties toward the lower t', () => {
    expect(resolveFrameAt(LOCATE_FRAMES, 2.4).frame_id).toBe('f-000003');
    expect(resolveFrameAt(LOCATE_FRAMES, 2.6).frame_id).toBe('f-000004');
    expect(resolveFrameAt(LOCATE_FRAMES, 9.1).frame_id).toBe('f-000006');
    const tied: FrameEntry[] = [
      { frame_id: 'f-000002', t: 3, path: 'b.jpg', rol: 'key' },
      { frame_id: 'f-000001', t: 1, path: 'a.jpg', rol: 'key' },
    ];
    expect(resolveFrameAt(tied, 2).frame_id).toBe('f-000001');
  });

  test('unknown frame_id throws an actionable error naming it', () => {
    expect(() => resolveFrameAt(LOCATE_FRAMES, 'f-999999')).toThrow(/unknown frame_id "f-999999"/);
  });

  test('empty frames and malformed at values throw actionable errors', () => {
    expect(() => resolveFrameAt([], 1)).toThrow(/clip-frames/);
    expect(() => resolveFrameAt(LOCATE_FRAMES, 'nope')).toThrow(/got "nope"/);
    expect(() => resolveFrameAt(LOCATE_FRAMES, '')).toThrow(/at must be/);
    expect(() => resolveFrameAt(LOCATE_FRAMES, Number.NaN)).toThrow(/at must be/);
    expect(() => resolveFrameAt(LOCATE_FRAMES, -1)).toThrow(/at must be/);
    expect(() => resolveFrameAt(LOCATE_FRAMES, 'f-42')).toThrow(/at must be/);
  });
});

describe('locateAt', () => {
  test('at = frame.t and at = frame.frame_id resolve to the same window (round-trip)', () => {
    for (const frame of LOCATE_FRAMES) {
      const byTime = locateAt({
        frames: LOCATE_FRAMES,
        words: LOCATE_WORDS,
        analyses: LOCATE_ANALYSES,
        at: frame.t,
      });
      const byId = locateAt({
        frames: LOCATE_FRAMES,
        words: LOCATE_WORDS,
        analyses: LOCATE_ANALYSES,
        at: frame.frame_id,
      });
      expect(byTime.frame).toEqual(frame);
      expect(byTime).toEqual(byId);
    }
  });

  test('neighbors span ±2s around the exact frame by default', () => {
    const result = locateAt({ frames: LOCATE_FRAMES, words: [], analyses: [], at: 2 });
    expect(result.frame.frame_id).toBe('f-000003');
    expect(result.neighbors.map((frame) => frame.frame_id)).toEqual([
      'f-000001',
      'f-000002',
      'f-000003',
      'f-000004',
      'f-000005',
    ]);
  });

  test('words span ±10s by default (boundary words overlapping the window stay)', () => {
    const result = locateAt({ frames: LOCATE_FRAMES, words: LOCATE_WORDS, analyses: [], at: 2 });
    expect(result.words.map((word) => word.word)).toEqual(['first', 'middle', 'edge']);
  });

  test('honors neighborSeconds and transcriptSeconds', () => {
    const result = locateAt({
      frames: LOCATE_FRAMES,
      words: LOCATE_WORDS,
      analyses: LOCATE_ANALYSES,
      at: 'f-000003',
      neighborSeconds: 1,
      transcriptSeconds: 3,
    });
    expect(result.neighbors.map((frame) => frame.frame_id)).toEqual([
      'f-000002',
      'f-000003',
      'f-000004',
    ]);
    expect(result.words.map((word) => word.word)).toEqual(['first', 'middle']);
    expect(result.analyses.map((analysis) => analysis.frame_id)).toEqual(['f-000003']);
  });

  test('keeps only the analyses of the neighbor frames and tolerates empty slices', () => {
    const result = locateAt({
      frames: LOCATE_FRAMES,
      words: [],
      analyses: LOCATE_ANALYSES,
      at: 2,
    });
    expect(result.analyses.map((analysis) => analysis.frame_id)).toEqual([
      'f-000001',
      'f-000003',
    ]);
    const empty = locateAt({ frames: LOCATE_FRAMES, words: [], analyses: [], at: 2 });
    expect(empty.words).toEqual([]);
    expect(empty.analyses).toEqual([]);
  });

  test('rejects empty frames and invalid window sizes', () => {
    expect(() => locateAt({ frames: [], words: [], analyses: [], at: 1 })).toThrow(/clip-frames/);
    expect(() =>
      locateAt({ frames: LOCATE_FRAMES, words: [], analyses: [], at: 1, neighborSeconds: -1 }),
    ).toThrow(/neighborSeconds/);
    expect(() =>
      locateAt({
        frames: LOCATE_FRAMES,
        words: [],
        analyses: [],
        at: 1,
        transcriptSeconds: Number.NaN,
      }),
    ).toThrow(/transcriptSeconds/);
  });
});

describe('planStripGrid', () => {
  test('lays the ids out row-major in order, labeled with frame_id', () => {
    const ids = idRange(1, 6);
    expect(planStripGrid(ids)).toEqual({ columns: 4, frameIds: ids, labelWith: 'frame_id' });
    expect(planStripGrid(ids, 2)).toEqual({ columns: 2, frameIds: ids, labelWith: 'frame_id' });
    expect(planStripGrid(ids, 2).frameIds).not.toBe(ids);
  });

  test('rejects empty ids, non-canonical ids and bad columns', () => {
    expect(() => planStripGrid([])).toThrow(/non-empty/);
    expect(() => planStripGrid(['f-42'])).toThrow(/canonical frame id/);
    expect(() => planStripGrid(idRange(1, 2), 0)).toThrow(/columns/);
    expect(() => planStripGrid(idRange(1, 2), 2.5)).toThrow(/columns/);
  });
});

describe('renderStripGrid', () => {
  test('composes the labeled tile grid into clips/strips/<from>-<to>.jpg', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-strip-'));
    const { runner, calls } = fakeProcess(() => ({ code: 0, stdout: '', stderr: '' }));

    const output = await renderStripGrid(runner, dir, {
      from: 80,
      to: 95,
      frameIds: idRange(1, 3),
      columns: 2,
    });

    expect(output).toBe(join(dir, 'clips', 'strips', '80-95.jpg'));
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('ffmpeg');
    expect(calls[0].args).toContain(join(dir, 'clips', 'frames', 'f-000001.jpg'));
    expect(calls[0].args).toContain(output);
    const filter = calls[0].args.join(' ');
    expect(filter).toContain("drawtext=text='f-000003'");
    expect(filter).toContain('tile=2x2');
    expect(filter).toContain('concat=n=3');
  });

  test('a nonzero ffmpeg exit throws an actionable error naming the window and frames', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-strip-'));
    const { runner } = fakeProcess(() => ({
      code: 1,
      stdout: '',
      stderr: 'ffmpeg: no such file clips/frames/f-000001.jpg',
    }));

    await expect(
      renderStripGrid(runner, dir, { from: 0, to: 5, frameIds: idRange(1, 2) }),
    ).rejects.toThrow(/ffmpeg failed building .*0-5\.jpg.*f-000001.*no such file/);
  });

  test('validates the window and the frame ids before any process run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-strip-'));
    const { runner, calls } = fakeProcess(() => ({ code: 0, stdout: '', stderr: '' }));

    await expect(
      renderStripGrid(runner, dir, { from: 5, to: 1, frameIds: idRange(1, 2) }),
    ).rejects.toThrow(/from <= to/);
    await expect(renderStripGrid(runner, dir, { from: 0, to: 5, frameIds: [] })).rejects.toThrow(
      /non-empty/,
    );
    expect(calls).toHaveLength(0);
  });
});

/** Dashboard card fixture; only the named fields vary between cases. */
function dashboardCard(overrides: Partial<ClipDashboardCard> = {}): ClipDashboardCard {
  return {
    id: 'clip-01',
    title: 'Fixture title',
    description: 'Fixture description.',
    hashtags: ['fixture'],
    score: 0.9,
    layout: 'single',
    status: 'candidate',
    start: 1,
    end: 5,
    frameIds: ['f-000001', 'f-000002'],
    ...overrides,
  };
}

describe('renderClipsDashboard', () => {
  test('escapes script-style payloads in title, description, hashtags, ids and paths', () => {
    const html = renderClipsDashboard({
      header: '<b>clips</b>',
      cards: [
        dashboardCard({
          id: '"><script>alert(1)</script>',
          title: '<script>alert(1)</script>',
          description: '<b>bold</b>',
          hashtags: ['<script>tag</script>'],
          stillPath: 'stills/a" onerror="alert(1)',
        }),
      ],
    });

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;tag&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;clips&lt;/b&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<script>tag</script>');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).not.toContain('<b>clips</b>');
    expect(html).not.toContain('onerror="alert(1)"');
  });

  test('renders one compact card per clip with score, layout and status (no frame_ids)', () => {
    const html = renderClipsDashboard({
      header: 'My clips',
      cards: [
        dashboardCard({ videoPath: '../../renders/clips/clip-01.mp4' }),
        dashboardCard({
          id: 'clip-02',
          title: 'Second title',
          description: 'Second description.',
          hashtags: ['two', '#three'],
          score: 0.5,
          layout: 'duo',
          status: 'approved',
          start: 6,
          end: 12,
          frameIds: ['f-000003'],
          stillPath: '../frames/f-000003.jpg',
          videoPath: '../../renders/clips/clip-02.mp4',
        }),
        dashboardCard({
          id: 'clip-03',
          title: 'No render yet',
          description: 'Candidate without a player.',
          hashtags: ['draft'],
          status: 'candidate',
          start: 12,
          end: 18,
          frameIds: [],
          stillPath: '../frames/f-000009.jpg',
        }),
      ],
    });

    expect(html.match(/class="card"/g)).toHaveLength(3);
    expect(html).toContain('<title>My clips</title>');
    expect(html).toContain('<h1>My clips</h1>');
    expect(html).toContain('id clip-01');
    expect(html).toContain('score 0.9');
    expect(html).toContain('score 0.5');
    expect(html).toContain('layout duo');
    expect(html).toContain('>candidate<');
    expect(html).toContain('>approved<');
    // frame_ids are pipeline data, not human-facing: never rendered.
    expect(html).not.toContain('frame_ids');
    expect(html).not.toContain('<code>f-000002</code>');
    // One player per card WITH a videoPath (rendered clips): relative src,
    // still as poster, preload=none, VERTICAL box centered. Cards without a
    // render show the still — never a player that 404s.
    expect(html.match(/<video controls/g)).toHaveLength(2);
    expect(html).toContain(
      '<video controls preload="none" src="../../renders/clips/clip-01.mp4"',
    );
    expect(html).toContain(
      '<video controls preload="none" src="../../renders/clips/clip-02.mp4"',
    );
    expect(html).toContain('poster="../frames/f-000003.jpg"');
    expect(html).toContain('aspect-ratio:9/16');
    expect(html).toContain('margin:8px auto');
    expect(html).toContain('alt="still clip-03"');
    // Hashtags render as a single-hash list even when data carries '#'.
    expect(html).toContain('<li>#three</li>');
    expect(html).not.toContain('##three');
    expect(html).not.toContain('<code>f-000003</code>');
  });

  test('lays clips out as a grid with CSS-only filters (no scripts)', () => {
    const html = renderClipsDashboard({
      header: 'My clips',
      cards: [
        dashboardCard({ videoPath: '../../renders/clips/clip-01.mp4', status: 'approved' }),
        dashboardCard({ id: 'clip-03', status: 'candidate', stillPath: '../frames/f-000009.jpg' }),
      ],
    });
    expect(html).toContain('<div class="grid">');
    expect(html).toContain('grid-template-columns:repeat(auto-fill,minmax(230px,1fr))');
    expect(html).toContain('data-status="approved"');
    expect(html).toContain('data-video="1"');
    expect(html).toContain('id="st-approved" checked');
    expect(html).toContain(
      'body:has(#st-approved:checked) .card:not([data-status=approved]){display:none}',
    );
    expect(html).toContain('body:has(#only-render:checked) .card:not([data-video="1"]){display:none}');
    expect(html).not.toContain('<script');
  });

  test('is a self-contained offline page: no scripts, no http(s) resource references', () => {
    const html = renderClipsDashboard({
      cards: [dashboardCard(), dashboardCard({ id: 'clip-02', stillPath: 'clips/stills/c2.png' })],
    });

    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).not.toContain('<script');
    expect(html).toContain('<title>Clip dashboard</title>');
  });
});

describe('buildClipCards', () => {
  test('maps ranges to cards, applying decisions and defaulting to candidate', () => {
    const approved = clipRangeFixture('clip-01', 1, 5);
    const rejected: ClipRange = {
      ...clipRangeFixture('clip-02', 6, 12),
      layout: 'duo',
      social: {
        title: 'Second title',
        description: 'Second description.',
        hashtags: ['#two'],
      },
    };
    const undecided = clipRangeFixture('clip-03', 13, 20);

    const cards = buildClipCards(
      [approved, rejected, undecided],
      [
        { range: approved, status: 'approved' },
        { range: rejected, status: 'rejected' },
      ],
      { 'clip-01': ['f-000001', 'f-000002'], 'clip-99': ['f-000009'] },
    );

    expect(cards.map((card) => card.status)).toEqual(['approved', 'rejected', 'candidate']);
    expect(cards[0]).toEqual({
      id: 'clip-01',
      title: 'Fixture title',
      description: 'Fixture description.',
      hashtags: ['fixture'],
      score: 0.9,
      layout: 'single',
      status: 'approved',
      start: 1,
      end: 5,
      frameIds: ['f-000001', 'f-000002'],
    });
    expect(cards[1].title).toBe('Second title');
    expect(cards[1].layout).toBe('duo');
    expect(cards[1].frameIds).toEqual([]);
    expect(cards[2].frameIds).toEqual([]);
  });

  test('is pure: copies arrays and never mutates its inputs', () => {
    const range = clipRangeFixture('clip-01', 1, 5);
    const frameIds = ['f-000001'];
    const before = JSON.stringify({ range, frameIds });

    const cards = buildClipCards([range], [{ range, status: 'approved' }], {
      'clip-01': frameIds,
    });
    cards[0].hashtags.push('mutated');
    cards[0].frameIds.push('f-999999');

    expect(JSON.stringify({ range, frameIds })).toBe(before);
  });
});

// Part 5/5 — render support (trim + FilmProps): the exact ffmpeg trim of one
// sealed range and its one-scene 1080×1920 @ 30 fps `FilmProps`, tested at
// the seam level (fake ffmpeg, no render, no network) with the same pins the
// specs/clip.test.ts render tests enforce end to end.

/** Recording fake for the `FfmpegRunner` seam (exit 0 unless `handle` says no). */
function recordingFfmpeg(
  handle?: (args: string[], callIndex: number) => FfmpegResult,
): { runner: FfmpegRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      async run(args) {
        const call = [...args];
        calls.push(call);
        return handle
          ? handle(call, calls.length - 1)
          : { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  };
}

/** A schema-valid sealed-range fixture (one bbox per face, presence 0.9). */
function renderRange(
  id: string,
  start: number,
  end: number,
  options: { layout?: 'single' | 'duo'; faceCount?: number } = {},
): ClipRange {
  const faceCount = options.faceCount ?? (options.layout === 'duo' ? 2 : 1);
  return {
    schemaVersion: 1,
    id,
    start,
    end,
    score: 0.5,
    breakdown: {
      highlight: 0.5,
      hook: 0.5,
      density: 0.5,
      emotion: 0.5,
      novelty: 0.5,
      closure: 0.5,
    },
    layout: options.layout ?? 'single',
    faces: Array.from({ length: faceCount }, (_, index) => ({
      id: `speaker-${String.fromCharCode(97 + index)}`,
      bbox: [100, 100, 250, 250],
      presence: 0.9,
    })),
    social: {
      title: `Highlight ${id}`,
      description: `Clip ${id} description.`,
      hashtags: ['clip', 'demo'],
    },
  };
}

/**
 * Analysis frames around the render ranges (t = 8, 10, 11, 20, 21 + one duo
 * frame at 33): only t = 10, 11, 20 fall inside `[10, 20]`.
 */
function renderAnalyses(): FrameAnalysis[] {
  const bbox: [number, number, number, number] = [100, 100, 250, 250];
  const facts = { energy: 0.8, topic: 'funny cats', highlight: 0.9 };
  return [
    analysisFrame(0, [speaker('speaker-a', true, bbox)], { t: 8, ...facts }),
    analysisFrame(1, [speaker('speaker-a', true, bbox)], { t: 10, ...facts }),
    analysisFrame(2, [speaker('speaker-a', true, bbox)], { t: 11, ...facts }),
    analysisFrame(3, [speaker('speaker-a', true, bbox)], { t: 20, ...facts }),
    analysisFrame(4, [speaker('speaker-a', true, bbox)], { t: 21, ...facts }),
    analysisFrame(5, [speaker('speaker-a', true, bbox), speaker('speaker-b', false, bbox)], {
      t: 33,
      ...facts,
    }),
  ];
}

/** A registry project (video.json) for the one-scene clip composition. */
async function clipProjectFixture(): Promise<Project> {
  const dir = await mkdtemp(join(tmpdir(), 'vm-clip-film-'));
  await makeTestProject(dir);
  return loadProject(dir);
}

describe('trimClipMedia', () => {
  test('runs the exact -ss/-t trim and the WAV extraction into clips/trimmed/', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-trim-'));
    const { runner, calls } = recordingFfmpeg();

    const first = await trimClipMedia({
      ffmpeg: runner,
      projectDir: dir,
      range: renderRange('clip-01', 10, 20),
      sourceRelative: 'clips/source.mp4',
    });
    const second = await trimClipMedia({
      ffmpeg: runner,
      projectDir: dir,
      range: renderRange('clip-02', 30, 45, { layout: 'duo', faceCount: 2 }),
      sourceRelative: 'clips/source.mp4',
    });

    // Exact trim args: -ss <start> -t <end - start> over clips/source.mp4.
    const trims = calls.filter((args) => args.includes('-an'));
    expect(trims.map((args) => args.slice(0, 7))).toEqual([
      ['-y', '-ss', '10', '-i', join(dir, 'clips', 'source.mp4'), '-t', '10'],
      ['-y', '-ss', '30', '-i', join(dir, 'clips', 'source.mp4'), '-t', '15'],
    ]);
    for (const args of trims) {
      expect(args).toContain('libx264');
      expect(args).toContain('yuv420p');
      expect(args).toContain('30');
    }
    expect(trims[0]![trims[0]!.length - 1]).toBe(join(dir, 'clips', 'trimmed', 'clip-01.mp4'));

    // The trim's audio is extracted ONCE to a WAV; the trimmed video is
    // video-only (-an), so the render can never double it.
    const audioCuts = calls.filter((args) => args.includes('pcm_s16le'));
    expect(audioCuts.map((args) => args.slice(0, 7))).toEqual([
      ['-y', '-ss', '10', '-i', join(dir, 'clips', 'source.mp4'), '-t', '10'],
      ['-y', '-ss', '30', '-i', join(dir, 'clips', 'source.mp4'), '-t', '15'],
    ]);
    expect(audioCuts[0]![audioCuts[0]!.length - 1]).toBe(join(dir, 'clips', 'trimmed', 'clip-01.wav'));

    // The staging sources plus the exact window length (`end - start`).
    expect(first).toEqual({
      videoRelative: 'clips/trimmed/clip-01.mp4',
      audioRelative: 'clips/trimmed/clip-01.wav',
      durationSeconds: 10,
    });
    expect(second.durationSeconds).toBe(15);
    expect((await stat(join(dir, 'clips', 'trimmed'))).isDirectory()).toBe(true);
  });

  test('surfaces a failed video trim naming the range and the exit code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-trim-'));
    const { runner, calls } = recordingFfmpeg((_args, index) =>
      index === 0 ? { exitCode: 1, stdout: '', stderr: 'no such file' } : { exitCode: 0, stdout: '', stderr: '' },
    );

    await expect(
      trimClipMedia({
        ffmpeg: runner,
        projectDir: dir,
        range: renderRange('clip-01', 10, 20),
        sourceRelative: 'clips/source.mp4',
      }),
    ).rejects.toThrow(
      'clip-render: ffmpeg trim of clip-01 failed (exit 1): no such file',
    );
    expect(calls).toHaveLength(1);
  });

  test('surfaces a failed audio extraction naming the range and the exit code', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-trim-'));
    const { runner } = recordingFfmpeg((_args, index) =>
      index === 1 ? { exitCode: 2, stdout: '', stderr: 'bad wav' } : { exitCode: 0, stdout: '', stderr: '' },
    );

    await expect(
      trimClipMedia({
        ffmpeg: runner,
        projectDir: dir,
        range: renderRange('clip-01', 10, 20),
        sourceRelative: 'clips/source.mp4',
      }),
    ).rejects.toThrow(
      'clip-render: ffmpeg audio extraction of clip-01 failed (exit 2): bad wav',
    );
  });
});

describe('buildClipFilmProps', () => {
  test('pins the one-scene FilmProps: canvas, clip intent, faces and the rebased track', async () => {
    const project = await clipProjectFixture();

    const props = buildClipFilmProps(project, {
      range: renderRange('clip-01', 10, 20),
      analyses: renderAnalyses(),
      words: [
        { word: 'hola', start: 9.5, end: 10.2 },
        { word: 'mundo', start: 10.5, end: 11.0 },
        { word: 'fuera', start: 25, end: 26 },
      ],
      sourceSize: { width: 1280, height: 720 },
      stagedVideoSrc: 'media/clips/clip-01.mp4',
      stagedAudioSrc: 'media/clips/clip-01.wav',
    });

    expect(props.width).toBe(1080);
    expect(props.height).toBe(1920);
    expect(props.fps).toBe(30);
    expect(props.scenes).toHaveLength(1);
    const scene = props.scenes[0]!;
    expect(scene.id).toBe('clip-01');
    expect(scene.intent).toBe('clip-vertical');
    expect(scene.source).toBe('clip');
    expect(scene.layout).toBe('single');
    expect(scene.durationInSeconds).toBe(10);
    expect(scene.faces).toEqual([{ id: 'speaker-a', bbox: [100, 100, 250, 250], presence: 0.9 }]);
    expect(scene.mediaSrc).toBe('/public/media/clips/clip-01.mp4');
    expect(scene.mediaDurationSeconds).toBe(10);
    expect(scene.mediaWidth).toBe(1280);
    expect(scene.mediaHeight).toBe(720);
    // The trim's audio plays exactly once: scene audio, never a film master.
    expect(scene.audioSrc).toBe('media/clips/clip-01.wav');
    expect(scene.audioDurationSeconds).toBe(10);
    expect(props.narration).toBeUndefined();
    // The track viewport is the SOURCE frame, not the vertical canvas.
    expect(scene.track?.viewport).toEqual({ width: 1280, height: 720 });
    // Burned-in subs come from the whisper word timestamps clipped to the
    // window and REBASED to the clip clock (9.5s clamped to the 10s start).
    expect(scene.subtitleSegments).toEqual([{ text: 'hola mundo', start: 0, end: 1 }]);
    // Frames at source t = 10, 11, 20 REBASED to the clip clock (0, 1, 10 s)
    // before quantization — outside frames (t = 8, 21) never leak in.
    expect(scene.track?.interactions.map((event) => event.t)).toEqual([0, 1, 10]);
    expect(scene.track?.interactions.map((event) => event.segmentId)).toEqual([
      'f-000002',
      'f-000003',
      'f-000004',
    ]);
    expect(scene.track?.interactions[0]?.action).toBe('select');
  });

  test('duo ranges compose clip-podcast with both faces and the exact window', async () => {
    const project = await clipProjectFixture();

    const props = buildClipFilmProps(project, {
      range: renderRange('clip-02', 30, 45, { layout: 'duo', faceCount: 2 }),
      analyses: renderAnalyses(),
      words: [{ word: 'duo', start: 31, end: 31.5 }],
      sourceSize: { width: 1280, height: 720 },
      stagedVideoSrc: 'media/clips/clip-02.mp4',
      stagedAudioSrc: 'media/clips/clip-02.wav',
    });

    const scene = props.scenes[0]!;
    expect(scene.id).toBe('clip-02');
    expect(scene.intent).toBe('clip-podcast');
    expect(scene.layout).toBe('duo');
    expect(scene.faces).toHaveLength(2);
    expect(scene.durationInSeconds).toBe(15);
    expect(scene.subtitleSegments).toEqual([{ text: 'duo', start: 1, end: 1.5 }]);
  });
});

// ---------------------------------------------------------------------------
// Part 6/6 — dense keyframes + window shards (`--keys`)
// ---------------------------------------------------------------------------

const KEY_WINDOWS: ProposedWindow[] = [
  { id: 'win-01', start: 4, end: 8, preScore: 0.5, reason: 'fixture' },
  { id: 'win-02', start: 20, end: 24, preScore: 0.9, reason: 'fixture' },
];

const KEY_BASE_FRAMES: FrameEntry[] = [
  { frame_id: 'f-000001', t: 0, path: 'clips/frames/f-000001.jpg', rol: 'key' },
  { frame_id: 'f-000002', t: 2, path: 'clips/frames/f-000002.jpg', rol: 'key' },
  { frame_id: 'f-000003', t: 30, path: 'clips/frames/f-000003.jpg', rol: 'key' },
];

function keyFramesFixture(): FrameEntry[] {
  return sampleKeyFrames({
    durationSeconds: 32,
    fps: 30,
    frames: KEY_BASE_FRAMES,
    windows: KEY_WINDOWS,
    keyFps: 1,
    keyMargin: 2,
  });
}

describe('sampleKeyFrames', () => {
  test('densifies window bodies as key and margins/regions as base', () => {
    const frames = keyFramesFixture();
    const rolAt = (t: number) => frames.find((frame) => frame.t === t)?.rol;
    expect(rolAt(0)).toBe('base');
    expect(rolAt(2)).toBe('base');
    expect(rolAt(3)).toBe('base');
    for (const t of [4, 5, 6, 7, 8, 20, 21, 22, 23, 24]) {
      expect(rolAt(t)).toBe('key');
    }
    for (const t of [9, 10, 18, 19, 25, 26, 30]) {
      expect(rolAt(t)).toBe('base');
    }
  });

  test('merges, dedupes by t and renumbers f-<6 digits> in t order', () => {
    const frames = keyFramesFixture();
    expect(frames.map((frame) => frame.frame_id)).toEqual(
      frames.map((_, index) => `f-${String(index + 1).padStart(6, '0')}`),
    );
    const times = frames.map((frame) => frame.t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(frames.map((frame) => frame.t)).size).toBe(frames.length);
    expect(frames.every((frame) => frame.t < 32)).toBe(true);
  });

  test('is deterministic and validates its options', () => {
    expect(keyFramesFixture()).toEqual(keyFramesFixture());
    const base = {
      durationSeconds: 32,
      fps: 30,
      frames: KEY_BASE_FRAMES,
      windows: KEY_WINDOWS,
    };
    expect(() => sampleKeyFrames({ ...base, keyFps: 0 })).toThrow(/keyFps/);
    expect(() => sampleKeyFrames({ ...base, keyMargin: -1 })).toThrow(/keyMargin/);
    expect(() =>
      sampleKeyFrames({
        ...base,
        windows: [{ id: 'win-09', start: 5, end: 5, preScore: 0.1, reason: 'x' }],
      }),
    ).toThrow(/start < end/);
  });
});

describe('buildWindowShards', () => {
  test('one shard per window, best preScore first, margins as context', () => {
    const shards = buildWindowShards(keyFramesFixture(), KEY_WINDOWS, { keyMargin: 2 });
    expect(shards.shardSize).toBe(0);
    expect(shards.shards.map((shard) => shard.id)).toEqual(['shard-001', 'shard-002']);
    const [best, second] = shards.shards;
    // win-02 (preScore 0.9) is analyzed first.
    expect(best?.frameIds.filter((id) => !best.contextOnlyFrameIds.includes(id))).toEqual(
      keyFramesFixture()
        .filter((frame) => frame.rol === 'key' && frame.t >= 20 && frame.t <= 24)
        .map((frame) => frame.frame_id),
    );
    expect(best?.contextOnlyFrameIds).toEqual(
      keyFramesFixture()
        .filter((frame) => frame.t >= 18 && frame.t <= 26 && frame.rol === 'base')
        .map((frame) => frame.frame_id),
    );
    expect(second?.frameIds.length).toBeGreaterThan(0);
  });

  test('skips windows without key frames and keeps determinism', () => {
    const windows: ProposedWindow[] = [
      ...KEY_WINDOWS,
      { id: 'win-03', start: 31.9, end: 31.95, preScore: 1, reason: 'no frames' },
    ];
    const shards = buildWindowShards(keyFramesFixture(), windows, { keyMargin: 2 });
    expect(shards.shards).toHaveLength(2);
    expect(shards).toEqual(buildWindowShards(keyFramesFixture(), windows, { keyMargin: 2 }));
  });
});

describe('runClipFramesKeys', () => {
  async function keysProject(): Promise<{ dir: string; srcPath: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-keys-'));
    const srcPath = join(dir, 'source.mp4');
    await writeFile(srcPath, 'abc');
    await mkdir(join(dir, 'clips'), { recursive: true });
    await writeFile(
      join(dir, 'clips', 'source.json'),
      JSON.stringify({ schemaVersion: 1, path: srcPath, durationSeconds: 32, fps: 30, sha256: SHA256_ABC }),
    );
    await writeFile(
      join(dir, 'clips', 'frames.json'),
      JSON.stringify({ schemaVersion: 1, frames: KEY_BASE_FRAMES }),
    );
    return { dir, srcPath };
  }

  test('extracts only the missing jpgs and rewrites frames/shards manifests', async () => {
    const { dir } = await keysProject();
    await mkdir(join(dir, 'clips', 'frames'), { recursive: true });
    await writeFile(join(dir, 'clips', 'frames', 'f-000001.jpg'), 'x');
    await writeFile(join(dir, 'clips', 'frames', 'f-000002.jpg'), 'x');
    const { runner, calls } = mediaRunner();

    const result = await runClipFramesKeys(runner, dir, {
      windows: KEY_WINDOWS,
      keyFps: 1,
      keyMargin: 2,
    });

    expect(result.frames.frames).toEqual(keyFramesFixture());
    expect(result.shards.shards.map((shard) => shard.id)).toEqual(['shard-001', 'shard-002']);
    const ffmpegCalls = calls.filter((call) => call.command === 'ffmpeg');
    // 21 candidate times, t=2 shared by the base pass and the dense grid ⇒ 20
    // frames; 2 jpgs already on disk are skipped.
    expect(result.frames.frames).toHaveLength(20);
    expect(ffmpegCalls).toHaveLength(18);
    const writtenFrames = JSON.parse(
      await readFile(join(dir, 'clips', 'frames.json'), 'utf8'),
    ) as { frames: FrameEntry[] };
    expect(writtenFrames.frames).toEqual(keyFramesFixture());
  });

  test('fails actionably without the first-pass manifests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-keys-empty-'));
    const { runner } = mediaRunner();
    await expect(
      runClipFramesKeys(runner, dir, { windows: KEY_WINDOWS }),
    ).rejects.toThrow(/run clip-frames first/);
  });
});

// ---------------------------------------------------------------------------
// Part 7/7 — agent self-review (critic rounds)
// ---------------------------------------------------------------------------

describe('parseCriticResponse', () => {
  const verdicts = [
    { id: 'clip-01', verdict: 'revise' as const, issues: ['weak hook'], patch: { start: 1.5 } },
  ];

  test('parses plain JSON and a single markdown code fence', () => {
    expect(parseCriticResponse(JSON.stringify({ verdicts }))).toEqual({ verdicts });
    expect(parseCriticResponse('```json\n' + JSON.stringify({ verdicts }) + '\n```')).toEqual({
      verdicts,
    });
    expect(parseCriticResponse('```\n' + JSON.stringify({ verdicts }) + '\n```')).toEqual({
      verdicts,
    });
  });

  test('rejects garbage without coercing (actionable contract message)', () => {
    expect(() => parseCriticResponse('not json')).toThrow(/Respond ONLY with JSON/);
    expect(() => parseCriticResponse('{"verdicts": 3}')).toThrow(/"verdicts" array/);
    expect(() => parseCriticResponse('{"verdicts":[{"id":""}]}')).toThrow(/non-empty string "id"/);
    expect(() =>
      parseCriticResponse('{"verdicts":[{"id":"clip-01","verdict":"maybe"}]}'),
    ).toThrow(/"pass" or "revise"/);
    expect(() =>
      parseCriticResponse('{"verdicts":[{"id":"clip-01","verdict":"pass","patch":{"start":"x"}}]}'),
    ).toThrow(/patch\.start .* must be a number/);
    expect(() =>
      parseCriticResponse(
        '{"verdicts":[{"id":"clip-01","verdict":"pass","patch":{"social":{"title":"t"}}}]}',
      ),
    ).toThrow(/not a valid ClipSocial/);
  });
});

describe('applyCriticVerdicts', () => {
  const candidates = [
    {
      schemaVersion: 1 as const,
      id: 'clip-01',
      start: 10,
      end: 40,
      score: 0.8,
      breakdown: {
        highlight: 0.8,
        hook: 0.5,
        density: 0.5,
        emotion: 0.5,
        novelty: 0.5,
        closure: 0.5,
      },
      layout: 'single' as const,
      faces: [],
      social: { title: 't', description: 'd', hashtags: ['h'] },
    },
    {
      schemaVersion: 1 as const,
      id: 'clip-02',
      start: 50,
      end: 80,
      score: 0.6,
      breakdown: {
        highlight: 0.5,
        hook: 0.5,
        density: 0.5,
        emotion: 0.5,
        novelty: 0.5,
        closure: 0.5,
      },
      layout: 'single' as const,
      faces: [],
      social: { title: 't2', description: 'd2', hashtags: ['h2'] },
    },
  ];

  test('applies valid patches and journals the round on every verdict', () => {
    const result = applyCriticVerdicts(
      candidates,
      [
        { id: 'clip-01', verdict: 'revise', issues: ['weak hook'], patch: { start: 12 } },
        { id: 'clip-02', verdict: 'pass' },
      ],
      1,
      { durationSeconds: 100 },
    );
    expect(result[0]?.start).toBe(12);
    expect(result[0]?.revisions).toEqual([
      { round: 1, verdict: 'revise', issues: ['weak hook'], applied: true },
    ]);
    expect(result[1]?.revisions).toEqual([
      { round: 1, verdict: 'pass', issues: [], applied: true },
    ]);
  });

  test('ignores invalid patches, records them and drops discarded candidates', () => {
    const result = applyCriticVerdicts(
      candidates,
      [
        { id: 'clip-01', verdict: 'revise', patch: { end: 200 } },
        { id: 'clip-02', verdict: 'revise', patch: { discard: true } },
      ],
      2,
      { durationSeconds: 100 },
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.end).toBe(40);
    expect(result[0]?.revisions?.[0]).toEqual({
      round: 2,
      verdict: 'revise',
      issues: ['ignored invalid patch.end 200'],
      applied: false,
    });
  });

  test('never mutates its inputs and stays deterministic', () => {
    const snapshot = JSON.parse(JSON.stringify(candidates));
    const verdicts = [{ id: 'clip-01', verdict: 'revise' as const, patch: { start: 11 } }];
    const first = applyCriticVerdicts(candidates, verdicts, 1);
    const second = applyCriticVerdicts(candidates, verdicts, 1);
    expect(first).toEqual(second);
    expect(candidates).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Context budget guards (long sources)
// ---------------------------------------------------------------------------

function guardCandidate(index: number, description: string) {
  return {
    schemaVersion: 1 as const,
    id: `clip-${String(index + 1).padStart(2, '0')}`,
    start: index * 60,
    end: index * 60 + 45,
    score: 1 - index / 1000,
    breakdown: {
      highlight: 0.5,
      hook: 0.5,
      density: 0.5,
      emotion: 0.5,
      novelty: 0.5,
      closure: 0.5,
    },
    layout: 'single' as const,
    faces: [],
    social: { title: `title ${index}`, description, hashtags: ['x'] },
  };
}

describe('compactCandidatesForReview', () => {
  test('sends only the best-N by score, compact and deterministic', () => {
    const candidates = Array.from({ length: 200 }, (_, index) =>
      guardCandidate(index, `description ${index}`.padEnd(400, '.')),
    );
    const compact = compactCandidatesForReview(candidates, 24);
    expect(compact).toHaveLength(24);
    expect(compact[0]?.id).toBe('clip-01');
    expect(compact[23]?.id).toBe('clip-24');
    // Compact form: no breakdown/hashtags/revisions leak into the payload.
    expect(Object.keys(compact[0]!).sort()).toEqual(
      ['description', 'end', 'faceCount', 'id', 'layout', 'score', 'start', 'title'].sort(),
    );
    expect(compact[0]?.description?.length).toBeLessThanOrEqual(160);
    expect(compactCandidatesForReview(candidates, 24)).toEqual(compact);
  });
});

describe('buildCriticState', () => {
  test('NEVER exceeds the character budget for a huge candidate set', () => {
    const candidates = Array.from({ length: 400 }, (_, index) =>
      guardCandidate(index, `long description ${index}`.padEnd(2000, 'x')),
    );
    const { state, reviewedIds } = buildCriticState({
      objective: 'virality',
      sourceDurationSeconds: 6180,
      candidates,
    });
    expect(state.length).toBeLessThanOrEqual(REVIEW_STATE_CHAR_BUDGET);
    expect(reviewedIds.length).toBeGreaterThan(1);
    expect(reviewedIds.length).toBeLessThanOrEqual(REVIEW_CANDIDATE_LIMIT);
    // The ids in the state are exactly the reviewed ones (best first).
    for (const id of reviewedIds) expect(state).toContain(`"${id}"`);
    expect(
      buildCriticState({ objective: 'virality', sourceDurationSeconds: 6180, candidates }).state,
    ).toBe(state);
  });

  test('drops descriptions before dropping candidates', () => {
    const candidates = Array.from({ length: 10 }, (_, index) =>
      guardCandidate(index, 'short'),
    );
    const { state, reviewedIds } = buildCriticState({ objective: 'x', candidates });
    expect(reviewedIds).toHaveLength(10);
    expect(state).toContain('description');
    // With megabyte descriptions the guard trims the list from the worst end.
    const huge = Array.from({ length: 10 }, (_, index) =>
      guardCandidate(index, 'x'.repeat(50_000)),
    );
    const capped = buildCriticState({ objective: 'x', candidates: huge });
    expect(capped.state.length).toBeLessThanOrEqual(REVIEW_STATE_CHAR_BUDGET);
    expect(capped.reviewedIds[capped.reviewedIds.length - 1]).toBe(
      `clip-${String(capped.reviewedIds.length).padStart(2, '0')}`,
    );
  });
});

describe('truncateTranscriptSlice', () => {
  test('caps the slice on a word boundary and marks the cut', () => {
    const text = Array.from({ length: 500 }, (_, index) => `word${index}`).join(' ');
    const capped = truncateTranscriptSlice(text, 100);
    expect(capped.length).toBeLessThanOrEqual(101);
    expect(capped.endsWith(' …')).toBe(true);
    expect(capped.startsWith('word0 word1')).toBe(true);
    expect(truncateTranscriptSlice('small slice', 100)).toBe('small slice');
  });
});

describe('selectDistinctSpans', () => {
  const spans = [
    { id: 'a', start: 727, end: 785 },
    { id: 'b', start: 732, end: 790 },
    { id: 'c', start: 755, end: 812 },
    { id: 'd', start: 1621, end: 1678 },
    { id: 'e', start: 1630, end: 1688 },
    { id: 'f', start: 3322, end: 3380 },
    { id: 'g', start: 4900, end: 4958 },
  ];
  const spanOf = (item: (typeof spans)[number]) => ({ start: item.start, end: item.end });

  test('picks the best NON-OVERLAPPING spans (no budget on one moment)', () => {
    const picked = selectDistinctSpans(spans, spanOf, 4).map((item) => item.id);
    // a/d/f/g are the best non-overlapping moments; b/c/e are the same zones.
    expect(picked).toEqual(['a', 'd', 'f', 'g']);
  });

  test('backfills with skipped items when distinct spans run out', () => {
    const picked = selectDistinctSpans(spans, spanOf, 6).map((item) => item.id);
    expect(picked).toHaveLength(6);
    expect(picked.slice(0, 4)).toEqual(['a', 'd', 'f', 'g']);
    expect(picked.slice(4)).toEqual(['b', 'c']);
  });

  test('respects the limit and the min gap; empty input is empty', () => {
    expect(selectDistinctSpans(spans, spanOf, 2).map((item) => item.id)).toEqual(['a', 'd']);
    expect(
      selectDistinctSpans(spans, spanOf, 4, { minGapSeconds: 60 }).map((item) => item.id),
    ).toEqual(['a', 'd', 'f', 'g']);
    expect(selectDistinctSpans([], spanOf, 5)).toEqual([]);
  });
});
