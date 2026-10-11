/**
 * QA orchestration: loudness/true-peak verification (ebur128 analysis) plus
 * artifact hash verification against the evidence report written at assemble
 * time. Failures exit != 0 with actionable detail naming the offending
 * artifact — a tampered or re-rendered file can never pass silently.
 */
import {
  EVIDENCE_REPORT_RELATIVE,
  LOUDNESS_REPORT_RELATIVE,
  loudnessCheck,
  qaPassed,
  readEvidenceReport,
  readLoudnessReport,
  verifyArtifactHashes,
  writeEvidenceReport,
  writeLoudnessReport,
  type QaCheck,
  type QaEvidenceReport,
} from './evidence';
import { buildEbur128MeasureArgs, parseEbur128Summary } from '@videomaker/motion-remotion/loudness';
import { projectAbsolute } from './assemble';
import type { MediaCommandDeps } from './deps';

export interface QaOptions {
  projectDir: string;
  deps: MediaCommandDeps;
  /** Project-relative video to measure; default: the evidence result.mp4. */
  video?: string;
  now: () => Date;
  out: (line: string) => void;
}

export interface QaRunResult {
  /** 0 when every check passes (or is not-applicable); 1 otherwise. */
  exitCode: number;
  checks: QaCheck[];
  /** Actionable detail of every blocked check. */
  failures: string[];
  reportPath: string;
  loudnessPath: string;
}

/**
 * Re-verifies a finished render against its evidence: recorded sha256s are
 * re-hashed (tamper detection) and the loudness/true-peak is re-measured with
 * ebur128 against the tolerance from `qa/loudness.json`.
 */
export async function runQa(options: QaOptions): Promise<QaRunResult> {
  const { projectDir, deps } = options;
  const evidence: QaEvidenceReport = await readEvidenceReport(projectDir);
  const video = options.video ?? evidence.result.mp4;
  const checks: QaCheck[] = [];

  // Hash verification covers every produced artifact AND the result mp4 —
  // except the QA-owned reports: `vm qa` itself rewrites `qa/report.json` and
  // `qa/loudness.json` (see the spec's `writes`; loudness embeds a fresh
  // timestamp), so pinning them would flag every re-run as tampering. Render
  // and media artifacts stay pinned; a tampered or re-rendered file can never
  // pass silently.
  const qaOwned: Record<string, true> = {
    [LOUDNESS_REPORT_RELATIVE]: true,
    [EVIDENCE_REPORT_RELATIVE]: true,
  };
  const pinned = evidence.artifacts.filter((artifact) => qaOwned[artifact.path] !== true);
  const recorded = evidence.result.mp4 === video
    ? pinned
    : [
        ...pinned,
        { path: evidence.result.mp4, role: 'result', sha256: evidence.result.sha256, bytes: 0 },
      ];
  checks.push(await verifyArtifactHashes(projectDir, recorded));

  // Loudness/true-peak vs tolerance (defaults -14 ±1 LUFS / TP ≤ -1 dBTP).
  let tolerance = { targetLufs: -14, lufsTolerance: 1, targetTruePeakDbtp: -1 };
  try {
    const stored = await readLoudnessReport(projectDir);
    tolerance = stored.tolerance;
  } catch {
    options.out(`qa: no readable qa/loudness.json; using default tolerance.`);
  }
  const videoAbsolute = projectAbsolute(projectDir, video);
  const measurement = await deps.ffmpeg.run(buildEbur128MeasureArgs(videoAbsolute));
  if (measurement.exitCode !== 0) {
    checks.push({
      code: 'loudness',
      label: 'Loudness within tolerance (ebur128)',
      status: 'blocked',
      detail:
        `ebur128 measurement failed for ${video}: ${measurement.stderr.slice(-200)} — ` +
        'verify the file exists and ffmpeg is available.',
    });
  } else {
    const stats = parseEbur128Summary(measurement.stderr);
    checks.push(loudnessCheck(stats, tolerance, video));
    await writeLoudnessReport(projectDir, {
      schemaVersion: 1,
      createdAt: options.now().toISOString(),
      file: video,
      measured: {
        integratedLufs: stats.integratedLufs,
        loudnessRangeLu: stats.loudnessRangeLu,
        truePeakDbtp: stats.truePeakDbtp,
      },
      tolerance,
      passed: checks[checks.length - 1]?.status === 'pass',
    });
  }

  const report: QaEvidenceReport = {
    ...evidence,
    createdAt: options.now().toISOString(),
    command: 'qa',
    result: {
      ...evidence.result,
      ...(options.video !== undefined ? { mp4: video } : {}),
      qaPassed: qaPassed(checks),
    },
    checks,
  };
  const reportPath = await writeEvidenceReport(projectDir, report);
  const loudnessPath = 'qa/loudness.json';

  const failures = checks
    .filter((check) => check.status === 'blocked')
    .map((check) => `${check.code}: ${check.detail}`);
  for (const check of checks) {
    options.out(`qa: [${check.status === 'pass' ? 'PASS' : check.status === 'blocked' ? 'FAIL' : 'n/a'}] ${check.code} — ${check.detail}`);
  }
  if (failures.length > 0) {
    options.out(`qa: ${failures.length} check(s) failed; evidence updated at ${reportPath}.`);
    return { exitCode: 1, checks, failures, reportPath, loudnessPath };
  }
  options.out(`qa: all checks passed; evidence updated at ${reportPath}.`);
  return { exitCode: 0, checks, failures, reportPath, loudnessPath };
}
