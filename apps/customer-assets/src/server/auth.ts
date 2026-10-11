import { apiKey } from '@better-auth/api-key';
import { magicLink } from 'better-auth/plugins';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { eq } from 'drizzle-orm';
import type { ErrorCode } from '@videomaker/customer-assets';
import { createDb, type PortalDb } from './db';
import {
  account,
  apikey,
  session,
  user,
  verification,
} from './db/auth-schema';

/**
 * Portal auth (contracts.md §3):
 * - Better Auth + Drizzle adapter over the emulated D1 binding.
 * - Magic link only: invite-only (`disableSignUp: true`), hashed short-lived
 *   single-use tokens. Email delivery is always injected (fake sink in tests;
 *   a real provider is a G-cap-live concern, never wired here).
 * - API keys via @better-auth/api-key with `enableSessionForAPIKeys: false`
 *   (an API key never mints a session) and guarded management routes: only a
 *   provisioned admin session may reach `/api/auth/api-key/*`; member sessions
 *   and agent keys cannot self-issue, widen scopes, or impersonate others.
 */

export interface AuthEnv {
  DB: D1Database;
}

/** Captured outbound magic-link mail. Tests reference entries by id only. */
export interface MagicLinkMail {
  id: string;
  email: string;
  /** Raw token as embedded in the link; never persisted or logged. */
  token: string;
  url: string;
}

export type SendMagicLink = (mail: {
  email: string;
  token: string;
  url: string;
}) => Promise<void>;

export type PortalRole = 'admin' | 'member';

export interface PortalAuthOptions {
  /** Fixture secret for tests; the app injects it from a protected binding. */
  secret: string;
  sendMagicLink: SendMagicLink;
  /** Origin fixture for tests; the app injects its approved origin. */
  baseURL?: string;
  /** Magic link lifetime in seconds (short by contract; default 5 min). */
  magicLinkExpiresIn?: number;
  /** Core Better Auth rate limiting (on in production, off in fixtures). */
  rateLimitEnabled?: boolean;
}

/** Named contract for the guarded /api/auth/* endpoint. */
export type PortalAuthHandler = (request: Request) => Promise<Response>;

/** Named contract for the Better Auth instance created by this module. */
export type PortalAuth = ReturnType<typeof createPortalAuth>;

const DEFAULT_BASE_URL = 'http://localhost:8787';

const authSchemaTables = { user, session, account, verification, apikey };

export function createPortalAuth(env: AuthEnv, options: PortalAuthOptions) {
  const db = createDb(env.DB);
  const baseURL = options.baseURL ?? DEFAULT_BASE_URL;

  return betterAuth({
    baseURL,
    trustedOrigins: [baseURL],
    secret: options.secret,
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema: authSchemaTables,
      // D1 has no interactive BEGIN/COMMIT; the adapter executes multiple
      // operations sequentially (its default). Documented, not faked.
      transaction: false,
    }),
    user: {
      additionalFields: {
        role: {
          type: 'string',
          defaultValue: 'member',
          input: false,
        },
      },
    },
    // Explicit pilot rate limiting (P-006): Better Auth core limiter, memory
    // storage per isolate. 100 req/min per IP+path is the Better Auth default
    // made EXPLICIT so the deployed behavior is stable across versions and
    // the pilot smoke (a handful of magic-link creations) can never exhaust
    // it by accident. Magic-link tokens remain hashed, single-use, 5 min.
    rateLimit: { enabled: options.rateLimitEnabled ?? true, window: 60, max: 100 },
    plugins: [
      magicLink({
        disableSignUp: true,
        storeToken: 'hashed',
        expiresIn: options.magicLinkExpiresIn ?? 300,
        sendMagicLink: async ({ email, token, url }) => {
          await options.sendMagicLink({ email, token, url });
        },
      }),
      apiKey({
        enableSessionForAPIKeys: false,
        rateLimit: { enabled: false, timeWindow: 60, maxRequests: 1_000 },
        permissions: {
          // Clamps defaults for keys created without explicit permissions;
          // privileged grants are decided server-side at provisioning.
          defaultPermissions: { materials: ['read'] },
        },
      }),
    ],
  });
}

/**
 * One-shot auth instance for admin-minted access links (operator-ordered,
 * 2026-10-05). It shares the SAME D1 tables and secret as the main portal
 * auth, so the minted token is stored hashed + single-use in the standard
 * `verification` table and is later consumed by the normal
 * `/api/auth/magic-link/verify` path — no parallel token store exists.
 *
 * expiryDesign: better-auth 1.7.7 has NO per-call `expiresIn` on
 * `signInMagicLink` (body is only email/callbackURL/...), so the per-mint
 * lifetime is expressed through the plugin-level `expiresIn` of THIS
 * throwaway instance. Better Auth writes that lifetime into the verification
 * row's `expiresAt` at creation, and the verify path enforces the ROW (not
 * the constructing instance's config), so a token minted for 7d still
 * verifies — and stops verifying after — via the main auth instance. The
 * injected sender CAPTURES the URL server-side and never delivers.
 */
export function createMintingAuth(
  env: AuthEnv,
  options: { secret: string; baseURL: string; expiresInSeconds: number },
) {
  const captured: { current: MagicLinkMail | null } = { current: null };
  const auth = createPortalAuth(env, {
    secret: options.secret,
    baseURL: options.baseURL,
    magicLinkExpiresIn: options.expiresInSeconds,
    // Minting is a server-to-server call inside the request handler: the core
    // limiter stays off for this instance (the verify path keeps the main
    // instance's limiter).
    rateLimitEnabled: false,
    sendMagicLink: async (mail) => {
      captured.current = { id: crypto.randomUUID(), email: mail.email, token: mail.token, url: mail.url };
    },
  });
  return {
    auth,
    /** The captured link (token/url) — read AFTER signInMagicLink resolves. */
    minted(): MagicLinkMail {
      if (captured.current === null) {
        throw new Error('minting auth produced no captured magic link');
      }
      return captured.current;
    },
  };
}

/**
 * Server-side provisioning (FR-001): the only supported way to create portal
 * users. Self sign-up stays impossible (`disableSignUp: true` blocks auth
 * routes, and `role` is `input: false` everywhere else). Sanctioned callers
 * are admin-gated server code only: the admin dashboard's userForEmail and
 * the access-link mint endpoint (admin human / agent with `access:write`).
 */
export async function provisionUser(
  db: PortalDb,
  input: { email: string; name: string; role: PortalRole },
) {
  const now = new Date();
  const [row] = await db
    .insert(user)
    .values({
      id: crypto.randomUUID(),
      email: input.email.toLowerCase(),
      name: input.name,
      role: input.role,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row;
}

export async function findUserByEmail(db: PortalDb, email: string) {
  const [row] = await db
    .select()
    .from(user)
    .where(eq(user.email, email.toLowerCase()))
    .limit(1);
  return row;
}

/** Typed error envelope per contracts.md §6 (no `success` flag). */
export function errorResponse(
  code: ErrorCode,
  message: string,
  status: number,
): Response {
  return Response.json(
    { error: { code, message, requestId: crypto.randomUUID() } },
    { status },
  );
}

/**
 * Guarded Better Auth HTTP handler (contracts.md §3/§6): management of API
 * keys is admin-only; every other auth path delegates unchanged.
 */
export function createPortalAuthHandler(auth: PortalAuth): PortalAuthHandler {
  return async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/auth/api-key/')) {
      const authContext = await auth.api.getSession({ headers: request.headers });
      const role = authContext?.user.role;
      if (!authContext || role !== 'admin') {
        return errorResponse(
          'forbidden',
          'API key management is restricted to provisioned admins.',
          403,
        );
      }
    }
    return auth.handler(request);
  };
}
