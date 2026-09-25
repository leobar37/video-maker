/**
 * Post-run self-checks of the e2e driver: the produced MP4 (duration > 0 and
 * an audio stream, via ffprobe), loudness within tolerance per `qa/loudness.json`,
 * and journal integrity (no unproven spend). Failures carry actionable detail
 * and gate the exit code.
 *
 * `repinLoudnessEvidence` keeps the evidence report honest across the qa
 * re-measurement: `runQa` rewrites `qa/loudness.json` with fresh stats, so the
 * report's recorded hash for it is re-pinned afterwards — the next `vm qa`
 * then verifies the artifacts byte-for-byte instead of failing on the
 * expected rewrite.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { sha256File } from '@videomaker/core';

import {
  LOUDNESS_REPORT_RELATIVE,
  readEvidenceReport,
  readLoudnessReport,
  writeEvidenceReport,
  type LoudnessReport,
} from '../pipeline/evidence';
import type { MediaCommandDeps } from '../pipeline/deps';

import type { JournalSummary } from './journal';
import type { E2eCheck, MetricsLoudness } from './metrics';

export interface RenderProbe {
  durationSeconds: number;
  hasAudio: boolean;
  bytes: number;
  check: E2eCheck;
}

/**
 * ffprobe the produced render: `duration > 0` and an audio stream present
 * (the acceptance contract) plus its size for the metrics report.
 */
export async function probeRenderArtifact(
  deps: MediaCommandDeps,
  projectDir: string,
  mp4Relative: string,
): Promise<RenderProbe> {
  const absolute = join(projectDir, ...mp4Relative.split('/'));
  const result = await deps.process.run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-show_entries',
    'stream=codec_type',
    '-of',
    'json',
    absolute,
  ]);
  const bytes = await stat(absolute).then((entry) => entry.size, () => 0);
  if (result.code !== 0) {
    return {
      durationSeconds: 0,
      hasAudio: false,
      bytes,
      check: {
        code: 'render-probe',
        label: 'Render has duration > 0 and an audio stream (ffprobe)',
        status: 'fail',
        detail: `ffprobe failed for ${mp4Relative}: ${result.stderr.slice(-200)}`,
      },
    };
  }
  let durationSeconds = 0;
  let hasAudio = false;
  try {
    const parsed = JSON.parse(result.stdout) as {
      format?: { duration?: unknown };
      streams?: Array<{ codec_type?: unknown }>;
    };
    const duration = Number(parsed.format?.duration);
    durationSeconds = Number.isFinite(duration) ? duration : 0;
    hasAudio = (parsed.streams ?? []).some((stream) => stream.codec_type === 'audio');
  } catch {
    // Falls through to the failed check below with the invalid payload named.
  }
  const problems: string[] = [];
  if (!(durationSeconds > 0)) problems.push(`duration is ${durationSeconds}s (expected > 0)`);
  if (!hasAudio) problems.push('no audio stream');
  return {
    durationSeconds,
    hasAudio,
    bytes,
    check: {
      code: 'render-probe',
      label: 'Render has duration > 0 and an audio stream (ffprobe)',
      status: problems.length > 0 ? 'fail' : 'pass',
      detail:
        problems.length > 0
          ? `${mp4Relative}: ${problems.join('; ')} — check the narration master and the render log.`
          : `${mp4Relative}: ${durationSeconds.toFixed(2)}s with an audio stream.`,
    },
  };
}

/** Loudness verdict vs the stored tolerance (ebur128 numbers). */
export function loudnessToleranceCheck(report: LoudnessReport): {
  check: E2eCheck;
  metrics: MetricsLoudness;
} {
  const metrics: MetricsLoudness = {
    integratedLufs: report.measured.integratedLufs,
    truePeakDbtp: report.measured.truePeakDbtp,
    targetLufs: report.tolerance.targetLufs,
    lufsTolerance: report.tolerance.lufsTolerance,
    targetTruePeakDbtp: report.tolerance.targetTruePeakDbtp,
    passed: report.passed,
  };
  return {
    check: {
      code: 'loudness-tolerance',
      label: 'Loudness within tolerance per qa/loudness.json',
      status: report.passed ? 'pass' : 'fail',
      detail:
        `I=${report.measured.integratedLufs.toFixed(2)} LUFS, ` +
        `TP=${report.measured.truePeakDbtp.toFixed(2)} dBTP vs ` +
        `${report.tolerance.targetLufs}±${report.tolerance.lufsTolerance} LUFS / ` +
        `TP ≤ ${report.tolerance.targetTruePeakDbtp} dBTP on ${report.file}`,
    },
    metrics,
  };
}

/** Journal integrity: every attempt proven and completed (nothing open). */
export function journalStateCheck(summary: JournalSummary): E2eCheck {
  const open = summary.entries.filter(
    (entry) => entry.state === 'uncertain' || entry.state === 'submitted',
  );
  return {
    code: 'journal-integrity',
    label: 'Spend journal holds receipts and no unresolved attempts',
    status: open.length > 0 ? 'fail' : 'pass',
    detail:
      open.length > 0
        ? `${open.length} unresolved attempt(s) in qa/spend.json (e.g. ${open[0]?.attemptId}); ` +
          'documented and never auto-retried — reconcile them before another run or a real publish.'
        : `${summary.entries.length} attempt(s), ${summary.counts.completed} completed, ` +
          `$${summary.totalReservedUsd.toFixed(4)} journalled.`,
  };
}

/**
 * Re-pins `qa/loudness.json`'s sha256 in `qa/report.json` after the qa stage
 * re-measured and rewrote it (the evidence report pins artifacts by hash; a
 * rewrite without a re-pin would look like tampering to the next `vm qa`).
 */
export async function repinLoudnessEvidence(projectDir: string): Promise<boolean> {
  const report = await readEvidenceReport(projectDir);
  const artifact = report.artifacts.find((entry) => entry.path === LOUDNESS_REPORT_RELATIVE);
  if (artifact === undefined) return false;
  const absolute = join(projectDir, ...LOUDNESS_REPORT_RELATIVE.split('/'));
  const sha256 = await sha256File(absolute);
  const bytes = await stat(absolute).then((entry) => entry.size, () => 0);
  if (artifact.sha256 === sha256 && artifact.bytes === bytes) return false;
  artifact.sha256 = sha256;
  artifact.bytes = bytes;
  await writeEvidenceReport(projectDir, report);
  return true;
}
