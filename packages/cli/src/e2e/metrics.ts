/**
 * Final e2e report (`qa/metrics.json` + printable summary): render metrics
 * (duration, size, render time), per-operation cost from the journal receipts
 * (total vs cap) and the journal state summary. Everything here is
 * secret-free by construction: receipts contribute ids, never values.
 */
import type { JournalEntrySummary, JournalSummary } from './journal';

export interface E2eCheck {
  code: string;
  label: string;
  status: 'pass' | 'fail';
  detail: string;
}

export interface MetricsVideo {
  id: string;
  /** Project-relative render (result contract's mp4). */
  mp4: string;
  sha256: string;
  durationSeconds: number;
  bytes: number;
}

export interface MetricsRender {
  startedAt: string;
  endedAt: string;
  renderTimeSeconds: number;
  totalFrames: number;
  fps: number;
}

export interface MetricsOperation {
  command: string;
  subject: string;
  attemptId: string;
  state: string;
  /** USD reserved by the attempt (0 for offline/free operations). */
  actualCostUsd: number;
  /** Provider receipt id (`offline:…` markers included); `null` when unproven. */
  receiptRequestId: string | null;
}

export interface MetricsSpend {
  /** Operator cap; `null` when the run carried no paid operations. */
  capUsd: number | null;
  plannedUsd: number;
  totalJournalledUsd: number;
  remainingUsd: number | null;
  operations: MetricsOperation[];
}

export interface MetricsLoudness {
  integratedLufs: number;
  truePeakDbtp: number;
  targetLufs: number;
  lufsTolerance: number;
  targetTruePeakDbtp: number;
  passed: boolean;
}

export interface MetricsReport {
  schemaVersion: 1;
  createdAt: string;
  mode: 'live' | 'offline';
  project: string;
  video: MetricsVideo;
  render: MetricsRender;
  spend: MetricsSpend;
  journal: {
    submitted: number;
    completed: number;
    uncertain: number;
    reconciled: number;
  };
  loudness: MetricsLoudness | null;
  checks: E2eCheck[];
  passed: boolean;
}

export interface MetricsInput {
  createdAt: string;
  mode: 'live' | 'offline';
  project: string;
  video: MetricsVideo;
  render: MetricsRender;
  spendCapUsd: number | null;
  plannedUsd: number;
  journal: JournalSummary;
  loudness: MetricsLoudness | null;
  checks: E2eCheck[];
}

function operationFromEntry(entry: JournalEntrySummary): MetricsOperation {
  return {
    command: entry.command,
    subject: entry.subject,
    attemptId: entry.attemptId,
    state: entry.state,
    actualCostUsd: entry.reservedUsd,
    receiptRequestId: entry.receiptRequestId,
  };
}

/** Builds the metrics report and the overall verdict (all checks must pass). */
export function buildMetricsReport(input: MetricsInput): MetricsReport {
  const operations = input.journal.entries.map(operationFromEntry);
  return {
    schemaVersion: 1,
    createdAt: input.createdAt,
    mode: input.mode,
    project: input.project,
    video: input.video,
    render: input.render,
    spend: {
      capUsd: input.spendCapUsd,
      plannedUsd: input.plannedUsd,
      totalJournalledUsd: input.journal.totalReservedUsd,
      remainingUsd:
        input.spendCapUsd === null
          ? null
          : Math.round((input.spendCapUsd - input.journal.totalReservedUsd) * 1e4) / 1e4,
      operations,
    },
    journal: {
      submitted: input.journal.counts.submitted,
      completed: input.journal.counts.completed,
      uncertain: input.journal.counts.uncertain,
      reconciled: input.journal.counts.reconciled,
    },
    loudness: input.loudness,
    checks: input.checks,
    passed: input.checks.every((check) => check.status === 'pass'),
  };
}

/** Printable final report; ids and costs only, never credential values. */
export function formatMetricsReport(report: MetricsReport): string[] {
  const lines = [
    `e2e report — mode ${report.mode}, project ${report.project}`,
    `  render ${report.video.mp4}: ${report.video.durationSeconds.toFixed(2)}s, ` +
      `${report.video.bytes} bytes, sha256 ${report.video.sha256.slice(0, 12)}…`,
    `  render time ${report.render.renderTimeSeconds.toFixed(1)}s ` +
      `(${report.render.totalFrames} frames @ ${report.render.fps} fps)`,
    '  cost per operation (from journal receipts):',
  ];
  if (report.spend.operations.length === 0) {
    lines.push('    (no journalled operations)');
  }
  for (const op of report.spend.operations) {
    lines.push(
      `    ${op.command.padEnd(10)} ${op.state.padEnd(10)} $${op.actualCostUsd.toFixed(4)}  ` +
        `${op.attemptId}  receipt ${op.receiptRequestId ?? '(unproven)'}`,
    );
  }
  lines.push(
    `  spend total $${report.spend.totalJournalledUsd.toFixed(4)} / ` +
      (report.spend.capUsd === null
        ? 'no cap (free run)'
        : `cap $${report.spend.capUsd.toFixed(4)} (remaining $${(report.spend.remainingUsd ?? 0).toFixed(4)})`),
  );
  lines.push(
    `  journal states: completed ${report.journal.completed}, submitted ${report.journal.submitted}, ` +
      `uncertain ${report.journal.uncertain}, reconciled ${report.journal.reconciled}`,
  );
  if (report.loudness !== null) {
    lines.push(
      `  loudness I=${report.loudness.integratedLufs.toFixed(2)} LUFS / ` +
        `TP=${report.loudness.truePeakDbtp.toFixed(2)} dBTP vs ` +
        `${report.loudness.targetLufs}±${report.loudness.lufsTolerance} LUFS / ` +
        `TP ≤ ${report.loudness.targetTruePeakDbtp} dBTP (${report.loudness.passed ? 'pass' : 'FAIL'})`,
    );
  }
  for (const check of report.checks) {
    lines.push(`  [${check.status === 'pass' ? 'PASS' : 'FAIL'}] ${check.code} — ${check.detail}`);
  }
  lines.push(`  result: ${report.passed ? 'PASS' : 'FAIL'}`);
  return lines;
}
