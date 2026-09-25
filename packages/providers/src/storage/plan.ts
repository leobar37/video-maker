/**
 * Redacted configuration plan for the R2 storage adapter.
 *
 * Pure over `EnvPresence`: it inspects NAME presence only (never values), so a
 * plan run stays offline and secret-free (NFR-001/NFR-002) and can describe
 * what WOULD be required even with zero environment declared.
 */
import {
  R2_BUNDLES_BUCKET_NAME,
  R2_GENERIC_PAIR,
  R2_MARKETING_PAIR,
  R2_REQUIRED_NAMES,
} from '@videomaker/credentials';

import type { EnvPresence } from './context';

export interface AdapterPlanReport {
  /** Adapter identifier as printed by the smoke plan. */
  adapter: string;
  /** Secret/config names this adapter expects (declared or not). */
  names: string[];
  /** Names actually declared (presence only — values are never read). */
  present: string[];
  /** Names not declared: the plan says what WOULD be required. */
  missing: string[];
  /** Incoherent declarations; a non-empty list fails the smoke plan. */
  errors: string[];
  /** Redacted description of what the adapter would do in run mode. */
  would: string[];
}

function declared(presence: EnvPresence, name: string): boolean {
  return presence(name);
}

/**
 * R2 contract coherence from name presence alone:
 * - `R2_REQUIRED_NAMES` are always required;
 * - the marketing pair (bucket + public URL) is one declaration: both or
 *   neither — a half pair mixes buckets and publishes 404 links;
 * - without the marketing pair the generic pair plays the same all-or-nothing
 *   game;
 * - `R2_BUNDLES_BUCKET_NAME` is optional.
 */
export function describeStoragePlan(presence: EnvPresence): AdapterPlanReport {
  const errors: string[] = [];
  const missing: string[] = [];
  const names = [
    ...R2_REQUIRED_NAMES,
    ...R2_MARKETING_PAIR,
    ...R2_GENERIC_PAIR,
    R2_BUNDLES_BUCKET_NAME,
  ];

  const [marketingBucket, marketingUrl] = R2_MARKETING_PAIR;
  const [genericBucket, genericUrl] = R2_GENERIC_PAIR;
  const hasMarketingBucket = declared(presence, marketingBucket);
  const hasMarketingUrl = declared(presence, marketingUrl);
  if (hasMarketingBucket !== hasMarketingUrl) {
    errors.push(
      `half-declared marketing pair: ${marketingBucket}=${hasMarketingBucket ? 'declared' : 'missing'}` +
        ` but ${marketingUrl}=${hasMarketingUrl ? 'declared' : 'missing'} — declare both or neither ` +
        '(one bucket + another bucket\'s URL publishes links that answer 404).',
    );
  }
  const useMarketing = hasMarketingBucket && hasMarketingUrl;
  let pairLabel: string;
  if (useMarketing) {
    pairLabel = `marketing pair (${marketingBucket} + ${marketingUrl})`;
  } else {
    const hasGenericBucket = declared(presence, genericBucket);
    const hasGenericUrl = declared(presence, genericUrl);
    if (hasGenericBucket !== hasGenericUrl) {
      errors.push(
        `half-declared generic pair: ${genericBucket}=${hasGenericBucket ? 'declared' : 'missing'}` +
          ` but ${genericUrl}=${hasGenericUrl ? 'declared' : 'missing'} — declare both or neither.`,
      );
    }
    pairLabel = `generic pair (${genericBucket} + ${genericUrl})`;
  }

  for (const name of R2_REQUIRED_NAMES) {
    if (!declared(presence, name)) missing.push(name);
  }
  if (useMarketing) {
    for (const name of R2_MARKETING_PAIR) {
      if (!declared(presence, name)) missing.push(name);
    }
  } else {
    for (const name of R2_GENERIC_PAIR) {
      if (!declared(presence, name)) missing.push(name);
    }
  }

  return {
    adapter: 'storage/r2-store',
    names,
    present: names.filter((name) => declared(presence, name)),
    missing,
    errors,
    would: [
      'resolve the R2 environment (accountId derived from the R2_ENDPOINT host; never requested as a name)',
      'build the S3 client (region=auto, maxAttempts=1: no silent SDK retries)',
      `head/put/get/inspect on s3://<bucket> from the ${pairLabel}, sha256 verified on inspect`,
      'verifyPublicUrlCoherence(bucket, publicUrl) before mutating manifests (pair match + live serve probe)',
      `optional override: ${R2_BUNDLES_BUCKET_NAME}=${declared(presence, R2_BUNDLES_BUCKET_NAME) ? 'declared' : 'not declared'}`,
    ],
  };
}
