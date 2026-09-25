/**
 * Submit-once gate: one live HTTP submit per `MediaSubmitInput.idempotencyKey`.
 *
 * The gate journals every attempt through `@videomaker/core`'s paid-operation
 * engine (`submitOnce`), so the spend-safety invariants hold for every media
 * adapter:
 * - Exactly one submit per idempotency key. A repeated submit replays the
 *   journalled receipt with ZERO additional HTTP requests.
 * - A submit that fails, times out, or answers without a valid provider
 *   receipt is journalled `uncertain` (core `PaidOperationState`) and blocks
 *   retries until it is explicitly `reconcile()`d. Never auto-retry.
 * - Reusing a key with different inputs is refused.
 */
import {
  InMemoryPaidOperationStore,
  PaidOperationError,
  paidPlanDigest,
  reconcileOperation,
  sha256Json,
  submitOnce,
  type PaidOperationPlan,
  type PaidOperationRecord,
  type PaidOperationStore,
  type ProviderReceipt,
} from '@videomaker/core';

import type {
  Clock,
  MediaJobStatus,
  MediaKind,
  PaidReceipt,
} from '../ports';
import {
  MediaProviderError,
  MediaSubmitConflictError,
  MediaSubmitUncertainError,
  isMediaKind,
  paramsSnapshot,
} from './common';

/** A synthetic plan keyed by the idempotency key: one journal per intended spend. */
const SYNTHETIC_PLAN_MAX_ATTEMPTS = 3;

export interface SubmitSpec {
  provider: string;
  kind: MediaKind;
  idempotencyKey: string;
  /** The caller's paid plan digest (`MediaSubmitInput.planDigest`). */
  planDigest: string;
  /** Non-secret params; snapshotted into the receipt (binaries/secret keys stripped). */
  params: Record<string, unknown>;
  estimatedCostUsd: number | null;
  /** Preferred artifact path, recorded in the synthetic plan outputs. */
  output?: string;
  /**
   * The ONE paid submit. Resolves with a provider receipt proving acceptance,
   * or throws/returns nothing when the outcome is unknown. Called at most once.
   */
  perform: () => Promise<ProviderReceipt>;
}

export interface SubmitGateOptions {
  /** Journal seam; defaults to an in-memory append-only store. */
  store?: PaidOperationStore;
  clock?: Clock;
}

export interface SubmitOutcome {
  receipt: PaidReceipt;
  status: MediaJobStatus;
}

/** Everything about a submit except the live HTTP call. */
export type SubmitProbe = Omit<SubmitSpec, 'perform'>;

/** Non-secret facts recovered from a receipt produced by a `SubmitGate`. */
export interface ReceiptFacts {
  idempotencyKey: string;
  attemptId: string;
  planDigest: string;
  kind: MediaKind;
  request: Record<string, unknown>;
  statusUrl?: string;
  responseUrl?: string;
}

function syntheticPlan(spec: SubmitProbe): PaidOperationPlan {
  const perAttempt = spec.estimatedCostUsd ?? 0;
  return {
    schemaVersion: 1,
    command: `media:${spec.provider}:${spec.kind}`,
    subject: spec.idempotencyKey,
    // The inputs digest folds in the caller's plan digest AND the request the
    // key authorizes, so reusing a key with different inputs is detectable.
    inputsDigest: sha256Json({
      planDigest: spec.planDigest,
      request: paramsSnapshot(spec.params),
      estimatedCostUsd: spec.estimatedCostUsd,
    }),
    outputs: [spec.output ?? `${spec.kind}-artifact`],
    estimatedCostUsd: spec.estimatedCostUsd,
    maxAttempts: SYNTHETIC_PLAN_MAX_ATTEMPTS,
    spendCapUsd: Math.round(perAttempt * SYNTHETIC_PLAN_MAX_ATTEMPTS * 1e6) / 1e6,
  };
}

function receiptFactsFrom(spec: SubmitProbe, record: PaidOperationRecord): ReceiptFacts {
  const proven = record.receipt;
  if (!proven) {
    throw new MediaProviderError(
      'RECEIPT_REQUIRED',
      `Attempt ${record.attemptId} has no provider receipt; it cannot evidence a submit.`,
    );
  }
  const facts: ReceiptFacts = {
    idempotencyKey: spec.idempotencyKey,
    attemptId: record.attemptId,
    planDigest: spec.planDigest,
    kind: spec.kind,
    request: paramsSnapshot(spec.params) as Record<string, unknown>,
  };
  if (proven.statusUrl !== undefined) facts.statusUrl = proven.statusUrl;
  if (proven.responseUrl !== undefined) facts.responseUrl = proven.responseUrl;
  return facts;
}

function paidReceiptOf(spec: SubmitProbe, record: PaidOperationRecord): PaidReceipt {
  const proven = record.receipt;
  if (!proven) {
    throw new MediaProviderError(
      'RECEIPT_REQUIRED',
      `Attempt ${record.attemptId} has no provider receipt; it cannot evidence a submit.`,
    );
  }
  const facts = receiptFactsFrom(spec, record);
  const raw: Record<string, unknown> = {
    idempotencyKey: facts.idempotencyKey,
    attemptId: facts.attemptId,
    planDigest: facts.planDigest,
    kind: facts.kind,
    request: facts.request,
    ...(facts.statusUrl !== undefined ? { statusUrl: facts.statusUrl } : {}),
    ...(facts.responseUrl !== undefined ? { responseUrl: facts.responseUrl } : {}),
  };
  return {
    provider: spec.provider,
    providerJobId: proven.requestId,
    submittedAt: record.createdAt,
    ...(spec.estimatedCostUsd !== null ? { costUsd: spec.estimatedCostUsd } : {}),
    raw,
  };
}

/**
 * Validates and decodes the non-secret facts a `status()`/`result()` call needs
 * from a receipt produced by this gate. `receipt.raw` never carries secrets.
 */
export function receiptFacts(receipt: PaidReceipt, provider: string): ReceiptFacts {
  if (receipt.provider !== provider) {
    throw new MediaProviderError(
      'FOREIGN_RECEIPT',
      `Receipt belongs to ${receipt.provider}, not ${provider}.`,
    );
  }
  const raw = receipt.raw;
  if (!raw || typeof raw !== 'object') {
    throw new MediaProviderError('INVALID_RECEIPT', 'Receipt carries no raw facts.');
  }
  const { idempotencyKey, attemptId, planDigest, kind, request, statusUrl, responseUrl } = raw;
  if (
    typeof idempotencyKey !== 'string' ||
    typeof attemptId !== 'string' ||
    typeof planDigest !== 'string' ||
    !isMediaKind(kind) ||
    !request ||
    typeof request !== 'object'
  ) {
    throw new MediaProviderError('INVALID_RECEIPT', 'Receipt raw facts are incomplete.');
  }
  const facts: ReceiptFacts = {
    idempotencyKey,
    attemptId,
    planDigest,
    kind,
    request: request as Record<string, unknown>,
  };
  if (typeof statusUrl === 'string') facts.statusUrl = statusUrl;
  if (typeof responseUrl === 'string') facts.responseUrl = responseUrl;
  return facts;
}

/**
 * Maps a gate outcome to a completed job: for synchronous providers the
 * submit receipt is minted only after a validated full response.
 */
export function synchronousOutcome(outcome: SubmitOutcome, detail: string): SubmitOutcome {
  return { receipt: outcome.receipt, status: { state: 'succeeded', detail } };
}

export class SubmitGate {
  /** Journal seam: append-only paid attempts (uncertain/submitted/reconciled). */
  readonly store: PaidOperationStore;
  readonly #clock: Clock;
  /** Full receipts for idempotent replay without touching the network. */
  readonly #receipts = new Map<string, PaidReceipt>();

  constructor(options: SubmitGateOptions = {}) {
    this.store = options.store ?? new InMemoryPaidOperationStore();
    this.#clock = options.clock ?? { now: () => new Date() };
  }

  /** Latest journal record for one idempotency key, when it has submitted. */
  async record(idempotencyKey: string): Promise<PaidOperationRecord | undefined> {
    return this.store.get(idempotencyKey);
  }

  /**
   * Submit-once evaluation WITHOUT any network: replays a proven receipt,
   * blocks on an uncertain attempt, or reports `undefined` when a fresh submit
   * is authorized. Callers run this before free preparation work (uploads) so
   * a replayed submit sends ZERO HTTP requests.
   */
  async lookup(probe: SubmitProbe): Promise<SubmitOutcome | undefined> {
    const key = probe.idempotencyKey.trim();
    if (!key) {
      throw new MediaProviderError('INVALID_PARAMS', 'idempotencyKey must be a non-empty string.');
    }
    const syntheticDigest = paidPlanDigest(syntheticPlan(probe));
    const prior = await this.store.get(key);
    if (!prior) return undefined;
    if (prior.planDigest !== syntheticDigest) {
      throw new MediaSubmitConflictError(key);
    }
    if (prior.state === 'uncertain') {
      throw new MediaSubmitUncertainError(
        key,
        'an earlier attempt is journalled uncertain and must be reconciled first',
      );
    }
    if (prior.state === 'submitted' || prior.state === 'completed') {
      return this.#replay(key, probe, prior);
    }
    // 'reconciled': explicit human evidence reopened the attempt for one try.
    return undefined;
  }

  /**
   * Performs exactly one live submit per idempotency key:
   * - proven prior submit → replayed receipt, zero HTTP;
   * - uncertain prior submit → `MediaSubmitUncertainError`, zero HTTP;
   * - reconciled prior submit → an explicitly authorized fresh submit.
   */
  async run(spec: SubmitSpec): Promise<SubmitOutcome> {
    const replay = await this.lookup(spec);
    if (replay) return replay;
    const key = spec.idempotencyKey.trim();
    const plan = syntheticPlan(spec);
    let record: PaidOperationRecord;
    try {
      record = await submitOnce({
        store: this.store,
        plan,
        attemptId: key,
        now: () => this.#clock.now(),
        submit: spec.perform,
      });
    } catch (cause) {
      throw this.#asSubmitOutcomeError(key, cause);
    }
    const receipt = paidReceiptOf(spec, record);
    this.#receipts.set(key, receipt);
    return {
      receipt,
      status: {
        state: 'queued',
        detail: `${spec.provider} accepted submit ${receipt.providerJobId}; poll status() for progress.`,
      },
    };
  }

  /**
   * The only door back to a safe retry: explicit human reconciliation of an
   * uncertain attempt, backed by external evidence.
   */
  async reconcile(
    idempotencyKey: string,
    reconciliation: { by: string; evidence: string; at?: string },
  ): Promise<PaidOperationRecord> {
    const current = await this.store.get(idempotencyKey);
    if (!current) {
      throw new MediaProviderError('UNKNOWN_ATTEMPT', `No submit recorded for ${idempotencyKey}.`);
    }
    this.#receipts.delete(idempotencyKey);
    return reconcileOperation(this.store, idempotencyKey, reconciliation, () => this.#clock.now());
  }

  #replay(key: string, spec: SubmitProbe, prior: PaidOperationRecord): SubmitOutcome {
    const cached = this.#receipts.get(key);
    const receipt = cached ?? paidReceiptOf(spec, prior);
    this.#receipts.set(key, receipt);
    return {
      receipt,
      status: {
        state: 'queued',
        detail: `submit-once replay for ${key}: the journalled receipt is returned, no new submit.`,
      },
    };
  }

  /**
   * Maps engine failures to the spend-safety contract: anything that left an
   * uncertain journal entry becomes `MediaSubmitUncertainError` (state
   * 'uncertain', blocked retry); pure refusals never submitted and are not
   * uncertain.
   */
  #asSubmitOutcomeError(key: string, cause: unknown): Error {
    if (cause instanceof PaidOperationError) {
      if (
        cause.code === 'SUBMIT_FAILED' ||
        cause.code === 'RECEIPT_REQUIRED' ||
        cause.code === 'INVALID_RECEIPT' ||
        cause.code === 'UNRESOLVED_ATTEMPT'
      ) {
        return new MediaSubmitUncertainError(key, cause.code, { cause });
      }
      return new MediaProviderError('SUBMIT_REFUSED', cause.message, { cause });
    }
    return new MediaSubmitUncertainError(key, 'submit threw before a receipt was proven', {
      cause,
    });
  }
}
