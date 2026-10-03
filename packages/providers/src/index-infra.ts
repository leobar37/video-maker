/**
 * `@videomaker/providers` infrastructure barrel: R2 object storage and the
 * complete Zernio publication surface (publish/schedule/status/reconcile,
 * distribution, ads, publication journal) plus the plan descriptors used by
 * `providers:smoke --plan`.
 *
 * Port types live in `./ports` and are re-exported by the package root, not
 * here — this barrel exports only concrete adapter code.
 */

// Storage seam + R2 adapter
export {
  assertRunMode,
  PlanModeError,
  processEnvPresence,
  systemClock,
} from './storage/context';
export type { EnvPresence } from './storage/context';

export {
  ChecksumMismatchError,
  createR2Client,
  isNotFoundError,
  ObjectNotFoundError,
  publicUrlFor,
  R2BucketAdmin,
  R2ObjectStore,
  RemoteUnverifiableError,
} from './storage/r2-store';
export type { CoherenceCheck, R2StoreOptions, S3Like } from './storage/r2-store';
export { bodyToBytes } from './storage/r2-store';

// Studio backup port adapter (P-004): private-bucket StudioStorage over R2
export {
  createPrivateStudioR2Storage,
  STUDIO_PRIVATE_BUCKET_ENV_NAME,
  studioPrivateBucketOf,
  StudioPrivateBucketMissingError,
  StudioR2Storage,
  StudioStorageConflictError,
} from './storage/studio-r2';
export type { PrivateStudioR2StorageOptions, StudioR2StorageOptions } from './storage/studio-r2';

export { describeStoragePlan } from './storage/plan';
export type { AdapterPlanReport } from './storage/plan';

// Zernio client + accounts
export { ZernioClient, ZERNIO_BASE_URL, ZernioTransportError } from './zernio/client';
export type { ZernioClientOptions, ZernioRequestInit, ZernioResponse } from './zernio/client';

export {
  DEFAULT_ZERNIO_PROFILE,
  mergeHealth,
  normalizeAccount,
  parseProfiles,
  resolveAccountRef,
  resolveTargetAccount,
  resolveZernioProfile,
  toPublisherAccount,
  ZernioAccountError,
  ZernioAccounts,
} from './zernio/accounts';
export type { ZernioAccount, ZernioProfile } from './zernio/accounts';

// Publication journal
export {
  attemptsUsed,
  FilePublicationJournal,
  InMemoryPublicationJournal,
  JournalError,
  latestByAttempt,
  latestByKey,
  outcomeOf,
  parsePublicationJournalText,
  validatePublicationJournalEntry,
} from './zernio/journal';
export type {
  PublicationJournalEntry,
  PublicationJournalStore,
} from './zernio/journal';

// Post response parsing
export {
  duplicatePostId,
  extractCreatedPost,
  extractFirstListedPost,
  extractListedPosts,
  extractReceiptPostId,
  isIdempotencyConflict,
  postUrlOf,
  targetReceiptOf,
} from './zernio/post-response';
export type {
  CreatedMediaItem,
  CreatedPlatform,
  CreatedPost,
  ReceiptTarget,
  TargetReceipt,
} from './zernio/post-response';

// Publish / status / reconcile
export {
  AttemptsExhaustedError,
  buildPostBody,
  PostValidationError,
  SCHEDULE_TIMEZONE_DEFAULT,
  validateSocialPost,
  ZernioPublisher,
} from './zernio/publish';
export type { ZernioPublisherOptions } from './zernio/publish';

export {
  reconcileByKey,
  remoteReconcileLookup,
  statusByKey,
} from './zernio/status';
export type {
  ReconcileFinding,
  ReconcileLookup,
  RemotePostEvidence,
  RemoteReconcileOptions,
  StatusOptions,
} from './zernio/status';

// Distribution (social-track)
export {
  limaLabel,
  mergeDistributionEntry,
  nextUtcOccurrence,
  parseBestTimeSlots,
  rankBestTimeSlots,
  toDistribution,
  ZernioDistribution,
  ZernioDistributionError,
} from './zernio/distribution';
export type {
  BestTimeSlot,
  DistributionEntry,
  DistributionMap,
  PostDistribution,
  QueueSlot,
  SocialEntry,
} from './zernio/distribution';

// Ads (paid operations)
export {
  adsConnectionId,
  buildBoostBody,
  evaluateAlert,
  extractCampaignId,
  ZernioAds,
  ZernioAdsError,
} from './zernio/ads';
export type {
  AlertResult,
  AlertThresholds,
  BoostPlanBundle,
  BoostRequest,
  BoostSubmitOptions,
  BoostSubmitResult,
  BoostTarget,
  CampaignInsights,
  CampaignSummary,
  ZernioAdsOptions,
} from './zernio/ads';

// Plan descriptors (smoke)
export { describeZernioPlan, ZERNIO_REQUIRED_NAMES } from './zernio/plan';
