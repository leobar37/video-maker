/**
 * Loudness normalization stage — SEPARATE from rendering and behind a
 * configurable gate (`AudioNormalizationOptions.enabled`). Runs as its own
 * optional stage after `renderMedia`: the render is valid without it; this
 * stage only makes the final file broadcast-ready.
 *
 * Pipeline (per cycle): measure real integrated loudness with ffmpeg
 * `loudnorm:print_format=json`, then apply `loudnorm` with those measurements
 * (double-pass). After the cycles, the result is independently measured with
 * `ebur128=peak=true`; if true peak exceeds the gate, a corrective gain
 * reduction (with a small safety margin) is applied and the file is
 * re-measured. The stage FAILS if the gate is still missed after correction.
 *
 * ffmpeg runs through an injectable `FfmpegRunner` seam: production code uses
 * the default process runner, tests inject a recording fake. The argument
 * builders and parsers are pure so the exact filter chain is unit-testable
 * without spawning ffmpeg.
 */

import { rename, rm } from 'node:fs/promises';
import { extname } from 'node:path';

/** Result of one ffmpeg invocation. */
export interface FfmpegResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Injectable ffmpeg seam. */
export interface FfmpegRunner {
  run(args: readonly string[]): Promise<FfmpegResult>;
}

/** Default runner: spawns the system `ffmpeg` binary. */
export const processFfmpegRunner: FfmpegRunner = {
  async run(args) {
    const proc = Bun.spawn(['ffmpeg', ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  },
};

export interface LoudnormStats {
  /** Measured integrated loudness (LUFS). */
  inputI: number;
  /** Measured true peak (dBTP). */
  inputTp: number;
  /** Measured loudness range (LU). */
  inputLra: number;
  /** Gating threshold (LUFS). */
  inputThresh: number;
  /** Target offset loudnorm suggests applying (dB). */
  targetOffset: number;
}

export interface ComplianceStats {
  integratedLufs: number;
  loudnessRangeLu: number;
  truePeakDbtp: number;
}

export interface LoudnessGate {
  /** Integrated loudness target (LUFS). Default -14. */
  targetLufs?: number;
  /** Allowed deviation from the target (LUFS). Default 1. */
  lufsTolerance?: number;
  /** True-peak ceiling (dBTP, ≤ this passes). Default -1. */
  targetTruePeakDbtp?: number;
  /** Loudness range target for the loudnorm filter (LU). Default 7. */
  targetLra?: number;
  /**
   * Safety margin (dB) baked into the corrective reduction: AAC re-encoding
   * introduces inter-sample peak rise (~0.4 dBTP), so the correction aims
   * below the gate to land inside it after re-encode. Default 0.5.
   */
  safetyMarginDbtp?: number;
  /** Skip corrections below this (rounding noise). Default 0.05. */
  minReductionDb?: number;
}

export interface AudioNormalizationOptions extends LoudnessGate {
  /** THE GATE: `false` skips the stage entirely (loudness untouched). */
  enabled: boolean;
  /** ffmpeg seam; defaults to `processFfmpegRunner`. */
  runner?: FfmpegRunner;
  /** Measure+apply cycles; a single pass lands ~1.5 LU short. Default 2. */
  cycles?: number;
  /** Independent ebur128 verification + corrective gain. Default true. */
  verify?: boolean;
  log?: (message: string) => void;
}

export interface AudioNormalizationResult {
  applied: boolean;
  cycles?: number;
  measured?: ComplianceStats;
  corrected?: boolean;
}

const DEFAULTS = {
  targetLufs: -14,
  lufsTolerance: 1,
  targetTruePeakDbtp: -1,
  targetLra: 7,
  safetyMarginDbtp: 0.5,
  minReductionDb: 0.05,
  cycles: 2,
};

/** `loudnorm` filter with the EBU R128 targets of this pipeline. */
export function loudnormFilter(gate: LoudnessGate = {}): string {
  return `loudnorm=I=${gate.targetLufs ?? DEFAULTS.targetLufs}:TP=${
    gate.targetTruePeakDbtp ?? DEFAULTS.targetTruePeakDbtp
  }:LRA=${gate.targetLra ?? DEFAULTS.targetLra}`;
}

/** Pass 1: measure the file's real loudness stats (loudnorm JSON on stderr). */
export function buildLoudnormMeasureArgs(file: string, gate: LoudnessGate = {}): string[] {
  return [
    '-hide_banner',
    '-i',
    file,
    '-af',
    `${loudnormFilter(gate)}:print_format=json`,
    '-f',
    'null',
    '-',
  ];
}

/**
 * Pass 2: apply loudnorm with the measured stats (video copied, AAC 48kHz).
 * The output muxer is pinned with `-f mp4`: ffmpeg cannot infer a container
 * from a bare temp name, and this stage targets the pipeline's h264 mp4
 * renders.
 */
export function buildLoudnormApplyArgs(
  file: string,
  output: string,
  measured: LoudnormStats,
  gate: LoudnessGate = {},
): string[] {
  const filter =
    `${loudnormFilter(gate)}:measured_I=${measured.inputI}:measured_TP=${measured.inputTp}` +
    `:measured_LRA=${measured.inputLra}:measured_thresh=${measured.inputThresh}` +
    `:offset=${measured.targetOffset}:print_format=summary`;
  return [
    '-y',
    '-i',
    file,
    '-af',
    filter,
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-f',
    'mp4',
    output,
  ];
}

/** Independent gate measurement: ebur128 with the true-peak estimator. */
export function buildEbur128MeasureArgs(file: string): string[] {
  return ['-hide_banner', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'];
}

/**
 * Corrective gain reduction (video copied, audio re-encoded). Muxer pinned
 * with `-f mp4`, same as the loudnorm apply pass.
 */
export function buildGainReductionArgs(
  file: string,
  output: string,
  reductionDb: number,
): string[] {
  return [
    '-y',
    '-i',
    file,
    '-af',
    `volume=-${reductionDb.toFixed(2)}dB`,
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-f',
    'mp4',
    output,
  ];
}

/** Parse the loudnorm measurement block ffmpeg prints with `print_format=json`. */
export function parseLoudnormJson(stderr: string): LoudnormStats {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseLoudnormJson: no loudnorm statistics block found.');
  }
  const raw = JSON.parse(stderr.slice(start, end + 1)) as Record<string, unknown>;
  const number = (key: string): number => {
    const value = Number(raw[key]);
    if (!Number.isFinite(value)) {
      throw new Error(`parseLoudnormJson: missing or invalid "${key}".`);
    }
    return value;
  };
  return {
    inputI: number('input_i'),
    inputTp: number('input_tp'),
    inputLra: number('input_lra'),
    inputThresh: number('input_thresh'),
    targetOffset: number('target_offset'),
  };
}

/**
 * Parse ffmpeg's ebur128=peak=true summary block. Only the final `Summary:`
 * block is read — per-frame updates contain invalid early-frame values.
 */
export function parseEbur128Summary(output: string): ComplianceStats {
  const summaryMarker = output.lastIndexOf('Summary:');
  const summaryBlock = summaryMarker >= 0 ? output.slice(summaryMarker) : output;

  const integrated = summaryBlock.match(/I:\s+([-+]?\d+(?:\.\d+)?)\s+LUFS/);
  const range = summaryBlock.match(/LRA:\s+([-+]?\d+(?:\.\d+)?)\s+LU/);
  // `Peak:` under "True peak" is dBFS on the same scale as dBTP.
  const peak = summaryBlock.match(/Peak:\s+([-+]?\d+(?:\.\d+)?)\s+dBFS/);
  if (!integrated || !peak) {
    throw new Error('parseEbur128Summary: no consolidated ebur128 summary found.');
  }
  return {
    integratedLufs: Number(integrated[1]),
    loudnessRangeLu: range ? Number(range[1]) : 0,
    truePeakDbtp: Number(peak[1]),
  };
}

export interface CorrectionDecision {
  apply: boolean;
  /** Positive numbers attenuate. Zero when `apply` is false. */
  reductionDb: number;
  reason: string;
}

/**
 * Decide whether the measured file needs a corrective gain reduction to land
 * under the true-peak gate. Always aims with a safety margin so the AAC
 * re-encode's inter-sample rise cannot push the result back over.
 */
export function decideCorrection(
  stats: ComplianceStats,
  gate: LoudnessGate = {},
): CorrectionDecision {
  const targetPeak = gate.targetTruePeakDbtp ?? DEFAULTS.targetTruePeakDbtp;
  const safetyMargin = gate.safetyMarginDbtp ?? DEFAULTS.safetyMarginDbtp;
  const minReduction = gate.minReductionDb ?? DEFAULTS.minReductionDb;

  const excess = stats.truePeakDbtp - targetPeak;
  const reductionDb = excess + safetyMargin;
  if (excess <= 0) {
    return { apply: false, reductionDb: 0, reason: `TP ${stats.truePeakDbtp} dBTP within gate` };
  }
  if (reductionDb < minReduction) {
    return {
      apply: false,
      reductionDb: 0,
      reason: `TP excess ${excess.toFixed(2)} dB below minimum correction`,
    };
  }
  return {
    apply: true,
    reductionDb,
    reason: `TP ${stats.truePeakDbtp} dBTP over ${targetPeak} dBTP gate`,
  };
}

/** Gate check after normalization + correction. */
export function passesLoudnessGate(
  stats: ComplianceStats,
  gate: LoudnessGate = {},
): boolean {
  const target = gate.targetLufs ?? DEFAULTS.targetLufs;
  const tolerance = gate.lufsTolerance ?? DEFAULTS.lufsTolerance;
  const targetPeak = gate.targetTruePeakDbtp ?? DEFAULTS.targetTruePeakDbtp;
  return (
    Math.abs(stats.integratedLufs - target) <= tolerance && stats.truePeakDbtp <= targetPeak
  );
}

async function runFfmpeg(
  runner: FfmpegRunner,
  args: readonly string[],
  what: string,
): Promise<FfmpegResult> {
  const result = await runner.run(args);
  if (result.exitCode !== 0) {
    throw new Error(`ffmpeg ${what} failed (exit ${result.exitCode}): ${result.stderr.slice(-500)}`);
  }
  return result;
}

/**
 * Re-encode to a container-suffixed temp file and atomically swap it over the
 * target. The temp keeps the target's real container extension (`out.mp4` →
 * `out.mp4.norm.tmp.mp4`) so ffmpeg can infer the muxer even without `-f`;
 * the builders pin `-f mp4` regardless. On failure the temp is deleted and
 * the original file is left untouched.
 */
async function reencodeInPlace(
  runner: FfmpegRunner,
  file: string,
  what: string,
  buildArgs: (tmp: string) => string[],
): Promise<void> {
  const tmp = `${file}.norm.tmp${extname(file) || '.mp4'}`;
  try {
    await runFfmpeg(runner, buildArgs(tmp), what);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  await rename(tmp, file);
}

async function measureCompliance(runner: FfmpegRunner, file: string): Promise<ComplianceStats> {
  const result = await runFfmpeg(runner, buildEbur128MeasureArgs(file), 'ebur128 measurement');
  return parseEbur128Summary(result.stderr);
}

/**
 * The normalization stage. No-op when `options.enabled` is false — the gate is
 * the first thing checked, so a disabled stage never touches the file.
 */
export async function normalizeAudioLoudness(
  file: string,
  options: AudioNormalizationOptions,
): Promise<AudioNormalizationResult> {
  if (!options.enabled) return { applied: false };

  const runner = options.runner ?? processFfmpegRunner;
  const cycles = options.cycles ?? DEFAULTS.cycles;
  const log = options.log ?? (() => {});
  const gate: LoudnessGate = options;

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    const measure = await runFfmpeg(
      runner,
      buildLoudnormMeasureArgs(file, gate),
      'loudnorm measurement',
    );
    const stats = parseLoudnormJson(measure.stderr);
    log(
      `loudnorm cycle ${cycle}: measured I=${stats.inputI} LUFS, TP=${stats.inputTp} dBTP ` +
        `-> ${gate.targetLufs ?? DEFAULTS.targetLufs}/${gate.targetTruePeakDbtp ?? DEFAULTS.targetTruePeakDbtp}.`,
    );
    await reencodeInPlace(runner, file, 'loudnorm application', (tmp) =>
      buildLoudnormApplyArgs(file, tmp, stats, gate),
    );
  }

  if (options.verify === false) return { applied: true, cycles };

  let stats = await measureCompliance(runner, file);
  const decision = decideCorrection(stats, gate);
  let corrected = false;
  if (decision.apply) {
    log(`ebur128 gate: ${decision.reason}; reducing ${decision.reductionDb.toFixed(2)} dB.`);
    await reencodeInPlace(runner, file, 'true-peak correction', (tmp) =>
      buildGainReductionArgs(file, tmp, decision.reductionDb),
    );
    corrected = true;
    stats = await measureCompliance(runner, file);
  }

  if (!passesLoudnessGate(stats, gate)) {
    throw new Error(
      `LOUDNESS_GATE_MISSED: I=${stats.integratedLufs.toFixed(2)} LUFS, ` +
        `TP=${stats.truePeakDbtp.toFixed(2)} dBTP after normalization and correction.`,
    );
  }
  log(
    `ebur128 gate: I=${stats.integratedLufs.toFixed(2)} LUFS, ` +
      `TP=${stats.truePeakDbtp.toFixed(2)} dBTP — within gate.`,
  );
  return { applied: true, cycles, measured: stats, corrected };
}
