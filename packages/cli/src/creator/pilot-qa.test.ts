import { describe, expect, test } from 'bun:test';
import { baseline, examples, frames, range } from '../../../../demo/creator-pilot/fixtures';
import { checkPilotClipQa } from './pilot-qa';

describe('offline pilot audiovisual QA', () => {
  for (const example of examples) {
    test(example.label, () => {
      const result = checkPilotClipQa(example.input);
      expect(result.ok).toBe(example.expectedOk);
      expect(result.problems.length === 0).toBe(example.expectedOk);
    });
  }
  test('unreviewed transcript never qualifies burned subtitles', () => {
    expect(checkPilotClipQa({ ...baseline, transcriptReviewed: false }).ok).toBe(false);
  });
  test('missing boundary and unaddressed camera evidence fail closed', () => {
    expect(checkPilotClipQa({ ...baseline, frames: frames.slice(1) }).problems).toContain('Missing exact boundary frame at 0.');
    expect(checkPilotClipQa({ ...baseline, layoutChanges: [] }).problems).toContain('Camera switch f-000002 missing from EDL.');
  });
  test('off-screen bbox rejected even when component validator accepts it', () => {
    const unsafe = frames.map((frame) => ({ ...frame, speakers: frame.speakers.map((speaker) => ({ ...speaker, bbox: [900, 200, 200, 400] as [number, number, number, number] })) }));
    expect(checkPilotClipQa({ ...baseline, frames: unsafe }).ok).toBe(false);
  });
  test('single listener crop cannot prove simultaneous speaker reaction retention', () => {
    expect(checkPilotClipQa({ ...baseline, range: { ...range, layout: 'single' }, layoutChanges: [{ t: 2, layout: 'single', frameId: 'f-000002' }] }).ok).toBe(false);
  });
  test('reviewed single face crop with no required listener reaction is valid', () => {
    expect(checkPilotClipQa({ ...baseline, range: { ...range, layout: 'single', faces: range.faces.slice(0, 1) }, reactionWindows: [], layoutChanges: [{ t: 2, layout: 'single', frameId: 'f-000002' }] }).ok).toBe(true);
  });
  test('malformed and nonfinite word evidence fails', () => {
    for (const word of [{ word: '', start: 0, end: 1 }, { word: 'bad', start: 0, end: Infinity }, { word: 'bad', start: 1, end: 0 }]) {
      expect(checkPilotClipQa({ ...baseline, words: [word] }).ok).toBe(false);
    }
  });
  test('exact IDs cannot hide duplicate or mismatched EDL clocks', () => {
    expect(checkPilotClipQa({ ...baseline, frames: [...frames, frames[0]!] }).ok).toBe(false);
    expect(checkPilotClipQa({ ...baseline, layoutChanges: [{ t: 2.01, layout: 'duo', frameId: 'f-000002' }] }).ok).toBe(false);
  });
  test('uncertain word outside range is not used as subtitle evidence', () => {
    expect(checkPilotClipQa({ ...baseline, words: [...baseline.words, { word: 'outside', start: 5, end: 6 }], unreliableWordIndexes: [4] }).ok).toBe(true);
  });
});
