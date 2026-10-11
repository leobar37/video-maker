import { describe, expect, test } from 'bun:test';
import { buildSceneTimeline, captionCues, compositionDurationFrames, tokenizeCode } from './helpers';
import { defaultCodemodeProps } from './placeholder';
import type { NarrationMeta } from './types';

describe('Pi Codemode vertical contracts', () => {
  test('the two-minute limit includes the closing hold and frame rounding', () => {
    const base = defaultCodemodeProps.narration;
    expect(compositionDurationFrames({ ...base, durationSeconds: 119.2 })).toBe(3600);
    expect(() => compositionDurationFrames({ ...base, durationSeconds: 119.21 })).toThrow();
    expect(() => compositionDurationFrames({ ...base, durationSeconds: 120 })).toThrow();
    expect(() => compositionDurationFrames({ ...base, durationSeconds: 0 })).toThrow();
    expect(() => compositionDurationFrames({ ...base, durationSeconds: Number.NaN })).toThrow();
  });

  test('voice-aligned scene ranges cover the content once with a final hold', () => {
    const first = { ...defaultCodemodeProps.script.scenes[0]!, id: 'first' };
    const second = { ...first, id: 'second' };
    const script = { ...defaultCodemodeProps.script, scenes: [first, second] };
    const narration: NarrationMeta = { ...defaultCodemodeProps.narration, durationSeconds: 8.41,
      scenes: [
        { sceneId: 'first', startSeconds: 0, endSeconds: 3.27, durationSeconds: 3.27 },
        { sceneId: 'second', startSeconds: 3.27, endSeconds: 8.41, durationSeconds: 5.14 },
      ],
    };
    const timeline = buildSceneTimeline(script, narration);
    expect(timeline.slots[0]!.startFrame).toBe(0);
    expect(timeline.slots[0]!.endFrame).toBe(timeline.slots[1]!.startFrame);
    expect(timeline.slots[1]!.endFrame).toBe(Math.ceil(8.41 * 30));
    expect(timeline.totalFrames).toBe(Math.ceil(8.41 * 30) + 24);
  });

  test('caption groups preserve every word and remain short', () => {
    const words = 'Pi coordina. Code Mode organiza la ejecución. MCP conecta herramientas. Jev puede evaluar.'.split(' ')
      .map((word, index) => ({ word, start: index * 0.3, end: index * 0.3 + 0.25 }));
    const cues = captionCues(words);
    expect(cues.flatMap(cue => cue.words.map(word => word.word))).toEqual(words.map(word => word.word));
    for (const cue of cues) {
      expect(cue.words.length).toBeLessThanOrEqual(6);
      expect(cue.words.map(word => word.word).join(' ').length).toBeLessThanOrEqual(40);
      expect(cue.end).toBeGreaterThan(cue.start);
    }
  });

  test('coloring never changes the displayed code', () => {
    const lines = ['const src = await tools.read({ path });', "if (src.includes('verifyToken')) text(path);"];
    expect(tokenizeCode(lines).map(line => line.tokens.map(token => token.text).join(''))).toEqual(lines);
  });
});
