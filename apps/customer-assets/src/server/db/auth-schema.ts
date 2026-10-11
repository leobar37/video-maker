import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Better Auth schema for Drizzle over D1 (better-auth 1.7.7 + @better-auth/api-key 1.7.7).
 *
 * Property keys are the Better Auth model field names (adapter resolves them
 * via `provider: 'sqlite'`, `usePlural: false`); SQL columns are snake_case.
 * Mirrors migrations/0001_auth.sql — keep both in sync.
 */

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
};

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' })
    .notNull()
    .default(false),
  image: text('image'),
  /** Portal role: server-side provisioning only, `input: false` in auth.ts. */
  role: text('role').notNull().default('member'),
  ...timestamps,
});

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    ...timestamps,
  },
  (t) => [index('session_user_id_idx').on(t.userId)],
);

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', {
    mode: 'timestamp',
  }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', {
    mode: 'timestamp',
  }),
  scope: text('scope'),
  password: text('password'),
  ...timestamps,
});

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    value: text('value').notNull(),
    identifier: text('identifier').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    ...timestamps,
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

/** Model name `apikey` matches API_KEY_TABLE_NAME in @better-auth/api-key. */
export const apikey = sqliteTable(
  'apikey',
  {
    id: text('id').primaryKey(),
    configId: text('config_id').notNull().default('default'),
    name: text('name'),
    start: text('start'),
    referenceId: text('reference_id').notNull(),
    prefix: text('prefix'),
    key: text('key').notNull(),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: integer('last_refill_at', { mode: 'timestamp' }),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    rateLimitEnabled: integer('rate_limit_enabled', { mode: 'boolean' })
      .notNull()
      .default(true),
    rateLimitTimeWindow: integer('rate_limit_time_window')
      .notNull()
      .default(86_400),
    rateLimitMax: integer('rate_limit_max').notNull().default(10),
    requestCount: integer('request_count').notNull().default(0),
    remaining: integer('remaining'),
    lastRequest: integer('last_request', { mode: 'timestamp' }),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
    permissions: text('permissions'),
    metadata: text('metadata'),
  },
  (t) => [
    index('apikey_key_idx').on(t.key),
    index('apikey_reference_id_idx').on(t.referenceId),
    index('apikey_config_id_idx').on(t.configId),
  ],
);
