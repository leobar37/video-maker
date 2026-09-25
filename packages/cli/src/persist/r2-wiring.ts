/**
 * Production wiring for `vm archive` run mode (FR-012): the persistence
 * `ArchiveStorageSource` backed by the real R2 adapter (`@videomaker/providers`)
 * with credentials resolved through `@videomaker/credentials`.
 *
 * Invariants:
 * - Lazy (NFR-002): nothing resolves or constructs until a real `archive` run
 *   invokes the source. `--plan`/`--dry-run` never installs it (see
 *   `src/main.ts`) and planning never reaches the storage seam at all.
 * - Secrets travel only through `@videomaker/credentials` (`resolveR2Env` for
 *   the R2 contract, `createSecretSource` for the provider context) and never
 *   enter logs or reports (NFR-001).
 * - The archive bucket is an explicit choice: `bundlesBucket ?? bucket`. The
 *   store runs on an env carrying that choice — S3 calls follow `env.bucket`.
 * - The default R2 client runs `maxAttempts: 1` (explicit, never silent SDK
 *   retries): uploads are content-addressed and idempotent at the seam level.
 */
import { resolveR2Env, type R2Env } from '@videomaker/credentials';
import {
  createSecretSource,
  R2ObjectStore,
  systemClock,
  type FetchLike,
  type ObjectStore,
  type ProviderContext,
} from '@videomaker/providers';

import { DEFAULT_KEY_PREFIX } from './archive';
import type { ArchiveStorage, ArchiveStorageSource } from './storage-seam';

/** Where archive objects go — reporting only, NEVER a secret (NFR-001). */
export interface ArchiveTargetDescription {
  bucket: string;
  endpointHost: string;
  keyPrefix: string;
  publicUrlPolicy: string;
}

export interface R2ArchiveSourceOptions {
  /** Test seam: environment resolution. Defaults to `resolveR2Env({ mode: 'run', fetchImpl })`. */
  resolveEnv?: (opts: { mode: 'run'; fetchImpl: FetchLike }) => Promise<R2Env>;
  /** Test seam: fetch used for credential resolution and the provider context. */
  fetchImpl?: FetchLike;
  /** Test seam: store construction. Defaults to the real `R2ObjectStore`. */
  createStore?: (env: R2Env) => ObjectStore;
}

/** The archive bucket is an explicit choice: bundles bucket first, marketing pair second. */
export function archiveBucketOf(env: R2Env): string {
  return env.bundlesBucket ?? env.bucket;
}

/** URL hostname with a `''` fallback for a malformed endpoint (reporting only). */
function endpointHostOf(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return '';
  }
}

/**
 * Report-only target: bucket + endpoint host + key convention + public URL
 * policy. Pure and secret-free — safe to print before or after uploading, so
 * the CLI can say WHERE objects go without exposing how to reach them.
 */
export function describeArchiveTarget(env: R2Env): ArchiveTargetDescription {
  return {
    bucket: archiveBucketOf(env),
    endpointHost: endpointHostOf(env.endpoint),
    keyPrefix: DEFAULT_KEY_PREFIX,
    publicUrlPolicy: `${env.publicUrl.replace(/\/+$/, '')}/<key>`,
  };
}

/** Structural check over the fields the description reads (never the secrets). */
function isR2EnvLike(value: unknown): value is R2Env {
  const record = value as Record<string, unknown> | undefined;
  return (
    typeof record === 'object' &&
    record !== null &&
    typeof record.bucket === 'string' &&
    typeof record.endpoint === 'string' &&
    typeof record.publicUrl === 'string' &&
    (record.bundlesBucket === undefined || typeof record.bundlesBucket === 'string')
  );
}

/**
 * Target behind a resolved archive storage: reads the resolved environment the
 * R2 adapter exposes on its store. `null` for stores without one (fakes, foreign
 * adapters) so callers can fall back to a generic line — never throws.
 */
export function archiveTargetOf(storage: ArchiveStorage): ArchiveTargetDescription | null {
  const env = (storage.store as { env?: unknown }).env;
  return isR2EnvLike(env) ? describeArchiveTarget(env) : null;
}

/**
 * The `ArchiveStorageSource` for run mode. Construction is pure: the R2
 * environment resolves and the store is built only when a real `archive` run
 * invokes the source — zero resolutions until then.
 */
export function createR2ArchiveStorageSource(
  options: R2ArchiveSourceOptions = {},
): ArchiveStorageSource {
  return async (): Promise<ArchiveStorage> => {
    const fetchImpl = options.fetchImpl ?? fetch;
    const resolveEnv = options.resolveEnv ?? resolveR2Env;
    const env = await resolveEnv({ mode: 'run', fetchImpl });
    // S3 calls follow `env.bucket`: the store runs on the explicit archive choice.
    const archiveEnv = { ...env, bucket: archiveBucketOf(env) };
    const store =
      options.createStore?.(archiveEnv) ?? new R2ObjectStore(archiveEnv, { maxAttempts: 1 });
    const ctx: ProviderContext = {
      mode: 'run',
      secrets: createSecretSource({ fetchImpl }),
      fetchImpl,
      clock: systemClock,
    };
    return { store, ctx };
  };
}
