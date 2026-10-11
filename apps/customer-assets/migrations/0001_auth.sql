-- 0001_auth.sql · Better Auth tables for the customer-assets portal.
-- Applied ONLY to emulated local D1 (vitest-pool-workers fixture) in P-001.
-- Real D1 provisioning/migrations require the human G-cap-live gate.
-- Field names mirror apps/customer-assets/src/server/db/auth-schema.ts
-- (better-auth 1.7.7 core models + @better-auth/api-key 1.7.7 "apikey" model).

CREATE TABLE IF NOT EXISTS "user" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "email_verified" INTEGER NOT NULL DEFAULT 0,
  "image" TEXT,
  -- Portal role: provisioned server-side only; never settable by public input.
  "role" TEXT NOT NULL DEFAULT 'member',
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "session" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "user_id" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "token" TEXT NOT NULL UNIQUE,
  "expires_at" INTEGER NOT NULL,
  "ip_address" TEXT,
  "user_agent" TEXT,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "account" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "account_id" TEXT NOT NULL,
  "provider_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "access_token" TEXT,
  "refresh_token" TEXT,
  "id_token" TEXT,
  "access_token_expires_at" INTEGER,
  "refresh_token_expires_at" INTEGER,
  "scope" TEXT,
  "password" TEXT,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "verification" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "value" TEXT NOT NULL,
  "identifier" TEXT NOT NULL,
  "expires_at" INTEGER NOT NULL,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS "apikey" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "config_id" TEXT NOT NULL DEFAULT 'default',
  "name" TEXT,
  "start" TEXT,
  "reference_id" TEXT NOT NULL,
  "prefix" TEXT,
  "key" TEXT NOT NULL,
  "refill_interval" INTEGER,
  "refill_amount" INTEGER,
  "last_refill_at" INTEGER,
  "enabled" INTEGER NOT NULL DEFAULT 1,
  "rate_limit_enabled" INTEGER NOT NULL DEFAULT 1,
  "rate_limit_time_window" INTEGER NOT NULL DEFAULT 86400,
  "rate_limit_max" INTEGER NOT NULL DEFAULT 10,
  "request_count" INTEGER NOT NULL DEFAULT 0,
  "remaining" INTEGER,
  "last_request" INTEGER,
  "expires_at" INTEGER,
  "created_at" INTEGER NOT NULL,
  "updated_at" INTEGER NOT NULL,
  "permissions" TEXT,
  "metadata" TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS "apikey_key_idx" ON "apikey" ("key");
CREATE INDEX IF NOT EXISTS "apikey_reference_id_idx" ON "apikey" ("reference_id");
CREATE INDEX IF NOT EXISTS "apikey_config_id_idx" ON "apikey" ("config_id");
CREATE INDEX IF NOT EXISTS "session_user_id_idx" ON "session" ("user_id");
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier");
