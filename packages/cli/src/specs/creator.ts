import { resolve } from 'node:path';
import type { CommandArgSpec, CommandRunContext, CommandSpec, PlanStep } from '../spec-types';
import { initProject, loadProject } from '../creator/model';
import { planPublication, runCreatorQa } from '../creator/qa';
import { defaultCreatorDeps, publishCreator, statusCreator, type CreatorDeps } from '../creator/workflow';

const PROJECT: CommandArgSpec = { name: 'project', kind: 'string', required: true, description: 'Project directory (new directory for init).' };
function projectOf(ctx: CommandRunContext): string {
  if (typeof ctx.args.project !== 'string' || !ctx.args.project.trim()) return ctx.fail('--project is required', 2);
  return resolve(ctx.cwd, ctx.args.project);
}
function requireRun(ctx: CommandRunContext): void {
  if (ctx.mode !== 'run') ctx.fail('Refusing side effects in plan mode', 2);
}
export function buildCreatorSpecs(deps = defaultCreatorDeps()): CommandSpec[] {
  const init: CommandSpec = {
    verb: 'creator-init', summary: 'Create a clean open-editing project with the exact versioned creator preset snapshot; no generations or prior approvals.',
    args: [PROJECT, { name: 'preset', kind: 'string', required: true, description: 'Explicit client preset JSON file; no default brand.' }, { name: 'id', kind: 'string', required: true, description: 'Unique lowercase project slug.' }, { name: 'title', kind: 'string', required: true, description: 'Project title (publication text starts empty).' }],
    supportsPlan: true, writes: ['creator-project.json', 'preset.snapshot.json', 'publication/draft.json'], movesGates: [],
    async plan(ctx) {
      const manifest = await initProject(projectOf(ctx), String(ctx.args.id ?? ''), String(ctx.args.title ?? ''), true, resolve(ctx.cwd, String(ctx.args.preset ?? '')));
      return [{ action: `Create clean project ${manifest.id}; exact preset ${manifest.preset.id}@${manifest.preset.version} sha256=${manifest.preset.sha256}. No writes, network, secrets, generation, or inherited media/receipts.`, target: projectOf(ctx) }];
    },
    async run(ctx) {
      requireRun(ctx);
      ctx.out(JSON.stringify(await initProject(projectOf(ctx), String(ctx.args.id ?? ''), String(ctx.args.title ?? ''), false, resolve(ctx.cwd, String(ctx.args.preset ?? ''))), null, 2));
      return { exitCode: 0 };
    },
  };
  const qa: CommandSpec = {
    verb: 'creator-qa', summary: 'Locally decode/probe the selected final video and PNG cover, measure loudness and bind QA to current hashes.',
    args: [PROJECT], supportsPlan: true, writes: ['qa/creator-media.json'], movesGates: [],
    async plan(ctx) {
      const { draft, preset } = await loadProject(projectOf(ctx));
      return [{ action: `Probe/decode final+PNG cover; require ${preset.editing.width}x${preset.editing.height}@${preset.editing.fps}, ${preset.editing.audio.targetLufs}±${preset.editing.audio.lufsTolerance ?? 1} LUFS and <=${preset.editing.audio.maxTruePeakDbtp} dBTP; each selected target duration cap; write hash-bound QA. Plan executes no process.`, target: `${draft.video || '<video missing>'}, ${draft.cover || '<cover missing>'}` }];
    },
    async run(ctx) {
      requireRun(ctx);
      ctx.out(JSON.stringify(await runCreatorQa(projectOf(ctx), deps.media), null, 2));
      return { exitCode: 0 };
    },
  };
  const publish: CommandSpec = {
    verb: 'creator-publish', summary: 'Publish the approved current render to all exact preset accounts, once per project/render/target; no uncertain retries.',
    args: [PROJECT, { name: 'confirm', kind: 'boolean', description: 'Additional explicit confirmation to submit now.' }, { name: 'spend-cap', kind: 'number', description: 'Explicit cap; 0 is sufficient (no paid generation).' }],
    paid: true, supportsPlan: true, writes: ['publication/intents/*', 'qa/publication/*'], movesGates: ['publish'],
    async plan(ctx): Promise<PlanStep[]> {
      try {
        const plan = await planPublication(projectOf(ctx), ctx.args['spend-cap']);
        return [
          ...plan.blockers.map((blocker) => ({ action: `BLOCKED: ${blocker}` })),
          { action: `Approval digest candidate: ${plan.digest ?? 'unavailable until media paths are valid'}` },
          { action: plan.remoteValidation },
          ...plan.preset.publishing.targets.map((target) => ({ action: `Target ${target.platform}:${target.accountId}; conservative preset caps: ${JSON.stringify(target.constraints ?? {})}; remote acceptance NOT guaranteed` })),
          { action: 'Run requires --confirm, explicit cap, current QA and hash-bound approval; upload only final+cover to existing R2; durable per-target submit-once intents; no force/retry.', costUsd: 0 },
        ];
      } catch (error) { return [{ action: `BLOCKED: ${error instanceof Error ? error.message : 'Invalid project/draft; run creator-init or repair the typed files'}` }]; }
    },
    async run(ctx) {
      requireRun(ctx);
      const results = await publishCreator(projectOf(ctx), deps, { confirm: ctx.args.confirm === true, spendCap: ctx.args['spend-cap'] });
      ctx.out(JSON.stringify(results, null, 2));
      return { exitCode: results.some((result) => result.state === 'failed' || result.state === 'uncertain') ? 1 : 0 };
    },
  };
  const status: CommandSpec = {
    verb: 'creator-status', summary: 'Read-only GET reconciliation of each durable target receipt/key; pending is never published. No writes or POST.',
    args: [PROJECT], supportsPlan: true, writes: [], movesGates: [],
    async plan(ctx) {
      const results = await statusCreator(projectOf(ctx), deps, true);
      return results.map((result) => ({ action: `${result.platform}: ${result.state}; ${result.detail ?? 'no local intent'} (remote NOT CHECKED)` }));
    },
    async run(ctx) {
      requireRun(ctx);
      const results = await statusCreator(projectOf(ctx), deps);
      ctx.out(JSON.stringify(results, null, 2));
      return { exitCode: results.some((result) => result.state === 'failed' || result.state === 'uncertain') ? 1 : 0 };
    },
  };
  return [init, qa, publish, status];
}
export const creatorSpecs = buildCreatorSpecs();
export type { CreatorDeps };
