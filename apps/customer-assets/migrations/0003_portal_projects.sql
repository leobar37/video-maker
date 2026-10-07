-- 0003_portal_projects.sql · PortalProject projection + material attribution
-- (P-101, R-1; contracts.md §2/§5 additive · customer-assets-requests).
-- Applied ONLY to emulated local D1 (vitest-pool-workers fixture; the offline
-- verifier/e2e fixtures replay 0001+0002 only, so every v1 statement must
-- keep working on a database WITHOUT this migration — the new column is
-- therefore touched exclusively by project-context code paths).
-- Real D1 provisioning/migrations require the human G-cap-live gate.
-- Mirrors apps/customer-assets/src/server/db/schema.ts — keep both in sync.
-- Timestamps are epoch milliseconds (INTEGER); ids are opaque UUID strings.

-- Canonical pointer projection per (portal client, Studio project), exactly
-- like PortalClient for clients (contracts.md §2): display fields only, the
-- Studio ids stay canonical, and adoption is admin-human-only. UNIQUE makes
-- registerProjectPointer retries non-duplicating (409 on divergent title).
CREATE TABLE IF NOT EXISTS "portal_project" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "workspace_id" TEXT NOT NULL REFERENCES "portal_workspace"("id"),
  "portal_client_id" TEXT NOT NULL REFERENCES "portal_client"("id"),
  "studio_project_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "projection_version" INTEGER NOT NULL DEFAULT 1,
  "created_ms" INTEGER NOT NULL,
  UNIQUE ("portal_client_id", "studio_project_id")
);

CREATE INDEX IF NOT EXISTS "portal_project_client_idx" ON "portal_project" ("portal_client_id", "created_ms");

-- Optional attribution (FR-104): NULL = free v1 upload, flow and permissions
-- untouched. Set ONLY when a logged-in principal completes a material upload
-- explicitly tagged with a project of that client; never backfilled. The
-- attribution binds at upload COMPLETE (same binding point the R-2 request
-- flow uses); the free path sends no field and executes none of this.
ALTER TABLE "material" ADD COLUMN "portal_project_id" TEXT;

CREATE INDEX IF NOT EXISTS "material_project_idx" ON "material" ("portal_project_id");
