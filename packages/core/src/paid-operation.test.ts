import { describe, expect, test } from 'bun:test';

import {
  InMemoryPaidOperationStore,
  PaidOperationError,
  completeOperation,
  paidPlanDigest,
  reconcileOperation,
  submitOnce,
  validatePaidOperationPlan,
  validatePaidOperationRecord,
  validateReceipt,
  type PaidOperationPlan,
  type PaidOperationRecord,
} from './paid-operation';

function plan(overrides: Partial<PaidOperationPlan> = {}): PaidOperationPlan {
  return {
    schemaVersion: 1,
    command: 'gen-audio',
    subject: 'script/audio/s1.wav',
    inputsDigest: 'a'.repeat(64),
    outputs: ['script/audio/s1.wav', 'script/audio/s1.json'],
    estimatedCostUsd: 1,
    maxAttempts: 3,
    spendCapUsd: 10,
    ...overrides,
  };
}

const receipt = { requestId: 'req-1', statusUrl: 'https://provider.example/ops/req-1' };

function capturePaidError(fn: () => unknown): PaidOperationError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PaidOperationError);
  if (!(caught instanceof PaidOperationError)) throw new Error('expected PaidOperationError');
  return caught;
}

async function capturePaidErrorAsync(fn: () => Promise<unknown>): Promise<PaidOperationError> {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PaidOperationError);
  if (!(caught instanceof PaidOperationError)) throw new Error('expected PaidOperationError');
  return caught;
}

describe('paidPlanDigest', () => {
  test('is stable across key order', () => {
    const reordered: PaidOperationPlan = {
      spendCapUsd: 10,
      maxAttempts: 3,
      estimatedCostUsd: 1,
      outputs: ['script/audio/s1.wav', 'script/audio/s1.json'],
      inputsDigest: 'a'.repeat(64),
      subject: 'script/audio/s1.wav',
      command: 'gen-audio',
      schemaVersion: 1,
    };
    expect(paidPlanDigest(plan())).toBe(paidPlanDigest(reordered));
  });

  test('changes when a plan field changes', () => {
    expect(paidPlanDigest(plan())).not.toBe(paidPlanDigest(plan({ spendCapUsd: 11 })));
    expect(paidPlanDigest(plan())).not.toBe(paidPlanDigest(plan({ inputsDigest: 'b'.repeat(64) })));
  });

  test('rejects invalid plans', () => {
    expect(capturePaidError(() => paidPlanDigest(plan({ maxAttempts: 0 }))).code).toBe(
      'INVALID_PLAN',
    );
  });
});

describe('validatePaidOperationPlan', () => {
  test('accepts a well-formed plan', () => {
    expect(validatePaidOperationPlan(plan()).subject).toBe('script/audio/s1.wav');
    expect(validatePaidOperationPlan(plan({ estimatedCostUsd: null })).estimatedCostUsd).toBeNull();
  });

  test('rejects malformed plans', () => {
    const cases: unknown[] = [
      { ...plan(), schemaVersion: 2 },
      { ...plan(), subject: '  ' },
      { ...plan(), outputs: [] },
      { ...plan(), estimatedCostUsd: -1 },
      { ...plan(), estimatedCostUsd: 99 },
      { ...plan(), maxAttempts: 1.5 },
      { ...plan(), spendCapUsd: Number.NaN },
      { ...plan(), spendCapUsd: -2 },
    ];
    for (const bad of cases) {
      expect(capturePaidError(() => validatePaidOperationPlan(bad)).code).toBe('INVALID_PLAN');
    }
    expect(capturePaidError(() => validatePaidOperationPlan(null)).code).toBe('INVALID_PLAN');
    expect(capturePaidError(() => validatePaidOperationPlan({ ...plan(), extra: 'x' })).code).toBe(
      'INVALID_PLAN',
    );
  });
});

describe('validateReceipt', () => {
  test('accepts receipts with safe URLs', () => {
    expect(validateReceipt(receipt).requestId).toBe('req-1');
    expect(validateReceipt({ requestId: 'only-id' }).statusUrl).toBeUndefined();
  });

  test('rejects malformed receipts', () => {
    for (const bad of [
      null,
      { requestId: '' },
      { requestId: 'r', statusUrl: 'http://insecure.example/x' },
      { requestId: 'r', statusUrl: 'https://provider.example/x?token=1' },
      { requestId: 'r', responseUrl: 'https://user:pass@provider.example/x' },
    ]) {
      expect(capturePaidError(() => validateReceipt(bad)).code).toBe('INVALID_RECEIPT');
    }
  });
});

describe('submitOnce', () => {
  test('journals a successful submit as submitted with its receipt', async () => {
    const store = new InMemoryPaidOperationStore();
    const record = await submitOnce({ store, plan: plan(), submit: async () => receipt });
    expect(record.state).toBe('submitted');
    expect(record.receipt?.requestId).toBe('req-1');
    expect(record.planDigest).toBe(paidPlanDigest(plan()));
    expect((await store.get(record.attemptId))?.state).toBe('submitted');
    expect(await store.list({ planDigest: record.planDigest })).toHaveLength(1);
  });

  test('journals unknown outcomes as uncertain and never auto-retries', async () => {
    const store = new InMemoryPaidOperationStore();
    let submits = 0;
    const failing = async (): Promise<unknown> => {
      submits += 1;
      throw new Error('provider exploded');
    };
    const first = await capturePaidErrorAsync(() => submitOnce({ store, plan: plan(), submit: failing }));
    expect(first.code).toBe('SUBMIT_FAILED');
    expect(first.attemptId).toBeString();
    const open = await store.get(first.attemptId!);
    expect(open?.state).toBe('uncertain');
    expect(open?.receipt).toBeUndefined();

    const second = await capturePaidErrorAsync(() => submitOnce({ store, plan: plan(), submit: failing }));
    expect(second.code).toBe('UNRESOLVED_ATTEMPT');
    expect(second.attemptId).toBe(first.attemptId);
    expect(submits).toBe(1);
  });

  test('keeps the attempt uncertain when no receipt is returned', async () => {
    const store = new InMemoryPaidOperationStore();
    const noReceipt = await capturePaidErrorAsync(() =>
      submitOnce({ store, plan: plan(), submit: async () => null }),
    );
    expect(noReceipt.code).toBe('RECEIPT_REQUIRED');
    expect((await store.get(noReceipt.attemptId!))?.state).toBe('uncertain');
    const blocked = await capturePaidErrorAsync(() =>
      submitOnce({ store, plan: plan(), submit: async () => receipt }),
    );
    expect(blocked.code).toBe('UNRESOLVED_ATTEMPT');
  });

  test('keeps the attempt uncertain on an invalid receipt', async () => {
    const store = new InMemoryPaidOperationStore();
    const bad = await capturePaidErrorAsync(() =>
      submitOnce({ store, plan: plan(), submit: async () => ({ requestId: '' }) }),
    );
    expect(bad.code).toBe('INVALID_RECEIPT');
    expect((await store.get(bad.attemptId!))?.state).toBe('uncertain');
  });

  test('refuses when attempts are exhausted', async () => {
    const store = new InMemoryPaidOperationStore();
    const limited = plan({ maxAttempts: 1, estimatedCostUsd: 0.5, spendCapUsd: 5 });
    const record = await submitOnce({ store, plan: limited, submit: async () => receipt });
    await completeOperation(store, record.attemptId);
    await reconcileOperation(store, record.attemptId, { by: 'ops', evidence: 'ticket-1' });
    const error = await capturePaidErrorAsync(() =>
      submitOnce({ store, plan: limited, submit: async () => receipt }),
    );
    expect(error.code).toBe('ATTEMPTS_EXHAUSTED');
  });

  test('refuses when the spend cap would be exceeded', async () => {
    const store = new InMemoryPaidOperationStore();
    const capped = plan({ estimatedCostUsd: 1.5, spendCapUsd: 2, maxAttempts: 5 });
    const record = await submitOnce({ store, plan: capped, submit: async () => receipt });
    await completeOperation(store, record.attemptId);
    await reconcileOperation(store, record.attemptId, { by: 'ops', evidence: 'ticket-1' });
    const error = await capturePaidErrorAsync(() =>
      submitOnce({ store, plan: capped, submit: async () => receipt }),
    );
    expect(error.code).toBe('SPEND_CAP_EXCEEDED');
  });

  test('reserves zero when the plan has no cost estimate', async () => {
    const store = new InMemoryPaidOperationStore();
    const record = await submitOnce({
      store,
      plan: plan({ estimatedCostUsd: null }),
      submit: async () => receipt,
    });
    expect(record.reservedUsd).toBe(0);
  });
});

describe('completeOperation', () => {
  test('completes a submitted attempt', async () => {
    const store = new InMemoryPaidOperationStore();
    const record = await submitOnce({ store, plan: plan(), submit: async () => receipt });
    const completed = await completeOperation(store, record.attemptId);
    expect(completed.state).toBe('completed');
    expect((await store.get(record.attemptId))?.state).toBe('completed');
    expect(completed.receipt?.requestId).toBe('req-1');
    expect((await capturePaidErrorAsync(() => completeOperation(store, record.attemptId))).code).toBe(
      'INVALID_TRANSITION',
    );
  });

  test('refuses unknown or non-submitted attempts', async () => {
    const store = new InMemoryPaidOperationStore();
    expect((await capturePaidErrorAsync(() => completeOperation(store, 'nope'))).code).toBe(
      'UNKNOWN_ATTEMPT',
    );

    const failed = async (): Promise<unknown> => {
      throw new Error('boom');
    };
    const uncertain = await capturePaidErrorAsync(() =>
      submitOnce({ store, plan: plan(), submit: failed }),
    );
    expect((await capturePaidErrorAsync(() => completeOperation(store, uncertain.attemptId!))).code).toBe(
      'INVALID_TRANSITION',
    );
    expect((await capturePaidErrorAsync(() => completeOperation(store, uncertain.attemptId!))).code).toBe(
      'INVALID_TRANSITION',
    );
  });
});

describe('reconcileOperation', () => {
  test('reconciles an uncertain attempt and unblocks new submits', async () => {
    const store = new InMemoryPaidOperationStore();
    const failed = async (): Promise<unknown> => {
      throw new Error('boom');
    };
    const uncertain = await capturePaidErrorAsync(() =>
      submitOnce({ store, plan: plan(), submit: failed }),
    );
    const reconciled = await reconcileOperation(store, uncertain.attemptId!, {
      by: 'ops',
      evidence: 'provider dashboard shows no charge',
    });
    expect(reconciled.state).toBe('reconciled');
    expect(reconciled.reconciliation?.by).toBe('ops');
    expect(reconciled.reconciliation?.evidence).toBe('provider dashboard shows no charge');

    const retry = await submitOnce({ store, plan: plan(), submit: async () => receipt });
    expect(retry.state).toBe('submitted');
    expect(retry.attemptId).not.toBe(uncertain.attemptId);
  });

  test('requires explicit reconciliation evidence', async () => {
    const store = new InMemoryPaidOperationStore();
    const record = await submitOnce({ store, plan: plan(), submit: async () => receipt });
    expect(
      (await capturePaidErrorAsync(() =>
        reconcileOperation(store, record.attemptId, { by: '', evidence: 'ticket' }),
      )).code,
    ).toBe('INVALID_RECONCILIATION');
    expect(
      (await capturePaidErrorAsync(() =>
        reconcileOperation(store, record.attemptId, { by: 'ops', evidence: '  ' }),
      )).code,
    ).toBe('INVALID_RECONCILIATION');
  });

  test('refuses unknown or already reconciled attempts', async () => {
    const store = new InMemoryPaidOperationStore();
    expect(
      (await capturePaidErrorAsync(() =>
        reconcileOperation(store, 'ghost', { by: 'ops', evidence: 'ticket' }),
      )).code,
    ).toBe('UNKNOWN_ATTEMPT');

    const record = await submitOnce({ store, plan: plan(), submit: async () => receipt });
    await reconcileOperation(store, record.attemptId, { by: 'ops', evidence: 'ticket' });
    expect(
      (await capturePaidErrorAsync(() =>
        reconcileOperation(store, record.attemptId, { by: 'ops', evidence: 'ticket-2' }),
      )).code,
    ).toBe('INVALID_TRANSITION');
  });
});

describe('validatePaidOperationRecord', () => {
  function record(overrides: Partial<PaidOperationRecord> = {}): PaidOperationRecord {
    return {
      schemaVersion: 1,
      attemptId: 'att-1',
      planDigest: 'b'.repeat(64),
      command: 'gen-audio',
      subject: 'script/audio/s1.wav',
      state: 'submitted',
      reservedUsd: 1,
      createdAt: '2026-09-24T12:00:00.000Z',
      receipt,
      ...overrides,
    };
  }

  test('accepts consistent entries', () => {
    expect(validatePaidOperationRecord(record()).attemptId).toBe('att-1');
    expect(
      validatePaidOperationRecord(record({ state: 'uncertain', receipt: undefined })).state,
    ).toBe('uncertain');
    expect(
      validatePaidOperationRecord(
        record({
          state: 'reconciled',
          reconciliation: { by: 'ops', at: '2026-09-24T13:00:00.000Z', evidence: 'ticket' },
        }),
      ).state,
    ).toBe('reconciled');
  });

  test('rejects inconsistent entries', () => {
    const cases: PaidOperationRecord[] = [
      record({ receipt: undefined }),
      record({ state: 'uncertain' }),
      record({ state: 'reconciled', reconciliation: undefined }),
      record({ reconciliation: { by: 'ops', at: '2026-09-24T13:00:00.000Z', evidence: 'ticket' } }),
      record({ state: 'draft' as PaidOperationRecord['state'] }),
      record({ reservedUsd: -1 }),
      record({ createdAt: 'not-a-date' }),
    ];
    for (const bad of cases) {
      expect(capturePaidError(() => validatePaidOperationRecord(bad)).code).toBe('INVALID_RECORD');
    }
  });
});

describe('InMemoryPaidOperationStore', () => {
  test('rejects invalid entries on append', async () => {
    const store = new InMemoryPaidOperationStore();
    const invalid = {
      schemaVersion: 1,
      attemptId: 'att-1',
      planDigest: 'b'.repeat(64),
      command: 'gen-audio',
      subject: 'script/audio/s1.wav',
      state: 'submitted',
      reservedUsd: 1,
      createdAt: '2026-09-24T12:00:00.000Z',
    } as unknown as PaidOperationRecord;
    expect((await capturePaidErrorAsync(() => store.append(invalid))).code).toBe('INVALID_RECORD');
  });

  test('exposes the latest entry per attempt id', async () => {
    const store = new InMemoryPaidOperationStore();
    const base = {
      schemaVersion: 1 as const,
      attemptId: 'att-1',
      planDigest: 'b'.repeat(64),
      command: 'gen-audio',
      subject: 'script/audio/s1.wav',
      reservedUsd: 1,
      createdAt: '2026-09-24T12:00:00.000Z',
      receipt,
    };
    await store.append({ ...base, state: 'submitted' });
    await store.append({ ...base, state: 'completed' });
    await store.append({
      ...base,
      attemptId: 'att-2',
      planDigest: 'c'.repeat(64),
      state: 'uncertain',
      receipt: undefined,
      reservedUsd: 2,
    });

    expect((await store.get('att-1'))?.state).toBe('completed');
    expect(await store.get('ghost')).toBeUndefined();
    expect(await store.list()).toHaveLength(2);
    expect(await store.list({ planDigest: 'b'.repeat(64) })).toHaveLength(1);
    expect(await store.list({ state: 'uncertain' })).toHaveLength(1);
    expect(await store.list({ subject: 'script/audio/s1.wav' })).toHaveLength(2);
  });
});
