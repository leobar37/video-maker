/**
 * keys.ts — known credential names and the R2 environment contract.
 *
 * The R2 contract deliberately has NO `R2_ACCOUNT_ID`: the S3 client only
 * needs `R2_ENDPOINT` + credentials, so the accountId is derived from the
 * endpoint host (`https://<accountId>.r2.cloudflarestorage.com`) via
 * `accountIdFromEndpoint`. Bucket names and public URLs are config values that
 * resolve env → project `.env` → Doppler like every other name here.
 */

/** Provider API keys (env → project `.env` → Doppler). */
export const CREDENTIAL_NAMES = [
  'FAL_KEY',
  'ZERNIO_API_KEY',
  'ELEVENLABS_API_KEY',
  'TYPE_SAFE_AI',
] as const;
export type CredentialName = (typeof CREDENTIAL_NAMES)[number];

/** R2 contract keys that are always required (env → `.env` → Doppler). */
export const R2_REQUIRED_NAMES = [
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_ENDPOINT',
] as const;
export type R2RequiredName = (typeof R2_REQUIRED_NAMES)[number];

/**
 * Marketing pair: bucket + public URL come from the same source. Both or
 * neither — a half declaration mixes the marketing bucket with the generic
 * pair's URL and publishes 404 links.
 */
export const R2_MARKETING_PAIR = [
  'R2_MARKETING_BUCKET_NAME',
  'R2_MARKETING_PUBLIC_URL',
] as const;
export type R2MarketingPairName = (typeof R2_MARKETING_PAIR)[number];

/** Generic fallback pair used when the marketing pair is not declared. */
export const R2_GENERIC_PAIR = ['R2_BUCKET_NAME', 'R2_PUBLIC_URL'] as const;
export type R2GenericPairName = (typeof R2_GENERIC_PAIR)[number];

/** Optional config lookup (exposed as `R2Env.bundlesBucket`). */
export const R2_BUNDLES_BUCKET_NAME = 'R2_BUNDLES_BUCKET_NAME';

/** Config (non-secret) names of the R2 contract. */
export const R2_CONFIG_NAMES = [
  ...R2_MARKETING_PAIR,
  ...R2_GENERIC_PAIR,
  R2_BUNDLES_BUCKET_NAME,
] as const;
export type R2ConfigName = (typeof R2_CONFIG_NAMES)[number];

/** Every name this package knows how to resolve individually. */
export const ALL_SECRET_NAMES = [...CREDENTIAL_NAMES, ...R2_REQUIRED_NAMES] as const;
export type SecretName = (typeof ALL_SECRET_NAMES)[number];

/**
 * R2 environment contract, mapped from the names above:
 *   accountId       ← derived from R2_ENDPOINT (never requested)
 *   accessKeyId     ← R2_ACCESS_KEY_ID
 *   secretAccessKey ← R2_SECRET_ACCESS_KEY
 *   endpoint        ← R2_ENDPOINT (trailing slashes stripped)
 *   bucket          ← R2_MARKETING_BUCKET_NAME ?? R2_BUCKET_NAME
 *   publicUrl       ← R2_MARKETING_PUBLIC_URL ?? R2_PUBLIC_URL (slashes stripped)
 *   bundlesBucket   ← R2_BUNDLES_BUCKET_NAME (optional)
 */
export interface R2Env {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
  publicUrl: string;
  bundlesBucket?: string;
}

/** First label of the endpoint hostname (`https://<accountId>.r2.cloudflarestorage.com`). */
export function accountIdFromEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).hostname.split('.')[0] ?? '';
  } catch {
    return '';
  }
}
