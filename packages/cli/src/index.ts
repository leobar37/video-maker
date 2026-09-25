/**
 * `@videomaker/cli` — declarative production CLI (FR-013).
 *
 * Commands are `CommandSpec` data in a registry; `runCli` interprets them.
 * Plan mode (`--plan`/`--dry-run`) never touches the network or credentials.
 */
export * from './spec-types';
export * from './args';
export * from './registry';
export * from './runtime';
export * from './all-specs';
export { inspectSpecs, filterVideos, CATALOG_RELATIVE } from './specs/inspect';
export { sceneSpecs, SCENE_AGENT_IDS } from './specs/scene';
export type { SceneAgentId } from './specs/scene';
