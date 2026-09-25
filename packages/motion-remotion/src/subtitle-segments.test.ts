import { describe, expect, test } from 'bun:test';

import {
  activeSegmentAt,
  buildSegments,
  buildTimedSegments,
  MAX_SEGMENT_CHARS,
} from './subtitle-segments';

describe('buildSegments', () => {
  test('splits narration on punctuation into short phrases', () => {
    // The first phrase exceeds the line budget and wraps on the word boundary.
    expect(
      buildSegments('Un video se arma con escenas encadenadas, sin huecos entre cortes.'),
    ).toEqual(['Un video se arma con escenas', 'encadenadas,', 'sin huecos entre cortes.']);
  });

  test('short phrases go on screen whole', () => {
    expect(buildSegments('Finanzas claras.')).toEqual(['Finanzas claras.']);
  });

  test('wraps long phrases within the line budget', () => {
    const segments = buildSegments(
      'Cada recurso del proyecto se resuelve por id desde el manifiesto de assets del proyecto, con su hash y sus medidas.',
    );
    expect(segments.length).toBeGreaterThan(1);
    segments.forEach((segment) => {
      expect(segment.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS);
    });
    // Words are never reordered.
    expect(segments.join(' ').split(/\s+/)).toEqual(
      'Cada recurso del proyecto se resuelve por id desde el manifiesto de assets del proyecto, con su hash y sus medidas.'.split(
        /\s+/,
      ),
    );
  });

  test('pulls dangling function words down to the next line', () => {
    // The greedy wrap would end line 1 on "de"; healing must move it down.
    const segments = buildSegments(
      'Aprende a manejar el dinero de tu negocio con decisiones simples de cada día.',
    );
    const nonLast = segments.slice(0, -1);
    nonLast.forEach((segment) => {
      const lastWord = segment.split(' ').pop()!.toLowerCase();
      expect(['de', 'el', 'la', 'con', 'y', 'que', 'a', 'en', 'del', 'los', 'las']).not.toContain(
        lastWord,
      );
    });
  });

  test('never leaves a single-word tail when it can be healed', () => {
    const segments = buildSegments(
      'La última palabra de la frase no queda sola cuando cabe en el máximo permitido.',
    );
    segments.slice(0, -1).forEach((segment) => {
      expect(segment.split(' ').length).toBeGreaterThan(1);
    });
    segments.forEach((segment) => {
      expect(segment.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS);
    });
  });

  test('empty input yields no segments', () => {
    expect(buildSegments('')).toEqual([]);
    expect(buildSegments('   ')).toEqual([]);
  });
});

describe('buildTimedSegments / activeSegmentAt', () => {
  // Scene-1 narration of the demo film over its voice slice (8.684 s @ 30 fps).
  const NARRATION =
    'Un video se arma con escenas encadenadas, sin huecos entre cortes. La narración continua suena una sola vez.';
  const SPAN_FRAMES = Math.round(8.684 * 30);

  test('windows tile the span with no gaps or overlaps', () => {
    const timed = buildTimedSegments(NARRATION, SPAN_FRAMES);
    expect(timed.length).toBeGreaterThan(1);
    expect(timed[0]!.start).toBe(0);
    expect(timed[timed.length - 1]!.end).toBe(SPAN_FRAMES);
    for (let i = 0; i < timed.length - 1; i += 1) {
      // Contiguous and half-open: the boundary frame belongs to the NEXT
      // segment alone, so consecutive segments can never co-render.
      expect(timed[i]!.end).toBe(timed[i + 1]!.start);
    }
  });

  test('every frame in the span maps to exactly one segment', () => {
    const timed = buildTimedSegments(NARRATION, SPAN_FRAMES);
    for (let frame = 0; frame < SPAN_FRAMES; frame += 1) {
      const owners = timed.filter((t) => frame >= t.start && frame < t.end);
      expect(owners.map((t) => t.s)).toHaveLength(1);
      expect(activeSegmentAt(timed, frame)).toEqual(owners[0]);
    }
  });

  test('at frame 30 (1s) exactly the expected segment is visible', () => {
    const timed = buildTimedSegments(NARRATION, SPAN_FRAMES);
    expect(activeSegmentAt(timed, 30)!.s).toBe('Un video se arma con escenas');
  });

  test('at a window boundary the next segment takes over alone', () => {
    const timed = buildTimedSegments(NARRATION, SPAN_FRAMES);
    const [first, second] = timed;
    expect(activeSegmentAt(timed, first!.end)!).toEqual(second!);
    expect(activeSegmentAt(timed, first!.end - 0.5)!).toEqual(first!);
  });

  test('the first and last phrases hold the ends of the scene tail', () => {
    const timed = buildTimedSegments(NARRATION, SPAN_FRAMES);
    expect(activeSegmentAt(timed, -5)!).toEqual(timed[0]!);
    expect(activeSegmentAt(timed, SPAN_FRAMES)!).toEqual(timed[timed.length - 1]!);
    expect(activeSegmentAt(timed, SPAN_FRAMES + 200)!).toEqual(timed[timed.length - 1]!);
    expect(activeSegmentAt([], 3)).toBeNull();
  });
});
