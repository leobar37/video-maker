/**
 * Portal bindings (declared in wrangler.jsonc for local emulation).
 * No real resource exists in P-001; ids are placeholders and all access is
 * via emulated fixtures. Secrets are never set from process args or files:
 * the operator injects BETTER_AUTH_SECRET behind G-cap-live.
 *
 * TEST_MIGRATIONS is injected by vitest.config.ts (readD1Migrations) for
 * applyD1Migrations() in tests only.
 */
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ASSETS: R2Bucket;
    BETTER_AUTH_SECRET?: string;
    PORTAL_ORIGIN?: string;
    /** P-006 magic-link delivery (secrets injected by the operator only). */
    RESEND_API_KEY?: string;
    PORTAL_MAIL_FROM?: string;
    /** Operator pilot var: login = copy the link via `wrangler tail`. */
    PORTAL_LIVE_SMOKE?: string;
    TEST_MIGRATIONS: { name: string; queries: string[] }[];
  }
}
