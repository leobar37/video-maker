import type { SubtitleWord } from './subtitle-words';

export interface WordCaptionOptions {
  maxWords?: number;
  maxChars?: number;
  /** Split phrases at pauses this long or longer, in seconds. Default: 0.35. */
  gapSeconds?: number;
}

export interface WordCaptionCue {
  readonly words: readonly SubtitleWord[];
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface WordCaptionSelection {
  readonly cue: WordCaptionCue;
  readonly cueIndex: number;
  /** -1 during a short pause inside a phrase: no word is highlighted. */
  readonly activeWordIndex: number;
}

/** Invalid positions use the central default; finite positions stay within the canvas. */
export function clampCaptionYPercent(value = 60): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 60;
}

/**
 * Build short, non-overlapping phrases in final-timeline seconds, without I/O.
 * Invalid/empty words are ignored; input is copied and sorted, never mutated.
 * Overlaps end at the next word's start (the last input wins for equal starts),
 * so at most one spoken word owns any instant. Exact duplicate records collapse.
 * A single over-budget token stays intact rather than truncating spoken text.
 * Pauses >= gapSeconds split cues; there is no hold after a cue's last word.
 * Editorial boundaries without a time gap must be supplied as separate lists.
 */
export function buildWordCaptions(
  words: readonly SubtitleWord[],
  options: WordCaptionOptions = {},
): WordCaptionCue[] {
  const maxWords = options.maxWords !== undefined
    && Number.isFinite(options.maxWords) && options.maxWords >= 1
    ? Math.floor(options.maxWords)
    : 4;
  const maxChars = options.maxChars !== undefined
    && Number.isFinite(options.maxChars) && options.maxChars >= 1
    ? Math.floor(options.maxChars)
    : 28;
  const gapSeconds = options.gapSeconds !== undefined
    && Number.isFinite(options.gapSeconds) && options.gapSeconds >= 0
    ? options.gapSeconds
    : 0.35;

  const sorted = words
    .filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end)
      && word.start >= 0 && word.end > word.start)
    .map((word) => ({ ...word, word: word.word.trim().replace(/\s+/g, ' ') }))
    .filter((word) => word.word.length > 0)
    .sort((a, b) => a.start - b.start);

  const normalized: SubtitleWord[] = [];
  for (let index = 0; index < sorted.length; index++) {
    const word = sorted[index]!;
    const next = sorted[index + 1];
    const end = next ? Math.min(word.end, next.start) : word.end;
    if (end > word.start) normalized.push({ ...word, end });
  }

  const cues: WordCaptionCue[] = [];
  let pending: SubtitleWord[] = [];
  let length = 0;
  const flush = () => {
    if (pending.length === 0) return;
    cues.push({
      words: pending,
      text: pending.map((word) => word.word).join(' '),
      start: pending[0]!.start,
      end: pending[pending.length - 1]!.end,
    });
    pending = [];
    length = 0;
  };

  for (const word of normalized) {
    const previous = pending[pending.length - 1];
    const candidateLength = length + (pending.length > 0 ? 1 : 0) + word.word.length;
    if (previous && (pending.length >= maxWords || candidateLength > maxChars
      || word.start - previous.end >= gapSeconds)) {
      flush();
    }
    length += (pending.length > 0 ? 1 : 0) + word.word.length;
    pending.push(word);
  }
  flush();
  return cues;
}

/** Half-open [start, end) selection; seeks and out-of-order renders are stateless. */
export function selectWordCaption(
  cues: readonly WordCaptionCue[],
  timeSeconds: number,
): WordCaptionSelection | null {
  if (!Number.isFinite(timeSeconds)) return null;

  // Cues built by buildWordCaptions are sorted and do not overlap.
  let low = 0;
  let high = cues.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const cue = cues[middle]!;
    if (timeSeconds < cue.start) {
      high = middle - 1;
    } else if (timeSeconds >= cue.end) {
      low = middle + 1;
    } else {
      return {
        cue,
        cueIndex: middle,
        activeWordIndex: cue.words.findIndex(
          (word) => timeSeconds >= word.start && timeSeconds < word.end,
        ),
      };
    }
  }
  return null;
}
