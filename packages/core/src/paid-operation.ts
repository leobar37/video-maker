/**
 * Paid-operation engine: planning, journalling and one-shot submission of
 * operations that spend money.
 *
 * Invariants (FR-011 spend safety):
 * - A submit is performed exactly once per call (`submitOnce` never retries on
 *   its own). Any submit whose outcome is not proven by a provider receipt is
 *   journalled as `uncertain` and blocks further submits for the same plan
 *   until it is explicitly `reconciled` — an uncertain outcome may have spent
 *   money, so silently retrying could spend it twice.
 * - Plans carry explicit `maxAttempts` and `spendCapUsd` limits; both are
 *   enforced before every submit against the plan's journalled history.
 * - The journal is append-only: the last entry for an attempt id is its
 *   current state.
 */
import { randomUUID } from 'node:crypto';

import { sha256Json } from './hash';
import { isRecord } from './guards';

/** On-disk location of a project's spend ledger (relative to the project dir). */
export const SPEND_LEDGER_RELATIVE = 'qa/spend.json';

export type PaidOperationErrorCode =
  | 'INVALID_PLAN'
  | 'INVALID_RECEIPT'
  | 'INVALID_RECORD'
  | 'INVALID_RECONCILIATION'
  | 'UNKNOWN_ATTEMPT'
  | 'UNRESOLVED_ATTEMPT'
  | 'ATTEMPTS_EXHAUSTED'
  | 'SPEND_CAP_EXCEEDED'
  | 'INVALID_TRANSITION'
  | 'SUBMIT_FAILED'
  | 'RECEIPT_REQUIRED';

/** Stable machine-readable code; the message is operator-facing context. */
export class PaidOperationError extends Error {
  constructor(
    public readonly code: PaidOperationErrorCode,
    message: string,
    public readonly attemptId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PaidOperationError';
  }
}

/** Planned paid operation with explicit attempt and spend limits. */
export interface PaidOperationPlan {
  schemaVersion: 1;
  command: string;
  subject: string;
  inputsDigest: string;
  outputs: string[];
  /** Expected cost of one attempt, or null when the provider prices on return. */
  estimatedCostUsd: number | null;
  /** Hard cap on submits for this plan. */
  maxAttempts: number;
  /** Hard cap on journalled USD across all attempts of this plan. */
  spendCapUsd: number;
}

/** Provider proof that a submit was accepted. */
export interface ProviderReceipt {
  requestId: string;
  statusUrl?: string;
  responseUrl?: string;
}

export type PaidOperationState = 'uncertain' | 'submitted' | 'completed' | 'reconciled';

/** Explicit human reconciliation of an uncertain outcome. */
export interface PaidOperationReconciliation {
  by: string;
  /** ISO timestamp of the reconciliation. */
  at: string;
  /** Where the proof lives (URL, ticket, provider dashboard note). */
  evidence: string;
}

export interface PaidOperationRecord {
  schemaVersion: 1;
  attemptId: string;
  planDigest: string;
  command: string;
  subject: string;
  state: PaidOperationState;
  /** USD reserved by this attempt (the attempt's planned/known cost). */
  reservedUsd: number;
  /** ISO timestamp of this journal entry. */
  createdAt: string;
  receipt?: ProviderReceipt;
  reconciliation?: PaidOperationReconciliation;
}

export interface PaidOperationFilter {
  planDigest?: string;
  subject?: string;
  state?: PaidOperationState;
}

/**
 * Append-only journal of paid attempts. `append` only adds entries (including
 * state transitions for an existing attempt id); `get`/`list` expose the
 * current state of each attempt (its latest entry).
 */
export interface PaidOperationStore {
  append(record: PaidOperationRecord): Promise<void>;
  /** Current state of one attempt, by attempt id. */
  get(attemptId: string): Promise<PaidOperationRecord | undefined>;
  /** Current state of every attempt (latest entry per attempt id). */
  list(filter?: PaidOperationFilter): Promise<PaidOperationRecord[]>;
}

function invalid(code: PaidOperationErrorCode, message: string, attemptId?: string): never {
  throw new PaidOperationError(code, message, attemptId);
}

function requireText(value: unknown, label: string, code: PaidOperationErrorCode): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(code, `${label} must be a non-empty string.`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string, code: PaidOperationErrorCode): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    invalid(code, `${label} must be an ISO timestamp.`);
  }
  return value;
}

/**
 * Closed contracts only: unknown fields would otherwise leak into
 * `paidPlanDigest` and let two different plans collide on one digest.
 */
function rejectUnknownFields(
  value: Record<string, unknown>,
  fields: Record<string, true>,
  label: string,
  code: PaidOperationErrorCode,
): void {
  for (const key of Object.keys(value)) {
    if (fields[key] !== true) {
      invalid(code, `${label} has unknown field ${JSON.stringify(key)}.`);
    }
  }
}

const PLAN_FIELDS: Record<string, true> = {
  schemaVersion: true,
  command: true,
  subject: true,
  inputsDigest: true,
  outputs: true,
  estimatedCostUsd: true,
  maxAttempts: true,
  spendCapUsd: true,
};

const RECEIPT_FIELDS: Record<string, true> = {
  requestId: true,
  statusUrl: true,
  responseUrl: true,
};

const RECORD_FIELDS: Record<string, true> = {
  schemaVersion: true,
  attemptId: true,
  planDigest: true,
  command: true,
  subject: true,
  state: true,
  reservedUsd: true,
  createdAt: true,
  receipt: true,
  reconciliation: true,
};

/** Validates an untrusted plan payload; throws `INVALID_PLAN` on any violation. */
export function validatePaidOperationPlan(value: unknown): PaidOperationPlan {
  if (!isRecord(value)) invalid('INVALID_PLAN', 'Plan must be an object.');
  rejectUnknownFields(value, PLAN_FIELDS, 'Plan', 'INVALID_PLAN');
  if (value.schemaVersion !== 1) invalid('INVALID_PLAN', 'Plan schemaVersion must be 1.');
  requireText(value.command, 'plan.command', 'INVALID_PLAN');
  requireText(value.subject, 'plan.subject', 'INVALID_PLAN');
  requireText(value.inputsDigest, 'plan.inputsDigest', 'INVALID_PLAN');
  if (!Array.isArray(value.outputs) || value.outputs.length === 0) {
    invalid('INVALID_PLAN', 'plan.outputs must be a non-empty array.');
  }
  value.outputs.forEach((output, index) =>
    requireText(output, `plan.outputs[${index}]`, 'INVALID_PLAN'),
  );
  const spendCapUsd = value.spendCapUsd;
  if (typeof spendCapUsd !== 'number' || !Number.isFinite(spendCapUsd) || spendCapUsd < 0) {
    invalid('INVALID_PLAN', 'plan.spendCapUsd must be a finite non-negative number.');
  }
  const estimatedCostUsd = value.estimatedCostUsd;
  if (estimatedCostUsd !== null) {
    if (
      typeof estimatedCostUsd !== 'number' ||
      !Number.isFinite(estimatedCostUsd) ||
      estimatedCostUsd < 0
    ) {
      invalid('INVALID_PLAN', 'plan.estimatedCostUsd must be null or a finite non-negative number.');
    }
    if (estimatedCostUsd > spendCapUsd) {
      invalid('INVALID_PLAN', 'plan.estimatedCostUsd must not exceed plan.spendCapUsd.');
    }
  }
  const maxAttempts = value.maxAttempts;
  if (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    invalid('INVALID_PLAN', 'plan.maxAttempts must be a positive integer.');
  }
  return value as unknown as PaidOperationPlan;
}

/** Stable plan identity: key order never changes the digest. */
export function paidPlanDigest(plan: PaidOperationPlan): string {
  return sha256Json(validatePaidOperationPlan(plan));
}

/** Validates a provider receipt; HTTPS URLs without credentials or tokens. */
export function validateReceipt(value: unknown): ProviderReceipt {
  if (!isRecord(value)) invalid('INVALID_RECEIPT', 'Receipt must be an object.');
  rejectUnknownFields(value, RECEIPT_FIELDS, 'Receipt', 'INVALID_RECEIPT');
  requireText(value.requestId, 'receipt.requestId', 'INVALID_RECEIPT');
  for (const key of ['statusUrl', 'responseUrl'] as const) {
    const url = value[key];
    if (url === undefined) continue;
    if (typeof url !== 'string') invalid('INVALID_RECEIPT', `receipt.${key} must be a string.`);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (cause) {
      throw new PaidOperationError('INVALID_RECEIPT', `receipt.${key} is not a valid URL.`, undefined, { cause });
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      invalid('INVALID_RECEIPT', `receipt.${key} must be an HTTPS URL without credentials or tokens.`);
    }
  }
  return value as unknown as ProviderReceipt;
}

/** Validates a journal entry including its per-state evidence invariants. */
export function validatePaidOperationRecord(value: unknown): PaidOperationRecord {
  const code: PaidOperationErrorCode = 'INVALID_RECORD';
  if (!isRecord(value)) invalid(code, 'Journal entry must be an object.');
  rejectUnknownFields(value, RECORD_FIELDS, 'Journal entry', code);
  if (value.schemaVersion !== 1) invalid(code, 'Journal entry schemaVersion must be 1.');
  requireText(value.attemptId, 'attemptId', code);
  requireText(value.planDigest, 'planDigest', code);
  requireText(value.command, 'command', code);
  requireText(value.subject, 'subject', code);
  if (
    value.state !== 'uncertain' &&
    value.state !== 'submitted' &&
    value.state !== 'completed' &&
    value.state !== 'reconciled'
  ) {
    invalid(code, 'Unknown journal state.', value.attemptId as string);
  }
  if (typeof value.reservedUsd !== 'number' || !Number.isFinite(value.reservedUsd) || value.reservedUsd < 0) {
    invalid(code, 'reservedUsd must be a finite non-negative number.', value.attemptId as string);
  }
  requireTimestamp(value.createdAt, 'createdAt', code);
  const state = value.state as PaidOperationState;
  if (state === 'uncertain' && value.receipt !== undefined) {
    invalid(code, 'An uncertain entry cannot carry a receipt.', value.attemptId as string);
  }
  if ((state === 'submitted' || state === 'completed') && value.receipt === undefined) {
    invalid(code, 'A receipt is required once a submit is proven.', value.attemptId as string);
  }
  if (value.receipt !== undefined) validateReceipt(value.receipt);
  if (state === 'reconciled') {
    if (!isRecord(value.reconciliation)) {
      invalid(code, 'A reconciled entry requires reconciliation evidence.', value.attemptId as string);
    }
    const reconciliation = value.reconciliation as Record<string, unknown>;
    requireText(reconciliation.by, 'reconciliation.by', code);
    requireTimestamp(reconciliation.at, 'reconciliation.at', code);
    requireText(reconciliation.evidence, 'reconciliation.evidence', code);
  } else if (value.reconciliation !== undefined) {
    invalid(code, 'Only reconciled entries carry reconciliation evidence.', value.attemptId as string);
  }
  return value as unknown as PaidOperationRecord;
}

/** In-memory append-only store: the reference implementation and test seam. */
export class InMemoryPaidOperationStore implements PaidOperationStore {
  readonly #entries: PaidOperationRecord[] = [];

  async append(record: PaidOperationRecord): Promise<void> {
    this.#entries.push(validatePaidOperationRecord(record));
  }

  async get(attemptId: string): Promise<PaidOperationRecord | undefined> {
    let current: PaidOperationRecord | undefined;
    for (const entry of this.#entries) {
      if (entry.attemptId === attemptId) current = entry;
    }
    return current;
  }

  async list(filter?: PaidOperationFilter): Promise<PaidOperationRecord[]> {
    const latest = new Map<string, PaidOperationRecord>();
    for (const entry of this.#entries) {
      latest.set(entry.attemptId, entry);
    }
    return [...latest.values()].filter(
      (entry) =>
        (filter?.planDigest === undefined || entry.planDigest === filter.planDigest) &&
        (filter?.subject === undefined || entry.subject === filter.subject) &&
        (filter?.state === undefined || entry.state === filter.state),
    );
  }
}

export interface SubmitOnceOptions {
  store: PaidOperationStore;
  plan: PaidOperationPlan;
  /**
   * Performs the paid submit. Called at most once per `submitOnce` call.
   * Resolve with the provider receipt proving acceptance.
   */
  submit: () => Promise<unknown>;
  /** Explicit attempt id (e.g. resuming from an external journal); else random. */
  attemptId?: string;
  /** Clock override for deterministic tests. */
  now?: () => Date;
}

/**
 * Enforces the plan limits, journals the attempt and performs exactly one
 * submit. Success requires a valid provider receipt (`submitted`); anything
 * else is journaled as `uncertain` and future submits for the plan are refused
 * until that attempt is reconciled.
 */
export async function submitOnce(options: SubmitOnceOptions): Promise<PaidOperationRecord> {
  const plan = validatePaidOperationPlan(options.plan);
  const planDigest = paidPlanDigest(plan);
  const history = await options.store.list({ planDigest });
  const open = history.find(
    (entry) => entry.state === 'uncertain' || entry.state === 'submitted',
  );
  if (open) {
    throw new PaidOperationError(
      'UNRESOLVED_ATTEMPT',
      `Attempt ${open.attemptId} is ${open.state}; reconcile it before submitting again.`,
      open.attemptId,
    );
  }
  if (history.length >= plan.maxAttempts) {
    invalid(
      'ATTEMPTS_EXHAUSTED',
      `Plan already used ${history.length}/${plan.maxAttempts} attempts.`,
    );
  }
  const reservedUsd = plan.estimatedCostUsd ?? 0;
  const spentUsd = history.reduce((sum, entry) => sum + entry.reservedUsd, 0);
  if (spentUsd + reservedUsd > plan.spendCapUsd) {
    invalid(
      'SPEND_CAP_EXCEEDED',
      `Plan spend cap is $${plan.spendCapUsd}; journalled $${spentUsd} and this attempt reserves $${reservedUsd}.`,
    );
  }
  const attemptId = options.attemptId ?? randomUUID();
  const base = {
    schemaVersion: 1 as const,
    attemptId,
    planDigest,
    command: plan.command,
    subject: plan.subject,
    reservedUsd,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  let outcome: unknown;
  try {
    outcome = await options.submit();
  } catch (cause) {
    await options.store.append({ ...base, state: 'uncertain' });
    throw new PaidOperationError(
      'SUBMIT_FAILED',
      `Submit for ${plan.subject} failed with an unknown outcome; reconciled review required before retrying.`,
      attemptId,
      { cause },
    );
  }
  if (outcome === null || outcome === undefined) {
    await options.store.append({ ...base, state: 'uncertain' });
    invalid(
      'RECEIPT_REQUIRED',
      `Submit for ${plan.subject} returned no receipt; the attempt stays uncertain.`,
      attemptId,
    );
  }
  let receipt: ProviderReceipt;
  try {
    receipt = validateReceipt(outcome);
  } catch (cause) {
    await options.store.append({ ...base, state: 'uncertain' });
    throw new PaidOperationError(
      'INVALID_RECEIPT',
      `Submit for ${plan.subject} returned an invalid receipt; the attempt stays uncertain.`,
      attemptId,
      { cause },
    );
  }
  const record: PaidOperationRecord = { ...base, state: 'submitted', receipt };
  await options.store.append(record);
  return record;
}

/**
 * Completes a submitted attempt. Only a submit proven by a receipt may
 * complete; uncertain attempts must be reconciled instead.
 */
export async function completeOperation(
  store: PaidOperationStore,
  attemptId: string,
  now?: () => Date,
): Promise<PaidOperationRecord> {
  const current = await store.get(attemptId);
  if (!current) invalid('UNKNOWN_ATTEMPT', `No paid attempt ${attemptId}.`, attemptId);
  if (current.state !== 'submitted') {
    invalid(
      'INVALID_TRANSITION',
      `Attempt ${attemptId} is ${current.state}; only a submitted attempt can complete.`,
      attemptId,
    );
  }
  const record: PaidOperationRecord = {
    ...current,
    state: 'completed',
    createdAt: (now ?? (() => new Date()))().toISOString(),
  };
  await store.append(record);
  return record;
}

/**
 * Reconciles an attempt whose outcome was uncertain or just submitted, based
 * on external evidence. This is the only door back to a safe retry.
 */
export async function reconcileOperation(
  store: PaidOperationStore,
  attemptId: string,
  reconciliation: { by: string; evidence: string; at?: string },
  now?: () => Date,
): Promise<PaidOperationRecord> {
  const current = await store.get(attemptId);
  if (!current) invalid('UNKNOWN_ATTEMPT', `No paid attempt ${attemptId}.`, attemptId);
  if (current.state === 'reconciled') {
    invalid('INVALID_TRANSITION', `Attempt ${attemptId} is already reconciled.`, attemptId);
  }
  const code: PaidOperationErrorCode = 'INVALID_RECONCILIATION';
  const by = requireText(reconciliation?.by, 'reconciliation.by', code);
  const evidence = requireText(reconciliation?.evidence, 'reconciliation.evidence', code);
  const at = reconciliation.at ?? (now ?? (() => new Date()))().toISOString();
  requireTimestamp(at, 'reconciliation.at', code);
  const record: PaidOperationRecord = {
    ...current,
    state: 'reconciled',
    createdAt: (now ?? (() => new Date()))().toISOString(),
    reconciliation: { by, at, evidence },
  };
  await store.append(record);
  return record;
}
