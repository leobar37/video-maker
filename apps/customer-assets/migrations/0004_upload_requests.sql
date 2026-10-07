-- 0004_upload_requests.sql · UploadRequest + capability token + material
-- attribution (P-102, R-2; contracts.md §2/§4/§5 additive ·
-- customer-assets-requests). Applied ONLY to emulated local D1 (vitest-pool-workers
-- fixture; verifier/e2e fixtures replay 0001..0004). Real D1
-- provisioning/migrations require the human G-cap-live gate.
-- Mirrors apps/customer-assets/src/server/db/schema.ts — keep both in sync.
-- Timestamps are epoch milliseconds (INTEGER); ids are opaque UUID strings.
-- Like upload_session/material (v1), these tables use PLAIN TEXT foreign-key
-- columns without REFERENCES clauses: the additive schema stays FK-safe under
-- the fixture reset (drop order) and never blocks a v1 table drop.

-- Material request (pedido) per project: configurable limits fixed by the
-- creator, live budget counters, lazy state open -> fulfilled|closed|expired.
-- portal_client_id is denormalized from the project for authorization + quota.
CREATE TABLE IF NOT EXISTS "upload_request" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "portal_client_id" TEXT NOT NULL,
  "portal_project_id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "instructions" TEXT,
  "max_files" INTEGER NOT NULL,
  "max_bytes" INTEGER NOT NULL,
  "used_files" INTEGER NOT NULL DEFAULT 0,
  "used_bytes" INTEGER NOT NULL DEFAULT 0,
  "state" TEXT NOT NULL DEFAULT 'open', -- open | fulfilled | closed | expired
  "expires_ms" INTEGER NOT NULL,
  "created_by" TEXT NOT NULL,
  "created_ms" INTEGER NOT NULL,
  "closed_ms" INTEGER,
  "close_reason" TEXT
);

CREATE INDEX IF NOT EXISTS "upload_request_client_idx" ON "upload_request" ("portal_client_id", "created_ms");
CREATE INDEX IF NOT EXISTS "upload_request_project_idx" ON "upload_request" ("portal_project_id");

-- Guest-direct capability token (contracts.md §2/§3): ONLY the SHA-256 hash is
-- stored — the raw token travels exclusively inside the minted URL, is shown
-- exactly once to the admin, and is never logged, audited or persisted. One
-- ACTIVE token per request (operator default): re-mint revokes the previous.
CREATE TABLE IF NOT EXISTS "upload_request_token" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "request_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL UNIQUE,
  "expires_ms" INTEGER NOT NULL,
  "revoked_ms" INTEGER,
  "created_by" TEXT NOT NULL,
  "created_ms" INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS "upload_request_token_request_idx" ON "upload_request_token" ("request_id");

-- Optional request attribution (FR-104): NULL = upload libre de v1 (free or
-- project-only). Set ONLY when a guest upload through a request token
-- completes; every request material always carries BOTH this column and
-- portal_project_id (the request's project).
ALTER TABLE "material" ADD COLUMN "upload_request_id" TEXT;

CREATE INDEX IF NOT EXISTS "material_upload_request_idx" ON "material" ("upload_request_id");
