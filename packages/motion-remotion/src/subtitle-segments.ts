/**
 * Pure text logic for burned-in subtitles, split out from `Subtitles.tsx` so it
 * can be unit-tested without pulling React/Remotion into the test runner.
 *
 * The narration is broken into short phrases (on punctuation, then wrapped to
 * ~30 chars). `Subtitles` then gives each segment a time slice proportional to
 * its length across the real narration duration.
 */

// Longest a single subtitle line may be before it must wrap; phrases at or under
// this length go on screen whole.
export const MAX_SEGMENT_CHARS = 34;
// Greedy wrap target: a new line starts once adding a word would exceed this.
const WRAP_TARGET_CHARS = 30;
// A wrapped phrase must not end in a fragment shorter than this. A lone tail
// like "vendiste," reads as a mistake, and on a muted video the subtitle is the
// main channel — so we pull a word down from the previous line to heal it.
export const MIN_TAIL_CHARS = 12;
// Spanish function words that must not dangle at the END of a subtitle line:
// «…de lo / que puedes perder.» or «…hoy con / plata de mañana.» reads as a
// broken clause in mute: every line must stand on its own. Healing pulls such
// a word DOWN to the next line when it fits.
const WEAK_LINE_ENDINGS: Record<string, true> = {
  a: true,
  al: true,
  con: true,
  de: true,
  del: true,
  el: true,
  en: true,
  es: true,
  esa: true,
  ese: true,
  eso: true,
  esta: true,
  está: true,
  están: true,
  fue: true,
  ha: true,
  han: true,
  la: true,
  las: true,
  llevar: true,
  lo: true,
  los: true,
  más: true,
  // Negadores y partículas: una línea que cierra en «…Digitalizar no» o
  // «…pero si» deja el predicado colgado en la siguiente.
  ni: true,
  no: true,
  pero: true,
  si: true,
  sin: true,
  solo: true,
  tan: true,
  todo: true,
  toda: true,
  también: true,
  ya: true,
  o: true,
  para: true,
  por: true,
  puede: true,
  pueden: true,
  que: true,
  se: true,
  son: true,
  su: true,
  sus: true,
  tiene: true,
  tienen: true,
  un: true,
  una: true,
  y: true,
};

/**
 * Greedy-wrap one punctuation phrase, then rebalance weak trailing fragments
 * and dangling function words.
 *
 * The rebalances only fire when the greedy pass leaves an orphan tail or a
 * line ending in a function word. Moving a word down never reorders words and
 * never overflows a line, so phrases that already wrap cleanly come out
 * byte-for-byte identical — published videos keep their exact segmentation,
 * only broken clause boundaries change.
 */
function wrapPhrase(phrase: string): string[] {
  if (phrase.length <= MAX_SEGMENT_CHARS) return [phrase];

  const lines: string[] = [];
  let line = '';
  const words = phrase.split(/\s+/);
  for (const [index, word] of words.entries()) {
    // La ÚLTIMA palabra de la frase nunca queda sola en una línea: si cabe
    // dentro del máximo, la línea crece hasta ahí aunque pase el target
    // (una línea de una sola palabra es un fragmento sin sentido).
    const limit = index === words.length - 1 ? MAX_SEGMENT_CHARS : WRAP_TARGET_CHARS;
    if (`${line} ${word}`.trim().length > limit) {
      if (line) lines.push(line.trim());
      line = word;
    } else {
      line = `${line} ${word}`.trim();
    }
  }
  if (line) lines.push(line.trim());

  while (lines.length >= 2) {
    const last = lines[lines.length - 1]!;
    if (last.length >= MIN_TAIL_CHARS) break;
    const prevWords = lines[lines.length - 2]!.split(' ');
    if (prevWords.length < 2) break; // never empty the previous line
    const moved = prevWords.pop()!;
    const mergedTail = `${moved} ${last}`;
    if (mergedTail.length > MAX_SEGMENT_CHARS) break; // don't overflow a line
    lines[lines.length - 2] = prevWords.join(' ');
    lines[lines.length - 1] = mergedTail;
  }

  // Clause healing: no line (except the last) may end in a dangling function
  // word when pulling it down keeps the next line within MAX_SEGMENT_CHARS.
  // Bounded by total word count — each iteration moves one word down for good.
  for (let i = 0; i < lines.length - 1; i += 1) {
    for (;;) {
      const words = lines[i]!.split(' ');
      const lastWord = (words[words.length - 1] ?? '').toLowerCase();
      if (words.length < 2 || !(lastWord in WEAK_LINE_ENDINGS)) break;
      const moved = words.pop()!;
      const merged = `${moved} ${lines[i + 1]}`;
      if (merged.length > MAX_SEGMENT_CHARS) break; // would overflow next line
      lines[i] = words.join(' ');
      lines[i + 1] = merged;
    }
  }
  return lines;
}

export function buildSegments(text: string): string[] {
  const phrases = text
    .split(/(?<=[,:;.\u2026\u2014])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const segments: string[] = [];
  for (const phrase of phrases) segments.push(...wrapPhrase(phrase));
  return segments;
}

/** A phrase with its half-open frame window `[start, end)` inside the voice span. */
export interface TimedSegment {
  s: string;
  start: number;
  end: number;
}

/**
 * Spread `text`'s segments over `spanFrames` proportional to their length.
 * Consecutive windows are contiguous (`t[i].end === t[i + 1].start`) and
 * half-open, so every frame in the span belongs to EXACTLY one segment — two
 * phrases can never claim the same frame and co-render.
 */
export function buildTimedSegments(text: string, spanFrames: number): TimedSegment[] {
  const segments = buildSegments(text);
  const totalChars = segments.reduce((n, s) => n + s.length, 0) || 1;
  let acc = 0;
  return segments.map((s) => {
    const start = (acc / totalChars) * spanFrames;
    acc += s.length;
    const end = (acc / totalChars) * spanFrames;
    return { s, start, end };
  });
}

/**
 * The ONE segment whose window contains `frame` (never two: windows tile the
 * span without overlap). After the voice ends, the last phrase stays on
 * screen through the scene tail; before the voice starts, the first is shown.
 */
export function activeSegmentAt(
  timed: readonly TimedSegment[],
  frame: number,
): TimedSegment | null {
  if (!timed.length) return null;
  const active = timed.find((t) => frame >= t.start && frame < t.end);
  if (active) return active;
  return frame >= timed[timed.length - 1]!.end ? timed[timed.length - 1]! : timed[0]!;
}
