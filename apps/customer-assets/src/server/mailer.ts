/**
 * Real magic-link delivery (P-006, G-cap-live ONLY).
 *
 * contracts.md §3: email delivery is injected. Offline/e2e keep the fake sink;
 * the deployed worker wires THIS module into `/api/auth/*`. Design rules:
 * - The provider secret lives ONLY in a Worker secret binding (env). It is
 *   never logged, echoed, or embedded in errors.
 * - Without a configured provider the sender REFUSES to deliver (same stub
 *   contract as before P-006): no fake success, no silent drop.
 * - Provider: Resend HTTP API (deployment-checklist.md §4 names RESEND_API_KEY
 *   as the reference provider). Adding another provider means a new branch in
 *   `selectProvider` — never a key in code or repo.
 * - `PORTAL_MAIL_FROM` must be a VERIFIED sender on the zone (SPF/DKIM/DMARC,
 *   deployment-checklist.md §5) before any real send.
 */
import type { SendMagicLink } from './auth';

/** Env slice the mailer needs (secrets arrive as Worker secret bindings). */
export interface MailerEnv {
  RESEND_API_KEY?: string;
  PORTAL_MAIL_FROM?: string;
  /**
   * Operator decision (Stage B pilot): when '1', delivery is deferred — the
   * single-use login URL is LOGGED (visible only in `wrangler tail`) instead
   * of emailed. Zero outbound emails. Any other value keeps the refusing stub.
   */
  PORTAL_LIVE_SMOKE?: string;
}

/** Provider secret bindings this deployment understands (names, never values). */
export const EMAIL_SECRET_NAMES = ['RESEND_API_KEY'] as const;

/** The single email provider secret the P-006 deployment expects. */
export const EMAIL_SECRET_NAME = 'RESEND_API_KEY';

/**
 * Builds the production sender for `/api/auth/*`.
 * - Provider configured → real delivery; transport failure THROWS (Better Auth
 *   surfaces the error instead of pretending the mail was sent).
 * - Provider missing → refusing stub (pre-P-006 behavior preserved).
 */
export function createMagicLinkSender(env: MailerEnv): SendMagicLink {
  const from = env.PORTAL_MAIL_FROM?.trim();
  const apiKey = env.RESEND_API_KEY?.trim();

  if (env.PORTAL_LIVE_SMOKE === '1') {
    return async ({ email, url }) => {
      // Operator-approved pilot channel: the single-use URL surfaces ONLY in
      // `wrangler tail` (never in HTTP responses). Marker kept greppable and
      // stable for the live verifier's tail capture.
      console.log(`[PORTAL-LIVE-SMOKE] magic-link to=${email} url=${url}`);
    };
  }

  if (apiKey === undefined || apiKey.length === 0 || from === undefined || from.length === 0) {
    return async () => {
      throw new Error(
        'magic link delivery provider not configured (requires secret '
          + `${EMAIL_SECRET_NAME} and var PORTAL_MAIL_FROM; G-cap-live)`,
      );
    };
  }

  return async ({ email, url }) => {
    const subject = 'Tu enlace de acceso al portal de contenidos';
    const html = [
      '<p>Hola,</p>',
      '<p>Usa el siguiente enlace para entrar al portal. Es de un solo uso y expira en pocos minutos:</p>',
      `<p><a href="${escapeHtml(url)}">Entrar al portal</a></p>`,
      '<p>Si no solicitaste este enlace, ignora este mensaje.</p>',
    ].join('\n');
    const text = `Enlace de acceso (un solo uso, expira en minutos): ${url}`;

    let response: Response;
    try {
      response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ from, to: [email], subject, html, text }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (cause) {
      throw new Error('magic link delivery failed: provider unreachable', { cause });
    }
    if (!response.ok) {
      // Status only: the provider body may echo addresses or ids; never log it.
      throw new Error(`magic link delivery failed: provider status ${response.status}`);
    }
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
