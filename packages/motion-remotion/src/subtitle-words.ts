/**
 * Word-level subtitle timing for clips, split out so it can be unit-tested
 * without pulling React/Remotion into the test runner.
 *
 * Whisper `word_timestamps` cover the whole source; a clip only owns a window
 * of them. `clipWordsToWindow` clips the transcript to that window and
 * `buildWordSegments` packs the surviving words into short burnable subtitle
 * segments. Pure text/time logic — no React, no ffmpeg, no I/O.
 */

/** One whisper word timestamp (`word_timestamps` entries). */
export interface SubtitleWord {
  word: string;
  /** Seconds from the start of the source. */
  start: number;
  /** Seconds from the start of the source. */
  end: number;
}

/**
 * Keep the words overlapping `[windowStart, windowEnd]`, with their `start`
 * and `end` clamped into the window. Words fully outside are dropped: a word
 * that merely touches a window edge has zero overlap inside it and belongs to
 * the neighbouring clip instead, so adjacent clips never share a word. Input
 * order is preserved. An empty word list or a non-positive-width window
 * (including `windowStart >= windowEnd`) yields `[]`.
 */
export function clipWordsToWindow(
  words: SubtitleWord[],
  windowStart: number,
  windowEnd: number,
): SubtitleWord[] {
  if (!(windowEnd > windowStart)) return [];

  const clipped: SubtitleWord[] = [];
  for (const word of words) {
    if (word.end <= windowStart || word.start >= windowEnd) continue;
    clipped.push({
      word: word.word,
      start: Math.max(word.start, windowStart),
      end: Math.min(word.end, windowEnd),
    });
  }
  return clipped;
}

/**
 * Pack words into subtitle segments of at most `maxChars` characters.
 *
 * Words are packed greedily and consecutively: a word joins the current
 * segment while the joined text (single spaces between words, trimmed) fits
 * the budget, otherwise the segment closes and a new one starts with that
 * word. A single word longer than `maxChars` cannot be split, so it stands
 * alone in an over-budget segment — truncating spoken words would be worse.
 * Each segment spans its own words: `start` is the first word's start and
 * `end` the last word's end, so segments follow word order and never overlap.
 * Words whose text is empty contribute nothing and are skipped.
 */
export function buildWordSegments(
  words: SubtitleWord[],
  maxChars = 30,
): Array<{ text: string; start: number; end: number }> {
  const segments: Array<{ text: string; start: number; end: number }> = [];
  let tokens: string[] = [];
  let start = 0;
  let end = 0;
  let length = 0;

  for (const word of words) {
    const token = word.word.trim().replace(/\s+/g, ' ');
    if (token.length === 0) continue;

    const candidate = tokens.length === 0 ? token.length : length + 1 + token.length;
    if (tokens.length > 0 && candidate > maxChars) {
      segments.push({ text: tokens.join(' '), start, end });
      tokens = [token];
      start = word.start;
      end = word.end;
      length = token.length;
      continue;
    }

    if (tokens.length === 0) start = word.start;
    tokens.push(token);
    end = word.end;
    length = candidate;
  }

  if (tokens.length > 0) segments.push({ text: tokens.join(' '), start, end });
  return segments;
}
