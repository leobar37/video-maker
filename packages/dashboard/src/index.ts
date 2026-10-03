/**
 * `@videomaker/dashboard` — ONE read-only consumer of the studio catalog
 * (contracts.md §8): Bun HTTP server, vanilla HTML/CSS/TS UI, sealed-file
 * serving by declared output name, and the `dashboard url` Tailscale link
 * resolution. No renderer, no per-client HTML, no snapshot/R2 logic.
 */
export {
  createDashboardApp,
  loadSealedManifest,
  resolveSealedOutput,
  sealedDownloadName,
  sniffServedMediaType,
  startDashboardServer,
} from './server';
export type { DashboardApp, DashboardAppOptions, DashboardServerOptions, RunningDashboard, SealedOutput, SealedOutputRequest } from './server';
export {
  dashboardServeStatePath,
  isTailscaleIpv4,
  probeDashboardHealth,
  probeListenerViaSs,
  readDashboardServeState,
  removeDashboardServeState,
  resolveDashboardUrl,
  tailscaleIpv4ViaCli,
  writeDashboardServeState,
} from './tailscale';
export type {
  DashboardServeState,
  DashboardUrlInput,
  DashboardUrlResult,
  HealthProbe,
  ListenerProbe,
  ListenerProbeInput,
  ListenerProbeResult,
  TailscaleIpv4Resolver,
} from './tailscale';
export { buildPublicCreatorBatchStatus } from './batch-status';
export type { PublicCreatorBatchCapacityStatus, PublicCreatorBatchStatus, PublicCreatorBatchTargetStatus } from './batch-status';
export { createByteResponse, createReviewPreviewHandler } from './review-preview';
export type { ReviewPreviewConfig, ReviewPreviewFile, ReviewPreviewHandler, ReviewPreviewMediaType } from './review-preview';
