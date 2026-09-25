/**
 * Metrics report contract: render facts, per-operation cost from receipts
 * (total vs cap), journal state counts and the overall verdict.
 */
import { describe, expect, test } from 'bun:test';

import { buildMetricsReport, formatMetricsReport, type MetricsInput } from './metrics';

const INPUT: MetricsInput = {
  createdAt: '2026-01-01T00:00:00.000Z',
  mode: 'offline',
  project: 'projects/demo/hello',
  video: {
    id: 'hello',
    mp4: 'renders/hello.mp4',
    sha256: 'a'.repeat(64),
    durationSeconds: 7.5,
    bytes: 123_456,
  },
  render: {
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:02:00.000Z',
    renderTimeSeconds: 120,
    totalFrames: 225,
    fps: 30,
  },
  spendCapUsd: 1,
  plannedUsd: 0,
  journal: {
    entries: [
      {
        attemptId: 'offline:gen-audio:0123456789abcdef',
        command: 'gen-audio',
        subject: 'offline:gen-audio:0123456789abcdef',
        state: 'completed',
        reservedUsd: 0,
        receiptRequestId: 'offline:gen-audio:0123456789abcdef',
      },
      {
        attemptId: 'attempt-2',
        command: 'gen-music',
        subject: 'gen-music:bed',
        state: 'completed',
        reservedUsd: 0.5,
        receiptRequestId: 'music-job-9',
      },
    ],
    counts: { uncertain: 0, submitted: 0, completed: 2, reconciled: 0 },
    totalReservedUsd: 0.5,
  },
  loudness: {
    integratedLufs: -14,
    truePeakDbtp: -1.5,
    targetLufs: -14,
    lufsTolerance: 1,
    targetTruePeakDbtp: -1,
    passed: true,
  },
  checks: [
    { code: 'render-probe', label: 'render', status: 'pass', detail: '7.50s with an audio stream.' },
  ],
};

describe('buildMetricsReport', () => {
  test('builds the report shape with spend totals vs cap and journal counts', () => {
    const report = buildMetricsReport(INPUT);
    expect(report.schemaVersion).toBe(1);
    expect(report.mode).toBe('offline');
    expect(report.video.durationSeconds).toBe(7.5);
    expect(report.render.renderTimeSeconds).toBe(120);
    expect(report.spend.capUsd).toBe(1);
    expect(report.spend.totalJournalledUsd).toBe(0.5);
    expect(report.spend.remainingUsd).toBe(0.5);
    expect(report.spend.operations).toHaveLength(2);
    expect(report.spend.operations[1]?.actualCostUsd).toBe(0.5);
    expect(report.journal).toEqual({
      submitted: 0,
      completed: 2,
      uncertain: 0,
      reconciled: 0,
    });
    expect(report.passed).toBe(true);
  });

  test('a failed check fails the verdict and documents uncertain attempts', () => {
    const report = buildMetricsReport({
      ...INPUT,
      journal: {
        entries: [
          {
            attemptId: 'attempt-x',
            command: 'gen-audio',
            subject: 'gen-audio:x',
            state: 'uncertain',
            reservedUsd: 0.3,
            receiptRequestId: null,
          },
        ],
        counts: { uncertain: 1, submitted: 0, completed: 0, reconciled: 0 },
        totalReservedUsd: 0.3,
      },
      checks: [
        { code: 'journal-integrity', label: 'journal', status: 'fail', detail: 'unresolved attempt' },
      ],
    });
    expect(report.passed).toBe(false);
    expect(report.journal.uncertain).toBe(1);
    expect(report.spend.operations[0]?.receiptRequestId).toBeNull();
    expect(report.spend.remainingUsd).toBeCloseTo(0.7, 6);
  });
});

describe('formatMetricsReport', () => {
  test('prints duration, cost per operation, totals and the verdict', () => {
    const text = formatMetricsReport(buildMetricsReport(INPUT)).join('\n');
    expect(text).toContain('7.50s');
    expect(text).toContain('render time 120.0s');
    expect(text).toContain('gen-audio');
    expect(text).toContain('spend total $0.5000 / cap $1.0000');
    expect(text).toContain('journal states: completed 2');
    expect(text).toContain('result: PASS');
    expect(text).toContain('offline:gen-audio:0123456789abcdef');
    expect(text).not.toMatch(/sk-|token\s*[=:]/i);
  });
});
