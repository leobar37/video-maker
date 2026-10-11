/**
 * `clip-cut` pipeline — the fast, ffmpeg-only vertical cut path.
 *
 * Complements the Remotion `clip-render` verb: this cuts plain 9:16 clips from
 * a local source without a bundle or a composition, and it is where the two
 * quality fixes over "cut from ASR timestamps alone" live:
 *
 *  1. Cut points are SNAPPED to measured silence (`silencedetect`), never taken
 *     straight from transcript timestamps (docs/creator-workflow.md rule).
 *     Silence is measured per window (±`pad` seconds), not over the whole file:
 *     a full-file silencedetect on a 70-minute source takes ~10 min, a window
 *     takes under a second.
 *  2. Loudness is normalized AT CUT TIME (−16 LUFS, ≤−1.5 dBTP, 48 kHz), so the
 *     artifact that reaches QA/publication is already publish-ready.
 *
 * Everything except `runClipCut` is pure and unit-tested without ffmpeg.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ProcessRunner } from '@videomaker/providers';

export interface SilenceInterval {
  startSec: number;
  endSec: number;
}

export type ClipLayout = 'blur' | 'crop';

export interface CutFilterOptions {
  layout: ClipLayout;
  width: number;
  height: number;
  /** Horizontal crop anchor for `crop`: 0 = left, 50 = center, 100 = right. */
  cropOffsetPercent?: number;
  blurSigma?: number;
  /** ASS subtitle file appended to the video chain (burn-in). */
  subtitlesPath?: string;
  hasAudio: boolean;
  targetLufs?: number;
  maxTruePeakDbtp?: number;
}

export interface CutFilter {
  filterComplex: string;
  maps: string[];
}

/**
 * Parses ffmpeg `silencedetect` stderr into intervals on the same clock as the
 * input it was measured on. An unmatched `silence_start` closes at `Infinity`
 * so a window whose tail is silent still snaps.
 */
export function parseSilenceDetect(text: string): SilenceInterval[] {
  const starts: number[] = [];
  const intervals: SilenceInterval[] = [];
  for (const line of text.split('\n')) {
    const start = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (start) {
      starts.push(Number(start[1]));
      continue;
    }
    const end = /silence_end:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (end && starts.length > 0) {
      intervals.push({ startSec: starts.shift() as number, endSec: Number(end[1]) });
    }
  }
  for (const open of starts) intervals.push({ startSec: open, endSec: Number.POSITIVE_INFINITY });
  return intervals.sort((a, b) => a.startSec - b.startSec);
}

function shifted(intervals: readonly SilenceInterval[], offsetSec: number): SilenceInterval[] {
  return intervals.map((interval) => ({
    startSec: interval.startSec + offsetSec,
    endSec: interval.endSec + offsetSec,
  }));
}

/**
 * Snaps a clip START to the silence where the previous speech stops: the clip
 * opens right before the speaker resumes, never mid-word. Falls back to the
 * requested time when no silence edge is within `maxShiftSec`.
 */
export function snapStartToSilence(
  targetSec: number,
  silences: readonly SilenceInterval[],
  maxShiftSec = 1.5,
): number {
  let best = targetSec;
  let bestDistance = maxShiftSec;
  for (const interval of silences) {
    const edge = Number.isFinite(interval.endSec) ? interval.endSec : interval.startSec;
    const distance = Math.abs(edge - targetSec);
    if (distance < bestDistance) {
      best = edge;
      bestDistance = distance;
    }
  }
  return Math.round(best * 1000) / 1000;
}

/**
 * Snaps a clip END to the silence where the final speech stops, so the closing
 * phrase is never clipped. Falls back to the requested time when no silence
 * edge is within `maxShiftSec`.
 */
export function snapEndToSilence(
  targetSec: number,
  silences: readonly SilenceInterval[],
  maxShiftSec = 1.5,
): number {
  let best = targetSec;
  let bestDistance = maxShiftSec;
  for (const interval of silences) {
    const distance = Math.abs(interval.startSec - targetSec);
    if (distance < bestDistance) {
      best = interval.startSec;
      bestDistance = distance;
    }
  }
  return Math.round(best * 1000) / 1000;
}

/**
 * Builds the video (+ optional loudness-normalized audio) filter chain.
 *
 * `blur` keeps every pixel of the 16:9 frame on a blurred backdrop (safe for
 * two-shots); `crop` fills the 9:16 frame and lets the caller anchor the
 * horizontal window, which reads far better on a phone for talking heads.
 */
export function buildCutFilter(options: CutFilterOptions): CutFilter {
  const { width, height, layout, hasAudio } = options;
  const subs = options.subtitlesPath ? `,subtitles=${escapeFilterPath(options.subtitlesPath)}` : '';
  const video =
    layout === 'crop'
      ? `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
        `crop=${width}:${height}:(in_w-${width})*${(options.cropOffsetPercent ?? 50) / 100}:0,` +
        `format=yuv420p${subs}[v]`
      : `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
        `crop=${width}:${height},boxblur=${options.blurSigma ?? 28}:2,` +
        'eq=brightness=-0.08:saturation=0.85[bg];' +
        `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg];` +
        `[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto,format=yuv420p${subs}[v]`;
  if (!hasAudio) return { filterComplex: video, maps: ['-map', '[v]'] };
  const loudness = `[0:a]loudnorm=I=${options.targetLufs ?? -16}:TP=${options.maxTruePeakDbtp ?? -2}:LRA=11[a]`;
  return {
    filterComplex: `${video};${loudness}`,
    maps: ['-map', '[v]', '-map', '[a]'],
  };
}

/**
 * Cover frame for a clip: the strongest reaction peak inside the window (that is
 * the moment that "lands"), else a position `fallbackFraction` into the clip.
 */
export function pickCoverTimeSec(
  startSec: number,
  endSec: number,
  peaks: readonly { peakSec: number; riseDb: number }[],
  fallbackFraction = 0.4,
): number {
  const inside = peaks.filter((p) => p.peakSec >= startSec + 2 && p.peakSec <= endSec - 2);
  if (inside.length === 0) {
    return Math.round((startSec + (endSec - startSec) * fallbackFraction) * 1000) / 1000;
  }
  const best = inside.reduce((a, b) => (b.riseDb > a.riseDb ? b : a));
  return Math.round(best.peakSec * 1000) / 1000;
}

export interface CutArgsOptions {
  source: string;
  out: string;
  startSec: number;
  durationSec: number;
  filter: CutFilter;
  preset?: string;
  crf?: number;
  fps?: number;
}

/** ffmpeg argv for one vertical clip. Pure so the wire is testable. */
export function buildCutArgs(options: CutArgsOptions): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    `${options.startSec}`,
    '-i',
    options.source,
    '-t',
    `${options.durationSec}`,
    '-filter_complex',
    options.filter.filterComplex,
    ...options.filter.maps,
    '-c:v',
    'libx264',
    '-preset',
    options.preset ?? 'veryfast',
    '-crf',
    `${options.crf ?? 20}`,
    '-r',
    `${options.fps ?? 30}`,
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-ar',
    '48000',
    '-movflags',
    '+faststart',
    options.out,
  ];
}

/** ffmpeg argv that measures silence inside one window of the source. */
export function buildSilenceArgs(
  source: string,
  startSec: number,
  durationSec: number,
  noiseDb = -32,
  minSilenceSec = 0.3,
): string[] {
  return [
    '-nostdin',
    '-hide_banner',
    '-ss',
    `${startSec}`,
    '-t',
    `${durationSec}`,
    '-i',
    source,
    '-af',
    `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`,
    '-f',
    'null',
    '-',
  ];
}


/** ffmpeg filter-graph escaping for a path argument (`\`, `:` and `'`). */
export function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/** `#RRGGBB` → ASS `&HAABBGGRR` (ASS stores colours as BGR). */
export function assColor(hex: string, alpha = '00'): string {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return `&H${alpha}FFFFFF`;
  const rgb = match[1] as string;
  const r = rgb.slice(0, 2);
  const g = rgb.slice(2, 4);
  const b = rgb.slice(4, 6);
  return `&H${alpha}${b}${g}${r}`.toUpperCase();
}

/** Seconds → ASS `H:MM:SS.cc`, relative to the clip. */
export function assTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const totalCs = Math.round(clamped * 100);
  const cs = totalCs % 100;
  const totalSec = (totalCs - cs) / 100;
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

export interface SubtitleWord {
  t: number;
  end: number;
  text: string;
}

export interface SubtitleOptions {
  startSec: number;
  endSec: number;
  width?: number;
  height?: number;
  maxWords?: number;
  maxChars?: number;
  fontSize?: number;
  maxGapSec?: number;
  textColor?: string;
  outlineColor?: string;
  marginV?: number;
  fontFamily?: string;
}

/** Groups clip words into one-to-`maxWords` cues on word budget, char budget or a pause. */
export function groupSubtitleCues(
  words: readonly SubtitleWord[],
  options: SubtitleOptions,
): { startSec: number; endSec: number; text: string }[] {
  const maxWords = options.maxWords ?? 4;
  const maxChars = options.maxChars ?? 28;
  const maxGap = options.maxGapSec ?? 0.6;
  const inside = words.filter((w) => w.end > options.startSec && w.t < options.endSec);
  const cues: { startSec: number; endSec: number; text: string }[] = [];
  let current: SubtitleWord[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    cues.push({
      startSec: current[0]!.t,
      endSec: current[current.length - 1]!.end,
      text: current.map((w) => w.text).join(' '),
    });
    current = [];
  };
  for (const word of inside) {
    const previous = current[current.length - 1];
    const chars = current.reduce((sum, w) => sum + w.text.length + 1, 0) + word.text.length;
    if (previous && (current.length >= maxWords || chars > maxChars || word.t - previous.end > maxGap)) {
      flush();
    }
    current.push(word);
  }
  flush();
  return cues;
}

/** Deterministic ASS document for one clip, with clip-relative timings. */
export function buildAssSubtitles(words: readonly SubtitleWord[], options: SubtitleOptions): string {
  const width = options.width ?? 1080;
  const height = options.height ?? 1920;
  const fontSize = options.fontSize ?? 58;
  const marginV = options.marginV ?? 420;
  const primary = assColor(options.textColor ?? '#FFFFFF');
  const outline = assColor(options.outlineColor ?? '#000000');
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${options.fontFamily ?? 'DejaVu Sans'},${fontSize},${primary},&H000000FF,${outline},&H80000000,-1,0,0,0,100,100,0,0,1,4,2,2,40,40,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const lines = groupSubtitleCues(words, options).map(
    (cue) =>
      `Dialogue: 0,${assTime(cue.startSec - options.startSec)},${assTime(Math.max(cue.endSec, cue.startSec + 0.2) - options.startSec)},Default,,0,0,0,,${cue.text.replace(/\r?\n/g, ' ')}`,
  );
  return `${[...header, ...lines].join('\n')}\n`;
}

export interface CutClipSpec {
  id: string;
  startSec: number;
  endSec: number;
}

export interface RunClipCutOptions {
  layout?: ClipLayout;
  width?: number;
  height?: number;
  cropOffsetPercent?: number;
  /** Extra seconds measured around each window when detecting silence. */
  padSec?: number;
  /** Hard cap on output duration. */
  maxDurationSec?: number;
  /** Reaction peaks used to pick the cover frame. */
  peaks?: readonly { peakSec: number; riseDb: number }[];
  /** Word timestamps (source clock) to burn in as captions. */
  words?: readonly SubtitleWord[];
  subtitles?: Omit<SubtitleOptions, 'startSec' | 'endSec'>;
  preset?: string;
  crf?: number;
  /** Clips rendered concurrently (default 1). ffmpeg is CPU-bound: 2-3 is sane. */
  jobs?: number;
}

export interface CutClipResult extends CutClipSpec {
  sourceStartSec: number;
  sourceEndSec: number;
  file: string;
  cover: string;
}

interface ProbeStream {
  codec_type?: string;
}

async function hasAudioStream(process: ProcessRunner, source: string): Promise<boolean> {
  const result = await process.run('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    source,
  ]);
  if (result.code !== 0) return false;
  try {
    const parsed = JSON.parse(result.stdout) as { streams?: ProbeStream[] };
    return (parsed.streams ?? []).some((stream) => stream.codec_type === 'audio');
  } catch {
    return false;
  }
}

async function measureWindowSilence(
  process: ProcessRunner,
  source: string,
  startSec: number,
  durationSec: number,
): Promise<SilenceInterval[]> {
  const result = await process.run('ffmpeg', buildSilenceArgs(source, startSec, durationSec));
  // ffmpeg exits 0 for `-f null`; silence lines go to stderr regardless.
  return shifted(parseSilenceDetect(result.stderr), startSec);
}

/** Runs `worker` over `items` with a bounded number of concurrent workers. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(Math.floor(limit) || 1, items.length)) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index] as T, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Cuts every clip in `clips` into `<projectDir>/renders/clips/`, snapping each
 * boundary to measured silence and normalizing loudness. Covers are extracted
 * at the strongest reaction peak (or 40 % into the clip).
 */
export async function runClipCut(
  process: ProcessRunner,
  projectDir: string,
  source: string,
  clips: readonly CutClipSpec[],
  options: RunClipCutOptions = {},
): Promise<CutClipResult[]> {
  const width = options.width ?? 1080;
  const height = options.height ?? 1920;
  const pad = options.padSec ?? 8;
  const maxDuration = options.maxDurationSec ?? 90;
  const outDir = join(projectDir, 'renders', 'clips');
  await mkdir(outDir, { recursive: true });
  const audio = await hasAudioStream(process, source);
  const results: CutClipResult[] = await mapWithLimit(clips, options.jobs ?? 1, async (clip) => {
    const silences = await measureWindowSilence(
      process,
      source,
      Math.max(0, clip.startSec - pad),
      clip.endSec - clip.startSec + pad * 2,
    );
    let start = snapStartToSilence(clip.startSec, silences);
    let end = snapEndToSilence(clip.endSec, silences);
    if (end - start > maxDuration) end = start + maxDuration;
    if (end - start < 5) {
      start = clip.startSec;
      end = clip.endSec;
    }
    let subtitlesPath: string | undefined;
    if (options.words && options.words.length > 0) {
      subtitlesPath = join(outDir, `${clip.id}.ass`);
      await writeFile(
        subtitlesPath,
        buildAssSubtitles(options.words, {
          width,
          height,
          startSec: start,
          endSec: end,
          ...options.subtitles,
        }),
      );
    }
    const filter = buildCutFilter({
      layout: options.layout ?? 'blur',
      width,
      height,
      cropOffsetPercent: options.cropOffsetPercent ?? 50,
      hasAudio: audio,
      ...(subtitlesPath ? { subtitlesPath } : {}),
    });
    const file = join(outDir, `${clip.id}.mp4`);
    const cut = await process.run(
      'ffmpeg',
      buildCutArgs({
        source,
        out: file,
        startSec: start,
        durationSec: end - start,
        filter,
        preset: options.preset ?? 'veryfast',
        crf: options.crf ?? 20,
      }),
    );
    if (cut.code !== 0) {
      throw new Error(`clip-cut failed for ${clip.id} (exit ${cut.code}): ${cut.stderr.slice(-300)}`);
    }
    const cover = join(outDir, `${clip.id}.png`);
    const coverTime = pickCoverTimeSec(start, end, options.peaks ?? []);
    const still = await process.run('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      `${coverTime}`,
      '-i',
      source,
      '-frames:v',
      '1',
      '-vf',
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      cover,
    ]);
    if (still.code !== 0) {
      throw new Error(`clip-cut cover failed for ${clip.id} (exit ${still.code})`);
    }
    return { ...clip, sourceStartSec: start, sourceEndSec: end, file, cover } satisfies CutClipResult;
  });
  return results;
}
