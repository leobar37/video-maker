import { describe, expect, test } from 'bun:test';
import { buildSceneTimeline, compositionDurationFrames, sceneWords, terminalEntries, tokenizeCode } from './helpers';
import { defaultTutorialProps } from './placeholder';
import type { AsyncScript, NarrationMeta } from './types';

describe('async tutorial timing', () => {
  test('scene boundaries are contiguous and the closing hold never trims audio', () => {
    const first = { ...defaultTutorialProps.script.scenes[0]!, id: 'first' };
    const second = { ...first, id: 'second' };
    const script: AsyncScript = { ...defaultTutorialProps.script, scenes: [first, second] };
    const narration: NarrationMeta = { ...defaultTutorialProps.narration, durationSeconds: 12.47,
      scenes: [
        { sceneId: 'first', startSeconds: 0, endSeconds: 5.23, durationSeconds: 5.23 },
        { sceneId: 'second', startSeconds: 5.23, endSeconds: 12.47, durationSeconds: 7.24 },
      ],
      words: [{ word: 'primera', start: 0, end: 0.4 }, { word: 'segunda', start: 5.23, end: 5.7 },
        { word: 'final', start: 12, end: 12.5 }],
    };
    const timeline = buildSceneTimeline(script, narration);
    expect(timeline.slots[0]!.startFrame).toBe(0);
    expect(timeline.slots[0]!.endFrame).toBe(timeline.slots[1]!.startFrame);
    expect(timeline.slots[1]!.endFrame).toBe(Math.ceil(12.47 * 30));
    expect(timeline.totalFrames).toBe(Math.ceil(12.47 * 30) + 30);
    expect(compositionDurationFrames(narration)).toBe(timeline.totalFrames);
    expect(sceneWords(narration, timeline.slots[0]!).map(word => word.word)).toEqual(['primera']);
    const finalWords = sceneWords(narration, timeline.slots[1]!);
    expect(finalWords[0]!.start).toBe(0);
    expect(finalWords.at(-1)!.end).toBeLessThanOrEqual(7.24 + 0.0001);
  });

  test('correct output is revealed after the prediction, in execution order', () => {
    const spoken = ['Si', 'pensaste', 'A,', 'B,', 'C,', 'no.', 'El', 'resultado', 'es', 'A,', 'C', 'y', 'después', 'B.'];
    const words = spoken.map((word, index) => ({ word, start: index, end: index + 0.6 }));
    const entries = terminalEntries('01-prediccion', ['A', 'C', 'B'], words, 20);
    const output = entries.filter(entry => entry.kind === 'output');
    expect(output.map(entry => entry.text)).toEqual(['A', 'C', 'B']);
    expect(output[0]!.at).toBeGreaterThanOrEqual(9 * 30);
    expect(output[0]!.at).toBeLessThan(output[1]!.at);
    expect(output[1]!.at).toBeLessThan(output[2]!.at);
    expect(output[2]!.at).toBeLessThan(20 * 30);
  });

  test('missing spoken cues still yield ordered output before scene end', () => {
    const output = terminalEntries('04-callbacks', ['Puedo continuar', 'Hola'], [], 30)
      .filter(entry => entry.kind === 'output');
    expect(output[0]!.at).toBeLessThan(output[1]!.at);
    expect(output[1]!.at).toBeLessThan(30 * 30);
  });

  test('syntax colors preserve the exact original code', () => {
    const code = "const response = await fetch(url);\nthrow new Error(`HTTP ${response.status}`);\n// comentario\n";
    expect(tokenizeCode(code).map(line => line.tokens.map(token => token.text).join('')).join('\n')).toBe(code);
  });
});
