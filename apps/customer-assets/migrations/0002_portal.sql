-- 0002_portal.sql · Portal projection schema (P-002, contracts.md §2).
-- Applied ONLY to emulated local D1 (vitest-pool-workers fixture).
-- Real D1 provisioning/migrations require the human G-cap-live gate.
-- Mirrors apps/customer-assets/src/server/db/schema.ts — keep both in sync.
-- Timestamps are epoch milliseconds (INTEGER); ids are opaque UUID strings.

-- Authorized integrator principal per workspace (mapping stays local to
-- Studio; the portal stores only the id + label, contracts.md §1/§2).
CREATE TABLE IF NOT EXISTS "portal_workspace" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "label" TEXT NOT NULL,
  "integrator_user_id" TEXT NOT NULL REFERENCES "user"("id"),
  "created_ms" INTEGER NOT NULL
);

-- Unique projection per (workspace, studio client); display fields only.
CREATE TABLE IF NOT EXISTS "portal_client" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "portal_workspace"("id"),
  "studio_client_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "projection_version" INTEGER NOT NULL DEFAULT 1,
  "created_ms" INTEGER NOT NULL,
  UNIQUE ("workspace_id", "studio_client_id")
);

-- Human access: one row per (user, client); revocation = status + revoked_ms.
CREATE TABLE IF NOT EXISTS "membership" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "user_id" TEXT NOT NULL REFERENCES "user"("id"),
  "portal_client_id" TEXT NOT NULL REFERENCES "portal_client"("id"),
  "status" TEXT NOT NULL DEFAULT 'active', -- active | revoked
  "created_ms" INTEGER NOT NULL,
  "revoked_ms" INTEGER,
  UNIQUE ("user_id", "portal_client_id")
);
CREATE INDEX IF NOT EXISTS "membership_client_idx" ON "membership" ("portal_client_id");
CREATE INDEX IF NOT EXISTS "membership_user_idx" ON "membership" ("user_id");

-- Invitations carry no alternative token: sign-in is Better Auth magic link
-- (contracts.md §3); the row only records who was invited where, until when.
CREATE TABLE IF NOT EXISTS "invitation" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "email" TEXT NOT NULL, -- normalized lowercase
  "portal_client_id" TEXT NOT NULL REFERENCES "portal_client"("id"),
  "status" TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | revoked | expired
  "invited_by" TEXT NOT NULL REFERENCES "user"("id"),
  "expires_ms" INTEGER NOT NULL,
  "accepted_user_id" TEXT REFERENCES "user"("id"),
  "created_ms" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "invitation_client_idx" ON "invitation" ("portal_client_id");
CREATE INDEX IF NOT EXISTS "invitation_email_idx" ON "invitation" ("email");

-- Server-side agent authorization (contracts.md §2/§3): verified key id ->
-- revocable workspace/client list + scopes. Scopes are NEVER taken from CLI
-- input or from Better Auth key permissions; this row is the only source.
CREATE TABLE IF NOT EXISTS "agent_grant" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "key_id" TEXT NOT NULL UNIQUE REFERENCES "apikey"("id"),
  "workspace_id" TEXT NOT NULL REFERENCES "portal_workspace"("id"),
  "client_ids" TEXT NOT NULL DEFAULT 'null', -- JSON array, or literal 'null' = whole workspace
  "scopes" TEXT NOT NULL,                    -- JSON array of scope strings
  "revoked_ms" INTEGER,
  "created_ms" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "agent_grant_workspace_idx" ON "agent_grant" ("workspace_id");

-- Staging sessions: pending rows are written BEFORE any R2 IO. The staging
-- key is always server-generated and never leaves the server (contracts §4).
CREATE TABLE IF NOT EXISTS "upload_session" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "client_id" TEXT NOT NULL REFERENCES "portal_client"("id"),
  "workspace_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL, -- material | delivery_output
  "staging_key" TEXT NOT NULL UNIQUE,
  "declared_bytes" INTEGER NOT NULL,
  "declared_media_type" TEXT NOT NULL,
  "declared_sha256" TEXT, -- required for delivery_output
  "delivery_id" TEXT,     -- delivery_output target
  "output_name" TEXT,     -- delivery_output target
  "original_name" TEXT,   -- display only (materials)
  "principal_id" TEXT NOT NULL, -- owning principal ('user:<id>' | 'key:<id>')
  "status" TEXT NOT NULL DEFAULT 'pending', -- pending | staged | ready | rejected | failed | expired
  "actual_bytes" INTEGER,
  "actual_sha256" TEXT,
  "actual_media_type" TEXT,
  "material_id" TEXT,
  "expires_ms" INTEGER NOT NULL,
  "created_ms" INTEGER NOT NULL,
  "completed_ms" INTEGER
);
CREATE INDEX IF NOT EXISTS "upload_session_client_idx" ON "upload_session" ("client_id", "created_ms");

-- Idempotency ledger (contracts.md §6): key bound to principal+client+
-- operation; the payload fingerprint detects divergent retries (409).
CREATE TABLE IF NOT EXISTS "idempotency_record" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "principal_id" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "key_hash" TEXT NOT NULL, -- sha256 of the raw key; raw keys are never stored
  "fingerprint" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', -- pending | completed | failed
  "response_status" INTEGER,
  "response_json" TEXT,
  "created_ms" INTEGER NOT NULL,
  UNIQUE ("principal_id", "client_id", "operation", "key_hash")
);

-- Concurrent-safe quota budget (default 1 GiB/client, decisions.json).
-- Reservation is a single-statement CAS; no read-modify-write races.
CREATE TABLE IF NOT EXISTS "client_quota" (
  "client_id" TEXT PRIMARY KEY NOT NULL REFERENCES "portal_client"("id"),
  "used_bytes" INTEGER NOT NULL DEFAULT 0,
  "reserved_bytes" INTEGER NOT NULL DEFAULT 0,
  "limit_bytes" INTEGER NOT NULL DEFAULT 1073741824,
  "updated_ms" INTEGER NOT NULL DEFAULT 0
);

-- Materials: ready only after the immutable final object exists (contracts §4).
CREATE TABLE IF NOT EXISTS "material" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "client_id" TEXT NOT NULL REFERENCES "portal_client"("id"),
  "workspace_id" TEXT NOT NULL,
  "object_key" TEXT NOT NULL UNIQUE,
  "original_name" TEXT,
  "media_type" TEXT NOT NULL,
  "bytes" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ready',
  "uploaded_by" TEXT NOT NULL, -- principal id only; no secrets/paths
  "created_ms" INTEGER NOT NULL,
  UNIQUE ("client_id", "sha256")
);
CREATE INDEX IF NOT EXISTS "material_client_idx" ON "material" ("client_id", "created_ms");

-- Exact Studio revision projection; immutable refs, new versions = new rows
-- (contracts.md §2/§5). Unique refs make delivery retries non-duplicating;
-- the same Studio revision may still be delivered to DIFFERENT portal clients
-- (multi-client projects), so uniqueness is per client.
CREATE TABLE IF NOT EXISTS "delivery_revision" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "client_id" TEXT NOT NULL REFERENCES "portal_client"("id"),
  "workspace_id" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "asset_id" TEXT NOT NULL,
  "revision_id" TEXT NOT NULL,
  "root_hash" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "provenance_json" TEXT,
  "fingerprint" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', -- pending | ready | failed
  "created_by" TEXT NOT NULL,
  "created_ms" INTEGER NOT NULL,
  "completed_ms" INTEGER,
  UNIQUE ("client_id", "project_id", "asset_id", "revision_id")
);
CREATE INDEX IF NOT EXISTS "delivery_client_idx" ON "delivery_revision" ("client_id", "created_ms");

CREATE TABLE IF NOT EXISTS "delivery_output" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "delivery_id" TEXT NOT NULL REFERENCES "delivery_revision"("id"),
  "name" TEXT NOT NULL,
  "media_type" TEXT NOT NULL,
  "bytes" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "object_key" TEXT, -- set only after verified finalize
  "finalized_ms" INTEGER,
  "created_ms" INTEGER NOT NULL,
  UNIQUE ("delivery_id", "name")
);

-- Client-facing catalog entry for a delivered revision. Visibility is
-- independent of editorial status (contracts.md §2).
CREATE TABLE IF NOT EXISTS "client_asset" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "client_id" TEXT NOT NULL REFERENCES "portal_client"("id"),
  "delivery_id" TEXT NOT NULL UNIQUE REFERENCES "delivery_revision"("id"),
  "title" TEXT NOT NULL,
  "visibility" TEXT NOT NULL DEFAULT 'internal', -- internal | client_visible
  "editorial_status" TEXT NOT NULL DEFAULT 'draft',
  "created_ms" INTEGER NOT NULL,
  "updated_ms" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "client_asset_client_idx" ON "client_asset" ("client_id", "created_ms");

CREATE TABLE IF NOT EXISTS "post" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "client_id" TEXT NOT NULL REFERENCES "portal_client"("id"),
  "asset_id" TEXT NOT NULL REFERENCES "client_asset"("id"),
  "title" TEXT NOT NULL,
  "caption" TEXT,
  "cover_output_name" TEXT NOT NULL,
  "visibility" TEXT NOT NULL DEFAULT 'internal', -- internal | client_visible
  "position" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_ms" INTEGER NOT NULL,
  "updated_ms" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "post_client_position_idx" ON "post" ("client_id", "position");

CREATE TABLE IF NOT EXISTS "post_output" (
  "post_id" TEXT NOT NULL REFERENCES "post"("id"),
  "name" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  PRIMARY KEY ("post_id", "name")
);

-- Versioned grid ordering per client (optimistic concurrency via version).
CREATE TABLE IF NOT EXISTS "client_grid" (
  "client_id" TEXT PRIMARY KEY NOT NULL REFERENCES "portal_client"("id"),
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_ms" INTEGER NOT NULL DEFAULT 0
);

-- Minimal audit: actor kinds/ids and resource ids only — never cookies,
-- tokens, signed URLs or local paths (contracts.md §2, NFR-006).
CREATE TABLE IF NOT EXISTS "audit_event" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT,
  "client_id" TEXT,
  "actor" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "resource_type" TEXT NOT NULL,
  "resource_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "created_ms" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "audit_client_idx" ON "audit_event" ("client_id", "created_ms");
