import { describe, expect, test } from 'bun:test';

import { buildWordSegments, clipWordsToWindow, type SubtitleWord } from './subtitle-words';

describe('clipWordsToWindow', () => {
  test('keeps overlapping words and clamps them into the window', () => {
    const words: SubtitleWord[] = [
      { word: 'uno', start: 0, end: 0.5 },
      { word: 'dos', start: 0.5, end: 1.2 },
      { word: 'tres', start: 1.2, end: 2 },
    ];
    expect(clipWordsToWindow(words, 0.4, 1.3)).toEqual([
      { word: 'uno', start: 0.4, end: 0.5 },
      { word: 'dos', start: 0.5, end: 1.2 },
      { word: 'tres', start: 1.2, end: 1.3 },
    ]);
  });

  test('drops words fully outside the window', () => {
    const words: SubtitleWord[] = [
      { word: 'antes-tocando', start: 0.5, end: 1 },
      { word: 'antes', start: 0, end: 0.9 },
      { word: 'dentro', start: 1.5, end: 1.6 },
      { word: 'despues-tocando', start: 2, end: 2.5 },
      { word: 'despues', start: 2.5, end: 3 },
    ];
    // Words that merely touch an edge belong to the neighbouring clip.
    expect(clipWordsToWindow(words, 1, 2)).toEqual([{ word: 'dentro', start: 1.5, end: 1.6 }]);
  });

  test('keeps a word exactly spanning the window unchanged', () => {
    expect(clipWordsToWindow([{ word: 'exacto', start: 1, end: 2 }], 1, 2)).toEqual([
      { word: 'exacto', start: 1, end: 2 },
    ]);
  });

  test('empty input or empty window yields no words', () => {
    expect(clipWordsToWindow([], 0, 1)).toEqual([]);
    expect(clipWordsToWindow([{ word: 'hola', start: 0, end: 1 }], 1, 1)).toEqual([]);
    expect(clipWordsToWindow([{ word: 'hola', start: 0, end: 1 }], 2, 1)).toEqual([]);
  });
});

describe('buildWordSegments', () => {
  test('packs a short phrase into a single segment', () => {
    expect(
      buildWordSegments([
        { word: 'hola', start: 0, end: 0.3 },
        { word: 'mundo', start: 0.3, end: 0.7 },
      ]),
    ).toEqual([{ text: 'hola mundo', start: 0, end: 0.7 }]);
  });

  test('packs greedily within the 30-character budget', () => {
    const words: SubtitleWord[] = [
      { word: 'Un', start: 0, end: 0.3 },
      { word: 'video', start: 0.3, end: 0.7 },
      { word: 'se', start: 0.7, end: 1 },
      { word: 'arma', start: 1, end: 1.5 },
      { word: 'con', start: 1.5, end: 1.9 },
      { word: 'escenas', start: 1.9, end: 2.5 },
      { word: 'encadenadas', start: 2.5, end: 3.4 },
      { word: 'sin', start: 3.4, end: 3.7 },
      { word: 'cortes', start: 3.7, end: 4.2 },
    ];
    const segments = buildWordSegments(words);
    expect(segments).toEqual([
      { text: 'Un video se arma con escenas', start: 0, end: 2.5 },
      { text: 'encadenadas sin cortes', start: 2.5, end: 4.2 },
    ]);
    segments.forEach((segment) => {
      expect(segment.text.length).toBeLessThanOrEqual(30);
    });
  });

  test('honours a custom maxChars at the exact boundary', () => {
    // "aaaa bbbb" is exactly 9 chars and must stay together; "cc" overflows.
    expect(
      buildWordSegments(
        [
          { word: 'aaaa', start: 0, end: 1 },
          { word: 'bbbb', start: 2, end: 3 },
          { word: 'cc', start: 3, end: 4 },
        ],
        9,
      ),
    ).toEqual([
      { text: 'aaaa bbbb', start: 0, end: 3 },
      { text: 'cc', start: 3, end: 4 },
    ]);
  });

  test('a word longer than maxChars stands alone', () => {
    const segments = buildWordSegments(
      [
        { word: 'supercalifragilistico', start: 0, end: 1 },
        { word: 'corto', start: 1, end: 2 },
      ],
      10,
    );
    expect(segments).toEqual([
      { text: 'supercalifragilistico', start: 0, end: 1 },
      { text: 'corto', start: 1, end: 2 },
    ]);
  });

  test('segments follow word order, stay contiguous and never overlap', () => {
    const words: SubtitleWord[] = [
      { word: '  Un ', start: 0, end: 0.3 },
      { word: 'video', start: 0.3, end: 0.7 },
      { word: 'se', start: 0.7, end: 1 },
      { word: 'arma', start: 1, end: 1.5 },
      { word: 'con', start: 1.5, end: 1.9 },
      { word: 'escenas', start: 1.9, end: 2.5 },
    ];
    const segments = buildWordSegments(words);
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i]!.start).toBeGreaterThanOrEqual(segments[i - 1]!.end);
    }
    // Every word lands in order, and word text is trimmed to single spaces.
    expect(segments.map((segment) => segment.text).join(' ').split(' ')).toEqual([
      'Un',
      'video',
      'se',
      'arma',
      'con',
      'escenas',
    ]);
  });

  test('empty input yields no segments', () => {
    expect(buildWordSegments([])).toEqual([]);
    expect(buildWordSegments([{ word: '   ', start: 0, end: 1 }])).toEqual([]);
  });
});
