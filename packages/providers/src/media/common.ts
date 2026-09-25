/**
 * Shared building blocks for the media adapters: planned-action reporting
 * (NFR-002), typed errors, source/param parsing and the safety helpers that
 * keep secret values out of journals, receipts and logs (NFR-001).
 *
 * Invariants enforced here:
 * - Plan mode (`ctx.mode === 'plan'`) never touches the network and never
 *   resolves secrets; adapters report planned actions via `plan()` and hard
 *   refuse `submit()` in plan mode.
 * - A submit without a provider receipt is never retried automatically; the
 *   outcome is reported as `uncertain` (core `PaidOperationState`) until it is
 *   explicitly reconciled.
 */
import type { PaidOperationState } from '@videomaker/core';

import type {
  MediaKind,
  MediaSubmitInput,
  MediaProvider,
  ProviderContext,
  ProcessRunner,
} from '../ports';

/** What a run-mode call would do. Pure data: no network, no secrets. */
export interface MediaPlannedAction {
  provider: string;
  /** MediaKind the adapter handles, or 'none' for non-media operations. */
  kind: MediaKind | 'none';
  /** Human-stable operation name (e.g. 'submit', 'adopt', 'use'). */
  operation: string;
  /** Whether run mode performs HTTP. */
  network: boolean;
  /** Whether run mode performs a paid submit (spends money). */
  paid: boolean;
  estimatedCostUsd: number | null;
  /** Endpoint run mode would call (never carries secrets). */
  endpoint?: string;
  /** Credential names run mode would resolve (values never touched in plan mode). */
  requiresSecrets: readonly string[];
  /** Non-secret request summary. */
  request: Record<string, unknown>;
  detail: string;
}

/** A `MediaProvider` that can also describe its run-mode work without doing it. */
export interface PlannedMediaProvider extends MediaProvider {
  plan(input: MediaSubmitInput): MediaPlannedAction;
}

export class MediaProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MediaProviderError';
  }
}

/**
 * A submit whose outcome is unknown (failure/timeout/invalid response without
 * a receipt). `state` is the core `PaidOperationState` the engine must journal;
 * the attempt blocks further submits for the same idempotency key until it is
 * explicitly reconciled. NEVER auto-retry.
 */
export class MediaSubmitUncertainError extends Error {
  readonly state: PaidOperationState = 'uncertain';
  readonly attemptId: string;

  constructor(attemptId: string, detail: string, options?: ErrorOptions) {
    super(
      `Submit ${attemptId} finished without a provider receipt (${detail}). ` +
        `The attempt is uncertain and blocks retries; reconcile it before submitting again.`,
      options,
    );
    this.name = 'MediaSubmitUncertainError';
    this.attemptId = attemptId;
  }
}

/** The idempotency key was already used with different inputs. */
export class MediaSubmitConflictError extends Error {
  constructor(idempotencyKey: string) {
    super(
      `Idempotency key ${idempotencyKey} was already used with different inputs; ` +
        `reusing a key across distinct spends is refused.`,
    );
    this.name = 'MediaSubmitConflictError';
  }
}

/**
 * Plan mode hard-refuses submit/status/result. The refusal carries the planned
 * actions so callers can report them (NFR-002: plan mode stays offline and
 * secret-free).
 */
export class PlanModeRefusalError extends Error {
  readonly planned: MediaPlannedAction;

  constructor(planned: MediaPlannedAction) {
    super(
      `Plan mode refuses ${planned.operation} on ${planned.provider}: ` +
        `planning must stay offline and secret-free. Use plan() to report ` +
        `${planned.detail}`,
    );
    this.name = 'PlanModeRefusalError';
    this.planned = planned;
  }
}

/** Throws `PlanModeRefusalError` when the context is a plan/dry run. */
export function assertRunMode(mode: ProviderContext['mode'], planned: MediaPlannedAction): void {
  if (mode === 'plan') throw new PlanModeRefusalError(planned);
}

/** Throws when a required process runner is missing (fail before spending). */
export function requireProcessRunner(ctx: ProviderContext, purpose: string): ProcessRunner {
  if (!ctx.process) {
    throw new MediaProviderError(
      'PROCESS_RUNNER_REQUIRED',
      `${purpose} needs a ProcessRunner (ctx.process); refusing before any spend.`,
    );
  }
  return ctx.process;
}

/** An input media asset: an already-hosted URL or in-memory bytes to upload. */
export type MediaSourceInput =
  | { url: string }
  | { bytes: Uint8Array; filename: string; contentType?: string };

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function parseMediaSource(value: unknown, label: string): MediaSourceInput {
  if (!value || typeof value !== 'object') {
    throw new MediaProviderError('INVALID_PARAMS', `${label} must be a media source object.`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.url === 'string') {
    if (!isHttpUrl(record.url)) {
      throw new MediaProviderError('INVALID_PARAMS', `${label}.url must be an http(s) URL.`);
    }
    return { url: record.url };
  }
  const bytes = record.bytes;
  if (!(bytes instanceof Uint8Array)) {
    throw new MediaProviderError(
      'INVALID_PARAMS',
      `${label} must carry an http(s) url or { bytes, filename }.`,
    );
  }
  const filename = record.filename;
  if (typeof filename !== 'string' || filename.trim().length === 0) {
    throw new MediaProviderError('INVALID_PARAMS', `${label}.filename must be a non-empty string.`);
  }
  const contentType = record.contentType;
  if (contentType !== undefined && typeof contentType !== 'string') {
    throw new MediaProviderError('INVALID_PARAMS', `${label}.contentType must be a string.`);
  }
  return contentType === undefined
    ? { bytes, filename }
    : { bytes, filename, contentType };
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MediaProviderError('INVALID_PARAMS', `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function requireStringParam(
  params: Record<string, unknown>,
  name: string,
  label: string,
): string {
  const value = params[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MediaProviderError('INVALID_PARAMS', `${label}.${name} must be a non-empty string.`);
  }
  return value;
}

export function optionalStringParam(
  params: Record<string, unknown>,
  name: string,
  label: string,
): string | undefined {
  const value = params[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new MediaProviderError('INVALID_PARAMS', `${label}.${name} must be a string.`);
  }
  return value;
}

export function optionalNumberParam(
  params: Record<string, unknown>,
  name: string,
  label: string,
): number | undefined {
  const value = params[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MediaProviderError('INVALID_PARAMS', `${label}.${name} must be a finite number.`);
  }
  return value;
}

const SECRET_KEY_PATTERN = /key|token|secret|password|credential|authorization|auth/i;

const MEDIA_KINDS = ['video', 'avatar', 'tts', 'music', 'image'] as const;

/** Type guard for the closed `MediaKind` union (ports.ts). */
export function isMediaKind(value: unknown): value is MediaKind {
  return typeof value === 'string' && (MEDIA_KINDS as readonly string[]).includes(value);
}

/**
 * Non-secret projection of a request for receipts/journals/logs: binary
 * payloads are summarized and secret-looking keys are dropped entirely
 * (NFR-001: secrets live only in provider request headers).
 */
export function paramsSnapshot(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value instanceof Uint8Array) return { bytes: value.byteLength };
  if (Array.isArray(value)) return value.map((item) => paramsSnapshot(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) continue;
      out[key] = paramsSnapshot(child, depth + 1);
    }
    return out;
  }
  return value;
}

/** Asserts the submit kind before anything else can happen. */
export function assertKind(input: MediaSubmitInput, allowed: readonly MediaKind[]): void {
  if (!allowed.includes(input.kind)) {
    throw new MediaProviderError(
      'UNSUPPORTED_KIND',
      `Unsupported media kind "${input.kind}" (allowed: ${allowed.join(', ')}).`,
    );
  }
}

/** Validates an idempotency key up front; it drives submit-once semantics. */
export function assertIdempotencyKey(input: MediaSubmitInput): string {
  const key = input.idempotencyKey;
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new MediaProviderError('INVALID_PARAMS', 'idempotencyKey must be a non-empty string.');
  }
  return key;
}
