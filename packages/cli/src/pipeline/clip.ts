/**
 * `clip-frames` pipeline (part 1/4 of the clip pipeline): deterministic frame
 * sampling, shard manifests and the offline source probe + ffmpeg extraction
 * thin layer.
 *
 * Everything except `probeSource` / `runClipFrames` is pure so the sampling
 * and sharding logic is testable without binaries, network or ffmpeg;
 * ffmpeg/ffprobe invocations live only in the thin runner. Local files only:
 * remote sources (YouTube URLs) are rejected with an actionable error because
 * `yt-dlp` is not wired in this part (plan: local file required).
 */
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

import { isRecord, type Project, type SceneConfig } from '@videomaker/core';
import type { Viewport } from '@videomaker/motion-core';
// The face-track seam lives in `motion-core/src/face-track.ts`; the package
// barrel does not export it and its `exports` map blocks subpaths, so it is
// consumed through a relative import (the demo project's kit seam precedent).
import { framesToInteractions } from '../../../motion-core/src/face-track';
import { buildWordSegments, clipWordsToWindow, type FilmProps, type FilmScene } from '@videomaker/motion-remotion';
import type { FfmpegRunner } from '@videomaker/motion-remotion/loudness';
import type { ProcessRunner } from '@videomaker/providers';
import {
  FRAME_ID_PATTERN,
  SCORING_SIGNALS,
  ClipSocialSchema,
  type BBox,
  type ClipBreakdown,
  type ClipFace,
  type ClipRange,
  type ClipSocial,
  type FrameAnalysis,
  type ScoringWeightValues,
} from '@videomaker/schemas';

import type { AgentQuestion } from './agent';

import { buildFilmProps, ffmpegStderrDetail, projectAbsolute } from './assemble';

/**
 * Canonical frame id: `f-<6 digits>` (`f-000001`), `t` in seconds from the
 * start of the source, `path` project-relative. `'base'` is reserved for the
 * sparse context level of later parts; this part only samples `'key'` frames.
 */
export interface FrameEntry {
  frame_id: string;
  t: number;
  path: string;
  rol: 'base' | 'key';
}

/** `clips/frames.json`: the only table `frame_id ↔ t ↔ file`. */
export interface FramesManifest {
  schemaVersion: 1;
  frames: FrameEntry[];
}

/**
 * One analysis unit: its analyzable frames in order plus the context frames
 * carried from the previous shard (also prepended to `frameIds`, listed
 * separately in `contextOnlyFrameIds`). `prevSummary` is a placeholder in this
 * part; later parts fill it from the neighboring transcript.
 */
export interface ShardEntry {
  id: string;
  frameIds: string[];
  contextOnlyFrameIds: string[];
  prevSummary: string;
}

/** `clips/shards.json`. Deterministic: same input ⇒ byte-identical output. */
export interface ShardsManifest {
  schemaVersion: 1;
  shardSize: number;
  shards: ShardEntry[];
}

/** Intrinsic source facts recorded in `clips/source.json`. */
export interface SourceProbe {
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  sha256: string;
}

/** Options of the pure sampling step. */
export interface SampleFramesOptions {
  durationSeconds: number;
  fps: number;
  /** Seconds between grid samples (default 1). */
  frameEverySeconds?: number;
  /** Scene-cut timestamps (seconds from source start) to add as samples. */
  sceneCutTimes?: number[];
}

/** Options of the `clip-frames` thin runner. */
export interface ClipFramesOptions {
  srcPath: string;
  /** Seconds between grid samples (default 1). */
  frameEverySeconds?: number;
  /** Scene-cut timestamps (seconds from source start) to add as samples. */
  sceneCutTimes?: number[];
  /** Analyzable frames per shard (default 60). */
  shardSize?: number;
  /** Context frames carried from the previous shard (default 5). */
  contextFrames?: number;
  /** yt-dlp binary used for remote `srcPath` (default `yt-dlp` on PATH). */
  ytdlpBin?: string;
}

const URL_PATTERN = /^https?:\/\//i;
const PROJECT_FRAMES_DIR = 'clips/frames';

/** True for remote `http(s)` sources, fetched with yt-dlp before probing. */
export function isRemoteSource(src: string): boolean {
  return URL_PATTERN.test(src);
}

/**
 * Deterministic sample list: one frame each `frameEverySeconds` starting at
 * `t = 0`, plus one frame at each `sceneCutTime`, deduped and sorted by `t`,
 * all strictly before `durationSeconds`, all `rol: 'key'`.
 *
 * Two timestamps within half a frame sample the same video frame, so they are
 * collapsed to the earlier `t` (this also dedupes a scene cut landing exactly
 * on a grid sample).
 */
export function sampleFrames(options: SampleFramesOptions): FrameEntry[] {
  const { durationSeconds, fps } = options;
  const frameEverySeconds = options.frameEverySeconds ?? 1;
  const sceneCutTimes = options.sceneCutTimes ?? [];
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(
      `sampleFrames: durationSeconds must be a positive finite number, got ${durationSeconds}.`,
    );
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`sampleFrames: fps must be a positive finite number, got ${fps}.`);
  }
  if (!Number.isFinite(frameEverySeconds) || frameEverySeconds <= 0) {
    throw new Error(
      `sampleFrames: frameEverySeconds must be a positive finite number, got ${frameEverySeconds}.`,
    );
  }
  const gridCount = Math.ceil(durationSeconds / frameEverySeconds);
  if (!Number.isFinite(gridCount) || gridCount > 10_000_000) {
    throw new Error(
      'sampleFrames: frameEverySeconds is too small for this duration ' +
        `(would sample more than 10,000,000 frames); got frameEverySeconds=${frameEverySeconds}, durationSeconds=${durationSeconds}.`,
    );
  }
  const candidates: number[] = [];
  for (let index = 0; index < gridCount; index += 1) {
    const t = index * frameEverySeconds;
    if (t < durationSeconds) candidates.push(t);
  }
  for (const cut of sceneCutTimes) {
    if (!Number.isFinite(cut) || cut < 0) {
      throw new Error(
        `sampleFrames: sceneCutTimes must contain finite seconds >= 0, got ${cut}.`,
      );
    }
    if (cut < durationSeconds) candidates.push(cut);
  }
  candidates.sort((a, b) => a - b);
  const halfFrame = 0.5 / fps;
  const times: number[] = [];
  for (const t of candidates) {
    const last = times[times.length - 1];
    if (last === undefined || t - last >= halfFrame) times.push(t);
  }
  return times.map((t, index): FrameEntry => {
    const frame_id = `f-${String(index + 1).padStart(6, '0')}`;
    return {
      frame_id,
      t,
      path: `${PROJECT_FRAMES_DIR}/${frame_id}.jpg`,
      rol: 'key',
    };
  });
}

/**
 * Shards of `shardSize` analyzable frames in input order; every shard after
 * the first carries the LAST `contextFrames` frames of the previous shard in
 * `contextOnlyFrameIds` (also prepended to `frameIds`). The first shard has no
 * context frames and `prevSummary` is always the `''` placeholder here.
 */
export function buildShardsManifest(
  frames: FrameEntry[],
  shardSize = 60,
  contextFrames = 5,
): ShardsManifest {
  if (!Number.isInteger(shardSize) || shardSize <= 0) {
    throw new Error(`buildShardsManifest: shardSize must be a positive integer, got ${shardSize}.`);
  }
  if (!Number.isInteger(contextFrames) || contextFrames < 0) {
    throw new Error(
      `buildShardsManifest: contextFrames must be a non-negative integer, got ${contextFrames}.`,
    );
  }
  const seen = new Set<string>();
  for (const frame of frames) {
    if (!FRAME_ID_PATTERN.test(frame.frame_id)) {
      throw new Error(
        `buildShardsManifest: invalid frame_id "${frame.frame_id}" (expected f-<6 digits>, e.g. f-000001).`,
      );
    }
    if (seen.has(frame.frame_id)) {
      throw new Error(`buildShardsManifest: duplicate frame_id "${frame.frame_id}".`);
    }
    seen.add(frame.frame_id);
  }
  const shards: ShardEntry[] = [];
  for (let start = 0, index = 0; start < frames.length; start += shardSize, index += 1) {
    const chunk = frames.slice(start, start + shardSize);
    const previousStart = Math.max(0, start - shardSize);
    const contextStart = Math.max(previousStart, start - contextFrames);
    const contextOnlyFrameIds =
      index === 0
        ? []
        : frames.slice(contextStart, start).map((frame) => frame.frame_id);
    shards.push({
      id: `shard-${String(index + 1).padStart(3, '0')}`,
      frameIds: [...contextOnlyFrameIds, ...chunk.map((frame) => frame.frame_id)],
      contextOnlyFrameIds,
      prevSummary: '',
    });
  }
  return { schemaVersion: 1, shardSize, shards };
}

/**
 * Offline source probe: ffprobe facts (width/height/duration/fps) plus the
 * sha256 of the file bytes. Local files only — a URL fails with an actionable
 * error naming `yt-dlp` (not wired in this part: plan, local file required).
 */
export async function probeSource(process: ProcessRunner, srcPath: string): Promise<SourceProbe> {
  if (typeof srcPath !== 'string' || srcPath.trim() === '') {
    throw new Error('probeSource: srcPath must be a non-empty local file path.');
  }
  if (URL_PATTERN.test(srcPath)) {
    throw new Error(
      `probeSource: remote sources are not supported here — got URL "${srcPath}". ` +
        'yt-dlp is not wired in this part (plan: local file required): download the source ' +
        'to a local file first (e.g. `yt-dlp -o source.mp4 <url>`) and pass its path.',
    );
  }
  const result = await process.run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,r_frame_rate:format=duration',
    '-of',
    'json',
    srcPath,
  ]);
  if (result.code !== 0) {
    throw new Error(`ffprobe failed for ${srcPath}: ${result.stderr.slice(-300)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch (cause) {
    throw new Error(`ffprobe returned invalid JSON for ${srcPath}.`, { cause });
  }
  const record = (raw ?? {}) as Record<string, unknown>;
  const streams = Array.isArray(record.streams) ? record.streams : [];
  const video = (streams[0] ?? {}) as Record<string, unknown>;
  const format = (record.format ?? {}) as Record<string, unknown>;
  const width = Number(video.width);
  const height = Number(video.height);
  const durationSeconds = Number(format.duration);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`ffprobe reported no usable video stream (width/height) for ${srcPath}.`);
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`ffprobe reported no usable duration for ${srcPath}.`);
  }
  let fps = Number.NaN;
  for (const key of ['r_frame_rate', 'avg_frame_rate']) {
    const parts = String(video[key] ?? '').split('/');
    if (parts.length !== 2) continue;
    const numerator = Number(parts[0]);
    const denominator = Number(parts[1]);
    if (
      Number.isFinite(numerator) &&
      Number.isFinite(denominator) &&
      numerator > 0 &&
      denominator !== 0
    ) {
      fps = numerator / denominator;
      break;
    }
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(
      `ffprobe reported no usable frame rate for ${srcPath} (r_frame_rate "${String(video.r_frame_rate)}").`,
    );
  }
  const hasher = new Bun.CryptoHasher('sha256');
  try {
    for await (const chunk of createReadStream(srcPath)) {
      hasher.update(chunk as Uint8Array);
    }
  } catch (cause) {
    throw new Error(`cannot read source file ${srcPath} to hash it.`, { cause });
  }
  return {
    durationSeconds,
    width,
    height,
    fps,
    sha256: hasher.digest('hex'),
  };
}

/**
 * Fetch a remote source with yt-dlp into `<projectDir>/clips/source.mp4` — the
 * canonical project source that `clip-transcribe` consumes by default. Returns
 * the local path; local files never reach this function (`runClipFrames` uses
 * them as-is).
 */
export async function downloadClipSource(
  process: ProcessRunner,
  projectDir: string,
  url: string,
  options?: { ytdlpBin?: string },
): Promise<string> {
  if (!isRemoteSource(url)) {
    throw new Error(`downloadClipSource: expected an http(s) URL, got "${url}".`);
  }
  const bin = options?.ytdlpBin ?? 'yt-dlp';
  await mkdir(join(projectDir, 'clips'), { recursive: true });
  const target = join(projectDir, 'clips', 'source.mp4');
  const result = await process.run(bin, [
    '--no-playlist',
    // Re-running `clip-frames --src <url>` must REFRESH the project source:
    // yt-dlp otherwise skips an existing output file (stale quality).
    '--force-overwrites',
    // YouTube needs a JS runtime for stream URLs (yt-dlp EJS); bun is the
    // repo's own runtime and is always on PATH here.
    '--js-runtimes',
    'bun',
    // 1080p video-only + separate audio, merged to mp4. The selector NEVER
    // falls back to the muxed 360p "format 18": video+audio streams are the
    // floor, so the sharp source the native crop needs is guaranteed.
    '-f',
    'bestvideo[height<=1080]+bestaudio/bestvideo[height<=720]+bestaudio',
    '--merge-output-format',
    'mp4',
    '-o',
    target,
    url,
  ]);
  if (result.code !== 0) {
    throw new Error(
      `${bin} failed for ${url} (exit ${result.code}): ${result.stderr.slice(-300)}`,
    );
  }
  try {
    await stat(target);
  } catch (cause) {
    throw new Error(
      `${bin} reported success but ${target} is missing — check the URL and the yt-dlp options.`,
      { cause },
    );
  }
  return target;
}

/**
 * Thin `clip-frames` runner: probes the source into `clips/source.json`,
 * extracts one jpg per sampled time at `clips/frames/f-%06d.jpg`, then writes
 * `clips/frames.json` and `clips/shards.json`. All ffmpeg invocations live
 * here; the manifests come from the pure helpers above.
 */
export async function runClipFrames(
  process: ProcessRunner,
  projectDir: string,
  options: ClipFramesOptions,
): Promise<{ frames: FramesManifest; shards: ShardsManifest }> {
  if (typeof projectDir !== 'string' || projectDir.trim() === '') {
    throw new Error('runClipFrames: projectDir must be a non-empty path.');
  }
  const srcPath = isRemoteSource(options.srcPath)
    ? await downloadClipSource(process, projectDir, options.srcPath, {
        ytdlpBin: options.ytdlpBin,
      })
    : options.srcPath;
  const probe = await probeSource(process, srcPath);
  const frames: FramesManifest = {
    schemaVersion: 1,
    frames: sampleFrames({
      durationSeconds: probe.durationSeconds,
      fps: probe.fps,
      frameEverySeconds: options.frameEverySeconds,
      sceneCutTimes: options.sceneCutTimes,
    }),
  };
  const shards = buildShardsManifest(frames.frames, options.shardSize, options.contextFrames);
  await mkdir(join(projectDir, PROJECT_FRAMES_DIR), { recursive: true });
  await writeFile(
    join(projectDir, 'clips', 'source.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        path: srcPath,
        ...(isRemoteSource(options.srcPath) ? { sourceUrl: options.srcPath } : {}),
        durationSeconds: probe.durationSeconds,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        sha256: probe.sha256,
      },
      null,
      2,
    )}\n`,
  );
  for (const frame of frames.frames) {
    const output = join(projectDir, frame.path);
    const result = await process.run('ffmpeg', [
      '-y',
      '-ss',
      String(frame.t),
      '-i',
      srcPath,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      output,
    ]);
    if (result.code !== 0) {
      throw new Error(
        `ffmpeg failed extracting ${frame.frame_id} (t=${frame.t}) from ${srcPath}: ` +
          result.stderr.slice(-300),
      );
    }
  }
  await writeFile(
    join(projectDir, 'clips', 'frames.json'),
    `${JSON.stringify(frames, null, 2)}\n`,
  );
  await writeFile(
    join(projectDir, 'clips', 'shards.json'),
    `${JSON.stringify(shards, null, 2)}\n`,
  );
  return { frames, shards };
}

// ---------------------------------------------------------------------------
// Part 2/4 — scoring and candidate aggregation (pure, `--plan`-safe)
//
// The "where to where" decision of the clip pipeline, fully auditable:
// `proposeWindows` proposes candidate windows from the transcript alone (local
// heuristics, no frames, no network), `windowSignals` computes the six
// normalized signals behind every score, `scoreWindow` applies the adjustable
// weight formula, `buildCandidates` aggregates one `ClipRange` per window
// (faces, layout, social copy, filtering, ranking) and `explainCandidate`
// renders the signal-by-signal audit for a single candidate.
//
// Everything in this section is pure and deterministic: no filesystem, no
// ffmpeg, no network — so `--plan` can run it in the dry.
// ---------------------------------------------------------------------------

/** Structural whisper word (`word_timestamps` entry) on the source clock. */
export interface ClipWord {
  word: string;
  start: number;
  end: number;
}

/**
 * One transcript-proposed candidate window. `id` is `win-01`, `win-02`, … in
 * `start` order; `preScore` is the cheap local ranking (0–1, transcript only —
 * the expensive vision score comes later from `scoreWindow`); `reason` is a
 * short English phrase naming the heuristic that proposed the window.
 */
export interface ProposedWindow {
  id: string;
  start: number;
  end: number;
  preScore: number;
  reason: string;
}

/** The six normalized signals (0–1) behind a window's score. */
export interface WindowSignals {
  highlight: number;
  hook: number;
  density: number;
  emotion: number;
  novelty: number;
  closure: number;
}

/** Long pause between words that ends a turn / topic segment. */
const PAUSE_GAP_SECONDS = 2;
/** Gaps longer than this count against `density`. */
const DENSITY_GAP_SECONDS = 1;
/** Adjacent words at most this close belong to the same fast burst. */
const BURST_GAP_SECONDS = 0.35;
/** Minimum adjacent words for a "fast-paced burst" seed. */
const BURST_MIN_WORDS = 6;
/** A turn at this word rate (without gaps) is a "dense speech" seed. */
const DENSE_MIN_WORDS_PER_SECOND = 2.5;
/** Target word rate for full `density` credit. */
const TARGET_WORDS_PER_SECOND = 3;
/** A hook cue gets full `hook` credit inside the window's first seconds. */
const HOOK_CUE_SECONDS = 3;
/** Each gap over `DENSITY_GAP_SECONDS` costs this fraction of `density`. */
const GAP_DENSITY_PENALTY = 0.2;
/** A word ending a written sentence (`…` included, optional closing quote). */
const TERMINAL_PUNCTUATION = /[.?!…]["')\]]?$/;

/**
 * Hook / list cue words matched on the accent-free lowercase word form, so
 * Spanish transcripts work unchanged (`cómo` matches `como`). Deliberately
 * excludes ultra-common words (`que`, `what`, …) to avoid false hooks.
 */
const HOOK_CUE_WORDS: Record<string, true> = {
  how: true,
  why: true,
  secret: true,
  secrets: true,
  mistake: true,
  mistakes: true,
  never: true,
  always: true,
  best: true,
  worst: true,
  tip: true,
  tips: true,
  step: true,
  steps: true,
  way: true,
  ways: true,
  reason: true,
  reasons: true,
  first: true,
  top: true,
  como: true,
  secreto: true,
  secretos: true,
  error: true,
  errores: true,
  nunca: true,
  siempre: true,
  mejor: true,
  peor: true,
  truco: true,
  trucos: true,
  consejo: true,
  consejos: true,
};

/** Equal weights used by `explainCandidate` when the caller has none at hand. */
const UNIT_SCORING_WEIGHTS: ScoringWeightValues = {
  highlight: 1,
  hook: 1,
  density: 1,
  emotion: 1,
  novelty: 1,
  closure: 1,
};

/**
 * A hook/list cue: question or exclamation (either orientation), a number, or
 * a hook/list cue word (`how`, `cómo`, `tips`, `secret`, …).
 */
function isHookCue(word: string): boolean {
  if (/[?¿!¡]/.test(word)) return true;
  if (/\d/.test(word)) return true;
  const normalized = word
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '');
  return HOOK_CUE_WORDS[normalized] === true;
}

/** Throws unless every word has finite times (`0 <= start <= end`), in order. */
function assertWordTimes(words: ClipWord[], caller: string): void {
  let previousStart = -1;
  for (const word of words) {
    if (
      !Number.isFinite(word.start) ||
      !Number.isFinite(word.end) ||
      word.start < 0 ||
      word.end < word.start
    ) {
      throw new Error(
        `${caller}: word "${word.word}" must have finite times with 0 <= start <= end, ` +
          `got start=${word.start}, end=${word.end}.`,
      );
    }
    if (word.start < previousStart) {
      throw new Error(
        `${caller}: words must be in chronological order; "${word.word}" starts at ${word.start} after ${previousStart}.`,
      );
    }
    previousStart = word.start;
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Rounds to 4 decimals so scores/flags are stable across runs and platforms. */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** Arithmetic mean; an empty list has no samples and contributes 0. */
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/** Middle value; an even sample count averages the two middle values. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

type WindowSeedKind = 'hook' | 'density' | 'burst';

interface WindowSeed {
  start: number;
  kind: WindowSeedKind;
}

/** Deterministic seed order when several seeds land on the same start. */
const SEED_KIND_ORDER: Record<WindowSeedKind, number> = {
  hook: 0,
  density: 1,
  burst: 2,
};

const SEED_REASONS: Record<WindowSeedKind, string> = {
  hook: 'opens with a hook cue',
  density: 'dense speech without gaps',
  burst: 'fast-paced burst',
};

/**
 * PURE local transcript heuristic (no frames, no network): proposes candidate
 * clip windows from whisper words alone.
 *
 * Heuristics (plan `clip-propose`):
 * - **hook**: a question/exclamation/number/list cue anchors a window that
 *   opens on the cue;
 * - **density**: a turn (see below) with `>= 2.5` words/second and no gap over
 *   1 s anchors a window at its start;
 * - **burst**: a run of `>= 6` adjacent words at most 0.35 s apart anchors a
 *   window at its start (energy-ish fast speech);
 * - **topic/turn boundaries**: words split into turns at long pauses
 *   (`>= 2 s`); window ends snap to the latest clean boundary inside the
 *   duration bounds — a sentence end (terminal punctuation), a turn end
 *   (long pause after the word) or the transcript end.
 *
 * Every window satisfies `minSeconds <= end - start <= maxSeconds` (defaults
 * 20 s / 90 s); seeds whose transcript tail is shorter than `minSeconds` are
 * dropped. Duplicate windows collapse to one (the seed order prefers the hook
 * reason) and windows strictly contained in a larger kept window are dropped.
 * The result is deterministic, sorted by `start`, numbered `win-01`, `win-02`,
 * …, with `preScore = clamp01(0.5·hook + 0.3·density + 0.2·closure)` where
 * `hook` is 1/0.5/0 (cue in the first 3 s / later cue / none), `density` is
 * `clamp01(wps/3) · clamp01(1 − 0.2·gapsOver1s)` and `closure` is 1 when the
 * end snapped to a clean boundary else 0.5. Empty words ⇒ `[]`.
 */
export function proposeWindows(
  words: ClipWord[],
  options?: { minSeconds?: number; maxSeconds?: number },
): ProposedWindow[] {
  const minSeconds = options?.minSeconds ?? 20;
  const maxSeconds = options?.maxSeconds ?? 90;
  if (!Number.isFinite(minSeconds) || minSeconds <= 0) {
    throw new Error(
      `proposeWindows: minSeconds must be a positive finite number, got ${minSeconds}.`,
    );
  }
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) {
    throw new Error(
      `proposeWindows: maxSeconds must be a positive finite number, got ${maxSeconds}.`,
    );
  }
  if (maxSeconds < minSeconds) {
    throw new Error(
      `proposeWindows: maxSeconds (${maxSeconds}) must be >= minSeconds (${minSeconds}).`,
    );
  }
  assertWordTimes(words, 'proposeWindows');
  if (words.length === 0) return [];

  // Turns: topic/turn segments split at long pauses.
  const turns: ClipWord[][] = [];
  for (const word of words) {
    if (turns.length === 0) {
      turns.push([word]);
      continue;
    }
    const currentTurn = turns[turns.length - 1];
    const previousWord = currentTurn[currentTurn.length - 1];
    if (word.start - previousWord.end >= PAUSE_GAP_SECONDS) {
      turns.push([word]);
    } else {
      currentTurn.push(word);
    }
  }

  // Seeds from the four heuristic families.
  const seeds: WindowSeed[] = [];
  for (const word of words) {
    if (isHookCue(word.word)) seeds.push({ start: word.start, kind: 'hook' });
  }
  for (const turn of turns) {
    const turnSpan = turn[turn.length - 1].end - turn[0].start;
    const turnWordsPerSecond = turnSpan > 0 ? turn.length / turnSpan : 0;
    let maxGap = 0;
    for (let index = 1; index < turn.length; index += 1) {
      const gap = turn[index].start - turn[index - 1].end;
      if (gap > maxGap) maxGap = gap;
    }
    if (
      turnWordsPerSecond >= DENSE_MIN_WORDS_PER_SECOND &&
      maxGap <= DENSITY_GAP_SECONDS
    ) {
      seeds.push({ start: turn[0].start, kind: 'density' });
    }
  }
  let runStart = 0;
  for (let index = 1; index <= words.length; index += 1) {
    const runBroken =
      index === words.length ||
      words[index].start - words[index - 1].end > BURST_GAP_SECONDS;
    if (!runBroken) continue;
    if (index - runStart >= BURST_MIN_WORDS) {
      seeds.push({ start: words[runStart].start, kind: 'burst' });
    }
    runStart = index;
  }
  seeds.sort(
    (a, b) => a.start - b.start || SEED_KIND_ORDER[a.kind] - SEED_KIND_ORDER[b.kind],
  );

  // Grow each seed to [minSeconds, maxSeconds], snapping the end to the latest
  // clean boundary inside the bounds.
  const transcriptEnd = words[words.length - 1].end;
  const grown: Array<{ start: number; end: number; snapped: boolean; seed: WindowSeed }> = [];
  for (const seed of seeds) {
    const earliestEnd = seed.start + minSeconds;
    const latestEnd = Math.min(seed.start + maxSeconds, transcriptEnd);
    if (latestEnd < earliestEnd) continue;
    let end = latestEnd;
    let snapped = false;
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      if (word.start < seed.start) continue;
      if (word.end > latestEnd) break;
      if (word.end < earliestEnd) continue;
      const isLastWord = index === words.length - 1;
      const followedByPause =
        !isLastWord && words[index + 1].start - word.end >= PAUSE_GAP_SECONDS;
      if (TERMINAL_PUNCTUATION.test(word.word) || isLastWord || followedByPause) {
        end = word.end;
        snapped = true;
      }
    }
    grown.push({ start: seed.start, end, snapped, seed });
  }

  // Collapse duplicates (first seed wins: hook reason preferred) and drop
  // windows strictly contained in a larger kept window.
  const unique: typeof grown = [];
  for (const window of grown) {
    const duplicate = unique.some(
      (kept) => kept.start === window.start && kept.end === window.end,
    );
    if (!duplicate) unique.push(window);
  }
  const kept = unique.filter(
    (window) =>
      !unique.some(
        (other) =>
          other.start <= window.start &&
          other.end >= window.end &&
          (other.start < window.start || other.end > window.end),
      ),
  );
  kept.sort((a, b) => a.start - b.start || a.end - b.end);

  return kept.map((window, index): ProposedWindow => {
    const windowWords = words.filter(
      (word) => word.start < window.end && word.end > window.start,
    );
    const firstWord = windowWords[0];
    const lastWord = windowWords[windowWords.length - 1];
    const span = lastWord.end - firstWord.start;
    const wordsPerSecond = span > 0 ? windowWords.length / span : 0;
    let gapCount = 0;
    let hasCue = false;
    let hasOpeningCue = false;
    for (let wordIndex = 0; wordIndex < windowWords.length; wordIndex += 1) {
      const word = windowWords[wordIndex];
      if (
        wordIndex > 0 &&
        word.start - windowWords[wordIndex - 1].end > DENSITY_GAP_SECONDS
      ) {
        gapCount += 1;
      }
      if (isHookCue(word.word)) {
        hasCue = true;
        if (word.start - firstWord.start < HOOK_CUE_SECONDS) hasOpeningCue = true;
      }
    }
    const hookComponent = hasOpeningCue ? 1 : hasCue ? 0.5 : 0;
    const densityComponent =
      clamp01(wordsPerSecond / TARGET_WORDS_PER_SECOND) *
      clamp01(1 - GAP_DENSITY_PENALTY * gapCount);
    const closureComponent = window.snapped ? 1 : 0.5;
    return {
      id: `win-${String(index + 1).padStart(2, '0')}`,
      start: window.start,
      end: window.end,
      preScore: round4(
        clamp01(0.5 * hookComponent + 0.3 * densityComponent + 0.2 * closureComponent),
      ),
      reason: SEED_REASONS[window.seed.kind],
    };
  });
}

/**
 * PURE, deterministic per-signal values (each 0–1) of one candidate window:
 *
 * - `highlight` — mean of `frame.highlight` over the window frames (0 if none);
 * - `hook` — 1 when a hook cue (question/exclamation/number/list) starts
 *   within the first 3 s of the window's words, 0.5 for a later cue, else 0;
 * - `density` — `clamp01(wordsPerSecond / 3) · clamp01(1 − 0.2·gapsOver1s)`
 *   over the window words (`wordsPerSecond = words / (lastEnd − firstStart)`);
 * - `emotion` — speaking-frames ratio × mean `frame.energy`;
 * - `novelty` — `0.5·sceneCutRatio + 0.5·topicNovelty` where `topicNovelty`
 *   is the fraction of the window's distinct topics absent from
 *   `previous.topics`, or the neutral 0.5 baseline when `previous` is absent
 *   (or there is nothing to compare);
 * - `closure` — 1 iff the window's last word ends a written sentence
 *   (terminal punctuation; a window cut mid-sentence scores 0).
 */
export function windowSignals(
  frames: FrameAnalysis[],
  words: ClipWord[],
  previous?: { topics: string[] },
): WindowSignals {
  assertWordTimes(words, 'windowSignals');
  const frameCount = frames.length;
  const highlight = mean(frames.map((frame) => frame.highlight));

  let hook = 0;
  let density = 0;
  let closure = 0;
  if (words.length > 0) {
    const firstWord = words[0];
    const lastWord = words[words.length - 1];
    let hasCue = false;
    let hasOpeningCue = false;
    let gapCount = 0;
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      if (isHookCue(word.word)) {
        hasCue = true;
        if (word.start - firstWord.start < HOOK_CUE_SECONDS) hasOpeningCue = true;
      }
      if (index > 0 && word.start - words[index - 1].end > DENSITY_GAP_SECONDS) {
        gapCount += 1;
      }
    }
    hook = hasOpeningCue ? 1 : hasCue ? 0.5 : 0;
    const span = lastWord.end - firstWord.start;
    const wordsPerSecond = span > 0 ? words.length / span : 0;
    density =
      clamp01(wordsPerSecond / TARGET_WORDS_PER_SECOND) *
      clamp01(1 - GAP_DENSITY_PENALTY * gapCount);
    closure = TERMINAL_PUNCTUATION.test(lastWord.word) ? 1 : 0;
  }

  const speakingRatio =
    frameCount === 0
      ? 0
      : frames.filter((frame) => frame.speakers.some((speaker) => speaker.speaking))
          .length / frameCount;
  const emotion = speakingRatio * mean(frames.map((frame) => frame.energy));

  const sceneCutRatio =
    frameCount === 0 ? 0 : frames.filter((frame) => frame.sceneCut).length / frameCount;
  const windowTopics = [...new Set(frames.map((frame) => frame.topic))];
  let topicNovelty = 0.5;
  if (previous !== undefined && previous.topics.length > 0 && windowTopics.length > 0) {
    topicNovelty =
      windowTopics.filter((topic) => !previous.topics.includes(topic)).length /
      windowTopics.length;
  }
  const novelty = 0.5 * sceneCutRatio + 0.5 * topicNovelty;

  return {
    highlight: round4(clamp01(highlight)),
    hook: round4(clamp01(hook)),
    density: round4(clamp01(density)),
    emotion: round4(clamp01(emotion)),
    novelty: round4(clamp01(novelty)),
    closure: round4(clamp01(closure)),
  };
}

/** Throws unless the weights are finite, non-negative and sum above zero. */
function weightSum(weights: ScoringWeightValues): number {
  let total = 0;
  for (const signal of SCORING_SIGNALS) {
    const weight = weights[signal];
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(
        `scoring weight "${signal}" must be a finite number >= 0, got ${weight}.`,
      );
    }
    total += weight;
  }
  if (total <= 0) {
    throw new Error('scoring weights must sum to a positive number.');
  }
  return total;
}

/**
 * The adjustable scoring formula: `score = Σ wᵢ·sᵢ / Σ wᵢ` clamped 0–1 and
 * rounded to 4 decimals; `breakdown` is the raw `windowSignals` output so the
 * score stays auditable (`explainCandidate` renders it). The same words/frames
 * must describe the window being scored (pass `previous` to compare novelty
 * against the previous window's topics).
 */
export function scoreWindow(
  frames: FrameAnalysis[],
  words: ClipWord[],
  weights: ScoringWeightValues,
  previous?: { topics: string[] },
): { score: number; breakdown: ClipBreakdown } {
  const total = weightSum(weights);
  const breakdown: ClipBreakdown = windowSignals(frames, words, previous);
  let weighted = 0;
  for (const signal of SCORING_SIGNALS) {
    weighted += weights[signal] * breakdown[signal];
  }
  return { score: round4(clamp01(weighted / total)), breakdown };
}

/**
 * Template social copy for a candidate window: `title` is the topic truncated
 * to 8 words (`'Clip highlight'` when there is no topic), `description`
 * mentions the `start`–`end` seconds range, and `hashtags` are 1–3 lowercase
 * alnum topic words (accent-stripped, deduped; `['clip']` when the topic has
 * no usable words).
 */
export function socialFallback(topic: string, start: number, end: number): ClipSocial {
  const topicWords = topic.split(/\s+/).filter((word) => word.length > 0);
  const title = topicWords.slice(0, 8).join(' ');
  const hashtags: string[] = [];
  for (const word of topicWords) {
    const tag = word
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '');
    if (tag.length === 0 || hashtags.includes(tag)) continue;
    hashtags.push(tag);
    if (hashtags.length === 3) break;
  }
  if (hashtags.length === 0) hashtags.push('clip');
  return {
    title: title === '' ? 'Clip highlight' : title,
    description: `Clip from ${start}s to ${end}s.`,
    hashtags,
  };
}

/**
 * Representative faces of a window: one entry per speaker id with the
 * per-component `median` bbox of its detections and `presence` = fraction of
 * window frames where the speaker appears (a speaker counts once per frame).
 * Sorted by presence desc, then id, so the primary face comes first.
 */
function aggregateFaces(frames: FrameAnalysis[]): ClipFace[] {
  if (frames.length === 0) return [];
  const byId = new Map<string, { bboxes: BBox[]; frameCount: number }>();
  for (const frame of frames) {
    const countedInFrame = new Set<string>();
    for (const speaker of frame.speakers) {
      if (countedInFrame.has(speaker.id)) continue;
      countedInFrame.add(speaker.id);
      const entry = byId.get(speaker.id);
      if (entry === undefined) {
        byId.set(speaker.id, { bboxes: [speaker.bbox], frameCount: 1 });
      } else {
        entry.bboxes.push(speaker.bbox);
        entry.frameCount += 1;
      }
    }
  }
  const faces: ClipFace[] = [];
  for (const [id, entry] of byId) {
    const bbox: BBox = [
      median(entry.bboxes.map((box) => box[0])),
      median(entry.bboxes.map((box) => box[1])),
      median(entry.bboxes.map((box) => box[2])),
      median(entry.bboxes.map((box) => box[3])),
    ];
    faces.push({ id, bbox, presence: entry.frameCount / frames.length });
  }
  faces.sort((a, b) => b.presence - a.presence || (a.id < b.id ? -1 : 1));
  return faces;
}

/** Most frequent frame topic; ties resolve to the lexicographically smallest. */
function dominantTopic(frames: FrameAnalysis[]): string {
  const counts = new Map<string, number>();
  for (const frame of frames) {
    counts.set(frame.topic, (counts.get(frame.topic) ?? 0) + 1);
  }
  let best = '';
  let bestCount = -1;
  const topics = [...counts.keys()].sort();
  for (const topic of topics) {
    const count = counts.get(topic) ?? 0;
    if (count > bestCount) {
      best = topic;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Candidate aggregation — the "where to where" decision. For every window
 * proposed from `words` (bounded by `options.minDurationSeconds` /
 * `maxDurationSeconds`, defaults 20 s / 90 s) it scores the window with the
 * `analyses` frames whose `t` falls inside `[start, end]` and the words
 * overlapping it, then aggregates:
 *
 * - `faces` — speakers of the window: median bbox + presence (fraction of
 *   window frames with that speaker), presence desc then id;
 * - `layout` — `'duo'` IFF exactly 2 faces both with presence `>= 0.8`,
 *   else `'single'` (duo is never forced);
 * - `social` — `socialDrafts[windowId]` (or `socialDrafts[clipId]`) when the
 *   caller provides drafts, else `socialFallback(dominantTopic, start, end)`;
 * - windows with `score < options.minScore` (default 0) are dropped, then the
 *   survivors are ranked by score desc, then `start`, and numbered `clip-01`,
 *   `clip-02`, … — fully deterministic.
 *
 * `objective` travels untouched for callers (e.g. `--objective`); the pure
 * template fallback does not interpret it.
 */
export function buildCandidates(input: {
  words: ClipWord[];
  analyses: FrameAnalysis[];
  weights: ScoringWeightValues;
  objective?: string;
  socialDrafts?: Record<string, ClipSocial>;
  options?: {
    minDurationSeconds?: number;
    maxDurationSeconds?: number;
    minScore?: number;
  };
}): ClipRange[] {
  const minScore = input.options?.minScore ?? 0;
  if (!Number.isFinite(minScore) || minScore < 0) {
    throw new Error(`buildCandidates: minScore must be a finite number >= 0, got ${minScore}.`);
  }
  const windows = proposeWindows(input.words, {
    minSeconds: input.options?.minDurationSeconds,
    maxSeconds: input.options?.maxDurationSeconds,
  });
  const scored = windows
    .map((window) => {
      const { start, end } = window;
      const windowWords = input.words.filter(
        (word) => word.start < end && word.end > start,
      );
      const windowFrames = input.analyses.filter(
        (frame) => frame.t >= start && frame.t <= end,
      );
      const { score, breakdown } = scoreWindow(windowFrames, windowWords, input.weights);
      return {
        window,
        start,
        end,
        score,
        breakdown,
        faces: aggregateFaces(windowFrames),
        topic: dominantTopic(windowFrames),
      };
    })
    .filter((record) => record.score >= minScore);
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.start - b.start ||
      a.end - b.end ||
      a.window.id.localeCompare(b.window.id),
  );
  return scored.map((record, index): ClipRange => {
    const id = `clip-${String(index + 1).padStart(2, '0')}`;
    const layout =
      record.faces.length === 2 &&
      record.faces[0].presence >= 0.8 &&
      record.faces[1].presence >= 0.8
        ? 'duo'
        : 'single';
    const social =
      input.socialDrafts?.[record.window.id] ??
      input.socialDrafts?.[id] ??
      socialFallback(record.topic, record.start, record.end);
    return {
      schemaVersion: 1,
      id,
      start: record.start,
      end: record.end,
      score: record.score,
      breakdown: record.breakdown,
      layout,
      faces: record.faces,
      social,
    };
  });
}

/**
 * Signal-by-signal audit of one candidate: `signal value × weight →
 * contribution` per line (contributions are `wᵢ·sᵢ / Σ wᵢ`, so they sum to
 * the total), then the total score. Pass the `weights` actually used to score
 * the candidate for exact contributions; without them unit weights (1 each)
 * are shown. Unknown ids throw an error naming the id.
 */
export function explainCandidate(
  candidates: ClipRange[],
  id: string,
  weights: ScoringWeightValues = UNIT_SCORING_WEIGHTS,
): string {
  const candidate = candidates.find((entry) => entry.id === id);
  if (candidate === undefined) {
    throw new Error(`explainCandidate: no candidate with id "${id}".`);
  }
  const total = weightSum(weights);
  const lines = SCORING_SIGNALS.map((signal) => {
    const value = candidate.breakdown[signal];
    const weight = weights[signal];
    const contribution = round4((weight * value) / total);
    return `  ${signal}: ${value.toFixed(4)} × ${weight.toFixed(4)} → ${contribution.toFixed(4)}`;
  });
  return [`Candidate "${candidate.id}"`, ...lines, `  total: ${candidate.score.toFixed(4)}`].join(
    '\n',
  );
}

// ---------------------------------------------------------------------------
// Part 3/4 — transcription (local whisper) and silence polish
//
// `transcribeToTranscript` runs the local whisper CLI through the injected
// `ProcessRunner` with word timestamps enabled and normalizes its
// `segments[].words` (whisper `word/start/end`) into `ClipWord[]` on the
// SOURCE clock `t` — whisper output is already relative to the source, so no
// offset math happens here. The document lands at `clips/transcript.json`.
//
// `polishRanges` is the pure silence polish: every range is trimmed to its
// first/last word phoneme ± `marginSeconds` and split at interior gaps longer
// than `maxGapSeconds`; `runClipPolish` is the thin file layer that polishes
// `clips/candidates.json` into `clips/decisions-ready.json`.
//
// Everything here is free and offline: local whisper, no network, no paid
// commands. `polishRanges` is deterministic and side-effect free.
// ---------------------------------------------------------------------------

/** `clips/transcript.json`: word-level transcript on the source `t` clock. */
export interface TranscriptDocument {
  schemaVersion: 1;
  language: string | null;
  words: ClipWord[];
}

/** `clips/decisions-ready.json`: silence-polished ranges sealed to the source. */
export interface PolishedRangesDocument {
  schemaVersion: 1;
  /** SHA-256 of the source video the ranges were cut from. */
  sourceSha256: string;
  /** Polish backend that produced this document. */
  backend: string;
  ranges: ClipRange[];
}

const DEFAULT_POLISH_MARGIN_SECONDS = 0.2;
const DEFAULT_POLISH_MAX_GAP_SECONDS = 2;

/**
 * Runs the local whisper CLI on one source video (word timestamps on) and
 * writes its normalized transcript to `clips/transcript.json`. The source
 * defaults to `<projectDir>/clips/source.mp4`; `whisperBin` selects the binary
 * and `language` is forwarded to whisper and used when detection is missing.
 * Never invents words: a nonzero exit or unparseable whisper output throws an
 * actionable error, and a valid output without words yields `words: []`.
 */
export async function transcribeToTranscript(
  process: ProcessRunner,
  projectDir: string,
  options?: { language?: string; whisperBin?: string; sourcePath?: string },
): Promise<TranscriptDocument> {
  if (typeof projectDir !== 'string' || projectDir.trim() === '') {
    throw new Error('transcribeToTranscript: projectDir must be a non-empty path.');
  }
  const srcPath = options?.sourcePath ?? join(projectDir, 'clips', 'source.mp4');
  if (typeof srcPath !== 'string' || srcPath.trim() === '') {
    throw new Error('transcribeToTranscript: sourcePath must be a non-empty local file path.');
  }
  const clipsDir = join(projectDir, 'clips');
  // whisper dumps `<basename>.json` into `--output_dir`; a dedicated directory
  // keeps it from overwriting `clips/source.json` (the probe manifest).
  const whisperDir = join(clipsDir, 'whisper');
  await mkdir(whisperDir, { recursive: true });
  const args = [
    srcPath,
    '--model',
    'base',
    '--output_format',
    'json',
    '--word_timestamps',
    'True',
    '--output_dir',
    whisperDir,
  ];
  if (options?.language !== undefined) {
    args.push('--language', options.language);
  }
  const result = await process.run(options?.whisperBin ?? 'whisper', args);
  if (result.code !== 0) {
    throw new Error(
      `whisper failed for ${srcPath} (exit ${result.code}): ${result.stderr.slice(-300)}`,
    );
  }
  const outputJsonPath = join(whisperDir, `${basename(srcPath, extname(srcPath))}.json`);
  let rawText: string | null = null;
  try {
    rawText = await readFile(outputJsonPath, 'utf8');
  } catch {
    rawText = null;
  }
  // Fallback for whisper builds that print the JSON document to stdout instead
  // of writing the output file.
  if (rawText === null) rawText = result.stdout;
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (cause) {
    throw new Error(
      `whisper produced no parseable JSON for ${srcPath} (expected ${outputJsonPath}): ` +
        'refusing to invent words.',
      { cause },
    );
  }
  if (!isRecord(raw) || !Array.isArray(raw.segments)) {
    throw new Error(
      `whisper output for ${srcPath} has no "segments" array — refusing to invent words.`,
    );
  }
  const words: ClipWord[] = [];
  raw.segments.forEach((segment, index) => {
    if (!isRecord(segment)) {
      throw new Error(`whisper output for ${srcPath}: segments[${index}] must be an object.`);
    }
    const rawWords = segment.words;
    if (rawWords === undefined || rawWords === null) return;
    if (!Array.isArray(rawWords)) {
      throw new Error(`whisper output for ${srcPath}: segments[${index}].words must be an array.`);
    }
    for (const rawWord of rawWords) {
      if (
        !isRecord(rawWord) ||
        typeof rawWord.word !== 'string' ||
        typeof rawWord.start !== 'number' ||
        !Number.isFinite(rawWord.start) ||
        typeof rawWord.end !== 'number' ||
        !Number.isFinite(rawWord.end) ||
        rawWord.end < rawWord.start
      ) {
        throw new Error(
          `whisper output for ${srcPath}: segments[${index}] has a malformed word entry ` +
            '(word/start/end) — refusing to invent words.',
        );
      }
      // whisper timestamps already sit on the source clock: copied unchanged.
      words.push({ word: rawWord.word, start: rawWord.start, end: rawWord.end });
    }
  });
  const detected =
    typeof raw.language === 'string' && raw.language.trim() !== '' ? raw.language : null;
  const document: TranscriptDocument = {
    schemaVersion: 1,
    language: detected ?? options?.language ?? null,
    words,
  };
  await writeFile(join(clipsDir, 'transcript.json'), `${JSON.stringify(document, null, 2)}\n`);
  return document;
}

/** Part-id suffix: `''`, `-b`, `-c`, … `-z`, `-aa`, … (bijective base-26). */
function polishPartSuffix(partIndex: number): string {
  let n = partIndex + 1;
  let letters = '';
  while (n > 0) {
    n -= 1;
    letters = String.fromCharCode(97 + (n % 26)) + letters;
    n = Math.floor(n / 26);
  }
  return `-${letters}`;
}

/**
 * Pure silence polish over candidate ranges. Every range is trimmed to its
 * first/last word phoneme ± `marginSeconds` (default 0.2) clamped to the
 * parent bounds; words outside the range are dropped. An interior gap between
 * consecutive words longer than `maxGapSeconds` (default 2.0) SPLITs the range
 * into parts at the gap: parts copy every parent field except `id/start/end`,
 * the first part keeps the parent id and later parts get `-b`, `-c`, … suffix
 * (slug-valid). Ranges with no words inside are removed entirely.
 * Deterministic: same input ⇒ identical output, inputs never mutated.
 */
export function polishRanges(
  ranges: ClipRange[],
  words: ClipWord[],
  options?: { marginSeconds?: number; maxGapSeconds?: number },
): ClipRange[] {
  const marginSeconds = options?.marginSeconds ?? DEFAULT_POLISH_MARGIN_SECONDS;
  const maxGapSeconds = options?.maxGapSeconds ?? DEFAULT_POLISH_MAX_GAP_SECONDS;
  if (!Number.isFinite(marginSeconds) || marginSeconds < 0) {
    throw new Error('polishRanges: marginSeconds must be a finite number >= 0.');
  }
  if (!Number.isFinite(maxGapSeconds) || maxGapSeconds <= 0) {
    throw new Error('polishRanges: maxGapSeconds must be a finite number > 0.');
  }
  words.forEach((word, index) => {
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end < word.start) {
      throw new Error(
        `polishRanges: words[${index}] has malformed times (start/end must be finite, end >= start).`,
      );
    }
  });
  const sortedWords = [...words].sort((a, b) => a.start - b.start || a.end - b.end);
  const polished: ClipRange[] = [];
  for (const range of ranges) {
    const inside = sortedWords.filter(
      (word) => word.end > range.start && word.start < range.end,
    );
    // A range without speech drops entirely (zero parts).
    if (inside.length === 0) continue;
    const groups: ClipWord[][] = [];
    for (const word of inside) {
      const group = groups[groups.length - 1];
      if (group !== undefined && word.start - group[group.length - 1].end <= maxGapSeconds) {
        group.push(word);
      } else {
        groups.push([word]);
      }
    }
    groups.forEach((group, partIndex) => {
      const first = group[0];
      const last = group[group.length - 1];
      const start = Math.max(range.start, first.start - marginSeconds);
      const end = Math.min(range.end, last.end + marginSeconds);
      // A part collapsing to zero length holds no audible speech.
      if (end <= start) return;
      polished.push({
        ...range,
        id: partIndex === 0 ? range.id : `${range.id}${polishPartSuffix(partIndex)}`,
        start,
        end,
      });
    });
  }
  return polished;
}

/** Reads one JSON document for `runClipPolish`, naming the fix on failure. */
async function readJsonDocument(path: string, hint: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    throw new Error(`runClipPolish: cannot read ${path} — ${hint}.`, { cause });
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(`runClipPolish: ${path} is not valid JSON — ${hint}.`, { cause });
  }
}

/**
 * Thin `clip-polish` runner: polishes `clips/candidates.json` (an array of
 * `ClipRange`) against `clips/transcript.json` and writes
 * `clips/decisions-ready.json` (`PolishedRangesDocument`, `backend` defaults to
 * `'omp'`). The source sha256 comes from the `clips/source.json` probe
 * manifest. Every missing input throws an actionable error naming the command
 * that produces it.
 */
export async function runClipPolish(
  projectDir: string,
  options?: { marginSeconds?: number; maxGapSeconds?: number; backend?: string },
): Promise<PolishedRangesDocument> {
  if (typeof projectDir !== 'string' || projectDir.trim() === '') {
    throw new Error('runClipPolish: projectDir must be a non-empty path.');
  }
  const clipsDir = join(projectDir, 'clips');
  const candidatesPath = join(clipsDir, 'candidates.json');
  const transcriptPath = join(clipsDir, 'transcript.json');
  const sourcePath = join(clipsDir, 'source.json');

  const candidatesDoc = await readJsonDocument(candidatesPath, 'run `clip-ranges` first');
  let candidateItems: unknown[];
  if (Array.isArray(candidatesDoc)) {
    candidateItems = candidatesDoc;
  } else if (isRecord(candidatesDoc) && Array.isArray(candidatesDoc.ranges)) {
    candidateItems = candidatesDoc.ranges;
  } else {
    throw new Error(
      `runClipPolish: ${candidatesPath} must be a JSON array of ClipRange ` +
        '(or an object with a "ranges" array) — run `clip-ranges` first.',
    );
  }
  // Minimal per-entry validation (id/start/end): extra candidate fields
  // (journaling, revisions, …) pass through untouched, so no strict parse.
  const candidates = candidateItems.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      typeof entry.start !== 'number' ||
      !Number.isFinite(entry.start) ||
      typeof entry.end !== 'number' ||
      !Number.isFinite(entry.end)
    ) {
      throw new Error(
        `runClipPolish: ${candidatesPath}[${index}] is not a ClipRange ` +
          '(id/start/end must be present) — run `clip-ranges` first.',
      );
    }
    // Shape (id/start/end) validated above; score/social/etc. ride along.
    const range = entry as ClipRange;
    return range;
  });

  const transcriptDoc = await readJsonDocument(transcriptPath, 'run `clip-transcribe` first');
  if (!isRecord(transcriptDoc) || !Array.isArray(transcriptDoc.words)) {
    throw new Error(
      `runClipPolish: ${transcriptPath} must contain a "words" array — run \`clip-transcribe\` first.`,
    );
  }
  const words = transcriptDoc.words.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.word !== 'string' ||
      typeof entry.start !== 'number' ||
      !Number.isFinite(entry.start) ||
      typeof entry.end !== 'number' ||
      !Number.isFinite(entry.end)
    ) {
      throw new Error(
        `runClipPolish: ${transcriptPath} words[${index}] is malformed (word/start/end) — ` +
          'run `clip-transcribe` first.',
      );
    }
    // Shape (word/start/end) validated above; times are rechecked by polishRanges.
    const word: ClipWord = { word: entry.word, start: entry.start, end: entry.end };
    return word;
  });

  const sourceDoc = await readJsonDocument(sourcePath, 'run `clip-frames` first');
  if (!isRecord(sourceDoc) || typeof sourceDoc.sha256 !== 'string' || sourceDoc.sha256 === '') {
    throw new Error(
      `runClipPolish: ${sourcePath} has no "sha256" — run \`clip-frames\` first.`,
    );
  }
  const sourceSha256 = sourceDoc.sha256;
  const backend = options?.backend ?? 'omp';
  if (backend.trim() === '') {
    throw new Error('runClipPolish: backend must be a non-empty string.');
  }

  const document: PolishedRangesDocument = {
    schemaVersion: 1,
    sourceSha256,
    backend,
    ranges: polishRanges(candidates, words, {
      marginSeconds: options?.marginSeconds,
      maxGapSeconds: options?.maxGapSeconds,
    }),
  };
  await writeFile(
    join(clipsDir, 'decisions-ready.json'),
    `${JSON.stringify(document, null, 2)}\n`,
  );
  return document;
}

// ---------------------------------------------------------------------------
// Part 4/4 — exact location tools and the read-only local dashboard
//
// The agent-facing side of the clip pipeline: canonical addressing of one
// frame (`resolveFrameAt`, `locateAt`), the labeled strip grid of a time
// window (`planStripGrid` + the thin ffmpeg `renderStripGrid`) and the local
// read-only dashboard (`renderClipsDashboard`, `buildClipCards`).
//
// Everything except `renderStripGrid` is pure: no filesystem, no ffmpeg, no
// network. The dashboard is one self-contained HTML string with inline CSS
// and zero external resource references (no CDN, no scripts, no actions);
// every user-controlled string is HTML-escaped. The agent fixes cuts by
// `frame_id` here and the CLI turns them into trim points.
// ---------------------------------------------------------------------------

/**
 * Canonical addressing for one exact frame: `at` is either a `frame_id`
 * (`f-<6 digits>`, exact match) or a `t` in seconds from the start of the
 * source (the frame with the NEAREST `t`; ties resolve to the lower `t`).
 * Numeric strings are accepted as `t` so CLI flags pass through unchanged.
 */
export function resolveFrameAt(frames: FrameEntry[], at: number | string): FrameEntry {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error(
      'resolveFrameAt: frames is empty — run `clip-frames` first to build clips/frames.json.',
    );
  }
  const atLabel = typeof at === 'string' ? JSON.stringify(at) : String(at);
  if (typeof at === 'string' && FRAME_ID_PATTERN.test(at)) {
    const exact = frames.find((frame) => frame.frame_id === at);
    if (!exact) {
      throw new Error(
        `resolveFrameAt: unknown frame_id "${at}" — not in the frames manifest ` +
          '(clips/frames.json). Run `clip-frames` first or pick an id it emitted.',
      );
    }
    return exact;
  }
  let t: number;
  if (typeof at === 'number') {
    t = at;
  } else {
    const trimmed = at.trim();
    t = trimmed === '' ? Number.NaN : Number(trimmed);
  }
  if (!Number.isFinite(t) || t < 0) {
    throw new Error(
      'resolveFrameAt: at must be a frame_id like "f-000042" or a non-negative finite ' +
        `number of seconds, got ${atLabel}.`,
    );
  }
  // Nearest `t` wins; an exact distance tie resolves to the lower `t`.
  return frames.reduce((best, frame) => {
    const distance = Math.abs(frame.t - t);
    const bestDistance = Math.abs(best.t - t);
    return distance < bestDistance || (distance === bestDistance && frame.t < best.t)
      ? frame
      : best;
  });
}

/** Exact frame plus its window: neighbors, transcript slice and analyses. */
export interface LocateResult {
  frame: FrameEntry;
  neighbors: FrameEntry[];
  words: ClipWord[];
  analyses: FrameAnalysis[];
}

/**
 * Pure location lookup: resolves `at` to one exact frame and collects its
 * window — neighbor frames within ±`neighborSeconds` (default 2, sorted by
 * `t`), the transcript words overlapping `[t − transcriptSeconds, t +
 * transcriptSeconds]` (default 10) and the `analyses` entries whose
 * `frame_id` is in the neighbor set.
 *
 * Round-trip invariant: `at = frame.t` and `at = frame.frame_id` resolve to
 * the same frame (and therefore the same window).
 */
export function locateAt(input: {
  frames: FrameEntry[];
  words: ClipWord[];
  analyses: FrameAnalysis[];
  at: number | string;
  neighborSeconds?: number;
  transcriptSeconds?: number;
}): LocateResult {
  const neighborSeconds = input.neighborSeconds ?? 2;
  const transcriptSeconds = input.transcriptSeconds ?? 10;
  if (!Number.isFinite(neighborSeconds) || neighborSeconds < 0) {
    throw new Error(
      `locateAt: neighborSeconds must be a non-negative finite number, got ${String(input.neighborSeconds)}.`,
    );
  }
  if (!Number.isFinite(transcriptSeconds) || transcriptSeconds < 0) {
    throw new Error(
      `locateAt: transcriptSeconds must be a non-negative finite number, got ${String(input.transcriptSeconds)}.`,
    );
  }
  const frame = resolveFrameAt(input.frames, input.at);
  const neighbors = input.frames
    .filter((candidate) => Math.abs(candidate.t - frame.t) <= neighborSeconds)
    .sort((a, b) => a.t - b.t);
  const windowStart = frame.t - transcriptSeconds;
  const windowEnd = frame.t + transcriptSeconds;
  const words = input.words.filter(
    (word) => word.end >= windowStart && word.start <= windowEnd,
  );
  const neighborIds = new Set(neighbors.map((neighbor) => neighbor.frame_id));
  const analyses = input.analyses.filter((analysis) => neighborIds.has(analysis.frame_id));
  return { frame, neighbors, words, analyses };
}

/** Layout of the labeled strip grid: row-major ids, labels carry `frame_id`. */
export interface StripPlan {
  columns: number;
  frameIds: string[];
  labelWith: 'frame_id';
}

/**
 * Pure strip-grid layout: the given frames in row-major order over `columns`
 * (default 4) tiles, each labeled with its `frame_id`. The input is copied,
 * never mutated; ids must be canonical (`f-<6 digits>`) so the labels can
 * never smuggle ffmpeg filter syntax.
 */
export function planStripGrid(frameIds: string[], columns = 4): StripPlan {
  if (!Array.isArray(frameIds) || frameIds.length === 0) {
    throw new Error(
      'planStripGrid: frameIds must be a non-empty array of frame ids like "f-000001".',
    );
  }
  if (!Number.isInteger(columns) || columns < 1) {
    throw new Error(`planStripGrid: columns must be a positive integer, got ${String(columns)}.`);
  }
  for (const frameId of frameIds) {
    if (typeof frameId !== 'string' || !FRAME_ID_PATTERN.test(frameId)) {
      throw new Error(
        `planStripGrid: ${JSON.stringify(frameId)} is not a canonical frame id ` +
          '(expected f-<6 digits>, e.g. "f-000001").',
      );
    }
  }
  return { columns, frameIds: [...frameIds], labelWith: 'frame_id' };
}

/**
 * Thin `clip-strip` runner: composes the labeled tile grid of `frameIds`
 * (frames extracted by `clip-frames` at `clips/frames/<frame_id>.jpg`) into
 * `clips/strips/<from>-<to>.jpg` with one ffmpeg call — each frame is
 * thumbnailed and `drawtext`-labeled with its `frame_id` per `planStripGrid`,
 * then concatenated into a `tile` grid. Returns the output path; a nonzero
 * exit throws an actionable error naming the window and the frames.
 */
export async function renderStripGrid(
  process: ProcessRunner,
  projectDir: string,
  input: { from: number; to: number; frameIds: string[]; columns?: number },
): Promise<string> {
  if (typeof projectDir !== 'string' || projectDir.trim() === '') {
    throw new Error('renderStripGrid: projectDir must be a non-empty path.');
  }
  if (!Number.isFinite(input.from) || !Number.isFinite(input.to) || input.from > input.to) {
    throw new Error(
      'renderStripGrid: from/to must be finite seconds with from <= to, ' +
        `got from=${String(input.from)} to=${String(input.to)}.`,
    );
  }
  const plan = planStripGrid(input.frameIds, input.columns);
  const rows = Math.ceil(plan.frameIds.length / plan.columns);
  const labeledInputs = plan.frameIds.flatMap((frameId) => [
    '-i',
    join(projectDir, PROJECT_FRAMES_DIR, `${frameId}.jpg`),
  ]);
  const labels = plan.frameIds
    .map(
      (frameId, index) =>
        `[${index}:v]scale=270:-2,drawtext=text='${frameId}':fontsize=24:fontcolor=white:` +
        `box=1:boxcolor=black@0.6:x=8:y=8[l${index}]`,
    )
    .join(';');
  const chain = plan.frameIds.map((_, index) => `[l${index}]`).join('');
  const filter =
    `${labels};${chain}concat=n=${plan.frameIds.length}:v=1:a=0[tiles];` +
    `[tiles]tile=${plan.columns}x${rows}`;
  const output = join(projectDir, 'clips', 'strips', `${input.from}-${input.to}.jpg`);
  await mkdir(join(projectDir, 'clips', 'strips'), { recursive: true });
  const result = await process.run('ffmpeg', [
    '-y',
    ...labeledInputs,
    '-filter_complex',
    filter,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    output,
  ]);
  if (result.code !== 0) {
    throw new Error(
      `renderStripGrid: ffmpeg failed building ${output} from ${plan.frameIds.length} frames ` +
        `(${plan.frameIds.join(', ')}): ${result.stderr.slice(-300)}`,
    );
  }
  return output;
}

/** One clip card of the read-only dashboard. */
export interface ClipDashboardCard {
  id: string;
  title: string;
  description: string;
  hashtags: string[];
  score: number;
  layout: 'single' | 'duo';
  status: 'candidate' | 'approved' | 'rejected';
  start: number;
  end: number;
  frameIds: string[];
  stillPath?: string;
  /** Dashboard-relative path of the rendered clip (player only when set). */
  videoPath?: string;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Standalone read-only dashboard HTML (`clips/dashboard/index.html`): a GRID of
 * compact clip cards (many per row) with a sticky filter toolbar (status,
 * layout, only-rendered, ordering) implemented in CSS ONLY via `:has()` +
 * radio/checkbox state, so the page keeps its contract: pure and offline,
 * inline CSS, zero external resource references and no scripts at all. Every
 * user-controlled string is HTML-escaped. Rendered clips sort first (they are
 * the work under review); the default chip shows the approved set.
 */
export function renderClipsDashboard(input: {
  cards: ClipDashboardCard[];
  header?: string;
}): string {
  const header = input.header ?? 'Clip dashboard';
  // Rendered clips first (those are the ones to review, newest work on top),
  // then approved, then the rest by score. The filter chips sort again by
  // score/time through the CSS `order` property.
  const ordered = [...input.cards].sort((a, b) => {
    const rank = (card: ClipDashboardCard): number =>
      card.videoPath ? 0 : card.status === 'approved' ? 1 : 2;
    return rank(a) - rank(b) || b.score - a.score;
  });
  const approvedCount = input.cards.filter((card) => card.status === 'approved').length;
  const withVideoCount = input.cards.filter((card) => card.videoPath !== undefined).length;
  const cards = ordered
    .map((card) => {
      // The dashboard lives at `clips/dashboard/index.html` and renders land at
      // `renders/clips/<id>.mp4`: callers pass the relative `videoPath` for
      // clips that EXIST (approved + rendered). Cards without one show the
      // still — a player pointing at a 404 is worse than a poster.
      const media = card.videoPath
        ? `<video controls preload="none" src="${escapeHtml(card.videoPath)}"` +
          `${card.stillPath ? ` poster="${escapeHtml(card.stillPath)}"` : ''}></video>`
        : card.stillPath
          ? `<img loading="lazy" src="${escapeHtml(card.stillPath)}" alt="still ${escapeHtml(card.id)}">`
          : '';
      const hashtags = card.hashtags
        .map((hashtag) => `<li>#${escapeHtml(hashtag.replace(/^#+/, ''))}</li>`)
        .join('');
      return `<article class="card" data-status="${escapeHtml(card.status)}" data-layout="${escapeHtml(card.layout)}" data-video="${card.videoPath ? '1' : '0'}" style="--o-score:${Math.round(-card.score * 100000)};--o-time:${Math.round(card.start)}">
<h2>${escapeHtml(card.title)}</h2>
<p class="meta">id ${escapeHtml(card.id)} · <span class="status">${escapeHtml(card.status)}</span> ·
layout ${escapeHtml(card.layout)} · score ${escapeHtml(String(card.score))} ·
${escapeHtml(String(card.start))}s to ${escapeHtml(String(card.end))}s</p>
${media}
<p class="description">${escapeHtml(card.description)}</p>
<ul class="hashtags">${hashtags}</ul>
</article>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(header)}</title>
<style>*{box-sizing:border-box}
body{font-family:system-ui,sans-serif;max-width:1700px;margin:auto;padding:12px 16px;background:#111;color:#eee}
h1{font-size:1.15rem;margin:0 0 2px}.sub{color:#888;font-size:.8em;margin:0 0 8px}
.filters{position:sticky;top:0;z-index:3;background:#111;display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 0 10px;border-bottom:1px solid #333;margin-bottom:12px}
.filters .lbl{color:#777;font-size:.75em;margin:0 2px}
.chip{display:inline-flex;align-items:center;border:1px solid #3a3a3a;border-radius:999px;padding:2px 10px;font-size:.78em;color:#bbb;cursor:pointer;background:#191919}
.chip input{position:absolute;opacity:0;width:0;height:0}
.chip:has(input:checked){border-color:#9cf;color:#9cf;background:#12202b}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px;align-items:start}
.card{border:1px solid #444;border-radius:12px;padding:10px;background:#1a1a1a;min-width:0}
.card h2{font-size:.9rem;margin:0 0 2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.meta{color:#aaa;font-size:.7em;margin:0 0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.status{color:#9cf}
video,img{display:block;margin:8px auto;width:auto;height:auto;max-width:100%;max-height:240px;aspect-ratio:9/16;object-fit:cover;background:#000;border-radius:8px}
.description{font-size:.78em;color:#ccc;margin:6px 0 2px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.hashtags{list-style:none;padding-left:0;margin:4px 0 0;color:#9cf;font-size:.72em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hashtags li{display:inline;margin:0 5px 0 0}
.empty{color:#888}
/* CSS-only filters (no scripts): radio/checkbox state read through :has(). */
body:has(#st-approved:checked) .card:not([data-status=approved]){display:none}
body:has(#st-rejected:checked) .card:not([data-status=rejected]){display:none}
body:has(#st-candidate:checked) .card:not([data-status=candidate]){display:none}
body:has(#ly-duo:checked) .card:not([data-layout=duo]){display:none}
body:has(#ly-single:checked) .card:not([data-layout=single]){display:none}
body:has(#only-render:checked) .card:not([data-video="1"]){display:none}
body:has(#sort-score:checked) .card{order:var(--o-score)}
body:has(#sort-time:checked) .card{order:var(--o-time)}</style>
</head><body>
<h1>${escapeHtml(header)}</h1>
<p class="sub">${input.cards.length} clips · ${approvedCount} approved · ${withVideoCount} rendered · read-only</p>
<div class="filters">
<span class="lbl">Ver:</span>
<label class="chip"><input type="radio" name="st" id="st-all"><span>Todos</span></label>
<label class="chip"><input type="radio" name="st" id="st-approved" checked><span>Aprobados</span></label>
<label class="chip"><input type="radio" name="st" id="st-rejected"><span>Rechazados</span></label>
<label class="chip"><input type="radio" name="st" id="st-candidate"><span>Candidatos</span></label>
<span class="lbl">tipo:</span>
<label class="chip"><input type="radio" name="ly" id="ly-all" checked><span>Ambos</span></label>
<label class="chip"><input type="radio" name="ly" id="ly-duo"><span>Dúo</span></label>
<label class="chip"><input type="radio" name="ly" id="ly-single"><span>Single</span></label>
<label class="chip"><input type="checkbox" id="only-render"><span>Solo con render</span></label>
<span class="lbl">orden:</span>
<label class="chip"><input type="radio" name="so" id="so-default" checked><span>Por defecto</span></label>
<label class="chip"><input type="radio" name="so" id="sort-score"><span>Score ↓</span></label>
<label class="chip"><input type="radio" name="so" id="sort-time"><span>Inicio ↑</span></label>
</div>
<div class="grid">
${cards || '<p class="empty">No clips yet.</p>'}
</div>
</body></html>`;
}

/**
 * Pure dashboard cards from the candidate ranges: `status` comes from the
 * decisions over the same ranges (keyed by `range.id`), defaulting to
 * `candidate`; `frameIds` come from `frameIdsByRange` (default `[]`). Array
 * fields are copied so the dashboard can never mutate pipeline documents.
 */
export function buildClipCards(
  candidates: ClipRange[],
  decisions: Array<{ range: ClipRange; status: 'approved' | 'rejected' }>,
  frameIdsByRange: Record<string, string[]>,
): ClipDashboardCard[] {
  return candidates.map((range) => {
    const rawIds = frameIdsByRange[range.id];
    const decision = decisions.find((entry) => entry.range.id === range.id);
    return {
      id: range.id,
      title: range.social.title,
      description: range.social.description,
      hashtags: [...range.social.hashtags],
      score: range.score,
      layout: range.layout,
      status: decision ? decision.status : 'candidate',
      start: range.start,
      end: range.end,
      frameIds: Array.isArray(rawIds) ? [...rawIds] : [],
    };
  });
}

// ---------------------------------------------------------------------------
// Part 5/5 (render support: trim + FilmProps)
//
// The two per-range building blocks `clip-render` needs, extracted from
// `specs/clip.ts` so the spec keeps orchestration only:
//
// - `trimClipMedia`: the EXACT ffmpeg trim of `clips/source.mp4` over
//   `[start, end]` (`-ss start` + `-t end - start`, full h264/yuv420p
//   re-encode at 30 fps — never a keyframe-snapping stream copy) plus the
//   trim's audio extracted to `clips/trimmed/<id>.wav`. The trimmed video is
//   VIDEO-ONLY: the trim's audio reaches the render EXACTLY ONCE through the
//   staged WAV as `scene.audioSrc` (which `Film` plays exactly once per
//   scene), so nothing can ever double it.
// - `buildClipFilmProps`: the one-scene `FilmProps` (1080×1920 @ 30 fps)
//   composed via `buildFilmProps` (the `runAssemble` composer) over a
//   synthesized clip scene, then carrying the clip-only fields: `source:
//   'clip'`, `layout`, `faces`, `mediaSrc` and the camera `track` whose
//   interactions are `framesToInteractions` over the analysis frames of the
//   range with `t` REBASED to the clip before quantization.
//
// Staging into the composition public dir, the `RenderSeam` calls, the
// loudness gate and the qa report stay in `specs/clip.ts` (part 3/3).
// ---------------------------------------------------------------------------

/** The clip film canvas is pinned by the plan: 1080×1920 vertical @ 30 fps. */
export const CLIP_FILM_WIDTH = 1080;
export const CLIP_FILM_HEIGHT = 1920;
export const CLIP_FILM_FPS = 30;

/**
 * Frame-accurate video trim: input `-ss` seek plus output `-t` cap with a
 * full h264/yuv420p re-encode at 30 fps (a stream copy would snap the cut to
 * keyframes). `-an` keeps the trimmed video SILENT by construction: the
 * trim's audio reaches the final render exactly once through the staged WAV
 * (`scene.audioSrc`, played once by `Film`), and the clip scene layers render
 * their video muted — a second audio path could only ever double it.
 */
function buildClipTrimVideoArgs(input: {
  source: string;
  output: string;
  start: number;
  durationSeconds: number;
}): string[] {
  return [
    '-y',
    '-ss',
    String(input.start),
    '-i',
    input.source,
    '-t',
    String(input.durationSeconds),
    '-an',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(CLIP_FILM_FPS),
    input.output,
  ];
}

/**
 * The trim's audio over the same `[start, start + duration)` window,
 * extracted to PCM WAV — the ONE audio source of the clip film (`Film` plays
 * the scene's `audioSrc` exactly once; scenes render visuals only).
 */
function buildClipTrimAudioArgs(input: {
  source: string;
  output: string;
  start: number;
  durationSeconds: number;
}): string[] {
  return [
    '-y',
    '-ss',
    String(input.start),
    '-i',
    input.source,
    '-t',
    String(input.durationSeconds),
    '-vn',
    '-c:a',
    'pcm_s16le',
    input.output,
  ];
}

/** What `trimClipMedia` wrote under `clips/trimmed/` for one sealed range. */
export interface ClipTrimResult {
  /** Project-relative trimmed video (`clips/trimmed/<id>.mp4`) — staging's copy source. */
  videoRelative: string;
  /** Project-relative trim audio (`clips/trimmed/<id>.wav`) — staging's copy source. */
  audioRelative: string;
  /** The exact trimmed window in seconds (`range.end - range.start`). */
  durationSeconds: number;
}

/**
 * The exact-trim step of `clip-render` for one sealed range: creates
 * `clips/trimmed/`, runs the frame-accurate video trim and extracts the
 * trim's audio to WAV. Returns the project-relative artifacts (the paths the
 * staging step copies into the composition public dir) plus the exact
 * duration of the trimmed window. Staging itself stays with the caller.
 */
export async function trimClipMedia(input: {
  ffmpeg: FfmpegRunner;
  projectDir: string;
  range: ClipRange;
  sourceRelative: string;
}): Promise<ClipTrimResult> {
  const { ffmpeg, projectDir, range } = input;
  const durationSeconds = range.end - range.start;
  const videoRelative = `clips/trimmed/${range.id}.mp4`;
  const audioRelative = `clips/trimmed/${range.id}.wav`;
  const source = projectAbsolute(projectDir, input.sourceRelative);
  const videoOutput = projectAbsolute(projectDir, videoRelative);
  const audioOutput = projectAbsolute(projectDir, audioRelative);
  await mkdir(dirname(videoOutput), { recursive: true });
  const trim = await ffmpeg.run(
    buildClipTrimVideoArgs({
      source,
      output: videoOutput,
      start: range.start,
      durationSeconds,
    }),
  );
  if (trim.exitCode !== 0) {
    throw new Error(
      `clip-render: ffmpeg trim of ${range.id} failed (exit ${trim.exitCode}): ` +
        ffmpegStderrDetail(trim.stderr),
    );
  }
  const audio = await ffmpeg.run(
    buildClipTrimAudioArgs({
      source,
      output: audioOutput,
      start: range.start,
      durationSeconds,
    }),
  );
  if (audio.exitCode !== 0) {
    throw new Error(
      `clip-render: ffmpeg audio extraction of ${range.id} failed (exit ${audio.exitCode}): ` +
        ffmpegStderrDetail(audio.stderr),
    );
  }
  return { videoRelative, audioRelative, durationSeconds };
}

/** Facts one sealed range needs to compose its `FilmProps`. */
export interface ClipSceneFacts {
  range: ClipRange;
  /** Every validated `clips/analysis` frame (the track source). */
  analyses: readonly FrameAnalysis[];
  /** Whisper `word_timestamps` on the SOURCE clock (burned-in subtitles). */
  words: readonly ClipWord[];
  /** Intrinsic source frame size (crop math + track viewport). */
  sourceSize: { width: number; height: number };
  /** publicDir-relative staged video (staticFile target). */
  stagedVideoSrc: string;
  /** publicDir-relative staged audio (staticFile target). */
  stagedAudioSrc: string;
}

/**
 * The ONE-scene `FilmProps` of one sealed range, composed via `buildFilmProps`
 * (the `runAssemble` composer) over a synthesized clip scene on the pinned
 * 1080×1920 @ 30 fps canvas. The scene then carries the clip-only fields
 * `buildFilmProps` predates: `source: 'clip'`, `layout`, `faces`, the staged
 * `mediaSrc` and the camera `track` — whose interactions are
 * `framesToInteractions` over the analysis frames inside `[start, end]` with
 * `t` REBASED to the clip (`t - start`) BEFORE quantization, so camera beats
 * live on the clip clock, not the source clock.
 */
export function buildClipFilmProps(project: Project, facts: ClipSceneFacts): FilmProps {
  const clipSeconds = facts.range.end - facts.range.start;
  const sceneConfig: SceneConfig = {
    id: facts.range.id,
    intent: facts.range.layout === 'duo' ? 'clip-podcast' : 'clip-vertical',
    // `SceneConfig.source` predates `FilmSceneSource += 'clip'`; the value is
    // overridden to 'clip' on the FilmScene below (what the registry needs).
    source: 'motion',
    narration: '',
    status: 'active',
    durationHint: clipSeconds,
  };
  const props = buildFilmProps({
    project: {
      ...project,
      config: {
        ...project.config,
        resolution: { width: CLIP_FILM_WIDTH, height: CLIP_FILM_HEIGHT },
        fps: CLIP_FILM_FPS,
        scenes: [sceneConfig],
      },
    },
    audioByScene: new Map([
      [facts.range.id, { src: facts.stagedAudioSrc, durationSeconds: clipSeconds }],
    ]),
  });
  const scene = props.scenes[0];
  if (scene === undefined) {
    throw new Error(`clip-render: buildFilmProps composed no scene for ${facts.range.id}.`);
  }
  const viewport: Viewport = { width: facts.sourceSize.width, height: facts.sourceSize.height };
  const framesInRange = facts.analyses
    .filter((frame) => frame.t >= facts.range.start && frame.t <= facts.range.end)
    .map((frame) => ({ ...frame, t: frame.t - facts.range.start }));
  applyClipSceneFields(scene, facts, clipSeconds, viewport, framesInRange);
  return props;
}

/** Attaches the clip-only `FilmScene` fields the composer cannot know about. */
function applyClipSceneFields(
  scene: FilmScene,
  facts: ClipSceneFacts,
  clipSeconds: number,
  viewport: Viewport,
  framesInRange: FrameAnalysis[],
): void {
  scene.source = 'clip';
  scene.layout = facts.range.layout;
  scene.faces = facts.range.faces.map((face) => ({
    id: face.id,
    bbox: face.bbox,
    presence: face.presence,
  }));
  // Clip scenes pass `mediaSrc` straight to `OffthreadVideo` (no wrapping), so
  // it must be the URL the render's static server serves: the bundler copies
  // `publicDir` to `<bundle>/public/` and maps requests 1:1 onto the bundle
  // root (`staticFile('media/…')` therefore resolves to `/public/media/…` at
  // render time). `audioSrc` stays staticFile-relative because `Film` wraps it.
  scene.mediaSrc = `/public/${facts.stagedVideoSrc}`;
  scene.mediaDurationSeconds = clipSeconds;
  scene.mediaWidth = facts.sourceSize.width;
  scene.mediaHeight = facts.sourceSize.height;
  // Burned-in subtitles: whisper `word_timestamps` clipped to the clip window
  // and packed into phrases, REBASED to the clip clock (the plan: subs come
  // from `subtitle-words`, never from evenly-split narration text).
  scene.subtitleSegments = buildWordSegments(
    clipWordsToWindow(facts.words, facts.range.start, facts.range.end),
  ).map((segment) => ({
    text: segment.text,
    start: segment.start - facts.range.start,
    end: segment.end - facts.range.start,
  }));
  scene.track = {
    viewport,
    interactions: framesToInteractions(framesInRange, viewport, CLIP_FILM_FPS),
  };
}

// ---------------------------------------------------------------------------
// Part 6/6 — dense keyframes + window shards (the `--keys` pass)
//
// Two-level sampling from the plan: the first pass lays a sparse grid, and
// `--keys` densifies ONLY inside the proposed candidate windows (± margin) at
// `keyFps`, marking those frames `rol: 'key'` (vision-analyzed) and the rest
// `rol: 'base'` (context only). When proposals exist, shards become WINDOWS —
// the plan's unit of analysis (one window = one vision call) — ordered by the
// cheap transcript `preScore` so `--max-shards` always spends on the best
// windows first. Without proposals the block shards of part 1/4 stay valid.
// ---------------------------------------------------------------------------

/** Options of the pure dense-sampling step. */
export interface KeyFramesOptions {
  durationSeconds: number;
  fps: number;
  /** Frames already sampled by the first pass (re-marked, never dropped). */
  frames: FrameEntry[];
  /** Proposed candidate windows to densify (from `clips/proposals.json`). */
  windows: ProposedWindow[];
  /** Dense samples per second inside window bodies (default 1). */
  keyFps?: number;
  /** Seconds of context margin around each window body (default 5). */
  keyMargin?: number;
}

/**
 * Deterministic dense sample list: the existing frames PLUS one sample per
 * `1 / keyFps` seconds across every window `[start - keyMargin, end + keyMargin]`
 * (clamped to the source). The merged list is deduped by `t` (half-frame),
 * renumbered `f-<6 digits>` in `t` order and re-marked: `rol: 'key'` inside a
 * window BODY, `rol: 'base'` otherwise (margins and untouched regions).
 */
export function sampleKeyFrames(options: KeyFramesOptions): FrameEntry[] {
  const { durationSeconds, fps, frames, windows } = options;
  const keyFps = options.keyFps ?? 1;
  const keyMargin = options.keyMargin ?? 5;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(
      `sampleKeyFrames: durationSeconds must be a positive finite number, got ${durationSeconds}.`,
    );
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error(`sampleKeyFrames: fps must be a positive finite number, got ${fps}.`);
  }
  if (!Number.isFinite(keyFps) || keyFps <= 0) {
    throw new Error(`sampleKeyFrames: keyFps must be a positive finite number, got ${keyFps}.`);
  }
  if (!Number.isFinite(keyMargin) || keyMargin < 0) {
    throw new Error(`sampleKeyFrames: keyMargin must be a finite number >= 0, got ${keyMargin}.`);
  }
  const bodyRanges: Array<[number, number]> = [];
  const dense: number[] = [];
  for (const window of windows) {
    if (!Number.isFinite(window.start) || !Number.isFinite(window.end) || window.end <= window.start) {
      throw new Error(
        `sampleKeyFrames: window ${window.id} must have start < end (finite seconds), ` +
          `got start=${window.start}, end=${window.end}.`,
      );
    }
    bodyRanges.push([window.start, window.end]);
    const denseStart = Math.max(0, window.start - keyMargin);
    const denseEnd = Math.min(durationSeconds, window.end + keyMargin);
    const step = 1 / keyFps;
    // Aligned to the GLOBAL tick grid (multiples of 1/keyFps): overlapping
    // windows share exact sample times, so their union dedupes cleanly below
    // instead of interleaving differently-phased grids.
    const firstTick = Math.ceil(denseStart * keyFps - 1e-9) / keyFps;
    for (let t = firstTick; t < denseEnd; t += step) dense.push(t);
    if (denseEnd < durationSeconds) dense.push(Math.ceil(denseEnd * keyFps - 1e-9) / keyFps);
  }
  for (const frame of frames) {
    if (!Number.isFinite(frame.t) || frame.t < 0) {
      throw new Error(`sampleKeyFrames: frame ${frame.frame_id} has invalid t ${frame.t}.`);
    }
  }
  const candidates = [...frames.map((frame) => frame.t), ...dense];
  candidates.sort((a, b) => a - b);
  // Collapse near-duplicates within half a dense tick (or half a video frame):
  // overlapping windows would otherwise leave phase-shifted twins behind.
  const minGap = Math.max(0.5 / fps, 0.5 / keyFps);
  const times: number[] = [];
  for (const t of candidates) {
    if (t >= durationSeconds) continue;
    const last = times[times.length - 1];
    if (last === undefined || t - last >= minGap) times.push(t);
  }
  return times.map((t, index): FrameEntry => {
    const frame_id = `f-${String(index + 1).padStart(6, '0')}`;
    const inBody = bodyRanges.some(([start, end]) => t >= start && t <= end);
    return {
      frame_id,
      t,
      path: `${PROJECT_FRAMES_DIR}/${frame_id}.jpg`,
      rol: inBody ? 'key' : 'base',
    };
  });
}

/**
 * Window shards (the plan's analysis unit): one shard per proposed window that
 * covers at least one `key` frame. The shard's analyzable set is the window
 * body's key frames; `keyMargin` base frames around the body ride along as
 * `contextOnlyFrameIds`. Shards are ordered by the window `preScore` descending
 * (ties: `start` ascending) so `--max-shards` caps spend on the best windows
 * first. `shardSize` is `0`: window shards vary in size by construction.
 */
export function buildWindowShards(
  frames: FrameEntry[],
  windows: ProposedWindow[],
  options?: { keyMargin?: number },
): ShardsManifest {
  const keyMargin = options?.keyMargin ?? 5;
  if (!Number.isFinite(keyMargin) || keyMargin < 0) {
    throw new Error(`buildWindowShards: keyMargin must be a finite number >= 0, got ${keyMargin}.`);
  }
  const ordered = [...windows].sort(
    (a, b) => b.preScore - a.preScore || a.start - b.start || a.id.localeCompare(b.id),
  );
  const shards: ShardEntry[] = [];
  for (const window of ordered) {
    const denseStart = Math.max(0, window.start - keyMargin);
    const denseEnd = window.end + keyMargin;
    const body = frames.filter(
      (frame) => frame.rol === 'key' && frame.t >= window.start && frame.t <= window.end,
    );
    if (body.length === 0) continue;
    const bodyIds = new Set(body.map((frame) => frame.frame_id));
    const contextOnlyFrameIds = frames
      .filter(
        (frame) =>
          !bodyIds.has(frame.frame_id) && frame.t >= denseStart && frame.t <= denseEnd,
      )
      .map((frame) => frame.frame_id);
    shards.push({
      id: `shard-${String(shards.length + 1).padStart(3, '0')}`,
      frameIds: [...contextOnlyFrameIds, ...body.map((frame) => frame.frame_id)],
      contextOnlyFrameIds,
      prevSummary: '',
    });
  }
  return { schemaVersion: 1, shardSize: 0, shards };
}

/** Options of the `--keys` thin runner. */
export interface ClipKeysOptions {
  /** Proposed windows to densify (from `clips/proposals.json`). */
  windows: ProposedWindow[];
  /** Dense samples per second inside window bodies (default 1). */
  keyFps?: number;
  /** Seconds of context margin around each window body (default 5). */
  keyMargin?: number;
}

/**
 * Thin `clip-frames --keys` runner: densifies `clips/frames.json` inside the
 * proposed windows (extracting only the jpgs that do not exist yet), re-marks
 * frame roles and rewrites `clips/shards.json` as WINDOW shards.
 */
export async function runClipFramesKeys(
  process: ProcessRunner,
  projectDir: string,
  options: ClipKeysOptions,
): Promise<{ frames: FramesManifest; shards: ShardsManifest }> {
  const sourceRaw = await readFile(join(projectDir, 'clips', 'source.json'), 'utf8').catch(() => {
    throw new Error('runClipFramesKeys: clips/source.json is missing — run clip-frames first.');
  });
  const framesRaw = await readFile(join(projectDir, 'clips', 'frames.json'), 'utf8').catch(() => {
    throw new Error('runClipFramesKeys: clips/frames.json is missing — run clip-frames first.');
  });
  const source = JSON.parse(sourceRaw) as Record<string, unknown>;
  const existing = JSON.parse(framesRaw) as FramesManifest;
  const durationSeconds = Number(source.durationSeconds);
  const fps = Number(source.fps);
  const srcPath = String(source.path ?? '');
  if (!Number.isFinite(durationSeconds) || !Number.isFinite(fps) || srcPath === '') {
    throw new Error('runClipFramesKeys: clips/source.json has no usable duration/fps/path.');
  }
  const frames: FramesManifest = {
    schemaVersion: 1,
    frames: sampleKeyFrames({
      durationSeconds,
      fps,
      frames: existing.frames,
      windows: options.windows,
      keyFps: options.keyFps,
      keyMargin: options.keyMargin,
    }),
  };
  const shards = buildWindowShards(frames.frames, options.windows, {
    keyMargin: options.keyMargin,
  });
  await mkdir(join(projectDir, PROJECT_FRAMES_DIR), { recursive: true });
  for (const frame of frames.frames) {
    const output = join(projectDir, frame.path);
    if (existsSync(output)) continue;
    const result = await process.run('ffmpeg', [
      '-y',
      '-ss',
      String(frame.t),
      '-i',
      srcPath,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      output,
    ]);
    if (result.code !== 0) {
      throw new Error(
        `ffmpeg failed extracting ${frame.frame_id} (t=${frame.t}) from ${srcPath}: ` +
          result.stderr.slice(-300),
      );
    }
  }
  await writeFile(join(projectDir, 'clips', 'frames.json'), `${JSON.stringify(frames, null, 2)}\n`);
  await writeFile(join(projectDir, 'clips', 'shards.json'), `${JSON.stringify(shards, null, 2)}\n`);
  return { frames, shards };
}

// ---------------------------------------------------------------------------
// Part 7/7 — agent self-review (`clip-ranges --review`)
//
// The plan's two-pass auto-review: the same agent backend runs as CRITIC over
// the candidates (rubric: bounds, layout↔faces, real hook, complete social, no
// overlaps), the generator applies the fixes and journals every round in
// `revisions[]`. At most `REVIEW_MAX_ROUNDS` rounds; the deterministic checks
// below never coerce — invalid patches are ignored and recorded as such.
// ---------------------------------------------------------------------------

/** Suggested fix for one candidate from the critic. */
export interface CriticPatch {
  start?: number;
  end?: number;
  social?: ClipSocial;
  discard?: boolean;
}

/** One critic verdict per candidate id. */
export interface CriticVerdict {
  id: string;
  verdict: 'pass' | 'revise';
  issues?: string[];
  patch?: CriticPatch;
}

/** Critic response envelope (raw JSON text from `AgentRunner.decide`). */
export interface CriticResponse {
  verdicts: CriticVerdict[];
}

/** Hard cap of self-review rounds (plan: "máx 2 rondas"). */
export const REVIEW_MAX_ROUNDS = 2;

/** The plan rubric, as numbered questions for `AgentRunner.decide`. */
export const REVIEW_RUBRIC: AgentQuestion[] = [
  {
    id: 'bounds',
    prompt:
      'Bounds: every range must satisfy 0 <= start < end <= the source duration. ' +
      'Report violations and fix them with patch.start / patch.end.',
  },
  {
    id: 'layout-faces',
    prompt:
      'Layout vs faces: layout "duo" requires exactly 2 faces, "single" never forces a ' +
      'duo. Report inconsistencies as issues (never change layout or faces here).',
  },
  {
    id: 'hook',
    prompt:
      'Hook: the first seconds of each range must contain a real hook in the provided ' +
      'transcript slice. Ranges without one: move patch.start to the nearest hook or discard.',
  },
  {
    id: 'social',
    prompt:
      'Social copy: title, description and hashtags must be complete and match the ' +
      'objective. Fix weak copy with patch.social {title, description, hashtags[]}.',
  },
  {
    id: 'overlaps',
    prompt:
      'Overlaps: ranges must not overlap each other. Keep the higher-scoring one; adjust ' +
      'the weaker with patch.start / patch.end or discard it.',
  },
];

/** Response shape instructions prepended to the critic state. */
export const REVIEW_RESPONSE_CONTRACT =
  'Respond ONLY with JSON: {"verdicts":[{"id":"clip-01","verdict":"pass"|"revise",' +
  '"issues":["..."],"patch":{"start":1.2,"end":9.8,"discard":false,' +
  '"social":{"title":"...","description":"...","hashtags":["..."]}}}]}';

function criticIssue(message: string): never {
  throw new Error(
    `parseCriticResponse: ${message} — expected ${REVIEW_RESPONSE_CONTRACT}`,
  );
}

/**
 * Parses the critic's raw reply (plain JSON or a single markdown code fence).
 * Garbage is rejected with the expected contract — never coerced.
 */
export function parseCriticResponse(text: string): CriticResponse {
  let raw = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(raw);
  if (fenced !== null && fenced[1] !== undefined) raw = fenced[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return criticIssue('reply is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return criticIssue('reply is not a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.verdicts)) criticIssue('missing "verdicts" array');
  const verdicts: CriticVerdict[] = [];
  for (const item of record.verdicts as unknown[]) {
    if (typeof item !== 'object' || item === null) criticIssue('verdict entry is not an object');
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== 'string' || entry.id === '') {
      criticIssue('verdict entry needs a non-empty string "id"');
    }
    if (entry.verdict !== 'pass' && entry.verdict !== 'revise') {
      criticIssue(`verdict for ${entry.id} must be "pass" or "revise"`);
    }
    if (entry.issues !== undefined) {
      if (
        !Array.isArray(entry.issues) ||
        entry.issues.some((issue) => typeof issue !== 'string')
      ) {
        criticIssue(`verdict for ${entry.id} has non-string "issues"`);
      }
    }
    let patch: CriticPatch | undefined;
    if (entry.patch !== undefined) {
      if (typeof entry.patch !== 'object' || entry.patch === null) {
        criticIssue(`verdict for ${entry.id} has a non-object "patch"`);
      }
      const raw = entry.patch as Record<string, unknown>;
      patch = {};
      if (raw.start !== undefined) {
        if (typeof raw.start !== 'number') criticIssue(`patch.start for ${entry.id} must be a number`);
        patch.start = raw.start;
      }
      if (raw.end !== undefined) {
        if (typeof raw.end !== 'number') criticIssue(`patch.end for ${entry.id} must be a number`);
        patch.end = raw.end;
      }
      if (raw.discard !== undefined) {
        if (typeof raw.discard !== 'boolean') {
          criticIssue(`patch.discard for ${entry.id} must be a boolean`);
        }
        patch.discard = raw.discard;
      }
      if (raw.social !== undefined) {
        const social = ClipSocialSchema.safeParse(raw.social);
        if (!social.success) {
          criticIssue(`patch.social for ${entry.id} is not a valid ClipSocial`);
        }
        patch.social = social.data;
      }
    }
    verdicts.push({
      id: entry.id,
      verdict: entry.verdict,
      ...(Array.isArray(entry.issues) ? { issues: entry.issues as string[] } : {}),
      ...(patch !== undefined ? { patch } : {}),
    });
  }
  return { verdicts };
}

/**
 * Applies one review round (pure, deterministic, no coercion): valid patches
 * land, invalid ones are ignored and journaled as such, discards drop the
 * candidate and every surviving verdict appends a `revisions[]` entry. Inputs
 * are never mutated.
 */
export function applyCriticVerdicts(
  candidates: ClipRange[],
  verdicts: CriticVerdict[],
  round: number,
  limits?: { durationSeconds?: number },
): ClipRange[] {
  if (!Number.isInteger(round) || round < 1) {
    throw new Error(`applyCriticVerdicts: round must be a positive integer, got ${round}.`);
  }
  const verdictById = new Map<string, CriticVerdict>();
  for (const verdict of verdicts) verdictById.set(verdict.id, verdict);
  const kept: ClipRange[] = [];
  for (const candidate of candidates) {
    const verdict = verdictById.get(candidate.id);
    if (verdict === undefined) {
      kept.push({ ...candidate });
      continue;
    }
    const issues = [...(verdict.issues ?? [])];
    if (verdict.patch?.discard === true) continue;
    const next: ClipRange = { ...candidate };
    let changed = false;
    const patch = verdict.patch ?? {};
    if (patch.start !== undefined) {
      if (
        Number.isFinite(patch.start) &&
        patch.start >= 0 &&
        patch.start < next.end &&
        (limits?.durationSeconds === undefined || patch.start <= limits.durationSeconds)
      ) {
        next.start = patch.start;
        changed = true;
      } else {
        issues.push(`ignored invalid patch.start ${patch.start}`);
      }
    }
    if (patch.end !== undefined) {
      if (
        Number.isFinite(patch.end) &&
        patch.end > next.start &&
        (limits?.durationSeconds === undefined || patch.end <= limits.durationSeconds)
      ) {
        next.end = patch.end;
        changed = true;
      } else {
        issues.push(`ignored invalid patch.end ${patch.end}`);
      }
    }
    if (patch.social !== undefined) {
      const social = ClipSocialSchema.safeParse(patch.social);
      if (social.success) {
        next.social = social.data;
        changed = true;
      } else {
        issues.push('ignored invalid patch.social');
      }
    }
    const applied = verdict.verdict === 'pass' ? true : changed;
    next.revisions = [
      ...(candidate.revisions ?? []),
      { round, verdict: verdict.verdict, issues, applied },
    ];
    kept.push(next);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Context budget guards (long sources)
//
// A multi-hour source produces hundreds of candidate windows and thousands of
// transcript words. The MODEL must never receive all of it: its context would
// reject the request. Three hard guards keep every agent payload bounded:
//   - the critic sees only the TOP-`REVIEW_CANDIDATE_LIMIT` candidates by
//     score, in compact form, under a fixed character budget;
//   - each analysis shard's transcript slice is window-scoped AND char-capped;
//   - everything else the pipeline moves around stays local/offline.
// ---------------------------------------------------------------------------

/** Candidates the critic ever sees (best-first by score). */
export const REVIEW_CANDIDATE_LIMIT = 24;
/** Hard character budget of the critic state (contract line included). */
export const REVIEW_STATE_CHAR_BUDGET = 12_000;
/** Per-shard transcript slice sent to vision is capped at this many chars. */
export const ANALYZE_TRANSCRIPT_SLICE_CHARS = 1_200;

/** Compact candidate form the critic receives (never the full ClipRange). */
export interface CriticCandidateSummary {
  id: string;
  start: number;
  end: number;
  score: number;
  layout: 'single' | 'duo';
  faceCount: number;
  title: string;
  description?: string;
}

/**
 * The best `limit` candidates in compact form, sorted by score descending
 * (ties: earlier start first). Deterministic; inputs never mutated.
 */
export function compactCandidatesForReview(
  candidates: readonly ClipRange[],
  limit = REVIEW_CANDIDATE_LIMIT,
): CriticCandidateSummary[] {
  return [...candidates]
    .sort((a, b) => b.score - a.score || a.start - b.start || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, limit))
    .map((range) => ({
      id: range.id,
      start: range.start,
      end: range.end,
      score: range.score,
      layout: range.layout,
      faceCount: range.faces.length,
      title: range.social.title.slice(0, 120),
      description: range.social.description.slice(0, 160),
    }));
}

/**
 * Build the critic state within `REVIEW_STATE_CHAR_BUDGET`: best candidates
 * first in compact form; when over budget the descriptions go first, then the
 * list shrinks from the worst end. `reviewedIds` reports exactly what the
 * model will see (the rest of the candidates simply keeps its score).
 */
export function buildCriticState(input: {
  objective: string;
  sourceDurationSeconds?: number;
  candidates: readonly ClipRange[];
  limit?: number;
}): { state: string; reviewedIds: string[] } {
  const head = REVIEW_RESPONSE_CONTRACT;
  const budget = REVIEW_STATE_CHAR_BUDGET - head.length - 1;
  const envelope = {
    objective: input.objective.slice(0, 300),
    sourceDurationSeconds: input.sourceDurationSeconds ?? null,
  };
  let list: CriticCandidateSummary[] = compactCandidatesForReview(
    input.candidates,
    input.limit ?? REVIEW_CANDIDATE_LIMIT,
  );
  let payload = JSON.stringify({ ...envelope, candidates: list });
  if (payload.length > budget) {
    list = list.map((summary) => {
      const { description: _dropped, ...lean } = summary;
      return { ...lean, title: lean.title.slice(0, 60) };
    });
    payload = JSON.stringify({ ...envelope, candidates: list });
    while (payload.length > budget && list.length > 1) {
      list = list.slice(0, list.length - 1);
      payload = JSON.stringify({ ...envelope, candidates: list });
    }
  }
  return { state: `${head}\n${payload}`, reviewedIds: list.map((summary) => summary.id) };
}

/**
 * Cap a transcript slice at `maxChars`, cutting on a word boundary and marking
 * the truncation — the slice sent to the model is never the full transcript.
 */
export function truncateTranscriptSlice(
  text: string,
  maxChars = ANALYZE_TRANSCRIPT_SLICE_CHARS,
): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  const cut = head.lastIndexOf(' ');
  return `${(cut > maxChars / 2 ? head.slice(0, cut) : head).trimEnd()} …`;
}

/**
 * Greedy pick of the best `limit` NON-OVERLAPPING spans (input order = best
 * first): dense sources hatch dozens of near-identical windows around the
 * same hook, and analysing those would burn the shard budget on ONE moment.
 * Spans at least `minGapSeconds` apart pass together; when strict
 * non-overlap yields fewer than `limit` items the remaining slots are
 * backfilled from the skipped ones in order.
 */
export function selectDistinctSpans<T>(
  items: readonly T[],
  spanOf: (item: T) => { start: number; end: number },
  limit: number,
  options?: { minGapSeconds?: number },
): T[] {
  const minGap = options?.minGapSeconds ?? 5;
  const picked: Array<{ start: number; end: number }> = [];
  const chosen: T[] = [];
  const skipped: T[] = [];
  for (const item of items) {
    if (chosen.length >= limit) break;
    const span = spanOf(item);
    const clash = picked.some(
      (other) => span.start < other.end + minGap && other.start < span.end + minGap,
    );
    if (clash) {
      skipped.push(item);
      continue;
    }
    picked.push(span);
    chosen.push(item);
  }
  for (const item of skipped) {
    if (chosen.length >= limit) break;
    chosen.push(item);
  }
  return chosen;
}
