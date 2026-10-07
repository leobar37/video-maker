-- 0005_asset_upload_links.sql · Asset upload links + per-asset material
-- attribution (operator order 2026-10-06; contratos aditivos §9 ·
-- customer-assets-requests). ADDITIVE PROOF: exactly ONE new table plus ONE
-- nullable material column with its index — no existing row is altered,
-- backfilled or rewritten, and every v1/R-1/R-2 statement keeps working on a
-- database WITHOUT this migration (the new column is touched exclusively by
-- asset-link code paths, same R-1 precedent for portal_project_id and R-2
-- for upload_request_id). Applied ONLY to emulated local D1; real D1
-- provisioning/migrations require the human G-cap-live gate.
-- Mirrors apps/customer-assets/src/server/db/schema.ts — keep both in sync.
-- Timestamps are epoch milliseconds (INTEGER); ids are opaque UUID strings.
-- Like upload_session/material/upload_request (v1/R-2), the new table uses
-- PLAIN TEXT foreign-key columns without REFERENCES clauses: the additive
-- schema stays FK-safe under the fixture reset (drop order) and never blocks
-- a v1 table drop.

-- Upload link bound to EXACTLY ONE Studio asset (workspace + portal client +
-- optional PortalProject pointer + Studio project/asset ids). ONLY the
-- SHA-256 hash of the capability token is stored — the raw token lives
-- exclusively inside the minted URL (/asset-upload/<token>), shown once to
-- the operator and never logged/audited/persisted. UNIQUE(token_hash) makes
-- the hash a stable lookup key without any plaintext column. Lazy state
-- machine open -> used | closed | expired, materialized on FIRST touch
-- (guarded UPDATE + one audit), no cron and no queues. `used` is terminal:
-- the capability covers ONE upload (una toma); re-minting for the same
-- (client, asset) closes the previous link (rotation, one ACTIVE link).
CREATE TABLE IF NOT EXISTS "asset_upload_link" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL,
  "portal_client_id" TEXT NOT NULL,
  "portal_project_id" TEXT,
  "studio_project_id" TEXT NOT NULL,
  "studio_asset_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL UNIQUE,
  "expires_ms" INTEGER NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'open', -- open | used | closed | expired
  "created_by" TEXT NOT NULL,
  "created_ms" INTEGER NOT NULL,
  "closed_ms" INTEGER,
  "close_reason" TEXT
);

CREATE INDEX IF NOT EXISTS "asset_upload_link_client_idx" ON "asset_upload_link" ("portal_client_id", "created_ms");
CREATE INDEX IF NOT EXISTS "asset_upload_link_asset_idx" ON "asset_upload_link" ("portal_client_id", "studio_asset_id");

-- Optional per-asset attribution (operator order 2026-10-06): NULL = any v1 /
-- request upload. Set ONLY when a guest upload through an asset link
-- completes; the value is the LOCAL Studio asset id the link was minted for
-- and NEVER comes from client input. Not backfilled; existing rows untouched.
ALTER TABLE "material" ADD COLUMN "asset_target" TEXT;

CREATE INDEX IF NOT EXISTS "material_asset_target_idx" ON "material" ("asset_target");
