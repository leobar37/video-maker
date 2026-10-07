import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';
import { createPortalAuth, createPortalAuthHandler, type PortalAuthHandler } from '../../../server/auth';
import { createMagicLinkSender } from '../../../server/mailer';

/**
 * /api/auth/* — Better Auth behind the portal guard (contracts.md §3/§6).
 * Email delivery: the real provider (P-006) ONLY when its secret binding and
 * PORTAL_MAIL_FROM are configured; otherwise the injected sender refuses to
 * deliver instead of faking success (pre-P-006 contract preserved).
 */

let cachedHandler: PortalAuthHandler | null = null;

function getHandler(): PortalAuthHandler {
  cachedHandler ??= createPortalAuthHandler(
    createPortalAuth(
      { DB: env.DB },
      {
        secret: env.BETTER_AUTH_SECRET ?? '',
        baseURL: env.PORTAL_ORIGIN ?? undefined,
        sendMagicLink: createMagicLinkSender(env),
      },
    ),
  );
  return cachedHandler;
}

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => getHandler()(request),
      POST: ({ request }) => getHandler()(request),
    },
  },
});
