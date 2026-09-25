import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import {
  buildEbur128MeasureArgs,
  buildGainReductionArgs,
  buildLoudnormApplyArgs,
  buildLoudnormMeasureArgs,
  decideCorrection,
  normalizeAudioLoudness,
  parseEbur128Summary,
  parseLoudnormJson,
  passesLoudnessGate,
  type FfmpegResult,
  type FfmpegRunner,
  type LoudnormStats,
} from './loudness';

const MEASURED: LoudnormStats = {
  inputI: -20.4,
  inputTp: -2.1,
  inputLra: 5.5,
  inputThresh: -30.2,
  targetOffset: 0.4,
};

const LOUDNORM_JSON = `
[Parsed_loudnorm_0 @ 0x0] {
	"input_i" : "-20.40",
	"input_tp" : "-2.10",
	"input_lra" : "5.50",
	"input_thresh" : "-30.20",
	"output_i" : "-14.00",
	"target_offset" : "0.40"
}
`;

const EBUR128_SUMMARY = `
[Parsed_ebur128_0 @ 0x0] t: 0.1 I: -70.0 LUFS
[Parsed_ebur128_0 @ 0x0] Summary:

  Integrated loudness:
    I:         -14.2 LUFS
    Threshold: -24.4 LUFS

  Loudness range:
    LRA:         3.1 LU

  True peak:
    Peak:       -0.6 dBFS
`;

describe('loudness arg builders', () => {
  test('measure pass reads loudnorm stats as JSON', () => {
    const args = buildLoudnormMeasureArgs('/renders/out.mp4');
    expect(args).toContain('/renders/out.mp4');
    expect(args.join(' ')).toContain('loudnorm=I=-14:TP=-1:LRA=7:print_format=json');
  });

  test('apply pass carries the measured stats and pins the mp4 muxer', () => {
    const args = buildLoudnormApplyArgs('/renders/out.mp4', '/renders/tmp.mp4', MEASURED);
    const filter = args[args.indexOf('-af') + 1]!;
    expect(filter).toContain('measured_I=-20.4');
    expect(filter).toContain('measured_TP=-2.1');
    expect(filter).toContain('measured_LRA=5.5');
    expect(filter).toContain('measured_thresh=-30.2');
    expect(filter).toContain('offset=0.4');
    expect(args.join(' ')).toContain('-c:v copy -c:a aac');
    // Explicit output format: ffmpeg cannot infer a container from a bare
    // temp name, so the argv must pin the muxer right before the output path.
    expect(args.slice(-3, -1)).toEqual(['-f', 'mp4']);
    expect(args[args.length - 1]).toBe('/renders/tmp.mp4');
  });

  test('ebur128 gate measures true peak with the oversampled estimator', () => {
    expect(buildEbur128MeasureArgs('/renders/out.mp4').join(' ')).toContain('ebur128=peak=true');
    const gain = buildGainReductionArgs('/renders/out.mp4', '/renders/tmp.mp4', 1.1);
    expect(gain.join(' ')).toContain('volume=-1.10dB');
    // Same explicit muxer pin as the loudnorm apply pass.
    expect(gain.slice(-3, -1)).toEqual(['-f', 'mp4']);
    expect(gain[gain.length - 1]).toBe('/renders/tmp.mp4');
  });
});

describe('loudness parsers', () => {
  test('parseLoudnormJson reads the measurement block', () => {
    expect(parseLoudnormJson(`noise\n${LOUDNORM_JSON}\nmore`)).toEqual(MEASURED);
    expect(() => parseLoudnormJson('no block here')).toThrow(/statistics block/);
    expect(() =>
      parseLoudnormJson('{"input_i": "x", "input_tp": "-1", "input_lra": "1", "input_thresh": "1", "target_offset": "1"}'),
    ).toThrow(/input_i/);
  });

  test('parseEbur128Summary reads only the consolidated summary', () => {
    const stats = parseEbur128Summary(EBUR128_SUMMARY);
    expect(stats.integratedLufs).toBe(-14.2);
    expect(stats.loudnessRangeLu).toBe(3.1);
    expect(stats.truePeakDbtp).toBe(-0.6);
    expect(() => parseEbur128Summary('I: -70.0 LUFS')).toThrow(/summary/);
  });
});

describe('correction decision + gate', () => {
  test('no correction when the peak is inside the gate', () => {
    const decision = decideCorrection(
      { integratedLufs: -14, loudnessRangeLu: 3, truePeakDbtp: -1.5 },
      {},
    );
    expect(decision.apply).toBe(false);
    expect(decision.reductionDb).toBe(0);
  });

  test('corrective reduction aims below the gate with a safety margin', () => {
    const decision = decideCorrection(
      { integratedLufs: -14, loudnessRangeLu: 3, truePeakDbtp: -0.6 },
      {},
    );
    expect(decision.apply).toBe(true);
    // excess 0.4 + default safety margin 0.5.
    expect(decision.reductionDb).toBeCloseTo(0.9, 10);
  });

  test('passesLoudnessGate checks both LUFS band and true peak', () => {
    expect(
      passesLoudnessGate({ integratedLufs: -14.2, loudnessRangeLu: 3, truePeakDbtp: -1.1 }),
    ).toBe(true);
    expect(
      passesLoudnessGate({ integratedLufs: -17, loudnessRangeLu: 3, truePeakDbtp: -2 }),
    ).toBe(false);
    expect(
      passesLoudnessGate({ integratedLufs: -14, loudnessRangeLu: 3, truePeakDbtp: -0.2 }),
    ).toBe(false);
  });
});

describe('normalizeAudioLoudness stage', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /** Fake ffmpeg: measures from canned stats, "applies" by creating the output file. */
  function fakeRunner(options: {
    peaks: number[];
    integrated?: number[];
    /** When the joined argv contains this, the run fails (after writing its output). */
    failOn?: string;
  }): { runner: FfmpegRunner; calls: string[][] } {
    const calls: string[][] = [];
    let peakIndex = 0;
    let integratedIndex = 0;
    return {
      calls,
      runner: {
        async run(args) {
          calls.push([...args]);
          const joined = args.join(' ');
          let stderr = '';
          if (joined.includes('print_format=json')) {
            stderr = LOUDNORM_JSON;
          } else if (joined.includes('ebur128=peak=true')) {
            const peak = options.peaks[Math.min(peakIndex, options.peaks.length - 1)]!;
            peakIndex += 1;
            const integrated = options.integrated?.[Math.min(integratedIndex, options.integrated.length - 1)] ?? -14.2;
            integratedIndex += 1;
            stderr = `Summary:\n\n  Integrated loudness:\n    I:         ${integrated} LUFS\n\n  True peak:\n    Peak:       ${peak} dBFS\n`;
          } else {
            // Apply/correction pass: create the target file like ffmpeg would
            // (a failing run may leave a partial temp behind — the stage must
            // clean it up).
            const target = args[args.length - 1]!;
            if (target !== '-') await writeFile(target, 'rendered');
          }
          if (options.failOn && joined.includes(options.failOn)) {
            return { exitCode: 1, stdout: '', stderr: 'fake ffmpeg failure' };
          }
          return { exitCode: 0, stdout: '', stderr } satisfies FfmpegResult;
        },
      },
    };
  }

  async function tempRender(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'loudness-'));
    tempDirs.push(dir);
    const file = join(dir, 'out.mp4');
    await writeFile(file, 'original');
    return file;
  }

  test('the enabled gate is the first check: disabled never touches ffmpeg', async () => {
    const file = await tempRender();
    const { runner, calls } = fakeRunner({ peaks: [-1] });
    const result = await normalizeAudioLoudness(file, { enabled: false, runner });
    expect(result).toEqual({ applied: false });
    expect(calls.length).toBe(0);
    expect(await readFile(file, 'utf8')).toBe('original');
  });

  test('runs the configured cycles then verifies with ebur128', async () => {
    const file = await tempRender();
    const { runner, calls } = fakeRunner({ peaks: [-1.4] });
    const result = await normalizeAudioLoudness(file, { enabled: true, runner, cycles: 2 });
    expect(result.applied).toBe(true);
    expect(result.cycles).toBe(2);
    expect(result.corrected).toBe(false);
    expect(result.measured?.truePeakDbtp).toBe(-1.4);
    // 2 cycles x (measure + apply) + 1 ebur128 verification.
    expect(calls.length).toBe(5);
    expect(await readFile(file, 'utf8')).toBe('rendered');
    // The temp keeps the target's real container extension so the muxer can
    // be inferred even before the explicit `-f mp4` is considered.
    const applyTmp = calls[1]![calls[1]!.length - 1]!;
    expect(applyTmp.endsWith('.norm.tmp.mp4')).toBe(true);
  });

  test('applies one corrective gain when true peak exceeds the gate', async () => {
    const file = await tempRender();
    const { runner, calls } = fakeRunner({ peaks: [-0.6, -1.2] });
    const result = await normalizeAudioLoudness(file, { enabled: true, runner, cycles: 1 });
    expect(result.corrected).toBe(true);
    // cycle 1 (measure + apply) + verify + correction + re-verify.
    expect(calls.length).toBe(5);
    expect(calls[3]!.join(' ')).toContain('volume=');
  });

  test('fails loudly when the gate is still missed after correction', async () => {
    const file = await tempRender();
    const { runner } = fakeRunner({ peaks: [-0.6, -0.4] });
    await expect(
      normalizeAudioLoudness(file, { enabled: true, runner, cycles: 1 }),
    ).rejects.toThrow(/LOUDNESS_GATE_MISSED/);
  });

  test('loudnorm apply failure: temp deleted, original file untouched', async () => {
    const file = await tempRender();
    const { runner } = fakeRunner({ peaks: [-1.4], failOn: 'print_format=summary' });
    await expect(
      normalizeAudioLoudness(file, { enabled: true, runner, cycles: 1 }),
    ).rejects.toThrow(/loudnorm application failed/);
    // Atomic swap semantics: nothing was swapped in and the partial temp is gone.
    expect(await readFile(file, 'utf8')).toBe('original');
    await expect(stat(`${file}.norm.tmp.mp4`)).rejects.toThrow();
  });

  test('correction failure: temp deleted, normalized file kept', async () => {
    const file = await tempRender();
    const { runner } = fakeRunner({ peaks: [-0.6], failOn: 'volume=' });
    await expect(
      normalizeAudioLoudness(file, { enabled: true, runner, cycles: 1 }),
    ).rejects.toThrow(/true-peak correction failed/);
    // The loudnorm cycle already swapped in its output; the failed corrective
    // pass must not damage it nor leave its temp behind.
    expect(await readFile(file, 'utf8')).toBe('rendered');
    await expect(stat(`${file}.norm.tmp.mp4`)).rejects.toThrow();
  });
});
