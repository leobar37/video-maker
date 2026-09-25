/**
 * Journal bridge for the e2e: $0 offline operations and run summaries over
 * `qa/spend.json` (core's spend gate file). Offline entries go through the
 * SAME core paid-operation engine as live submits — `submitPaidOnce` +
 * `completePaidAttempt` — with an `offline:` receipt marker and `reservedUsd`
 * 0, so every operation the pipeline performed is documented in one journal
 * and the spend invariants (submit-once, receipts, uncertain states) hold in
 * both modes.
 */
import type { PaidOperationRecord, PaidOperationState } from '@videomaker/core';
import { paidPlanDigest } from '@videomaker/core';
import type { PaidReceipt } from '@videomaker/providers';

import {
  buildPaidPlan,
  completePaidAttempt,
  submitPaidOnce,
  FileSpendLedger,
  spendLedgerPath,
} from '../pipeline/spend-ledger';

/** Receipt `provider` marker of locally performed, $0 operations. */
export const OFFLINE_RECEIPT_PROVIDER = 'offline';

export interface OfflineJournalInput {
  /** Pipeline command being documented, e.g. `gen-audio`. */
  command: string;
  /** Subject (idempotency key) of the operation. */
  subject: string;
  /** Non-secret inputs folded into the plan digest. */
  inputs: Record<string, unknown>;
  /** Project-relative outputs the operation produced. */
  outputs: string[];
  now: () => Date;
}

export interface OfflineJournalResult {
  attemptId: string;
  state: PaidOperationState;
  reservedUsd: number;
  /** True when a completed entry already documented this operation. */
  replayed: boolean;
}

/**
 * Journals one offline operation as a receipt-proven $0 attempt (idempotent:
 * a completed entry for the same plan is reused, never duplicated). A prior
 * `uncertain`/`submitted` entry surfaces the core `UNRESOLVED_ATTEMPT` refusal
 * unchanged — documented, never auto-retried.
 */
export async function journalOfflineOperation(
  projectDir: string,
  input: OfflineJournalInput,
): Promise<OfflineJournalResult> {
  const store = new FileSpendLedger(spendLedgerPath(projectDir));
  const plan = buildPaidPlan({
    command: input.command,
    subject: input.subject,
    inputs: input.inputs,
    outputs: input.outputs,
    estimatedCostUsd: 0,
    spendCapUsd: 0,
    maxAttempts: 3,
  });
  const history = await store.list({ planDigest: paidPlanDigest(plan) });
  const completed = history.find((record) => record.state === 'completed');
  if (completed) {
    return {
      attemptId: completed.attemptId,
      state: completed.state,
      reservedUsd: completed.reservedUsd,
      replayed: true,
    };
  }
  const attemptId = `offline:${input.subject}`;
  const submitted = await submitPaidOnce({
    store,
    plan,
    attemptId,
    now: input.now,
    submit: async () => {
      const receipt: PaidReceipt = {
        provider: OFFLINE_RECEIPT_PROVIDER,
        providerJobId: attemptId,
        submittedAt: input.now().toISOString(),
        costUsd: 0,
      };
      return { receipt, status: { state: 'succeeded' } };
    },
  });
  const record = await completePaidAttempt(store, submitted.record.attemptId, input.now);
  return {
    attemptId: record.attemptId,
    state: record.state,
    reservedUsd: record.reservedUsd,
    replayed: false,
  };
}

export interface JournalEntrySummary {
  attemptId: string;
  command: string;
  subject: string;
  state: PaidOperationState;
  reservedUsd: number;
  /** Provider receipt id (never a secret); `null` on unproven entries. */
  receiptRequestId: string | null;
}

export interface JournalSummary {
  entries: JournalEntrySummary[];
  counts: Record<PaidOperationState, number>;
  totalReservedUsd: number;
}

/** Reads the project journal and summarizes states and journalled spend. */
export async function readJournalSummary(projectDir: string): Promise<JournalSummary> {
  const store = new FileSpendLedger(spendLedgerPath(projectDir));
  const records: PaidOperationRecord[] = await store.list();
  const counts: Record<PaidOperationState, number> = {
    uncertain: 0,
    submitted: 0,
    completed: 0,
    reconciled: 0,
  };
  const entries: JournalEntrySummary[] = records.map((record) => {
    counts[record.state] += 1;
    return {
      attemptId: record.attemptId,
      command: record.command,
      subject: record.subject,
      state: record.state,
      reservedUsd: record.reservedUsd,
      receiptRequestId: record.receipt?.requestId ?? null,
    };
  });
  return {
    entries,
    counts,
    totalReservedUsd: entries.reduce((sum, entry) => sum + entry.reservedUsd, 0),
  };
}
