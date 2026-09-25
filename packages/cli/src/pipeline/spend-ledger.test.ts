/**
 * Spend ledger (FR-011): receipts journaled to `qa/spend.json` through the
 * core paid-operation engine, uncertain state on receipt-less failures, and
 * the explicit spend cap as the enforced limit.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PaidOperationError,
  completeOperation,
  type PaidOperationRecord,
} from '@videomaker/core';

import {
  FileSpendLedger,
  MissingSpendCapError,
  buildPaidPlan,
  completePaidAttempt,
  openAttempts,
  spendCapFromArgs,
  spendLedgerPath,
  submitPaidOnce,
} from './spend-ledger';

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vm-spend-'));
}

function planFor(spendCapUsd: number, estimatedCostUsd: number | null = 0.4) {
  return buildPaidPlan({
    command: 'gen-media',
    subject: 'gen-media:scene-a:abc',
    inputs: { sceneId: 'scene-a', prompt: 'x' },
    outputs: ['scenes/scene-a/media/video.mp4'],
    estimatedCostUsd,
    spendCapUsd,
    maxAttempts: 3,
  });
}

describe('FileSpendLedger', () => {
  test('receives provider receipts at qa/spend.json and completes them', async () => {
    const projectDir = await tempProject();
    const store = new FileSpendLedger(spendLedgerPath(projectDir));
    const plan = planFor(5);
    const outcome = await submitPaidOnce({
      store,
      plan,
      submit: async () => ({
        receipt: {
          provider: 'fal-video',
          providerJobId: 'job-1',
          submittedAt: '2026-01-01T00:00:00.000Z',
          raw: { statusUrl: 'https://queue.fal.media/status/1' },
        },
        status: { state: 'queued' },
      }),
    });
    expect(outcome.record.state).toBe('submitted');
    expect(outcome.record.reservedUsd).toBe(0.4);

    // The journal is on disk at qa/spend.json in core's gate shape.
    const raw = JSON.parse(await readFile(spendLedgerPath(projectDir), 'utf8')) as {
      schemaVersion: number;
      attempts: PaidOperationRecord[];
    };
    expect(raw.schemaVersion).toBe(1);
    expect(raw.attempts).toHaveLength(1);
    expect(raw.attempts[0]?.receipt?.requestId).toBe('job-1');
    expect(raw.attempts[0]?.receipt?.statusUrl).toBe('https://queue.fal.media/status/1');

    const completed = await completePaidAttempt(store, outcome.record.attemptId);
    expect(completed.state).toBe('completed');
    expect(await openAttempts(store)).toHaveLength(0);
  });

  test('journals an uncertain attempt when the submit fails without a receipt', async () => {
    const projectDir = await tempProject();
    const store = new FileSpendLedger(spendLedgerPath(projectDir));
    const plan = planFor(5);
    await expect(
      submitPaidOnce({
        store,
        plan,
        submit: async () => {
          throw new Error('connection reset mid-submit');
        },
      }),
    ).rejects.toThrow(PaidOperationError);

    const open = await openAttempts(store);
    expect(open).toHaveLength(1);
    expect(open[0]?.state).toBe('uncertain');
    expect(open[0]?.receipt).toBeUndefined();

    // The uncertain attempt blocks further submits for the plan (no auto-retry).
    await expect(
      submitPaidOnce({
        store,
        plan,
        submit: async () => ({
          receipt: {
            provider: 'fal-video',
            providerJobId: 'job-2',
            submittedAt: '2026-01-01T00:00:00.000Z',
          },
          status: { state: 'queued' },
        }),
      }),
    ).rejects.toThrow(/reconcile/i);
  });

  test('a receipt-less provider answer stays uncertain', async () => {
    const projectDir = await tempProject();
    const store = new FileSpendLedger(spendLedgerPath(projectDir));
    await expect(
      submitPaidOnce({
        store,
        plan: planFor(5),
        submit: async () => ({
          // No providerJobId: the outcome cannot be proven.
          receipt: {
            provider: 'fal-video',
            providerJobId: '',
            submittedAt: '2026-01-01T00:00:00.000Z',
          },
          status: { state: 'queued' },
        }),
      }),
    ).rejects.toThrow(PaidOperationError);
    const open = await openAttempts(store);
    expect(open[0]?.state).toBe('uncertain');
  });

  test('refuses submits over the spend cap', async () => {
    const projectDir = await tempProject();
    const store = new FileSpendLedger(spendLedgerPath(projectDir));
    const plan = buildPaidPlan({
      command: 'gen-media',
      subject: 'gen-media:scene-a:abc',
      inputs: { sceneId: 'scene-a' },
      outputs: ['scenes/scene-a/media/video.mp4'],
      estimatedCostUsd: 2,
      spendCapUsd: 3,
      maxAttempts: 3,
    });
    const first = await submitPaidOnce({
      store,
      plan,
      submit: async () => ({
        receipt: {
          provider: 'fal-video',
          providerJobId: 'job-1',
          submittedAt: '2026-01-01T00:00:00.000Z',
        },
        status: { state: 'queued' },
      }),
    });
    await completeOperation(store, first.record.attemptId);
    // Second attempt would reserve $2 more on top of the journalled $2 > $3.
    await expect(
      submitPaidOnce({
        store,
        plan,
        submit: async () => ({
          receipt: {
            provider: 'fal-video',
            providerJobId: 'job-2',
            submittedAt: '2026-01-01T00:00:00.000Z',
          },
          status: { state: 'queued' },
        }),
      }),
    ).rejects.toThrow(/spend cap/i);
  });

  test('an estimate above the cap cannot even become a plan', () => {
    expect(() => planFor(1, 2)).toThrow(/estimatedCostUsd/);
  });
});

describe('spendCapFromArgs', () => {
  test('requires an explicit, finite, non-negative cap', () => {
    expect(spendCapFromArgs('gen-audio', { 'spend-cap': 2.5 })).toBe(2.5);
    expect(spendCapFromArgs('gen-audio', { 'spend-cap': 0 })).toBe(0);
    expect(() => spendCapFromArgs('gen-audio', {})).toThrow(MissingSpendCapError);
    expect(() => spendCapFromArgs('gen-audio', {})).toThrow(/--spend-cap/);
    expect(() => spendCapFromArgs('gen-audio', { 'spend-cap': -1 })).toThrow(MissingSpendCapError);
  });
});
