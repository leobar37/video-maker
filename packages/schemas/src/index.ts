/**
 * `@videomaker/schemas` — versioned data contracts of the video production
 * pipeline. Every document schema carries a `schemaVersion` literal so old
 * files keep parsing while the contracts evolve.
 */
export * from './primitives';
export * from './execution';
export * from './scene';
export * from './narration';
export * from './catalog';
export * from './clip';
export * from './studio';
export * from './clip-selection';
export {
  CreatorPlatformSchema, CreatorPresetSchema, CreatorDraftSchema, CreatorProjectSchema,
  CreatorQaSchema, CreatorProbeSchema, CreatorTikTokInfoSchema, CreatorTikTokEnvelopeSchema,
  CreatorIntentSchema, CreatorTargetResultSchema, CreatorRemotePostSchema, CreatorLookupSchema,
  type CreatorPreset, type CreatorDraft, type CreatorProject, type CreatorMediaQa,
  type CreatorIntent, type CreatorTargetResult, type CreatorTikTokCapability,
} from './creator';
export * from './creator-batch';
export * from './creator-preflight';
export * from './creator-pilot';

/**
 * Current (latest) `schemaVersion` per contract. Older versions remain
 * parseable wherever the contract keeps them (execution V1, scene V1/V2).
 */
export const SCHEMA_VERSIONS = {
  executionProposal: 1,
  executionProgress: 2,
  executionResult: 2,
  sceneBrief: 1,
  sceneResult: 3,
  narration: 1,
  catalog: 3,
  frameAnalysis: 1,
  scoringWeights: 1,
  clipRange: 1,
  clipDecision: 1,
  clipSelectionRequest: 1,
  clipSelectionTranscript: 1,
  clipSelectionResult: 2,
  creatorBatchManifest: 1,
  creatorBatchProgress: 1,
  clipPilotPolicy: 1,
  clipPilotEvidence: 1,
  studioClient: 1,
  studioPresetVersion: 1,
  studioProject: 1,
  studioAsset: 1,
  studioRevisionManifest: 1,
  studioSyncReceipt: 1,
  studioProjectCheckpoint: 1,
  studioCatalog: 1,
} as const;

export type SchemaContract = keyof typeof SCHEMA_VERSIONS;
