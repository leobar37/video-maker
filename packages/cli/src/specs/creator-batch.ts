import { resolve } from 'node:path';
import { CreatorBatchProgressSchema, type CreatorBatchProgress } from '@videomaker/schemas';
import type { CommandArgSpec, CommandRunContext, CommandSpec, PlanStep } from '../spec-types';
import {
  planCreatorBatch, publishCreatorBatch, statusCreatorBatch, resumeCreatorBatch, reconcileCreatorBatch,
  type CreatorBatchRunOptions,
} from '../creator/batch';
import { defaultCreatorDeps, type CreatorDeps } from '../creator/workflow';

const BATCH: CommandArgSpec = {
  name: 'batch', kind: 'string', required: true,
  description: 'Path to the schemaVersion 1 batch manifest; projects are bounded relative to its directory.',
};
const CAP: CommandArgSpec = {
  name: 'spend-cap', kind: 'number',
  description: 'Explicit zero cap; use --spend-cap 0 (no paid generation).',
};
const CONFIRM: CommandArgSpec = {
  name: 'confirm', kind: 'boolean', description: 'Explicit confirmation for this mutating batch run.',
};

function batchOf(ctx: CommandRunContext): string {
  if (typeof ctx.args.batch !== 'string' || !ctx.args.batch.trim()) return ctx.fail('--batch is required', 2);
  return resolve(ctx.cwd, ctx.args.batch);
}
function requireRun(ctx: CommandRunContext): void {
  if (ctx.mode !== 'run') ctx.fail('Refusing side effects in plan mode', 2);
}
function runOptions(ctx: CommandRunContext): CreatorBatchRunOptions {
  if (ctx.args.confirm !== true) return ctx.fail('Batch mutation requires --confirm', 2);
  const spendCap = ctx.args['spend-cap'];
  if (typeof spendCap !== 'number' || !Number.isFinite(spendCap) || spendCap !== 0) {
    return ctx.fail('Batch mutation requires explicit --spend-cap 0; no paid generation is allowed', 2);
  }
  return { confirm: true, spendCap };
}
function exitCode(progress: CreatorBatchProgress): number {
  const { blocked, failed, uncertain } = progress.summary;
  return blocked + failed + uncertain > 0 ? 1 : 0;
}
function summary(progress: CreatorBatchProgress): string {
  const counts = progress.summary;
  return `Batch ${progress.manifest.batchId}: ${counts.published}/${counts.total} published; ${counts.pending} pending (accepted queue is not published), ${counts.notStarted} not-started, ${counts.blocked} blocked, ${counts.failed} failed, ${counts.uncertain} uncertain; complete=${progress.complete}.`;
}

/** Dependency creation is deferred until an explicitly authorized online run. */
export function buildCreatorBatchSpecs(deps?: CreatorDeps): CommandSpec[] {
  const onlineDeps = (): CreatorDeps => deps ?? defaultCreatorDeps();
  const offlinePlan = async (ctx: CommandRunContext, action: string): Promise<PlanStep[]> => {
    const path = batchOf(ctx);
    let progress: CreatorBatchProgress;
    try {
      progress = CreatorBatchProgressSchema.parse(await planCreatorBatch(path, ctx.args['spend-cap'] ?? 0));
    } catch {
      return ctx.fail('Unable to plan creator batch; validate the schemaVersion 1 manifest and local approved project evidence', 1);
    }
    return [
      { action: summary(progress), target: path },
      ...progress.targets.map(target => ({ action: `${target.projectId} ${target.platform}:${target.accountId}: ${target.state}; remote NOT CHECKED` })),
      { action: `${action} Plan performs local reads only: no writes, network, secrets, storage, processes, or generation.`, costUsd: 0 },
    ];
  };
  const output = (ctx: CommandRunContext, value: CreatorBatchProgress) => {
    const progress = CreatorBatchProgressSchema.parse(value);
    ctx.out(JSON.stringify(progress, null, 2));
    return { exitCode: exitCode(progress) };
  };
  const plan: CommandSpec = {
    verb: 'creator-batch-plan',
    summary: 'Inspect the schemaVersion 1 batch and hash-bound approvals offline; pending is not published. No writes or generation.',
    args: [BATCH, CAP], supportsPlan: true, writes: [], movesGates: [],
    plan: ctx => offlinePlan(ctx, 'Inspect all required approved targets; no remote acceptance or capacity is inferred.'),
    async run(ctx) {
      requireRun(ctx);
      const path = batchOf(ctx);
      try { return output(ctx, await planCreatorBatch(path, ctx.args['spend-cap'] ?? 0)); }
      catch { return ctx.fail('Unable to plan creator batch; validate the schemaVersion 1 manifest and local approved project evidence', 1); }
    },
  };
  const publish: CommandSpec = {
    verb: 'creator-batch-publish',
    summary: 'Publish only approved batch projects and exact selected targets, submit-once; queue accepted is pending, not published. No generation.',
    args: [BATCH, CONFIRM, CAP], paid: true, supportsPlan: true,
    writes: ['publication/intents/*', 'qa/publication/*'], movesGates: ['publish'],
    plan: ctx => offlinePlan(ctx, 'Run requires --confirm and explicit --spend-cap 0; uploads approved media and submits only safe not-started targets.'),
    async run(ctx) {
      requireRun(ctx);
      const path = batchOf(ctx);
      const options = runOptions(ctx);
      try { return output(ctx, await publishCreatorBatch(path, onlineDeps(), options)); }
      catch { return ctx.fail('Unable to publish creator batch; validate local approvals and inspect batch status before retrying', 1); }
    },
  };
  const status: CommandSpec = {
    verb: 'creator-batch-status',
    summary: 'GET-only batch status; pending is never published. No POST, writes, storage, media processes, or generation.',
    args: [BATCH], supportsPlan: true, writes: [], movesGates: [],
    plan: ctx => offlinePlan(ctx, 'Run reads existing target receipts with GET only; does not persist reconciliation.'),
    async run(ctx) {
      requireRun(ctx);
      const path = batchOf(ctx);
      try { return output(ctx, await statusCreatorBatch(path, onlineDeps())); }
      catch { return ctx.fail('Unable to read creator batch status; validate the manifest and local target evidence', 1); }
    },
  };
  const resume: CommandSpec = {
    verb: 'creator-batch-resume',
    summary: 'Resume safe not-started approved batch targets only; never resubmit pending, failed, uncertain, or published targets. No generation.',
    args: [BATCH, CONFIRM, CAP], paid: true, supportsPlan: true,
    writes: ['publication/intents/*', 'qa/publication/*'], movesGates: ['publish'],
    plan: ctx => offlinePlan(ctx, 'Run requires --confirm and explicit --spend-cap 0; reconciles with GET and submits only safe not-started targets.'),
    async run(ctx) {
      requireRun(ctx);
      const path = batchOf(ctx);
      const options = runOptions(ctx);
      try { return output(ctx, await resumeCreatorBatch(path, onlineDeps(), options)); }
      catch { return ctx.fail('Unable to resume creator batch; inspect batch status and resolve blockers without forcing retries', 1); }
    },
  };
  const reconcile: CommandSpec = {
    verb: 'creator-batch-reconcile',
    summary: 'GET-only reconciliation with durable local audit writes; never POST or resubmit. Pending is not published; no generation.',
    args: [BATCH, CONFIRM, CAP], supportsPlan: true,
    writes: ['publication/reconciliations.jsonl', 'publication/intents/*.result.json', 'qa/publication/zernio-journal.jsonl'], movesGates: [],
    plan: ctx => offlinePlan(ctx, 'Run requires --confirm and explicit --spend-cap 0; performs GET and local audit writes only, never POST.'),
    async run(ctx) {
      requireRun(ctx);
      const path = batchOf(ctx);
      const options = runOptions(ctx);
      try { return output(ctx, await reconcileCreatorBatch(path, onlineDeps(), options)); }
      catch { return ctx.fail('Unable to reconcile creator batch; inspect local target evidence before any further mutation', 1); }
    },
  };
  return [plan, publish, status, resume, reconcile];
}

export const creatorBatchSpecs = buildCreatorBatchSpecs();
