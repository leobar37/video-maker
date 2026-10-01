/**
 * Failure shape shared by every studio service (contracts.md §5): a stable
 * code, a human message and redacted details. Services never return partial
 * objects carrying a confirmed state — they throw.
 */
import type { StudioErrorCode } from '@videomaker/schemas';

import type { StudioServiceError as StudioServiceErrorShape } from './contracts';

export class StudioServiceError extends Error implements StudioServiceErrorShape {
  readonly code: StudioErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: StudioErrorCode, message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'StudioServiceError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function isStudioServiceError(value: unknown): value is StudioServiceError {
  return value instanceof StudioServiceError;
}

/** Throw a typed failure; keeps public codes stable and details redacted. */
export function fail(code: StudioErrorCode, message: string, details?: Record<string, unknown>, cause?: unknown): never {
  throw new StudioServiceError(code, message, details, cause);
}
