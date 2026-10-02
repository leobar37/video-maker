import { describe, expect, test } from 'bun:test';

import type { SubtitleWord } from './subtitle-words';
import { buildWordCaptions, clampCaptionYPercent, selectWordCaption } from './word-captions';

describe('buildWordCaptions', () => {
  test('empty input and whitespace produce no cues', () => {
    expect(buildWordCaptions([])).toEqual([]);
    expect(buildWordCaptions([{ word: ' \n ', start: 0, end: 1 }])).toEqual([]);
  });

  test('defaults to four words per phrase and preserves every word exactly once', () => {
    const words = ['este', 'video', 'es', 'una', 'prueba', 'de', 'voz'].map((word, index) => ({
      word, start: index / 2, end: (index + 1) / 2,
    }));
    const cues = buildWordCaptions(words);
    expect(cues.map((cue) => cue.text)).toEqual(['este video es una', 'prueba de voz']);
    expect(cues.flatMap((cue) => cue.words)).toEqual(words);
    expect(cues.map(({ start, end }) => ({ start, end }))).toEqual([
      { start: 0, end: 2 }, { start: 2, end: 3.5 },
    ]);
  });

  test('default character budget is 28, including spaces', () => {
    const cues = buildWordCaptions([
      { word: 'abcdefghijklm', start: 0, end: 1 },
      { word: 'nopqrstuvwxyzx', start: 1, end: 2 },
      { word: 'fin', start: 2, end: 3 },
    ]);
    expect(cues.map((cue) => cue.text)).toEqual(['abcdefghijklm nopqrstuvwxyzx', 'fin']);
    expect(cues.every((cue) => cue.text.length <= 28)).toBe(true);
  });

  test('custom word and character limits include the exact boundary', () => {
    const words: SubtitleWord[] = [
      { word: 'aaaa', start: 0, end: 0.5 },
      { word: 'bbbb', start: 0.5, end: 1 },
      { word: 'cc', start: 1, end: 1.5 },
    ];
    expect(buildWordCaptions(words, { maxChars: 9 }).map((cue) => cue.text))
      .toEqual(['aaaa bbbb', 'cc']);
    expect(buildWordCaptions(words, { maxWords: 1 }).map((cue) => cue.text))
      .toEqual(['aaaa', 'bbbb', 'cc']);
    expect(buildWordCaptions(words, { maxWords: 2.9 }).map((cue) => cue.text))
      .toEqual(['aaaa bbbb', 'cc']);
  });

  test('does not truncate a token longer than the character budget', () => {
    const cues = buildWordCaptions([
      { word: 'supercalifragilistico', start: 0, end: 1 },
      { word: 'corto', start: 1, end: 2 },
    ], { maxChars: 10 });
    expect(cues.map((cue) => cue.text)).toEqual(['supercalifragilistico', 'corto']);
  });

  test('splits a significant pause even when the phrase otherwise fits', () => {
    const cues = buildWordCaptions([
      { word: 'antes', start: 0, end: 0.5 },
      { word: 'después', start: 1, end: 1.5 },
    ]);
    expect(cues.map((cue) => cue.text)).toEqual(['antes', 'después']);
    expect(selectWordCaption(cues, 0.75)).toBeNull();
  });

  test('gap threshold is inclusive and can be customized', () => {
    const words: SubtitleWord[] = [
      { word: 'uno', start: 0, end: 0.5 },
      { word: 'dos', start: 1, end: 1.5 },
    ];
    expect(buildWordCaptions(words, { gapSeconds: 0.5 })).toHaveLength(2);
    expect(buildWordCaptions(words, { gapSeconds: 0.6 })).toHaveLength(1);
    expect(buildWordCaptions([
      { word: 'uno', start: 0, end: 1 },
      { word: 'dos', start: 1, end: 2 },
    ], { gapSeconds: 0 })).toHaveLength(2);
  });

  test('invalid options fall back to defaults instead of creating broken cues', () => {
    const words = ['un', 'dos', 'tres', 'más', 'fin'].map((word, index) => ({
      word, start: index, end: index + 1,
    }));
    for (const value of [NaN, Infinity, -Infinity, -1, 0, 0.5]) {
      expect(buildWordCaptions(words, { maxWords: value, maxChars: value }))
        .toEqual(buildWordCaptions(words));
    }
    for (const gapSeconds of [NaN, Infinity, -1]) {
      expect(buildWordCaptions(words, { gapSeconds })).toEqual(buildWordCaptions(words));
    }
  });

  test('drops nonfinite, reversed, zero-width and negative-time records', () => {
    expect(buildWordCaptions([
      { word: 'nan', start: NaN, end: 1 },
      { word: 'infinite', start: 0, end: Infinity },
      { word: 'negative infinity', start: -Infinity, end: 1 },
      { word: 'bad end', start: 0, end: NaN },
      { word: 'reversed', start: 2, end: 1 },
      { word: 'empty', start: 1, end: 1 },
      { word: 'negative', start: -1, end: 1 },
      { word: 'bien', start: 0, end: 1 },
    ]).map((cue) => cue.text)).toEqual(['bien']);
  });

  test('normalizes whitespace and sorts without mutating frozen input', () => {
    const words = Object.freeze([
      Object.freeze({ word: ' mundo ', start: 1, end: 2 }),
      Object.freeze({ word: ' hola\n allí ', start: 0, end: 1 }),
    ]);
    const cues = buildWordCaptions(words);
    expect(cues[0]!.text).toBe('hola allí mundo');
    expect(words[0]!.word).toBe(' mundo ');
    expect(words[1]!.end).toBe(1);
    expect(buildWordCaptions(words)).toEqual(cues);
  });

  test('duplicate records collapse while genuine repeated speech remains', () => {
    const cues = buildWordCaptions([
      { word: 'no', start: 0, end: 1 },
      { word: 'no', start: 0, end: 1 },
      { word: 'no', start: 1, end: 2 },
    ]);
    expect(cues[0]!.text).toBe('no no');
    expect(cues[0]!.words).toHaveLength(2);
  });

  test('overlapping words and cues have one owner at every boundary', () => {
    const cues = buildWordCaptions([
      { word: 'uno', start: 0, end: 3 },
      { word: 'dos', start: 1, end: 4 },
      { word: 'tres', start: 2, end: 3 },
    ], { maxWords: 1 });
    expect(cues.map(({ start, end }) => ({ start, end }))).toEqual([
      { start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 },
    ]);
    expect(selectWordCaption(cues, 1)?.cue.text).toBe('dos');
    expect(selectWordCaption(cues, 2)?.cue.text).toBe('tres');
    expect(selectWordCaption(cues, 3)).toBeNull();
  });

  test('last input token owns a colliding start time', () => {
    expect(buildWordCaptions([
      { word: 'anterior', start: 0, end: 2 },
      { word: 'actual', start: 0, end: 1 },
    ]).map((cue) => cue.text)).toEqual(['actual']);
  });
});

describe('selectWordCaption', () => {
  const cues = buildWordCaptions([
    { word: 'hola', start: 1, end: 1.5 },
    { word: 'mundo', start: 1.5, end: 2 },
    { word: 'otra', start: 3, end: 3.5 },
    { word: 'vez', start: 3.5, end: 4 },
  ]);

  test('empty, before speech, silence and after speech are invisible', () => {
    expect(selectWordCaption([], 1)).toBeNull();
    for (const time of [-1, 0, 2, 2.5, 4, 100, NaN, Infinity, -Infinity]) {
      expect(selectWordCaption(cues, time)).toBeNull();
    }
  });

  test('word selection is half-open at adjacent timestamps', () => {
    expect(selectWordCaption(cues, 1)?.activeWordIndex).toBe(0);
    expect(selectWordCaption(cues, 1.499)?.activeWordIndex).toBe(0);
    expect(selectWordCaption(cues, 1.5)?.activeWordIndex).toBe(1);
    expect(selectWordCaption(cues, 2)).toBeNull();
  });

  test('adjacent phrases never duplicate at a transition', () => {
    const adjacent = buildWordCaptions([
      { word: 'primero', start: 0, end: 1 },
      { word: 'segundo', start: 1, end: 2 },
    ], { maxWords: 1 });
    expect(selectWordCaption(adjacent, 0.999)?.cueIndex).toBe(0);
    expect(selectWordCaption(adjacent, 1)?.cueIndex).toBe(1);
    expect(selectWordCaption(adjacent, 2)).toBeNull();
  });

  test('brief internal gaps keep the phrase but do not highlight an inactive word', () => {
    const shortPause = buildWordCaptions([
      { word: 'hola', start: 0, end: 0.5 },
      { word: 'mundo', start: 0.75, end: 1 },
    ]);
    expect(shortPause).toHaveLength(1);
    expect(selectWordCaption(shortPause, 0.5)?.activeWordIndex).toBe(-1);
    expect(selectWordCaption(shortPause, 0.75)?.activeWordIndex).toBe(1);
    expect(selectWordCaption(shortPause, 1)).toBeNull();
  });

  test('random-access frame order does not alter selection', () => {
    expect([3.5, 1, 4, 1.5, 3].map((time) => {
      const selection = selectWordCaption(cues, time);
      return selection ? [selection.cueIndex, selection.activeWordIndex] : null;
    })).toEqual([[1, 1], [0, 0], null, [0, 1], [1, 0]]);
  });
});

describe('clampCaptionYPercent', () => {
  test('defaults centrally and clamps finite values to the canvas', () => {
    expect(clampCaptionYPercent()).toBe(60);
    expect(clampCaptionYPercent(65)).toBe(65);
    expect(clampCaptionYPercent(-10)).toBe(0);
    expect(clampCaptionYPercent(120)).toBe(100);
    expect(clampCaptionYPercent(0)).toBe(0);
    expect(clampCaptionYPercent(100)).toBe(100);
  });

  test('nonfinite positions use the central default', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(clampCaptionYPercent(value)).toBe(60);
    }
  });
});
