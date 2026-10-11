import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';
import { createPortalAuth } from '../../../server/auth';
import { createDb } from '../../../server/db';
import { handlePortalApiV1, type RequestDeps } from '../../../server/api';

/**
 * /api/v1/$ — portal v1 API (contracts.md §6). All policy lives in the
 * server dispatcher; this file only binds the emulated/live D1+R2 bindings
 * and the guarded auth instance, then delegates. Bindings mirror
 * wrangler.jsonc; no real cloud resources exist in P-002.
 */

let cachedDeps: RequestDeps | null = null;

function getDeps(): RequestDeps {
  cachedDeps ??= {
    env: { DB: env.DB, ASSETS: env.ASSETS },
    auth: createPortalAuth(
      { DB: env.DB },
      {
        secret: env.BETTER_AUTH_SECRET ?? '',
        baseURL: env.PORTAL_ORIGIN ?? undefined,
        sendMagicLink: async () => {
          throw new Error('magic link delivery provider not configured (G-cap-live)');
        },
      },
    ),
    db: createDb(env.DB),
    // Admin access-link minting only (never logged/echoed elsewhere).
    portalOrigin: env.PORTAL_ORIGIN ?? undefined,
    portalSecret: env.BETTER_AUTH_SECRET ?? undefined,
  };
  return cachedDeps;
}

function handle(request: Request): Promise<Response> {
  return handlePortalApiV1(request, getDeps());
}

export const Route = createFileRoute('/api/v1/$')({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      HEAD: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
      PUT: ({ request }) => handle(request),
      PATCH: ({ request }) => handle(request),
    },
  },
});
