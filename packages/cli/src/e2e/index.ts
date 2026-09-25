/**
 * Public surface of the e2e pipeline helpers (`packages/cli/src/e2e`):
 * driver argv + spend-cap enforcement, offline narration/music synthesis,
 * the $0 journal bridge, secret self-check, run self-checks and the metrics
 * report. `runE2e` is the orchestrator `scripts/demo-e2e.ts` drives.
 */
export { E2E_USAGE, E2eUsageError, parseE2eArgs, type E2eArgs, type E2eMode } from './args';
export {
  MUSIC_PLANNED_USD_PER_TRACK,
  SpendCapRefusal,
  TTS_PLANNED_USD_PER_1K_CHARS,
  assertSpendHeadroom,
  buildSpendPlan,
  decideMusicSource,
  enforceSpendCap,
  formatCostTable,
  type MusicSourceDecision,
  type PlannedOperation,
  type SpendPlan,
} from './costs';
export {
  OFFLINE_RECEIPT_PROVIDER,
  journalOfflineOperation,
  readJournalSummary,
  type JournalEntrySummary,
  type JournalSummary,
  type OfflineJournalInput,
  type OfflineJournalResult,
} from './journal';
export {
  OFFLINE_PROVIDER_ID,
  findNarrationMaster,
  isOfflineNarrationMeta,
  writeOfflineNarrationMaster,
  type OfflineNarrationOptions,
  type OfflineNarrationResult,
} from './offline-narration';
export {
  SYNTH,
  planNarrationTimeline,
  synthesizeMusicBedWav,
  synthesizeNarrationWav,
  timelineAlignment,
  type NarrationTimeline,
} from './offline-audio';
export { encodePcm16Wav, type WavFormat } from './wav';
export {
  DEMO_BED_ID,
  demoMusicLibraryPaths,
  ensureDemoMusicBed,
  type MusicBedState,
} from './music-bed';
export { ensureSceneCaptures, type CapturePrepResult } from './captures';
export {
  formatSecretFindings,
  isScannableTextPath,
  scanProjectSecrets,
  scanTextForSecrets,
  type SecretFinding,
  type SecretScanReport,
} from './secret-scan';
export {
  journalStateCheck,
  loudnessToleranceCheck,
  probeRenderArtifact,
  repinLoudnessEvidence,
  type RenderProbe,
} from './checks';
export {
  buildMetricsReport,
  formatMetricsReport,
  type E2eCheck,
  type MetricsInput,
  type MetricsLoudness,
  type MetricsOperation,
  type MetricsRender,
  type MetricsReport,
  type MetricsSpend,
  type MetricsVideo,
} from './metrics';
export { buildDemoMediaDeps, demoWebpackOverride } from './wiring';
export {
  METRICS_RELATIVE,
  runE2e,
  type RunE2eOptions,
  type RunE2eResult,
} from './run';
