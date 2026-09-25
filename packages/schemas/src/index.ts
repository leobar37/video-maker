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
} as const;

export type SchemaContract = keyof typeof SCHEMA_VERSIONS;
