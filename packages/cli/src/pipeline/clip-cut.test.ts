/**
 * clip-cut pure contract: silence parsing/snapping, layout filters, cover pick
 * and the ffmpeg wires — all without invoking ffmpeg.
 */
import { describe, expect, test } from 'bun:test';

import {
  assColor,
  assTime,
  buildAssSubtitles,
  buildCutArgs,
  buildCutFilter,
  buildSilenceArgs,
  escapeFilterPath,
  groupSubtitleCues,
  parseSilenceDetect,
  pickCoverTimeSec,
  snapEndToSilence,
  snapStartToSilence,
} from './clip-cut';

const STDERR = `
[silencedetect @ 0x1] silence_start: 17.8998
[silencedetect @ 0x1] silence_end: 18.4154 | silence_duration: 0.5156
[silencedetect @ 0x1] silence_start: 19.6825
[silencedetect @ 0x1] silence_end: 20.5882 | silence_duration: 0.9057
frame= 120 fps=0.0 q=-0.0 size=N/A time=00:00:05.00
`;

describe('parseSilenceDetect', () => {
  test('pairs starts with ends and ignores other lines', () => {
    expect(parseSilenceDetect(STDERR)).toEqual([
      { startSec: 17.8998, endSec: 18.4154 },
      { startSec: 19.6825, endSec: 20.5882 },
    ]);
  });

  test('an unmatched start stays open at infinity', () => {
    const parsed = parseSilenceDetect('silence_start: 42.5');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.startSec).toBe(42.5);
    expect(parsed[0]!.endSec).toBe(Number.POSITIVE_INFINITY);
  });

  test('empty input is empty', () => {
    expect(parseSilenceDetect('')).toEqual([]);
  });
});

describe('silence snapping', () => {
  const silences = [
    { startSec: 10, endSec: 11 },
    { startSec: 30, endSec: 31.2 },
  ];

  test('start snaps to the silence end within the shift budget', () => {
    expect(snapStartToSilence(10.8, silences)).toBe(11);
    expect(snapStartToSilence(30.5, silences)).toBe(31.2);
  });

  test('start falls back when nothing is close enough', () => {
    expect(snapStartToSilence(20, silences, 1.5)).toBe(20);
  });

  test('end snaps to the silence start within the shift budget', () => {
    expect(snapEndToSilence(29.6, silences)).toBe(30);
    expect(snapEndToSilence(10.4, silences)).toBe(10);
  });

  test('end falls back when nothing is close enough', () => {
    expect(snapEndToSilence(22, silences, 1.5)).toBe(22);
  });

  test('an open tail silence can still anchor the start', () => {
    expect(snapStartToSilence(50.4, [{ startSec: 50, endSec: Number.POSITIVE_INFINITY }])).toBe(50);
  });
});

describe('buildCutFilter', () => {
  const base = { width: 1080, height: 1920, hasAudio: true } as const;

  test('blur layout keeps the full frame over a blurred backdrop', () => {
    const filter = buildCutFilter({ ...base, layout: 'blur' });
    expect(filter.filterComplex).toContain('boxblur=28:2');
    expect(filter.filterComplex).toContain('overlay=(W-w)/2:(H-h)/2');
    expect(filter.filterComplex).toContain('loudnorm=I=-16:TP=-2:LRA=11');
    expect(filter.maps).toEqual(['-map', '[v]', '-map', '[a]']);
  });

  test('crop layout fills the frame and honors the horizontal anchor', () => {
    const filter = buildCutFilter({ ...base, layout: 'crop', cropOffsetPercent: 25 });
    expect(filter.filterComplex).toContain('force_original_aspect_ratio=increase');
    expect(filter.filterComplex).toContain('crop=1080:1920:(in_w-1080)*0.25:0');
    expect(filter.filterComplex).not.toContain('overlay');
  });

  test('a silent source drops the audio chain and its map', () => {
    const filter = buildCutFilter({ ...base, layout: 'crop', hasAudio: false });
    expect(filter.filterComplex).not.toContain('loudnorm');
    expect(filter.maps).toEqual(['-map', '[v]']);
  });
});

describe('pickCoverTimeSec', () => {
  test('picks the strongest reaction inside the window', () => {
    const peaks = [
      { peakSec: 12, riseDb: 4 },
      { peakSec: 20, riseDb: 9 },
      { peakSec: 40, riseDb: 99 },
    ];
    expect(pickCoverTimeSec(10, 30, peaks)).toBe(20);
  });

  test('ignores peaks too close to the edges and falls back', () => {
    const peaks = [{ peakSec: 10.5, riseDb: 50 }];
    expect(pickCoverTimeSec(10, 30, peaks, 0.4)).toBe(18);
  });
});

describe('subtitles', () => {
  test('assTime formats ASS centisecond timestamps', () => {
    expect(assTime(0)).toBe('0:00:00.00');
    expect(assTime(61.5)).toBe('0:01:01.50');
    expect(assTime(3661.25)).toBe('1:01:01.25');
  });

  test('assColor converts RGB to ASS BGR order', () => {
    expect(assColor('#FFFFFF')).toBe('&H00FFFFFF');
    expect(assColor('#FF0000')).toBe('&H000000FF');
    expect(assColor('nope')).toBe('&H00FFFFFF');
  });

  test('escapeFilterPath escapes filter-graph separators', () => {
    expect(escapeFilterPath('/tmp/a:b.ass')).toBe('/tmp/a\\:b.ass');
  });

  test('cues break on word budget, char budget and pauses', () => {
    const words = [
      { t: 0, end: 0.4, text: 'uno' },
      { t: 0.5, end: 0.9, text: 'dos' },
      { t: 1.0, end: 1.4, text: 'tres' },
      { t: 3.0, end: 3.4, text: 'cuatro' },
    ];
    const cues = groupSubtitleCues(words, { startSec: 0, endSec: 10, maxWords: 3, maxGapSec: 0.3 });
    expect(cues).toHaveLength(2);
    expect(cues[0]!.text).toBe('uno dos tres');
    expect(cues[1]!.text).toBe('cuatro');
  });

  test('the ASS document carries style, clip-relative timings and text', () => {
    const ass = buildAssSubtitles(
      [
        { t: 100, end: 100.5, text: 'hola' },
        { t: 100.6, end: 101.1, text: 'mundo' },
      ],
      { startSec: 99, endSec: 102, fontSize: 64 },
    );
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('Style: Default,DejaVu Sans,64');
    expect(ass).toContain('Dialogue: 0,0:00:01.00,0:00:02.10,Default');
    expect(ass).toContain('hola mundo');
  });

  test('the cut filter chains the subtitle renderer when a file is given', () => {
    const filter = buildCutFilter({
      layout: 'crop',
      width: 1080,
      height: 1920,
      hasAudio: true,
      subtitlesPath: '/tmp/c1.ass',
    });
    expect(filter.filterComplex).toContain(',subtitles=/tmp/c1.ass[v]');
  });
});

describe('ffmpeg wires', () => {
  test('cut args carry the trim, filter, encoder and faststart', () => {
    const args = buildCutArgs({
      source: '/p/source.mp4',
      out: '/p/renders/clips/c1.mp4',
      startSec: 12.5,
      durationSec: 30,
      filter: buildCutFilter({ layout: 'crop', width: 1080, height: 1920, hasAudio: true }),
    });
    expect(args.slice(0, 4)).toEqual(['-y', '-hide_banner', '-loglevel', 'error']);
    expect(args[args.indexOf('-ss') + 1]).toBe('12.5');
    expect(args[args.indexOf('-t') + 1]).toBe('30');
    expect(args).toContain('-filter_complex');
    expect(args[args.indexOf('-preset') + 1]).toBe('veryfast');
    expect(args[args.indexOf('-ar') + 1]).toBe('48000');
    expect(args[args.indexOf('-movflags') + 1]).toBe('+faststart');
    expect(args[args.length - 1]).toBe('/p/renders/clips/c1.mp4');
  });

  test('silence args measure one window with silencedetect', () => {
    const args = buildSilenceArgs('/p/source.mp4', 100, 40);
    expect(args[args.indexOf('-ss') + 1]).toBe('100');
    expect(args[args.indexOf('-t') + 1]).toBe('40');
    expect(args[args.indexOf('-af') + 1]).toBe('silencedetect=noise=-32dB:d=0.3');
    expect(args.slice(-3)).toEqual(['-f', 'null', '-']);
  });
});
