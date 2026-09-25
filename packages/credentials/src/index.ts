/**
 * Public API of @videomaker/credentials: env-first credential resolution with
 * lazy `.env`/Doppler fallback, redacted reporting, and plan-mode refusal.
 */
export {
  assertNotPlanMode,
  credentialReport,
  CredentialMissingError,
  DOPPLER_CONFIG,
  DOPPLER_PROJECT,
  DOPPLER_TOKEN_ENV,
  inspectR2Env,
  redact,
  resetCredentialCache,
  resolveCredentials,
  resolveR2Env,
  type CredentialReportEntry,
  type Mode,
  type ResolveOptions,
  type R2Inspection,
} from './resolver';

export {
  accountIdFromEndpoint,
  ALL_SECRET_NAMES,
  CREDENTIAL_NAMES,
  R2_BUNDLES_BUCKET_NAME,
  R2_CONFIG_NAMES,
  R2_GENERIC_PAIR,
  R2_MARKETING_PAIR,
  R2_REQUIRED_NAMES,
  type CredentialName,
  type R2ConfigName,
  type R2Env,
  type R2GenericPairName,
  type R2MarketingPairName,
  type R2RequiredName,
  type SecretName,
} from './keys';
