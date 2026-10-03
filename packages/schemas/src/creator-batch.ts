import { z } from 'zod';
import { CreatorPlatformSchema, CreatorProjectSchema, CreatorQaSchema } from './creator';

const identity = z.string().min(1).refine((value) => value.trim() === value && value.length > 0, 'Nonblank identity required');
const timestamp = z.iso.datetime({ offset: true });
const hash = CreatorQaSchema.shape.videoSha256;
const projectPath = z.string().min(1).refine((value) => (
  !value.startsWith('/') && !/^[a-z]:/i.test(value) && !value.includes('\\') && !/[\u0000-\u001f\u007f]/.test(value)
  && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
), 'Require a contained, canonical project-relative path');

export const CreatorBatchQueuePolicySchema = z.enum(['allow-provider-queue', 'require-capacity']);
export type CreatorBatchQueuePolicy = z.infer<typeof CreatorBatchQueuePolicySchema>;

/** Execution scope only: settings remain in the hash-bound, approved preset. */
export const CreatorBatchTargetSchema = z.object({
  platform: CreatorPlatformSchema,
  accountId: identity,
  username: identity,
}).strict().readonly();
export type CreatorBatchTarget = z.infer<typeof CreatorBatchTargetSchema>;

export const CreatorBatchProjectSchema = z.object({
  projectPath,
  projectId: CreatorProjectSchema.shape.id,
  preset: CreatorProjectSchema.shape.preset.readonly(),
  approval: z.object({ approved: z.literal(true), digest: hash }).strict().readonly(),
  media: z.object({ videoSha256: hash, coverSha256: hash }).strict().readonly(),
  targets: z.array(CreatorBatchTargetSchema).min(1).refine(
    (targets) => new Set(targets.map((target) => target.accountId)).size === targets.length,
    'Unique target accounts required per project',
  ).readonly(),
}).strict().readonly();
export type CreatorBatchProject = z.infer<typeof CreatorBatchProjectSchema>;

/** All listed targets are required; there is no optional target or ledger bypass. */
export const CreatorBatchManifestSchema = z.object({
  schemaVersion: z.literal(1),
  batchId: CreatorProjectSchema.shape.id,
  queuePolicy: CreatorBatchQueuePolicySchema.default('allow-provider-queue'),
  projects: z.array(CreatorBatchProjectSchema).min(1).readonly(),
}).strict().superRefine((manifest, ctx) => {
  const paths = new Set<string>();
  const ids = new Set<string>();
  const accounts = new Map<string, CreatorBatchTarget>();
  manifest.projects.forEach((project, index) => {
    if (paths.has(project.projectPath)) ctx.addIssue({ code: 'custom', path: ['projects', index, 'projectPath'], message: 'Duplicate project path' });
    if (ids.has(project.projectId)) ctx.addIssue({ code: 'custom', path: ['projects', index, 'projectId'], message: 'Duplicate project identity' });
    paths.add(project.projectPath);
    ids.add(project.projectId);
    project.targets.forEach((target, targetIndex) => {
      const previous = accounts.get(target.accountId);
      if (previous && (previous.platform !== target.platform || previous.username !== target.username)) {
        ctx.addIssue({ code: 'custom', path: ['projects', index, 'targets', targetIndex], message: 'Account identity conflicts across projects' });
      }
      accounts.set(target.accountId, target);
    });
  });
}).readonly();
export type CreatorBatchManifest = z.infer<typeof CreatorBatchManifestSchema>;

export const CreatorBatchTargetStateSchema = z.enum(['published', 'pending', 'not-started', 'uncertain', 'failed', 'blocked']);
export type CreatorBatchTargetState = z.infer<typeof CreatorBatchTargetStateSchema>;

/** Internal evidence, not a public/sanitized report. Progress never authorizes resubmission. */
export const CreatorBatchTargetProgressSchema = z.object({
  projectId: CreatorProjectSchema.shape.id,
  platform: CreatorPlatformSchema,
  accountId: identity,
  state: CreatorBatchTargetStateSchema,
  idempotencyKey: z.string().regex(/^creator:[a-f0-9]{64}$/).optional(),
  remoteId: identity.optional(),
  url: z.url().optional(),
  checkedAt: timestamp.optional(),
  detail: z.string().min(1).optional(),
}).strict().superRefine((target, ctx) => {
  if (target.state === 'published' && (!target.idempotencyKey || !target.remoteId || !target.checkedAt)) {
    ctx.addIssue({ code: 'custom', message: 'Published requires exact intent, remote identity and checkedAt evidence' });
  }
  if ((target.state === 'not-started' || target.state === 'blocked') && (target.idempotencyKey || target.remoteId || target.url)) {
    ctx.addIssue({ code: 'custom', message: 'Unstarted/blocked targets cannot carry attempted-publication evidence' });
  }
});
export type CreatorBatchTargetProgress = z.infer<typeof CreatorBatchTargetProgressSchema>;

/** Unknown is the offline default, not an inferred quota or promise of immediate publication. */
export const CreatorBatchCapacityObservationSchema = z.object({
  platform: CreatorPlatformSchema,
  accountId: identity,
  status: z.enum(['confirmed', 'estimated', 'unknown']),
  source: z.string().min(1),
  checkedAt: timestamp.nullable(),
  remaining: z.number().int().nonnegative().optional(),
  available: z.number().int().nonnegative().optional(),
  canPostMore: z.boolean().optional(),
  resetAt: timestamp.optional(),
  nextRetryAt: timestamp.optional(),
  detail: z.string().min(1).optional(),
}).strict().superRefine((observation, ctx) => {
  if (observation.status === 'unknown' && (observation.remaining !== undefined || observation.available !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Unknown capacity cannot claim a numeric quota' });
  }
  if (observation.status !== 'unknown' && observation.checkedAt === null) {
    ctx.addIssue({ code: 'custom', message: 'Confirmed/estimated capacity requires checkedAt' });
  }
  if (observation.checkedAt === null && (observation.canPostMore !== undefined || observation.resetAt !== undefined || observation.nextRetryAt !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Unchecked offline capacity cannot claim remote capability or scheduling hints' });
  }
});
export type CreatorBatchCapacityObservation = z.infer<typeof CreatorBatchCapacityObservationSchema>;

const dependency = {
  dependencyId: identity,
  state: z.enum(['clear', 'open', 'uncertain', 'unknown']),
  detail: z.string().min(1),
};
/** An independent evaluation may inform; a same-project dependency cannot be downgraded. */
export const CreatorBatchDependencyObservationSchema = z.discriminatedUnion('scope', [
  z.object({ ...dependency, scope: z.literal('independent'), effect: z.literal('informative') }).strict(),
  z.object({ ...dependency, scope: z.literal('project'), projectId: CreatorProjectSchema.shape.id, effect: z.literal('blocking') }).strict(),
]);
export type CreatorBatchDependencyObservation = z.infer<typeof CreatorBatchDependencyObservationSchema>;

const count = z.number().int().nonnegative();
export const CreatorBatchSummarySchema = z.object({
  total: count,
  published: count,
  pending: count,
  notStarted: count,
  uncertain: count,
  failed: count,
  blocked: count,
}).strict();
export type CreatorBatchSummary = z.infer<typeof CreatorBatchSummarySchema>;

const targetKey = (target: { projectId: string; platform: string; accountId: string }): string => JSON.stringify([target.projectId, target.platform, target.accountId]);
const accountKey = (target: { platform: string; accountId: string }): string => JSON.stringify([target.platform, target.accountId]);

/** Embedding the immutable manifest makes omitted required destinations detectable at the boundary. */
export const CreatorBatchProgressSchema = z.object({
  schemaVersion: z.literal(1),
  manifest: CreatorBatchManifestSchema,
  checkedAt: timestamp,
  targets: z.array(CreatorBatchTargetProgressSchema).min(1),
  summary: CreatorBatchSummarySchema,
  complete: z.boolean(),
  capacity: z.array(CreatorBatchCapacityObservationSchema).default([]),
  dependencies: z.array(CreatorBatchDependencyObservationSchema).default([]),
}).strict().superRefine((progress, ctx) => {
  const required = new Set(progress.manifest.projects.flatMap((project) => project.targets.map((target) => targetKey({ projectId: project.projectId, ...target }))));
  const accounts = new Set(progress.manifest.projects.flatMap((project) => project.targets.map(accountKey)));
  const projects = new Set(progress.manifest.projects.map((project) => project.projectId));
  const seen = new Set<string>();
  const summary: CreatorBatchSummary = { total: required.size, published: 0, pending: 0, notStarted: 0, uncertain: 0, failed: 0, blocked: 0 };
  progress.targets.forEach((target, index) => {
    const key = targetKey(target);
    if (!required.has(key) || seen.has(key)) ctx.addIssue({ code: 'custom', path: ['targets', index], message: 'Unknown or duplicate required target identity' });
    seen.add(key);
    const state = target.state === 'not-started' ? 'notStarted' : target.state;
    summary[state] += 1;
  });
  if (seen.size !== required.size || [...required].some((key) => !seen.has(key))) {
    ctx.addIssue({ code: 'custom', path: ['targets'], message: 'Progress must contain every required target exactly once' });
  }
  for (const key of Object.keys(summary) as (keyof CreatorBatchSummary)[]) {
    if (summary[key] !== progress.summary[key]) ctx.addIssue({ code: 'custom', path: ['summary', key], message: 'Summary must match independent target states' });
  }
  const complete = progress.targets.length === required.size && summary.published === required.size;
  if (progress.complete !== complete) ctx.addIssue({ code: 'custom', path: ['complete'], message: 'Complete must be true if and only if all required targets are published' });
  const observed = new Set<string>();
  progress.capacity.forEach((observation, index) => {
    const key = accountKey(observation);
    if (!accounts.has(key) || observed.has(key)) ctx.addIssue({ code: 'custom', path: ['capacity', index], message: 'Unknown or duplicate capacity account' });
    observed.add(key);
  });
  progress.dependencies.forEach((observation, index) => {
    if (observation.scope === 'project' && !projects.has(observation.projectId)) {
      ctx.addIssue({ code: 'custom', path: ['dependencies', index, 'projectId'], message: 'Unknown project dependency' });
    }
  });
});
export type CreatorBatchProgress = z.infer<typeof CreatorBatchProgressSchema>;
