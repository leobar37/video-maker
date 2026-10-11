/**
 * Browser-side portal API access (contracts.md §6/§8).
 *
 * The typed SDK is instantiated SAME-ORIGIN: every URL is built from
 * `window.location.origin`, cookies ride automatically on same-origin fetch,
 * and `redirect: 'error'` (SDK-wide) means a session cookie can never follow
 * a redirect cross-origin. No API keys in the browser: humans authenticate
 * with Better Auth sessions only.
 */

import { CustomerAssetsClient, ApiClientError } from '@videomaker/customer-assets/client';

export { ApiClientError };

const browserOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:8787';

export const portal = new CustomerAssetsClient({ baseUrl: browserOrigin });

/** True when the failure means "no/invalid session" (rendered as a login redirect). */
export function isUnauthorized(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError && error.status === 401;
}

/** True when the session exists but the role/scope is insufficient. */
export function isForbidden(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError && error.status === 403;
}

/** True for "unknown resource / other client's data" (never enumerable). */
export function isNotFound(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError && error.status === 404;
}

/** Human-readable message for any API failure (envelope text when available). */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError) return error.message.replace(/^\[\d+\]\s*/, '');
  if (error instanceof Error) return error.message;
  return 'Error inesperado.';
}

/* auth HTTP endpoints (Better Auth behind the portal guard) ---------------- */

export async function requestMagicLink(email: string, callbackURL?: string): Promise<void> {
  const response = await fetch('/api/auth/sign-in/magic-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(callbackURL ? { email, callbackURL } : { email }),
  });
  if (!response.ok) {
    // Neutral contract (§3): unknown emails get the same 200; anything else
    // is surfaced as a generic retryable failure, never an email enumeration.
    throw new Error(`magic-link-request-failed:${response.status}`);
  }
}

export async function signOutSession(): Promise<void> {
  await fetch('/api/auth/sign-out', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}
