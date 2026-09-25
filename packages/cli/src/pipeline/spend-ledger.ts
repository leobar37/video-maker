/**
 * Spend ledger + one-shot paid submits.
 *
 * The ledger lives at `qa/spend.json` (`SPEND_LEDGER_RELATIVE`, the same file
 * core's `deriveGates` inspects for the `spend` gate): an append-only journal
 * of paid attempts in core's `PaidOperationRecord` shape. Every spending
 * command submits through `submitPaidOnce`, which wraps core's `submitOnce`:
 * exactly one provider submit per attempt, a receipt proving acceptance or an
 * `uncertain` journal entry that blocks further submits until an operator
 * reconciles it. Never auto-retry.
 */
import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';

import {
  completeOperation,
  sha256Json,
  submitOnce,
  validatePaidOperationPlan,
  validatePaidOperationRecord,
  type PaidOperationFilter,
  type PaidOperationPlan,
  type PaidOperationRecord,
  type PaidOperationStore,
  type ProviderReceipt,
} from '@videomaker/core';
import type { MediaJobStatus, PaidReceipt } from '@videomaker/providers';

/** Absolute path of a project's spend ledger. */
export function spendLedgerPath(projectDir: string): string {
  return join(projectDir, 'qa', 'spend.json');
}

interface LedgerFile {
  schemaVersion: 1;
  attempts: PaidOperationRecord[];
}

async function readLedgerFile(path: string): Promise<LedgerFile> {
  let text: string;
  try {
    text = await fsp.readFile(path, 'utf8');
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') {
      return { schemaVersion: 1, attempts: [] };
    }
    throw cause;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error(`Spend ledger ${path} is not valid JSON; reconcile it manually.`, { cause });
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Spend ledger ${path} has an invalid shape (expected {schemaVersion:1, attempts:[]}).`);
  }
  const parsed = raw as Record<string, unknown>;
  const attemptsRaw = parsed.attempts;
  if (parsed.schemaVersion !== 1 || !Array.isArray(attemptsRaw)) {
    throw new Error(`Spend ledger ${path} has an invalid shape (expected {schemaVersion:1, attempts:[]}).`);
  }
  const attempts = attemptsRaw.map((entry: unknown) => validatePaidOperationRecord(entry));
  return { schemaVersion: 1, attempts };
}

async function writeLedgerFile(path: string, file: LedgerFile): Promise<void> {
  await fsp.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, path);
}

/**
 * Append-only `PaidOperationStore` over `qa/spend.json`. The file keeps the
 * shape core's spend gate derives from: `{ schemaVersion: 1, attempts: [...] }`.
 */
export class FileSpendLedger implements PaidOperationStore {
  constructor(readonly path: string) {}

  async append(record: PaidOperationRecord): Promise<void> {
    const file = await readLedgerFile(this.path);
    file.attempts.push(validatePaidOperationRecord(record));
    await writeLedgerFile(this.path, file);
  }

  async get(attemptId: string): Promise<PaidOperationRecord | undefined> {
    return (await this.list()).find((record) => record.attemptId === attemptId);
  }

  async list(filter?: PaidOperationFilter): Promise<PaidOperationRecord[]> {
    const file = await readLedgerFile(this.path);
    const latest = new Map<string, PaidOperationRecord>();
    for (const entry of file.attempts) latest.set(entry.attemptId, entry);
    return [...latest.values()].filter(
      (record) =>
        (filter?.planDigest === undefined || record.planDigest === filter.planDigest) &&
        (filter?.subject === undefined || record.subject === filter.subject) &&
        (filter?.state === undefined || record.state === filter.state),
    );
  }
}

/** Attempts whose outcome is not yet proven (`uncertain`/`submitted`). */
export async function openAttempts(store: PaidOperationStore): Promise<PaidOperationRecord[]> {
  const all = await store.list();
  return all.filter((record) => record.state === 'uncertain' || record.state === 'submitted');
}

export interface PaidPlanInput {
  /** Command identity, e.g. `gen-audio`. */
  command: string;
  /** Subject of this spend (usually the idempotency key). */
  subject: string;
  /** Non-secret inputs folded into the plan digest. */
  inputs: Record<string, unknown>;
  /** Project-relative outputs this spend produces. */
  outputs: string[];
  /** Expected cost of one attempt, or null when the provider prices on return. */
  estimatedCostUsd: number | null;
  /** Hard cap on journalled USD across all attempts of this plan. */
  spendCapUsd: number;
  /** Hard cap on submits; default 1 (submit-once). */
  maxAttempts?: number;
}

/** Builds (and validates) the core paid plan for one intended spend. */
export function buildPaidPlan(input: PaidPlanInput): PaidOperationPlan {
  return validatePaidOperationPlan({
    schemaVersion: 1,
    command: input.command,
    subject: input.subject,
    inputsDigest: sha256Json(input.inputs),
    outputs: input.outputs,
    estimatedCostUsd: input.estimatedCostUsd,
    maxAttempts: input.maxAttempts ?? 1,
    spendCapUsd: input.spendCapUsd,
  });
}

/** A `PaidReceipt` whose `providerJobId` is missing: the outcome is unknown. */
function toCoreReceipt(receipt: PaidReceipt): ProviderReceipt {
  const requestId = receipt?.providerJobId;
  if (typeof requestId !== 'string' || requestId.trim().length === 0) {
    throw new Error('provider submit returned no receipt (missing providerJobId)');
  }
  const core: ProviderReceipt = { requestId };
  const raw = receipt.raw;
  for (const key of ['statusUrl', 'responseUrl'] as const) {
    const url = raw?.[key];
    if (typeof url !== 'string') continue;
    // Only credential-free HTTPS URLs may evidence a receipt (core's
    // `validateReceipt`): paths are fine, query/fragment/userinfo are not.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (
      parsed.protocol === 'https:' &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    ) {
      core[key] = url;
    }
  }
  return core;
}

export interface PaidSubmitOptions {
  store: PaidOperationStore;
  plan: PaidOperationPlan;
  /** Explicit attempt id (e.g. the idempotency key); else random. */
  attemptId?: string;
  now?: () => Date;
  /** The ONE provider submit. Resolve with its receipt; never retry. */
  submit: () => Promise<{ receipt: PaidReceipt; status: MediaJobStatus }>;
}

export interface PaidSubmitOutcome {
  record: PaidOperationRecord;
  receipt: PaidReceipt;
  status: MediaJobStatus;
  planDigest: string;
}

/**
 * Journals the attempt and performs exactly one provider submit. Success
 * requires a receipt (`submitted`); a submit that fails or answers without one
 * is journalled `uncertain` and blocks this plan until reconciled.
 */
export async function submitPaidOnce(options: PaidSubmitOptions): Promise<PaidSubmitOutcome> {
  let receipt: PaidReceipt | undefined;
  let status: MediaJobStatus | undefined;
  const record = await submitOnce({
    store: options.store,
    plan: options.plan,
    ...(options.attemptId !== undefined ? { attemptId: options.attemptId } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    submit: async () => {
      const outcome = await options.submit();
      receipt = outcome.receipt;
      status = outcome.status;
      return toCoreReceipt(outcome.receipt);
    },
  });
  if (!receipt || !status) {
    throw new Error('submit proven without a provider receipt payload; this is a bug.');
  }
  return { record, receipt, status, planDigest: record.planDigest };
}

/** Marks a receipt-proven attempt completed after its artifact landed. */
export async function completePaidAttempt(
  store: PaidOperationStore,
  attemptId: string,
  now?: () => Date,
): Promise<PaidOperationRecord> {
  return completeOperation(store, attemptId, now);
}

/** The explicit spend cap every paid run must carry before any submit. */
export class MissingSpendCapError extends Error {
  constructor(command: string) {
    super(
      `${command} refuses to spend without an explicit cap: pass --spend-cap <USD> ` +
        `(0 is allowed for explicitly free operations). This is the hard limit ` +
        `journalled against every submit.`,
    );
    this.name = 'MissingSpendCapError';
  }
}

/**
 * Reads the explicit `--spend-cap` from parsed args. Throws
 * `MissingSpendCapError` when absent or invalid — a paid run never guesses a
 * budget.
 */
export function spendCapFromArgs(
  command: string,
  args: Record<string, string | number | boolean | string[]>,
): number {
  const raw = args['spend-cap'];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    throw new MissingSpendCapError(command);
  }
  return raw;
}
