import { describe, expect, test } from 'bun:test';

import {
  activeSegmentAt,
  buildTimedSegments,
} from '../../../../packages/motion-remotion/src/subtitle-segments';

import { bottomLineFor } from './bottom-copy';
import { demoFilmProps } from './demo-props';

/**
 * Overlap regression: the demo scenes used to burn `Caption` AND `Subtitles`
 * at once — two display-800 lines stacked in the same bottom safe zone
 * (visible as overlapping text at ~1s of renders/hello.mp4). Every scene must
 * resolve to exactly ONE bottom line: burned subtitles while the narration
 * speaks, the lower-third caption only when there is no narration to caption.
 */
describe('bottomLineFor', () => {
  test('every demo scene burns exactly one bottom line — Caption and Subtitles never co-render', () => {
    for (const scene of demoFilmProps.scenes) {
      expect(['subtitles', 'caption']).toContain(bottomLineFor(scene));
    }
  });

  test('burned subtitles own the bottom safe zone whenever the narration speaks', () => {
    for (const scene of demoFilmProps.scenes) {
      expect(scene.narration?.trim()).toBeTruthy();
      // The caption would sit in the same zone and repeat the voice on screen.
      expect(bottomLineFor(scene)).toBe('subtitles');
    }
  });

  test('the caption fills the zone only when there is no narration to caption', () => {
    expect(bottomLineFor({ caption: 'Todo video es una cadena de escenas.' })).toBe('caption');
    expect(bottomLineFor({ narration: 'Una sola vez.', caption: 'Repite la voz.' })).toBe(
      'subtitles',
    );
    expect(bottomLineFor({})).toBeNull();
    expect(bottomLineFor({ narration: '   ', caption: '' })).toBeNull();
  });
});

describe('visible bottom line over the demo narration', () => {
  test('at frame 30 (1s) exactly the expected segment is visible', async () => {
    // The render spreads subtitles over the scene's narration slice
    // (script/audio/narration.json, fed to FilmScene.durationInSeconds).
    const timings = JSON.parse(
      await Bun.file(new URL('../script/audio/narration.json', import.meta.url)).text(),
    ) as { scenes: { sceneId: string; durationSeconds: number }[] };
    const intro = timings.scenes.find((s) => s.sceneId === 'intro');
    expect(intro).toBeDefined();
    const spanFrames = Math.max(1, Math.round(intro!.durationSeconds * demoFilmProps.fps));
    const timed = buildTimedSegments(demoFilmProps.scenes[0]!.narration!, spanFrames);

    // Exactly one bottom line at frame 30, and it is the first phrase.
    const owners = timed.filter((t) => 30 >= t.start && 30 < t.end);
    expect(owners.map((t) => t.s)).toEqual(['Un video se arma con escenas']);
    expect(activeSegmentAt(timed, 30)!.s).toBe('Un video se arma con escenas');
  });

  test('consecutive segments never co-render across the scene', async () => {
    const timings = JSON.parse(
      await Bun.file(new URL('../script/audio/narration.json', import.meta.url)).text(),
    ) as { scenes: { sceneId: string; durationSeconds: number }[] };
    for (const [index, scene] of demoFilmProps.scenes.entries()) {
      const timing = timings.scenes.find((s) => s.sceneId === scene.id)!;
      const spanFrames = Math.max(1, Math.round(timing.durationSeconds * demoFilmProps.fps));
      const timed = buildTimedSegments(scene.narration!, spanFrames);
      for (let frame = 0; frame < spanFrames; frame += 1) {
        expect(timed.filter((t) => frame >= t.start && frame < t.end)).toHaveLength(1);
      }
      expect(timed.length).toBeGreaterThan(1);
    }
  });
});
