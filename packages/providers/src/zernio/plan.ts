/**
 * Redacted configuration plan for the Zernio adapters (publish + ads).
 *
 * Pure over `EnvPresence` (NAME presence only, never values): describes what
 * each adapter WOULD do so `providers:smoke --plan` can validate the
 * configuration offline, with zero fetch calls and zero secret reads.
 */
import type { AdapterPlanReport } from '../storage/plan';
import type { EnvPresence } from '../storage/context';

/** The only credential name the Zernio surface resolves. */
export const ZERNIO_REQUIRED_NAMES = ['ZERNIO_API_KEY'] as const;

export function describeZernioPlan(presence: EnvPresence): AdapterPlanReport {
  const names = [...ZERNIO_REQUIRED_NAMES];
  return {
    adapter: 'zernio',
    names,
    present: names.filter((name) => presence(name)),
    missing: ZERNIO_REQUIRED_NAMES.filter((name) => !presence(name)),
    errors: [],
    would: [
      'resolve ZERNIO_API_KEY (never logged, never journalled)',
      'GET /accounts + /accounts/health (health-merged account listing) and GET /profiles',
      'POST /posts with the post idempotency key as Idempotency-Key/x-request-id ' +
        '(HTTP 409 dedupe ⇒ accepted, never re-sent)',
      'publish now (publishNow) or schedule (scheduledFor + timezone)',
      'GET /posts/:id status per idempotency key; reconcile resolves uncertain attempts only',
      'distribution: GET /posts/:id, POST /posts/:id/retry, POST /posts/:id/edit, ' +
        '/queue/slots, /queue/preview, /analytics/best-time',
      'ads: pure plan (maxAttempts + spendCapUsd) → submitOnce POST /ads/boost ' +
        '(Idempotency-Key = plan digest) → campaign status; uncertain submits block until reconciled',
      'publication journal: append-only JSONL per attempt (idempotency key, attempt, outcome, remote id, timestamps)',
    ],
  };
}
