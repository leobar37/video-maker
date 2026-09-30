/**
 * Clip analysis command specs (specs/clip.ts, part 1/3): the analysis trio.
 *
 * - `clip-frames` samples the local source into `clips/frames/f-%06d.jpg` plus
 *   the `clips/frames.json` / `clips/shards.json` manifests (thin runner:
 *   `runClipFrames` owns every ffmpeg/ffprobe invocation).
 * - `clip-transcribe` runs local whisper through `transcribeToTranscript` and
 *   lands `clips/transcript.json` (free, offline).
 * - `clip-analyze` is the PAID step: one small `AgentRunner` vision call per
 *   shard, schema-validated JSON per shard, and EVERY shard's cost journalled
 *   to `qa/spend.json` through the spend-ledger API (submit-once per shard).
 *
 * Plan mode is pure (NFR-002): local fs reads of the `clips/` manifests only —
 * no subprocesses, no network, no credential resolution. `run()` hard-refuses
 * plan mode; `clip-analyze` refuses to spend without `--submit --spend-cap`.
 *
 * Later parts APPEND the remaining clip specs below this section (1/3).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { PaidOperationError, type PaidOperationStore } from '@videomaker/core';
import { FrameAnalysisSchema, type FrameAnalysis } from '@videomaker/schemas';

import { PROJECT_ARG, pathExists, resolveProjectDir } from '../args';
import type {
  CommandResult,
  CommandRunContext,
  CommandSpec,
  PlanStep,
} from '../spec-types';
import type { MediaCommandDeps } from '../pipeline/deps';
import { defaultMediaDeps } from '../pipeline/deps';
import {
  runClipFrames,
  transcribeToTranscript,
  type ClipWord,
  type FrameEntry,
  type FramesManifest,
  type ShardEntry,
  type ShardsManifest,
  type TranscriptDocument,
} from '../pipeline/clip';
import {
  runShardAnalysis,
  type AgentRunner,
  type AgentShardContext,
  type ShardAnalysisOutcome,
  type ShardFrame,
} from '../pipeline/agent';
import { BACKEND_IDS, createAgentRunner, type BackendId } from '../pipeline/backends';
import { estimateShardCostUsd } from '../pipeline/backends/omp-sdk';
import {
  FileSpendLedger,
  MissingSpendCapError,
  buildPaidPlan,
  completePaidAttempt,
  spendCapFromArgs,
  spendLedgerPath,
  submitPaidOnce,
} from '../pipeline/spend-ledger';

/** Natural-language brief that rides in every shard prompt (`--objective`). */
const DEFAULT_OBJECTIVE =
  'Find the most engaging, self-contained moments worth keeping as vertical clips ' +
  'and confirm what happens in each frame; preserve faces and speaker turns.';

function argString(
  args: Record<string, string | number | boolean | string[]>,
  name: string,
): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function argNumber(
  args: Record<string, string | number | boolean | string[]>,
  name: string,
): number | undefined {
  const value = args[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function argBoolean(
  args: Record<string, string | number | boolean | string[]>,
  name: string,
  fallback: boolean,
): boolean {
  const value = args[name];
  return typeof value === 'boolean' ? value : fallback;
}

function refusePlanMode(ctx: CommandRunContext, verb: string): never {
  return ctx.fail(
    `${verb}: run() refuses plan mode — run with --plan/--dry-run for the plan, ` +
      'without --plan to execute.',
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads a `clips/` manifest. Missing files yield `undefined` (the project has
 * no clip data yet — `plan()` stays a zero-cost no-op); corrupt JSON throws
 * with an actionable message instead of being silently ignored.
 */
async function readManifest<T>(path: string, label: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new Error(
      `${label} is not valid JSON — regenerate it with clip-frames.`,
      { cause },
    );
  }
}

interface ClipAnalysisInputs {
  shards: ShardEntry[];
  framesById: Map<string, FrameEntry>;
  /** `sha256` of the source from `clips/source.json`; empty when missing. */
  sourceSha256: string;
}

/** Local-fs reads of the clip-frames manifests (plan-safe, NFR-002). */
async function readAnalysisInputs(projectDir: string): Promise<ClipAnalysisInputs> {
  const shardsDoc = await readManifest<ShardsManifest>(
    join(projectDir, 'clips', 'shards.json'),
    'clips/shards.json',
  );
  const framesDoc = await readManifest<FramesManifest>(
    join(projectDir, 'clips', 'frames.json'),
    'clips/frames.json',
  );
  const sourceDoc = await readManifest<{ sha256?: unknown }>(
    join(projectDir, 'clips', 'source.json'),
    'clips/source.json',
  );
  const framesById = new Map<string, FrameEntry>();
  for (const frame of framesDoc?.frames ?? []) framesById.set(frame.frame_id, frame);
  return {
    shards: shardsDoc?.shards ?? [],
    framesById,
    sourceSha256: typeof sourceDoc?.sha256 === 'string' ? sourceDoc.sha256 : '',
  };
}

/** Transcript words from `clips/transcript.json` (empty before clip-transcribe). */
async function readTranscriptWords(projectDir: string): Promise<ClipWord[]> {
  const doc = await readManifest<TranscriptDocument>(
    join(projectDir, 'clips', 'transcript.json'),
    'clips/transcript.json',
  );
  return Array.isArray(doc?.words) ? doc.words : [];
}

/** One shard's analysis unit: frames, cost estimate and prompt context. */
interface ShardJob {
  shard: ShardEntry;
  frames: ShardFrame[];
  /** Frames actually analyzed (shard frames minus context-only frames). */
  analyzableCount: number;
  costUsd: number;
  transcriptSlice: string;
  attemptId: string;
  analysisRelative: string;
  analysisPath: string;
}

/**
 * Builds one job per shard in manifest order. Frame ids referenced by
 * `clips/shards.json` must exist in `clips/frames.json`; anything else is
 * corrupt state and fails with an actionable message.
 */
async function buildShardJobs(
  inputs: ClipAnalysisInputs,
  projectDir: string,
): Promise<ShardJob[]> {
  const words = inputs.shards.length > 0 ? await readTranscriptWords(projectDir) : [];
  const jobs: ShardJob[] = [];
  for (const shard of inputs.shards) {
    const frames: ShardFrame[] = [];
    for (const frameId of shard.frameIds) {
      const entry = inputs.framesById.get(frameId);
      if (entry === undefined) {
        throw new Error(
          `clips/shards.json references ${frameId} which is missing from clips/frames.json — ` +
            're-run clip-frames to regenerate consistent manifests.',
        );
      }
      frames.push({
        frame_id: entry.frame_id,
        t: entry.t,
        path: resolve(projectDir, entry.path),
      });
    }
    const contextOnly = new Set(shard.contextOnlyFrameIds);
    const analyzableCount = shard.frameIds.filter((frameId) => !contextOnly.has(frameId)).length;
    const times = frames.map((frame) => frame.t);
    const from = times.length > 0 ? Math.min(...times) : 0;
    const to = times.length > 0 ? Math.max(...times) : 0;
    const transcriptSlice = words
      .filter((word) => word.end >= from && word.start <= to)
      .map((word) => word.word)
      .join(' ');
    const analysisRelative = `clips/analysis/${shard.id}.json`;
    jobs.push({
      shard,
      frames,
      analyzableCount,
      costUsd: estimateShardCostUsd(analyzableCount),
      transcriptSlice,
      attemptId: `clip-analyze:${inputs.sourceSha256.slice(0, 12)}:${shard.id}`,
      analysisRelative,
      analysisPath: join(projectDir, 'clips', 'analysis', `${shard.id}.json`),
    });
  }
  return jobs;
}

interface ShardRunResult {
  job: ShardJob;
  status: 'ok' | 'uncertain' | 'skipped';
  reason?: string;
  chargedUsd: number;
}

/** Writes `clips/analysis/<shardId>.json` with schema-validated frames. */
async function writeShardAnalysis(
  job: ShardJob,
  sourceSha256: string,
  result: { status: 'ok' | 'uncertain'; frames: FrameAnalysis[]; reason?: string },
): Promise<void> {
  await mkdir(dirname(job.analysisPath), { recursive: true });
  await writeFile(
    job.analysisPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        shardId: job.shard.id,
        sourceSha256,
        status: result.status,
        frames: result.frames.map((frame) => FrameAnalysisSchema.parse(frame)),
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * One paid shard analysis: the `AgentRunner` call IS the submit (one
 * submit-once attempt per shard), the validated analysis lands on disk, then
 * the attempt completes. A submit that fails with an unknown outcome is
 * journalled `uncertain` and recorded as an explicit hole — analyses are never
 * invented. Already-journalled shards are skipped, never re-spent.
 */
async function analyzeShardJob(input: {
  job: ShardJob;
  sourceSha256: string;
  objective: string;
  backend: BackendId;
  spendCapUsd: number;
  store: PaidOperationStore;
  runner: AgentRunner;
  now: () => Date;
}): Promise<ShardRunResult> {
  const { job, store, now } = input;
  const prior = await store.get(job.attemptId);
  if (
    (prior?.state === 'completed' || prior?.state === 'reconciled') &&
    (await pathExists(job.analysisPath))
  ) {
    return { job, status: 'skipped', chargedUsd: 0 };
  }
  const agentCtx: AgentShardContext = {
    shardId: job.shard.id,
    sourceSha256: input.sourceSha256,
    objective: input.objective,
    transcriptSlice: job.transcriptSlice,
    ...(job.shard.prevSummary.length > 0 ? { prevSummary: job.shard.prevSummary } : {}),
  };
  const plan = buildPaidPlan({
    command: 'clip-analyze',
    subject: job.shard.id,
    inputs: {
      sourceSha256: input.sourceSha256,
      frameIds: job.shard.frameIds,
      objective: input.objective,
      backend: input.backend,
    },
    outputs: [job.analysisRelative],
    estimatedCostUsd: job.costUsd,
    spendCapUsd: input.spendCapUsd,
    maxAttempts: 1,
  });
  let outcome: ShardAnalysisOutcome | undefined;
  try {
    const submitted = await submitPaidOnce({
      store,
      plan,
      attemptId: job.attemptId,
      now,
      submit: async () => {
        outcome = await runShardAnalysis(input.runner, job.frames, agentCtx);
        return {
          receipt: {
            provider: input.backend,
            providerJobId: job.attemptId,
            submittedAt: now().toISOString(),
            costUsd: job.costUsd,
          },
          status: { state: 'succeeded' as const },
        };
      },
    });
    const finalOutcome: ShardAnalysisOutcome = outcome ?? {
      status: 'uncertain',
      reason: 'the shard analysis produced no outcome — reconcile qa/spend.json before retrying.',
    };
    await writeShardAnalysis(job, input.sourceSha256, {
      status: finalOutcome.status,
      frames: finalOutcome.status === 'ok' ? finalOutcome.analyses : [],
      ...(finalOutcome.status === 'uncertain' ? { reason: finalOutcome.reason } : {}),
    });
    await completePaidAttempt(store, submitted.record.attemptId, now);
    return {
      job,
      status: finalOutcome.status,
      chargedUsd: job.costUsd,
      ...(finalOutcome.status === 'uncertain' ? { reason: finalOutcome.reason } : {}),
    };
  } catch (error) {
    if (error instanceof PaidOperationError && error.code !== 'SUBMIT_FAILED') {
      throw error;
    }
    // Unknown submit outcome: the ledger already journals the attempt as
    // `uncertain`; record the hole on disk instead of inventing analyses.
    const reason = errorText(error);
    await writeShardAnalysis(job, input.sourceSha256, {
      status: 'uncertain',
      frames: [],
      reason,
    });
    return { job, status: 'uncertain', reason, chargedUsd: job.costUsd };
  }
}

/**
 * `FileSpendLedger` appends are read-modify-write on one file: this queues all
 * store operations so concurrent shard jobs (via `--jobs`) never lose entries.
 */
function serializedStore(store: PaidOperationStore): PaidOperationStore {
  let tail: Promise<unknown> = Promise.resolve();
  const through = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(() => operation());
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    append: (record) => through(() => store.append(record)),
    get: (attemptId) => through(() => store.get(attemptId)),
    list: (filter) => through(() => store.list(filter)),
  };
}

export function buildClipAnalysisSpecs(deps: MediaCommandDeps = defaultMediaDeps()): CommandSpec[] {
  const clipFrames: CommandSpec = {
    verb: 'clip-frames',
    summary:
      'Sample the local source into frames + shard manifests (clips/frames.json, ' +
      'clips/shards.json). Pure ffmpeg/ffprobe, free, offline.',
    args: [
      PROJECT_ARG,
      {
        name: 'src',
        kind: 'string',
        description:
          'Source video file (local only; download remote sources first). Required in run ' +
          'mode; optional for --plan.',
      },
      {
        name: 'frame-every',
        kind: 'number',
        default: 1,
        description: 'Seconds between sampled frames.',
      },
      {
        name: 'shard-size',
        kind: 'number',
        default: 60,
        description: 'Analyzable frames per shard.',
      },
      {
        name: 'context-frames',
        kind: 'number',
        default: 5,
        description: 'Context frames carried into the next shard.',
      },
    ],
    supportsPlan: true,
    writes: [
      'clips/source.json',
      'clips/frames/f-%06d.jpg',
      'clips/frames.json',
      'clips/shards.json',
    ],
    movesGates: [],
    plan(ctx): PlanStep[] {
      const src = argString(ctx.args, 'src') ?? '<source>';
      const frameEvery = argNumber(ctx.args, 'frame-every') ?? 1;
      const shardSize = argNumber(ctx.args, 'shard-size') ?? 60;
      const contextFrames = argNumber(ctx.args, 'context-frames') ?? 5;
      return [
        {
          action: `probe ${src} with ffprobe (duration, fps, size, sha256)`,
          target: src,
          writes: 'clips/source.json',
        },
        {
          action: `extract one jpg per sampled t with ffmpeg (every ${frameEvery}s + scene cuts)`,
          writes: 'clips/frames/f-%06d.jpg',
        },
        {
          action: 'write the frame_id ↔ t ↔ file table',
          writes: 'clips/frames.json',
        },
        {
          action: `shard the frames (${shardSize} analyzable + ${contextFrames} context per shard)`,
          writes: 'clips/shards.json',
        },
      ];
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') refusePlanMode(ctx, 'clip-frames');
      const src = argString(ctx.args, 'src');
      if (src === undefined) {
        return ctx.fail(
          'clip-frames: --src <file> is required in run mode — a local video file path ' +
            '(download remote sources first). Run with --plan to preview without it.',
        );
      }
      const projectDir = resolveProjectDir(ctx);
      try {
        const result = await runClipFrames(deps.process, projectDir, {
          srcPath: resolve(ctx.cwd, src),
          frameEverySeconds: argNumber(ctx.args, 'frame-every'),
          shardSize: argNumber(ctx.args, 'shard-size'),
          contextFrames: argNumber(ctx.args, 'context-frames'),
        });
        ctx.out(
          `clip-frames: ${result.frames.frames.length} frame(s) → clips/frames.json, ` +
            `${result.shards.shards.length} shard(s) → clips/shards.json`,
        );
        return { exitCode: 0 };
      } catch (error) {
        return ctx.fail(`clip-frames: ${errorText(error)}`);
      }
    },
  };

  const clipTranscribe: CommandSpec = {
    verb: 'clip-transcribe',
    summary:
      'Transcribe the whole source with local whisper (word timestamps) → ' +
      'clips/transcript.json. Free, offline.',
    args: [
      PROJECT_ARG,
      {
        name: 'language',
        kind: 'string',
        description: 'Whisper language code (default: auto-detect).',
      },
      {
        name: 'whisper-bin',
        kind: 'string',
        description: 'Whisper binary to invoke (default: whisper on PATH).',
      },
    ],
    supportsPlan: true,
    writes: ['clips/transcript.json'],
    movesGates: [],
    plan(): PlanStep[] {
      return [
        {
          action: 'run local whisper with word timestamps over the source audio',
          target: 'clips/source.json',
          writes: 'clips/transcript.json',
        },
      ];
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') refusePlanMode(ctx, 'clip-transcribe');
      const projectDir = resolveProjectDir(ctx);
      const language = argString(ctx.args, 'language');
      const whisperBin = argString(ctx.args, 'whisper-bin');
      try {
        const transcript = await transcribeToTranscript(deps.process, projectDir, {
          ...(language !== undefined ? { language } : {}),
          ...(whisperBin !== undefined ? { whisperBin } : {}),
        });
        ctx.out(`clip-transcribe: ${transcript.words.length} word(s) → clips/transcript.json`);
        return { exitCode: 0 };
      } catch (error) {
        return ctx.fail(`clip-transcribe: ${errorText(error)}`);
      }
    },
  };

  const clipAnalyze: CommandSpec = {
    verb: 'clip-analyze',
    summary:
      'PAID small vision analysis: one AgentRunner call per shard over its key ' +
      'frames + transcript slice → clips/analysis/<shardId>.json (+ qa/spend.json). ' +
      'Requires --submit --spend-cap.',
    args: [
      PROJECT_ARG,
      {
        name: 'submit',
        kind: 'boolean',
        default: false,
        description: 'Emit the paid submits (without it nothing is spent).',
      },
      {
        name: 'spend-cap',
        kind: 'number',
        description:
          'Hard spend cap in USD journalled against this run. REQUIRED before any ' +
          'paid submit in run mode.',
      },
      {
        name: 'backend',
        kind: 'string',
        default: 'omp',
        description: 'Agent backend: omp | jev (default omp).',
      },
      {
        name: 'max-shards',
        kind: 'number',
        description: 'Analyze at most N shards (default: all shards).',
      },
      {
        name: 'jobs',
        kind: 'number',
        default: 1,
        description: 'Shards analyzed concurrently (journal writes stay serialized).',
      },
      {
        name: 'objective',
        kind: 'string',
        default: DEFAULT_OBJECTIVE,
        description: 'Natural-language objective carried in every shard prompt.',
      },
    ],
    paid: true,
    supportsPlan: true,
    writes: ['clips/analysis/<shardId>.json', 'qa/spend.json'],
    movesGates: ['spend'],
    async plan(ctx): Promise<PlanStep[]> {
      const projectDir = resolveProjectDir(ctx);
      const inputs = await readAnalysisInputs(projectDir);
      const allJobs = await buildShardJobs(inputs, projectDir);
      const maxShards = argNumber(ctx.args, 'max-shards');
      const selected =
        maxShards === undefined ? allJobs : allJobs.slice(0, Math.max(0, Math.floor(maxShards)));
      if (selected.length === 0) return [];
      const backend = argString(ctx.args, 'backend') ?? 'omp';
      const steps: PlanStep[] = selected.map((job) => ({
        action:
          `vision-analyze ${job.shard.id} with --backend ${backend} ` +
          `(${job.analyzableCount} analyzable frame(s)` +
          `${job.shard.contextOnlyFrameIds.length > 0 ? ` + ${job.shard.contextOnlyFrameIds.length} context` : ''})`,
        target: job.analysisRelative,
        writes: job.analysisRelative,
        costUsd: job.costUsd,
      }));
      const totalUsd = selected.reduce((sum, job) => sum + job.costUsd, 0);
      steps.push({
        action:
          `journal every shard to qa/spend.json (submit-once per shard) — total vision ` +
          `estimate $${totalUsd.toFixed(4)} across ${selected.length} shard(s), capped by --spend-cap`,
        writes: 'qa/spend.json',
        gate: 'spend',
        costUsd: totalUsd,
      });
      return steps;
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') refusePlanMode(ctx, 'clip-analyze');
      if (!argBoolean(ctx.args, 'submit', false)) {
        return ctx.fail(
          'clip-analyze: refuses to spend without --submit — pass --submit --spend-cap <USD> ' +
            'to pay for the shard analyses (see --plan for the per-shard estimate).',
        );
      }
      let spendCapUsd: number;
      try {
        spendCapUsd = spendCapFromArgs('clip-analyze', ctx.args);
      } catch (error) {
        return ctx.fail(error instanceof MissingSpendCapError ? error.message : errorText(error));
      }
      const backendRaw = argString(ctx.args, 'backend') ?? 'omp';
      if (!(BACKEND_IDS as readonly string[]).includes(backendRaw)) {
        return ctx.fail(
          `clip-analyze: unknown --backend "${backendRaw}" — expected ${BACKEND_IDS.join(' | ')} (default omp).`,
        );
      }
      const backend = backendRaw as BackendId;
      const projectDir = resolveProjectDir(ctx);
      const inputs = await readAnalysisInputs(projectDir);
      if (inputs.shards.length === 0) {
        return ctx.fail(
          `clip-analyze: no shards found (${join('clips', 'shards.json')} missing or empty in ` +
            `${projectDir}) — run clip-frames first.`,
        );
      }
      if (inputs.sourceSha256 === '') {
        return ctx.fail(
          `clip-analyze: ${join('clips', 'source.json')} is missing in ${projectDir} — ` +
            'run clip-frames first.',
        );
      }
      const objective = argString(ctx.args, 'objective') ?? DEFAULT_OBJECTIVE;
      let allJobs: ShardJob[];
      try {
        allJobs = await buildShardJobs(inputs, projectDir);
      } catch (error) {
        return ctx.fail(`clip-analyze: ${errorText(error)}`);
      }
      const maxShards = argNumber(ctx.args, 'max-shards');
      const selected =
        maxShards === undefined ? allJobs : allJobs.slice(0, Math.max(0, Math.floor(maxShards)));
      let runner: AgentRunner;
      try {
        runner = createAgentRunner(backend, { process: deps.process });
      } catch (error) {
        return ctx.fail(`clip-analyze: ${errorText(error)}`);
      }
      const now = deps.clock.now;
      const store = serializedStore(new FileSpendLedger(spendLedgerPath(projectDir)));
      const jobsPerBatch = Math.max(1, Math.floor(argNumber(ctx.args, 'jobs') ?? 1));
      let okCount = 0;
      let uncertainCount = 0;
      let alreadyCount = 0;
      let committedUsd = 0;
      let chargedUsd = 0;
      for (let offset = 0; offset < selected.length; offset += jobsPerBatch) {
        const batch = selected.slice(offset, offset + jobsPerBatch);
        for (const job of batch) {
          if (committedUsd + job.costUsd > spendCapUsd) {
            return ctx.fail(
              `clip-analyze: ${job.shard.id} would cost $${job.costUsd.toFixed(4)} ` +
                `(${job.analyzableCount} analyzable frame(s)), pushing this run to ` +
                `$${(committedUsd + job.costUsd).toFixed(4)} — over the $${spendCapUsd} --spend-cap. ` +
                `Nothing was submitted for it: lower --max-shards (${offset} shard(s) fit the cap) ` +
                'or raise --spend-cap.',
            );
          }
          committedUsd += job.costUsd;
        }
        let results: ShardRunResult[];
        try {
          results = await Promise.all(
            batch.map((job) =>
              analyzeShardJob({
                job,
                sourceSha256: inputs.sourceSha256,
                objective,
                backend,
                spendCapUsd,
                store,
                runner,
                now,
              }),
            ),
          );
        } catch (error) {
          return ctx.fail(`clip-analyze: ${errorText(error)}`);
        }
        for (const result of results) {
          chargedUsd += result.chargedUsd;
          if (result.status === 'skipped') {
            alreadyCount += 1;
            ctx.out(
              `clip-analyze: skipped ${result.job.shard.id} ` +
                '(already analyzed and journalled — no new spend).',
            );
            continue;
          }
          if (result.status === 'ok') {
            okCount += 1;
            ctx.out(
              `clip-analyze: ${result.job.shard.id} ok (${result.job.analyzableCount} frame(s), ` +
                `$${result.chargedUsd.toFixed(4)}) → clips/analysis/${result.job.shard.id}.json`,
            );
          } else {
            uncertainCount += 1;
            ctx.out(
              `clip-analyze: ${result.job.shard.id} uncertain (${result.job.analyzableCount} ` +
                `frame(s), $${result.chargedUsd.toFixed(4)}) — ${result.reason ?? 'no outcome'}`,
            );
          }
        }
      }
      ctx.out(
        `clip-analyze: ${selected.length} shard(s) — ${okCount} ok, ${uncertainCount} uncertain, ` +
          `${alreadyCount} already journalled — total vision spend $${chargedUsd.toFixed(4)} ` +
          'journalled to qa/spend.json.',
      );
      return { exitCode: 0 };
    },
  };

  return [clipFrames, clipTranscribe, clipAnalyze];
}

/** The registry's clip analysis commands (specs/clip.ts part 1/3). */
export const clipAnalysisSpecs: CommandSpec[] = buildClipAnalysisSpecs();

// ---------------------------------------------------------------------------
// End of part 1/3 (analysis trio). Parts 2/3 and 3/3 APPEND their specs below.

// ---------------------------------------------------------------------------
// Part 2/3 (decision verbs): clip-propose, clip-ranges, clip-polish,
// clip-approve, clip-locate, clip-strip and clip-viewer — the offline half of
// the clip pipeline.
//
// - `clip-propose` grows transcript heuristics into candidate windows.
// - `clip-ranges` scores them against the vision analyses (100% offline,
//   adjustable weights) into `clips/candidates.json` — a bare `ClipRange[]`,
//   the exact shape `runClipPolish`/`buildClipCards` consume.
// - `clip-polish` trims silences into `clips/decisions-ready.json`.
// - `clip-approve` is the deterministic seal (⛔ no render without it): it
//   re-validates every selected range (ClipRange schema + start<end within the
//   source duration, duo⇔2 faces, complete social) and the source sha256, then
//   seals `clips/decisions.json`. The verifier NEVER mutates ranges.
// - `clip-locate` / `clip-strip` anchor cuts to exact `frame_id`s.
// - `clip-viewer` renders the read-only local dashboard (no actions).
//
// Every verb is FREE and offline: `plan()` is pure (NFR-002 — no network, no
// secrets, no subprocesses), `run()` refuses plan mode and nothing here
// touches the paid providers. Part 3/3 APPENDS its specs below this section.
// ---------------------------------------------------------------------------
import { readdir } from 'node:fs/promises';

import {
  ClipDecisionSchema,
  ClipRangeSchema,
  ClipSocialSchema,
  ScoringPresetSchema,
  ScoringWeightsSchema,
  scoringWeightsFor,
  type ClipDecision,
  type ClipRange,
  type ClipSocial,
  type ScoringWeightValues,
} from '@videomaker/schemas';

import {
  buildCandidates,
  buildClipCards,
  explainCandidate,
  locateAt,
  planStripGrid,
  proposeWindows,
  renderClipsDashboard,
  renderStripGrid,
  resolveFrameAt,
  runClipPolish,
  type ClipDashboardCard,
  type LocateResult,
  type ProposedWindow,
} from '../pipeline/clip';

/** Repeatable string flags (`--id a --id b`): order kept, empties dropped. */
function argStringList(
  args: Record<string, string | number | boolean | string[]>,
  name: string,
): string[] {
  const value = args[name];
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => entry.trim().length > 0);
}

/** JSON document read with an actionable error naming the producing command. */
async function readJsonDocument(path: string, label: string, hint: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(`${label} is missing (${path}) — ${hint}.`);
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(`${label} is not valid JSON (${path}) — ${hint}.`, { cause });
  }
}

/** One actionable line from a zod v4 issue list (schema failures). */
function zodIssues(
  issues: ReadonlyArray<{ path: readonly PropertyKey[]; message?: string }>,
): string {
  return issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message ?? 'invalid value'}`)
    .join('; ');
}

/**
 * Flattened `FrameAnalysis` entries of every `clips/analysis/*.json` shard
 * document (file names sorted for determinism). A missing directory yields an
 * empty list (nothing analyzed yet); malformed documents throw with the
 * producing command named. When `knownFrameIds` is given, every analyzed frame
 * must exist in `clips/frames.json` — stale analyses fail instead of silently
 * scoring frames that are no longer sampled.
 */
async function readAnalysisFrames(
  projectDir: string,
  knownFrameIds?: Set<string>,
): Promise<FrameAnalysis[]> {
  const dir = join(projectDir, 'clips', 'analysis');
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const frames: FrameAnalysis[] = [];
  for (const name of names) {
    const label = join('clips', 'analysis', name);
    const doc = await readJsonDocument(join(dir, name), label, 'run clip-analyze to regenerate it');
    const rawFrames = (doc as { frames?: unknown } | null)?.frames;
    if (!Array.isArray(rawFrames)) {
      throw new Error(`${label} has no "frames" array — run clip-analyze to regenerate it.`);
    }
    for (const [index, entry] of rawFrames.entries()) {
      const parsed = FrameAnalysisSchema.safeParse(entry);
      if (!parsed.success) {
        throw new Error(
          `${label} frames[${index}] is not a valid FrameAnalysis — ${zodIssues(parsed.error.issues)}.`,
        );
      }
      if (knownFrameIds !== undefined && !knownFrameIds.has(parsed.data.frame_id)) {
        throw new Error(
          `${label} references ${parsed.data.frame_id} which is missing from clips/frames.json — ` +
            're-run clip-frames and clip-analyze for one consistent project state.',
        );
      }
      frames.push(parsed.data);
    }
  }
  return frames;
}

/**
 * Deterministic seal checks for one selected range: finite `start < end`
 * inside the source duration, `layout 'duo'` ⇔ exactly 2 faces and complete
 * social copy. The verifier never mutates the range — it only accepts or
 * rejects. Returns an actionable failure line, or `undefined` when clean.
 */
function rangeInvariantViolation(
  range: Record<string, unknown>,
  id: string,
  durationSeconds: number,
): string | undefined {
  const start = range.start;
  const end = range.end;
  if (
    typeof start !== 'number' ||
    !Number.isFinite(start) ||
    typeof end !== 'number' ||
    !Number.isFinite(end)
  ) {
    return `clip-approve: ${id} needs finite numeric start/end seconds — fix it in clips/decisions-ready.json.`;
  }
  if (start >= end) {
    return (
      `clip-approve: ${id} must satisfy start < end (got start=${start}, end=${end}) — ` +
      'fix it in clips/decisions-ready.json.'
    );
  }
  if (end > durationSeconds) {
    return (
      `clip-approve: ${id} ends at ${end}s, beyond the ${durationSeconds}s source duration — ` +
      're-run clip-polish on the current source.'
    );
  }
  if (range.layout === 'duo') {
    const faceCount = Array.isArray(range.faces) ? range.faces.length : 0;
    if (faceCount !== 2) {
      return (
        `clip-approve: ${id} layout "duo" requires exactly 2 faces (found ${faceCount}) — ` +
        'fix it in clips/decisions-ready.json.'
      );
    }
  }
  const social = ClipSocialSchema.safeParse(range.social);
  if (!social.success) {
    return (
      `clip-approve: ${id} social is incomplete (title, description and hashtags are required) — ` +
      `${zodIssues(social.error.issues)}.`
    );
  }
  return undefined;
}

export function buildClipDecisionSpecs(deps: MediaCommandDeps = defaultMediaDeps()): CommandSpec[] {
  const clipPropose: CommandSpec = {
    verb: 'clip-propose',
    summary:
      'Propose candidate clip windows from local transcript heuristics (free, offline) → ' +
      'clips/proposals.json.',
    args: [
      PROJECT_ARG,
      {
        name: 'min',
        kind: 'number',
        default: 20,
        description: 'Minimum window length in seconds.',
      },
      {
        name: 'max',
        kind: 'number',
        default: 90,
        description: 'Maximum window length in seconds.',
      },
    ],
    supportsPlan: true,
    writes: ['clips/proposals.json'],
    movesGates: [],
    plan(ctx): PlanStep[] {
      const min = argNumber(ctx.args, 'min') ?? 20;
      const max = argNumber(ctx.args, 'max') ?? 90;
      return [
        {
          action: `grow transcript heuristics into candidate windows (${min}–${max}s)`,
          target: 'clips/transcript.json',
          writes: 'clips/proposals.json',
        },
      ];
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') refusePlanMode(ctx, 'clip-propose');
      const projectDir = resolveProjectDir(ctx);
      const minSeconds = argNumber(ctx.args, 'min') ?? 20;
      const maxSeconds = argNumber(ctx.args, 'max') ?? 90;
      try {
        const words = await readTranscriptWords(projectDir);
        const proposals: { schemaVersion: 1; windows: ProposedWindow[] } = {
          schemaVersion: 1,
          windows: proposeWindows(words, { minSeconds, maxSeconds }),
        };
        await mkdir(join(projectDir, 'clips'), { recursive: true });
        await writeFile(
          join(projectDir, 'clips', 'proposals.json'),
          `${JSON.stringify(proposals, null, 2)}\n`,
        );
        ctx.out(
          `clip-propose: ${proposals.windows.length} window(s) from ${words.length} transcript ` +
            'word(s) → clips/proposals.json',
        );
        return { exitCode: 0 };
      } catch (error) {
        return ctx.fail(`clip-propose: ${errorText(error)}`);
      }
    },
  };

  const clipRanges: CommandSpec = {
    verb: 'clip-ranges',
    summary:
      'Score transcript windows against the visual analyses (100% offline) → ' +
      'clips/candidates.json (bare ClipRange[]).',
    args: [
      PROJECT_ARG,
      {
        name: 'preset',
        kind: 'string',
        default: 'viral',
        description: 'Scoring preset: viral | podcast | educational.',
      },
      {
        name: 'weights',
        kind: 'string',
        description: 'ScoringWeights JSON file overriding the preset weights.',
      },
      {
        name: 'init-weights',
        kind: 'boolean',
        default: false,
        description: 'Write clips/scoring.json from --preset and exit.',
      },
      {
        name: 'min-score',
        kind: 'number',
        default: 0,
        description: 'Drop candidates scoring below this value (0–1).',
      },
      {
        name: 'min',
        kind: 'number',
        default: 20,
        description: 'Minimum candidate window length in seconds.',
      },
      {
        name: 'max',
        kind: 'number',
        default: 90,
        description: 'Maximum candidate window length in seconds.',
      },
      {
        name: 'objective',
        kind: 'string',
        description: 'Natural-language objective carried with the candidates.',
      },
      {
        name: 'explain',
        kind: 'string',
        description: 'Print the score breakdown of one candidate id and exit (nothing written).',
      },
      {
        name: 'social-drafts',
        kind: 'string',
        description: 'JSON file mapping range/window ids to ClipSocial drafts from the agent.',
      },
    ],
    supportsPlan: true,
    writes: ['clips/candidates.json', 'clips/scoring.json'],
    movesGates: [],
    plan(ctx): PlanStep[] {
      const preset = argString(ctx.args, 'preset') ?? 'viral';
      if (argBoolean(ctx.args, 'init-weights', false)) {
        return [
          {
            action: `write the "${preset}" scoring weights document`,
            writes: 'clips/scoring.json',
          },
        ];
      }
      const min = argNumber(ctx.args, 'min') ?? 20;
      const max = argNumber(ctx.args, 'max') ?? 90;
      const scoreAction =
        `score transcript windows (${min}–${max}s) against the visual analyses ` +
        `("${preset}" weights)`;
      const explainId = argString(ctx.args, 'explain');
      if (explainId !== undefined) {
        return [
          {
            action: `${scoreAction} and explain candidate "${explainId}" (prints, writes nothing)`,
          },
        ];
      }
      return [
        {
          action: scoreAction,
          target: 'clips/transcript.json',
          writes: 'clips/candidates.json',
        },
      ];
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') refusePlanMode(ctx, 'clip-ranges');
      const projectDir = resolveProjectDir(ctx);
      const presetRaw = argString(ctx.args, 'preset') ?? 'viral';
      const presetParsed = ScoringPresetSchema.safeParse(presetRaw);
      if (!presetParsed.success) {
        return ctx.fail(
          `clip-ranges: unknown --preset "${presetRaw}" — expected viral | podcast | educational.`,
        );
      }
      const preset = presetParsed.data;
      if (argBoolean(ctx.args, 'init-weights', false)) {
        try {
          await mkdir(join(projectDir, 'clips'), { recursive: true });
          await writeFile(
            join(projectDir, 'clips', 'scoring.json'),
            `${JSON.stringify(scoringWeightsFor(preset), null, 2)}\n`,
          );
        } catch (error) {
          return ctx.fail(`clip-ranges: ${errorText(error)}`);
        }
        ctx.out(`clip-ranges: "${preset}" scoring weights → clips/scoring.json`);
        return { exitCode: 0 };
      }

      let weights: ScoringWeightValues;
      const weightsFile = argString(ctx.args, 'weights');
      if (weightsFile !== undefined) {
        let doc: unknown;
        try {
          doc = await readJsonDocument(
            resolve(ctx.cwd, weightsFile),
            weightsFile,
            'pass a ScoringWeights JSON document (see --init-weights)',
          );
        } catch (error) {
          return ctx.fail(`clip-ranges: ${errorText(error)}`);
        }
        const parsed = ScoringWeightsSchema.safeParse(doc);
        if (!parsed.success) {
          return ctx.fail(
            `clip-ranges: ${weightsFile} is not a ScoringWeights document — ` +
              `${zodIssues(parsed.error.issues)}.`,
          );
        }
        weights = parsed.data.weights;
      } else {
        weights = scoringWeightsFor(preset).weights;
      }

      const draftsFile = argString(ctx.args, 'social-drafts');
      let socialDrafts: Record<string, ClipSocial> | undefined;
      if (draftsFile !== undefined) {
        let doc: unknown;
        try {
          doc = await readJsonDocument(
            resolve(ctx.cwd, draftsFile),
            draftsFile,
            'pass a JSON object mapping ids to ClipSocial drafts',
          );
        } catch (error) {
          return ctx.fail(`clip-ranges: ${errorText(error)}`);
        }
        if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
          return ctx.fail(
            `clip-ranges: ${draftsFile} must be a JSON object mapping ids to ClipSocial drafts.`,
          );
        }
        const drafts: Record<string, ClipSocial> = {};
        for (const [id, entry] of Object.entries(doc)) {
          const parsed = ClipSocialSchema.safeParse(entry);
          if (!parsed.success) {
            return ctx.fail(
              `clip-ranges: ${draftsFile}["${id}"] is not a ClipSocial draft — ` +
                `${zodIssues(parsed.error.issues)}.`,
            );
          }
          drafts[id] = parsed.data;
        }
        socialDrafts = drafts;
      }

      let words: ClipWord[];
      let framesDoc: FramesManifest | undefined;
      let analyses: FrameAnalysis[];
      try {
        words = await readTranscriptWords(projectDir);
        framesDoc = await readManifest<FramesManifest>(
          join(projectDir, 'clips', 'frames.json'),
          'clips/frames.json',
        );
        analyses = await readAnalysisFrames(
          projectDir,
          framesDoc === undefined
            ? undefined
            : new Set(framesDoc.frames.map((frame) => frame.frame_id)),
        );
      } catch (error) {
        return ctx.fail(`clip-ranges: ${errorText(error)}`);
      }
      if (framesDoc === undefined) {
        return ctx.fail(
          `clip-ranges: clips/frames.json is missing in ${projectDir} — run clip-frames first.`,
        );
      }
      const objective = argString(ctx.args, 'objective');
      let candidates: ClipRange[];
      try {
        candidates = buildCandidates({
          words,
          analyses,
          weights,
          ...(objective !== undefined ? { objective } : {}),
          ...(socialDrafts !== undefined ? { socialDrafts } : {}),
          options: {
            minDurationSeconds: argNumber(ctx.args, 'min') ?? 20,
            maxDurationSeconds: argNumber(ctx.args, 'max') ?? 90,
            minScore: argNumber(ctx.args, 'min-score') ?? 0,
          },
        });
      } catch (error) {
        return ctx.fail(`clip-ranges: ${errorText(error)}`);
      }
      const explainId = argString(ctx.args, 'explain');
      if (explainId !== undefined) {
        try {
          ctx.out(explainCandidate(candidates, explainId, weights));
        } catch (error) {
          return ctx.fail(`clip-ranges: ${errorText(error)}`);
        }
        return { exitCode: 0 };
      }
      try {
        await mkdir(join(projectDir, 'clips'), { recursive: true });
        await writeFile(
          join(projectDir, 'clips', 'candidates.json'),
          `${JSON.stringify(candidates, null, 2)}\n`,
        );
      } catch (error) {
        return ctx.fail(`clip-ranges: ${errorText(error)}`);
      }
      ctx.out(`clip-ranges: ${candidates.length} candidate(s) → clips/candidates.json`);
      return { exitCode: 0 };
    },
  };

  const clipPolish: CommandSpec = {
    verb: 'clip-polish',
    summary:
      'Trim silences and split interior gaps in the candidate ranges (free, offline) → ' +
      'clips/decisions-ready.json.',
    args: [
      PROJECT_ARG,
      {
        name: 'margin',
        kind: 'number',
        description: 'Seconds of margin around the first/last phoneme (default 0.2).',
      },
      {
        name: 'max-gap',
        kind: 'number',
        description: 'Interior gaps longer than this many seconds split the range (default 2).',
      },
      {
        name: 'backend',
        kind: 'string',
        description: 'Backend label recorded in the polished document (default omp).',
      },
    ],
    supportsPlan: true,
    writes: ['clips/decisions-ready.json'],
    movesGates: [],
    plan(): PlanStep[] {
      return [
        {
          action: 'trim each candidate to its first/last phoneme and split interior gaps > 2s',
          target: 'clips/candidates.json',
          writes: 'clips/decisions-ready.json',
        },
      ];
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') refusePlanMode(ctx, 'clip-polish');
      const projectDir = resolveProjectDir(ctx);
      const marginSeconds = argNumber(ctx.args, 'margin');
      const maxGapSeconds = argNumber(ctx.args, 'max-gap');
      const backend = argString(ctx.args, 'backend');
      try {
        const polished = await runClipPolish(projectDir, {
          ...(marginSeconds !== undefined ? { marginSeconds } : {}),
          ...(maxGapSeconds !== undefined ? { maxGapSeconds } : {}),
          ...(backend !== undefined ? { backend } : {}),
        });
        ctx.out(
          `clip-polish: ${polished.ranges.length} polished range(s) → clips/decisions-ready.json`,
        );
        return { exitCode: 0 };
      } catch (error) {
        return ctx.fail(`clip-polish: ${errorText(error)}`);
      }
    },
  };

  const clipApprove: CommandSpec = {
    verb: 'clip-approve',
    summary:
      'Deterministically seal the approved ranges (ClipRange schema + source sha256 + ' +
      'invariants) → clips/decisions.json. ⛔ No render without this seal.',
    args: [
      PROJECT_ARG,
      {
        name: 'id',
        kind: 'string[]',
        description: 'Range id to approve (repeatable). Unlisted ranges are sealed as rejected.',
      },
    ],
    supportsPlan: true,
    writes: ['clips/decisions.json'],
    movesGates: [],
    plan(ctx): PlanStep[] {
      const ids = argStringList(ctx.args, 'id');
      return [
        {
          action:
            `re-validate and seal ${ids.length > 0 ? ids.join(', ') : 'the approved ranges'} ` +
            '(ClipRange schema, source sha256, duration/layout/social invariants)',
          target: 'clips/decisions-ready.json',
          writes: 'clips/decisions.json',
        },
      ];
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') refusePlanMode(ctx, 'clip-approve');
      const projectDir = resolveProjectDir(ctx);
      const selectedIds = [...new Set(argStringList(ctx.args, 'id'))];
      if (selectedIds.length === 0) {
        return ctx.fail(
          'clip-approve: no approved ranges — pass at least one --id <range-id> from ' +
            'clips/decisions-ready.json to seal (every unlisted range is sealed as rejected).',
        );
      }

      let readyDoc: unknown;
      try {
        readyDoc = await readJsonDocument(
          join(projectDir, 'clips', 'decisions-ready.json'),
          'clips/decisions-ready.json',
          'run clip-polish first',
        );
      } catch (error) {
        return ctx.fail(`clip-approve: ${errorText(error)}`);
      }
      // Non-object documents degrade to `{}` (never a TypeError) so the shape
      // check below reports the actionable message.
      const ready: { sourceSha256?: unknown; backend?: unknown; ranges?: unknown } =
        typeof readyDoc === 'object' && readyDoc !== null && !Array.isArray(readyDoc)
          ? (readyDoc as { sourceSha256?: unknown; backend?: unknown; ranges?: unknown })
          : {};
      const readySha256 = typeof ready.sourceSha256 === 'string' ? ready.sourceSha256 : '';
      const backend = typeof ready.backend === 'string' ? ready.backend : '';
      const rangesRaw = Array.isArray(ready.ranges) ? ready.ranges : undefined;
      if (rangesRaw === undefined) {
        return ctx.fail(
          'clip-approve: clips/decisions-ready.json must be a PolishedRangesDocument ' +
            '(sourceSha256, backend, ranges) — run clip-polish first.',
        );
      }
      if (readySha256 === '' || backend === '') {
        return ctx.fail(
          'clip-approve: clips/decisions-ready.json needs a non-empty "sourceSha256" and ' +
            '"backend" — run clip-polish first.',
        );
      }

      let sourceDoc: unknown;
      try {
        sourceDoc = await readJsonDocument(
          join(projectDir, 'clips', 'source.json'),
          'clips/source.json',
          'run clip-frames first',
        );
      } catch (error) {
        return ctx.fail(`clip-approve: ${errorText(error)}`);
      }
      const source: { sha256?: unknown; durationSeconds?: unknown } =
        typeof sourceDoc === 'object' && sourceDoc !== null && !Array.isArray(sourceDoc)
          ? (sourceDoc as { sha256?: unknown; durationSeconds?: unknown })
          : {};
      const sourceSha256 = typeof source.sha256 === 'string' ? source.sha256 : '';
      const durationSeconds =
        typeof source.durationSeconds === 'number' && Number.isFinite(source.durationSeconds)
          ? source.durationSeconds
          : undefined;
      if (sourceSha256 === '') {
        return ctx.fail('clip-approve: clips/source.json has no "sha256" — run clip-frames first.');
      }
      if (durationSeconds === undefined) {
        return ctx.fail(
          'clip-approve: clips/source.json has no finite "durationSeconds" — run clip-frames first.',
        );
      }
      if (readySha256 !== sourceSha256) {
        return ctx.fail(
          `clip-approve: source sha256 mismatch — clips/decisions-ready.json was polished from ` +
            `${readySha256} but clips/source.json is ${sourceSha256}; re-run clip-frames, ` +
            'clip-ranges and clip-polish on the current source before sealing.',
        );
      }

      const byId = new Map<string, Record<string, unknown>>();
      for (const [index, entry] of rangesRaw.entries()) {
        const raw = entry as Record<string, unknown> | null;
        const id = typeof raw?.id === 'string' ? raw.id : undefined;
        if (raw === null || typeof entry !== 'object' || id === undefined) {
          return ctx.fail(
            `clip-approve: clips/decisions-ready.json ranges[${index}] has no string "id" — ` +
              'run clip-polish again.',
          );
        }
        if (byId.has(id)) {
          return ctx.fail(
            `clip-approve: clips/decisions-ready.json has duplicate range id "${id}" — ` +
              'run clip-polish again.',
          );
        }
        byId.set(id, raw);
      }
      for (const id of selectedIds) {
        const raw = byId.get(id);
        if (raw === undefined) {
          return ctx.fail(
            `clip-approve: unknown --id "${id}" — not present in clips/decisions-ready.json ` +
              `(known: ${[...byId.keys()].join(', ') || 'none'}).`,
          );
        }
        const violation = rangeInvariantViolation(raw, id, durationSeconds);
        if (violation !== undefined) return ctx.fail(violation);
        const parsed = ClipRangeSchema.safeParse(raw);
        if (!parsed.success) {
          return ctx.fail(
            `clip-approve: ${id} is not a valid ClipRange — ${zodIssues(parsed.error.issues)}.`,
          );
        }
      }

      const selectedSet = new Set(selectedIds);
      const decisionDoc: ClipDecision = {
        schemaVersion: 1,
        sourceSha256: readySha256,
        backend,
        decisions: rangesRaw.map((entry) => {
          const raw = entry as Record<string, unknown>;
          return {
            range: raw as unknown as ClipRange,
            status: selectedSet.has(String(raw.id)) ? ('approved' as const) : ('rejected' as const),
          };
        }),
      };
      const sealed = ClipDecisionSchema.safeParse(decisionDoc);
      if (!sealed.success) {
        return ctx.fail(
          `clip-approve: the sealed document fails ClipDecisionSchema — ` +
            `${zodIssues(sealed.error.issues)}.`,
        );
      }
      try {
        await mkdir(join(projectDir, 'clips'), { recursive: true });
        await writeFile(
          join(projectDir, 'clips', 'decisions.json'),
          `${JSON.stringify(decisionDoc, null, 2)}\n`,
        );
      } catch (error) {
        return ctx.fail(`clip-approve: ${errorText(error)}`);
      }
      ctx.out(
        `clip-approve: sealed ${selectedIds.join(', ')} → clips/decisions.json ` +
          `(${decisionDoc.decisions.length - selectedIds.length} rejected).`,
      );
      return { exitCode: 0 };
    },
  };

  const clipLocate: CommandSpec = {
    verb: 'clip-locate',
    summary:
      'Resolve one exact frame (t or frame_id) with its neighbor paths and transcript slice ' +
      '(stdout only, free).',
    args: [
      PROJECT_ARG,
      {
        name: 'at',
        kind: 'string',
        description: 'Exact location to resolve: t in seconds or frame_id (REQUIRED in run mode).',
      },
    ],
    supportsPlan: true,
    writes: [],
    movesGates: [],
    plan(ctx): PlanStep[] {
      const at = argString(ctx.args, 'at') ?? '<t|frame_id>';
      return [
        {
          action: `resolve ${at} to its exact frame + neighbor paths + transcript slice (stdout)`,
          target: 'clips/frames.json',
        },
      ];
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') refusePlanMode(ctx, 'clip-locate');
      const at = argString(ctx.args, 'at');
      if (at === undefined) {
        return ctx.fail(
          'clip-locate: --at <t|frame_id> is required (seconds from source start, or a frame ' +
            'id like f-000042).',
        );
      }
      const projectDir = resolveProjectDir(ctx);
      let framesDoc: FramesManifest | undefined;
      let words: ClipWord[];
      let analyses: FrameAnalysis[];
      try {
        framesDoc = await readManifest<FramesManifest>(
          join(projectDir, 'clips', 'frames.json'),
          'clips/frames.json',
        );
        words = await readTranscriptWords(projectDir);
        analyses = await readAnalysisFrames(projectDir);
      } catch (error) {
        return ctx.fail(`clip-locate: ${errorText(error)}`);
      }
      if (framesDoc === undefined || framesDoc.frames.length === 0) {
        return ctx.fail(
          'clip-locate: clips/frames.json is missing or empty — run clip-frames first.',
        );
      }
      let result: LocateResult;
      try {
        result = locateAt({ frames: framesDoc.frames, words, analyses, at });
      } catch (error) {
        return ctx.fail(`clip-locate: ${errorText(error)}`);
      }
      ctx.out(`clip-locate: ${result.frame.frame_id} t=${result.frame.t} → ${result.frame.path}`);
      for (const neighbor of result.neighbors) {
        ctx.out(`clip-locate:   neighbor ${neighbor.frame_id} t=${neighbor.t} → ${neighbor.path}`);
      }
      ctx.out(`clip-locate:   transcript: ${result.words.map((word) => word.word).join(' ')}`);
      return { exitCode: 0 };
    },
  };

  const clipStrip: CommandSpec = {
    verb: 'clip-strip',
    summary:
      'Compose the labeled frame_id grid of one window (free, offline) → ' +
      'clips/strips/<from>-<to>.jpg.',
    args: [
      PROJECT_ARG,
      {
        name: 'from',
        kind: 'number',
        description: 'Window start in seconds (REQUIRED in run mode).',
      },
      {
        name: 'to',
        kind: 'number',
        description: 'Window end in seconds (REQUIRED in run mode).',
      },
    ],
    supportsPlan: true,
    writes: ['clips/strips/<from>-<to>.jpg'],
    movesGates: [],
    plan(ctx): PlanStep[] {
      const from = argNumber(ctx.args, 'from') ?? '<from>';
      const to = argNumber(ctx.args, 'to') ?? '<to>';
      return [
        {
          action: `tile the ${from}–${to}s window frames into one frame_id-labeled grid`,
          target: 'clips/frames.json',
          writes: `clips/strips/${from}-${to}.jpg`,
        },
      ];
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') refusePlanMode(ctx, 'clip-strip');
      const from = argNumber(ctx.args, 'from');
      const to = argNumber(ctx.args, 'to');
      if (from === undefined || to === undefined) {
        return ctx.fail(
          'clip-strip: --from <seconds> and --to <seconds> are required (the window to grid).',
        );
      }
      if (from < 0 || to < from) {
        return ctx.fail(
          `clip-strip: --from/--to must satisfy 0 <= from <= to (got from=${from}, to=${to}).`,
        );
      }
      const projectDir = resolveProjectDir(ctx);
      let framesDoc: FramesManifest | undefined;
      try {
        framesDoc = await readManifest<FramesManifest>(
          join(projectDir, 'clips', 'frames.json'),
          'clips/frames.json',
        );
      } catch (error) {
        return ctx.fail(`clip-strip: ${errorText(error)}`);
      }
      if (framesDoc === undefined || framesDoc.frames.length === 0) {
        return ctx.fail(
          'clip-strip: clips/frames.json is missing or empty — run clip-frames first.',
        );
      }
      const frameIds = framesDoc.frames
        .filter((frame) => frame.t >= from && frame.t <= to)
        .sort((a, b) => a.t - b.t)
        .map((frame) => frame.frame_id);
      if (frameIds.length === 0) {
        return ctx.fail(
          `clip-strip: no sampled frames between ${from}s and ${to}s — widen the window or run ` +
            'clip-frames with a finer --frame-every.',
        );
      }
      try {
        await renderStripGrid(deps.process, projectDir, {
          from,
          to,
          frameIds: planStripGrid(frameIds).frameIds,
        });
      } catch (error) {
        return ctx.fail(`clip-strip: ${errorText(error)}`);
      }
      ctx.out(
        `clip-strip: ${frameIds.length} frame(s) → ` +
          `${join('clips', 'strips', `${from}-${to}.jpg`)}`,
      );
      return { exitCode: 0 };
    },
  };

  const clipViewer: CommandSpec = {
    verb: 'clip-viewer',
    summary:
      'Render the READ-ONLY local clip dashboard from candidates/decisions (no actions, no ' +
      'network) → clips/dashboard/index.html.',
    args: [
      PROJECT_ARG,
      {
        name: 'objective',
        kind: 'string',
        description: 'Header text for the dashboard (default: "Clip dashboard").',
      },
    ],
    supportsPlan: true,
    writes: ['clips/dashboard/index.html'],
    movesGates: [],
    plan(ctx): PlanStep[] {
      const header = argString(ctx.args, 'objective') ?? 'Clip dashboard';
      return [
        {
          action: `render the read-only clip dashboard ("${header}")`,
          target: 'clips/candidates.json',
          writes: 'clips/dashboard/index.html',
        },
      ];
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') refusePlanMode(ctx, 'clip-viewer');
      const projectDir = resolveProjectDir(ctx);
      let candidatesRaw: unknown;
      try {
        candidatesRaw = await readJsonDocument(
          join(projectDir, 'clips', 'candidates.json'),
          'clips/candidates.json',
          'run clip-ranges first',
        );
      } catch (error) {
        return ctx.fail(`clip-viewer: ${errorText(error)}`);
      }
      if (!Array.isArray(candidatesRaw)) {
        return ctx.fail(
          'clip-viewer: clips/candidates.json must be a bare ClipRange[] — run clip-ranges first.',
        );
      }
      const candidates: ClipRange[] = [];
      for (const [index, entry] of candidatesRaw.entries()) {
        const parsed = ClipRangeSchema.safeParse(entry);
        if (!parsed.success) {
          return ctx.fail(
            `clip-viewer: clips/candidates.json[${index}] is not a ClipRange — ` +
              `${zodIssues(parsed.error.issues)}.`,
          );
        }
        candidates.push(parsed.data);
      }

      let decisions: Array<{ range: ClipRange; status: 'approved' | 'rejected' }> = [];
      const decisionsPath = join(projectDir, 'clips', 'decisions.json');
      if (await pathExists(decisionsPath)) {
        let doc: unknown;
        try {
          doc = await readJsonDocument(
            decisionsPath,
            'clips/decisions.json',
            'run clip-approve first',
          );
        } catch (error) {
          return ctx.fail(`clip-viewer: ${errorText(error)}`);
        }
        const parsed = ClipDecisionSchema.safeParse(doc);
        if (!parsed.success) {
          return ctx.fail(
            `clip-viewer: clips/decisions.json is not a ClipDecision — ` +
              `${zodIssues(parsed.error.issues)}.`,
          );
        }
        decisions = parsed.data.decisions.map((entry) => ({
          range: entry.range,
          status: entry.status,
        }));
      }

      let framesDoc: FramesManifest | undefined;
      try {
        framesDoc = await readManifest<FramesManifest>(
          join(projectDir, 'clips', 'frames.json'),
          'clips/frames.json',
        );
      } catch (error) {
        return ctx.fail(`clip-viewer: ${errorText(error)}`);
      }
      const frames = framesDoc?.frames ?? [];
      const frameIdsByRange: Record<string, string[]> = {};
      const stillByRange: Record<string, string> = {};
      for (const range of candidates) {
        frameIdsByRange[range.id] = frames
          .filter((frame) => frame.t >= range.start && frame.t <= range.end)
          .sort((a, b) => a.t - b.t)
          .map((frame) => frame.frame_id);
        if (frames.length > 0) {
          const midpoint = (range.start + range.end) / 2;
          const still = resolveFrameAt(frames, midpoint);
          stillByRange[range.id] = join('clips', 'frames', `${still.frame_id}.jpg`);
        }
      }
      const cards: ClipDashboardCard[] = buildClipCards(
        candidates,
        decisions,
        frameIdsByRange,
      ).map((card) => ({
        ...card,
        ...(stillByRange[card.id] !== undefined ? { stillPath: stillByRange[card.id] } : {}),
      }));
      const header = argString(ctx.args, 'objective');
      const html = renderClipsDashboard({ cards, ...(header !== undefined ? { header } : {}) });
      try {
        await mkdir(join(projectDir, 'clips', 'dashboard'), { recursive: true });
        await writeFile(join(projectDir, 'clips', 'dashboard', 'index.html'), html);
      } catch (error) {
        return ctx.fail(`clip-viewer: ${errorText(error)}`);
      }
      ctx.out(
        `clip-viewer: ${cards.length} card(s) → ` +
          `${join('clips', 'dashboard', 'index.html')}`,
      );
      return { exitCode: 0 };
    },
  };

  return [clipPropose, clipRanges, clipPolish, clipApprove, clipLocate, clipStrip, clipViewer];
}

/** The registry's clip decision commands (specs/clip.ts part 2/3). */
export const clipDecisionSpecs: CommandSpec[] = buildClipDecisionSpecs();

// ---------------------------------------------------------------------------
// End of part 2/3 (decision verbs). Part 3/3 APPENDS its specs below.

// ---------------------------------------------------------------------------
// Part 3/3 (render verb): clip-render — the ONLY verb that turns a sealed
// decision into pixels.
//
// - `clip-render` is FREE (rendering is compute, not spend) and refuses plan
//   mode like every other verb. The sealed `clips/decisions.json` written by
//   `clip-approve` is the entry ticket: missing seal or zero approved entries
//   is an actionable failure NAMING clip-approve (⛔ without this seal there
//   is no render); selected `--id`s must be approved.
// - Per approved range: `trimClipMedia` (pipeline/clip.ts, part 5/5) runs the
//   EXACT ffmpeg trim of `clips/source.mp4` over
//   `[start, end]` (`-ss start` + `-t end - start`, full h264/yuv420p
//   re-encode at 30 fps — never a keyframe-snapping stream copy) plus the
//   trim's audio extracted to `clips/trimmed/<id>.wav`. The trimmed video is
//   VIDEO-ONLY: the trim's audio reaches the render EXACTLY ONCE through the
//   staged WAV as `scene.audioSrc` (which `Film` plays exactly once per
//   scene), so nothing can ever double it.
// - `buildClipFilmProps` (pipeline/clip.ts, part 5/5) composes the one-scene
//   `FilmProps` (1080×1920 @ 30 fps) from `buildFilmProps`
//   (the `runAssemble` composer) over a synthesized clip scene, then carries
//   the clip-only fields: `source: 'clip'`, `layout`, `faces`, `mediaSrc` and
//   the camera `track` whose interactions are `framesToInteractions` over the
//   analysis frames of the range with `t` REBASED to the clip before
//   quantization. The composition side registers the clip intents through the
//   tiny `motion-remotion/src/clip-entry.tsx` module (mirroring the
//   project-side intent registration `runAssemble` bundles).
// - Render via the `RenderSeam`: the video lands at `renders/clips/<id>.mp4`
//   and the still samples the SAME composition at the FIRST frame of the
//   scene span (still parity by construction), then the loudness gate of
//   `runAssemble` runs and `qa/clips/<id>.report.json` pins the sha256 of
//   both artifacts (FR-011-style evidence).
//
// Plan mode is pure (NFR-002): static steps only, no subprocesses, no
// network, no secret resolution. Part 3/3 is the final append of this file.
// ---------------------------------------------------------------------------
import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { loadProject, sha256File, type Project } from '@videomaker/core';
import { filmTimingPlan, type TimingPlan } from '@videomaker/motion-core';
import { normalizeAudioLoudness } from '@videomaker/motion-remotion/loudness';

import { projectAbsolute } from '../pipeline/assemble';
import {
  CLIP_FILM_FPS,
  CLIP_FILM_HEIGHT,
  CLIP_FILM_WIDTH,
  buildClipFilmProps,
  trimClipMedia,
} from '../pipeline/clip';

/**
 * Remotion entry bundled for clip renders. `runAssemble` bundles the
 * project's own `remotion/index.ts` (whose Root registers its scene
 * renderers as an import side effect); clip films have no project-side root,
 * so `clip-render` bundles `clip-entry.tsx` — the module that registers
 * `clip-vertical` / `clip-podcast` and mounts `Film`.
 */
const CLIP_FILM_ENTRY_POINT = fileURLToPath(
  new URL('../../../motion-remotion/src/clip-entry.tsx', import.meta.url),
);

/**
 * Every stage/render/qa path one clip render touches (the trim outputs come
 * from `trimClipMedia`), project-relative and absolute.
 */
interface ClipRenderPaths {
  /** publicDir-relative staged video (staticFile target). */
  stagedVideoSrc: string;
  /** publicDir-relative staged audio (staticFile target). */
  stagedAudioSrc: string;
  stagedVideoAbsolute: string;
  stagedAudioAbsolute: string;
  mp4Relative: string;
  mp4Absolute: string;
  stillRelative: string;
  stillAbsolute: string;
  reportRelative: string;
  reportAbsolute: string;
}

/** Builds every clip-render path for one range id (all under the project). */
function clipRenderPaths(projectDir: string, id: string): ClipRenderPaths {
  const stagedVideoSrc = `media/clips/${id}.mp4`;
  const stagedAudioSrc = `media/clips/${id}.wav`;
  const mp4Relative = `renders/clips/${id}.mp4`;
  const stillRelative = `qa/stills/clips/${id}.png`;
  const reportRelative = `qa/clips/${id}.report.json`;
  return {
    stagedVideoSrc,
    stagedAudioSrc,
    // Staged copies live inside the composition public dir (`staticFile` root).
    stagedVideoAbsolute: projectAbsolute(join(projectDir, 'public'), stagedVideoSrc),
    stagedAudioAbsolute: projectAbsolute(join(projectDir, 'public'), stagedAudioSrc),
    mp4Relative,
    mp4Absolute: projectAbsolute(projectDir, mp4Relative),
    stillRelative,
    stillAbsolute: projectAbsolute(projectDir, stillRelative),
    reportRelative,
    reportAbsolute: projectAbsolute(projectDir, reportRelative),
  };
}

/** Shared fixture facts every rendered range reads from the project. */
interface ClipRenderContext {
  projectDir: string;
  project: Project;
  /** Project-relative source video (`clips/source.mp4`). */
  sourceRelative: string;
  /** Every validated `clips/analysis` frame of the project. */
  analyses: readonly FrameAnalysis[];
  /** Intrinsic source frame size from `clips/source.json`. */
  sourceSize: { width: number; height: number };
}

/** `qa/clips/<id>.report.json`: the qa evidence contract of one clip render. */
interface ClipQaReport {
  schemaVersion: 1;
  id: string;
  mp4: string;
  mp4Sha256: string;
  still: string;
  stillSha256: string;
  width: number;
  height: number;
  fps: number;
  durationFrames: number;
  expectedDurationSeconds: number;
}

/**
 * One sealed approved range end to end: exact trim + its audio once →
 * one-scene `FilmProps` → `RenderSeam` video + first-frame parity still (the
 * SAME composition and `expectedDurationInFrames`) → the loudness gate of
 * `runAssemble` → `qa/clips/<id>.report.json` with both sha256 digests.
 */
async function renderApprovedClip(input: {
  deps: MediaCommandDeps;
  context: ClipRenderContext;
  range: ClipRange;
  out: (line: string) => void;
}): Promise<ClipQaReport> {
  const { deps, context, range } = input;
  const paths = clipRenderPaths(context.projectDir, range.id);
  const publicClipsDir = join(context.projectDir, 'public', 'media', 'clips');

  // 1. EXACT trim (frame-accurate re-encode) + the trim's audio into
  //    `clips/trimmed/` (`trimClipMedia`), staged into the composition
  //    public dir as the scene's media/audio sources.
  const trim = await trimClipMedia({
    ffmpeg: deps.ffmpeg,
    projectDir: context.projectDir,
    range,
    sourceRelative: context.sourceRelative,
  });
  await mkdir(publicClipsDir, { recursive: true });
  await copyFile(
    projectAbsolute(context.projectDir, trim.videoRelative),
    paths.stagedVideoAbsolute,
  );
  await copyFile(
    projectAbsolute(context.projectDir, trim.audioRelative),
    paths.stagedAudioAbsolute,
  );

  // 2. One-scene FilmProps + the shared timing plan (the frame-math authority
  //    both render paths consume through `expectedDurationInFrames`).
  const props = buildClipFilmProps(context.project, {
    range,
    analyses: context.analyses,
    sourceSize: context.sourceSize,
    stagedVideoSrc: paths.stagedVideoSrc,
    stagedAudioSrc: paths.stagedAudioSrc,
  });
  const timingPlan: TimingPlan = filmTimingPlan({
    fps: props.fps,
    scenes: props.scenes.map((scene) => ({
      durationInSeconds: scene.durationInSeconds,
      source: scene.source,
    })),
    timingMode: props.timingMode,
    narration: props.narration ?? null,
  });

  // 3. Video + still through the RenderSeam: the still samples the FIRST
  //    frame of the scene span of the SAME composition (parity by
  //    construction).
  await mkdir(dirname(paths.mp4Absolute), { recursive: true });
  await deps.render.renderVideo({
    entryPoint: CLIP_FILM_ENTRY_POINT,
    publicDir: join(context.projectDir, 'public'),
    inputProps: props,
    expectedDurationInFrames: timingPlan.totalFrames,
    outputLocation: paths.mp4Absolute,
    concurrency: null,
  });
  await mkdir(dirname(paths.stillAbsolute), { recursive: true });
  await deps.render.renderStill({
    entryPoint: CLIP_FILM_ENTRY_POINT,
    publicDir: join(context.projectDir, 'public'),
    inputProps: props,
    output: paths.stillAbsolute,
    frame: timingPlan.spans[0]!.startFrame,
    expectedDurationInFrames: timingPlan.totalFrames,
  });

  // 4. Loudness gate (the existing `runAssemble` gate over the trim's audio)
  //    + the qa evidence report with the sha256 of both artifacts.
  const normalization = await normalizeAudioLoudness(paths.mp4Absolute, {
    enabled: true,
    runner: deps.ffmpeg,
    // Cap every AAC re-encode at the exact VIDEO span
    // (expectedDurationInFrames / fps), never the audio-inclusive container
    // length: the AAC quantization (~1 frame + priming) then stays inside the
    // `end - start ± 1 frame` duration contract.
    capDurationSeconds: timingPlan.totalFrames / props.fps,
    ...(deps.log ? { log: deps.log } : {}),
  });
  const report: ClipQaReport = {
    schemaVersion: 1,
    id: range.id,
    mp4: paths.mp4Relative,
    mp4Sha256: await sha256File(paths.mp4Absolute),
    still: paths.stillRelative,
    stillSha256: await sha256File(paths.stillAbsolute),
    width: CLIP_FILM_WIDTH,
    height: CLIP_FILM_HEIGHT,
    fps: CLIP_FILM_FPS,
    durationFrames: timingPlan.totalFrames,
    expectedDurationSeconds: trim.durationSeconds,
  };
  await mkdir(dirname(paths.reportAbsolute), { recursive: true });
  await writeFile(paths.reportAbsolute, `${JSON.stringify(report, null, 2)}\n`);
  input.out(
    `clip-render: ${range.id} → ${paths.mp4Relative} (${report.durationFrames} frames) + ` +
      `${paths.stillRelative} + ${paths.reportRelative}` +
      (normalization.measured !== undefined
        ? `; loudness I=${normalization.measured.integratedLufs.toFixed(2)} LUFS / ` +
          `TP=${normalization.measured.truePeakDbtp.toFixed(2)} dBTP` +
          `${normalization.applied ? ' (normalized)' : ''}`
        : ''),
  );
  return report;
}

export function buildClipRenderSpecs(deps: MediaCommandDeps = defaultMediaDeps()): CommandSpec[] {
  const clipRender: CommandSpec = {
    verb: 'clip-render',
    summary:
      'Cut every sealed approved range exactly and render its one-scene vertical film ' +
      '(1080×1920 @ 30 fps) + parity still + loudness/qa report. Free — rendering is ' +
      'compute, not spend.',
    args: [
      PROJECT_ARG,
      {
        name: 'id',
        kind: 'string[]',
        description:
          'Approved range id to render (repeatable). Omitted renders every approved range ' +
          'in clips/decisions.json.',
      },
    ],
    supportsPlan: true,
    writes: ['renders/clips/<id>.mp4', 'qa/stills/clips/<id>.png', 'qa/clips/<id>.report.json'],
    movesGates: ['render', 'qa'],
    plan(ctx): PlanStep[] {
      const ids = argStringList(ctx.args, 'id');
      const selection = ids.length > 0 ? ids.join(', ') : 'every approved range';
      return [
        {
          action:
            `trim ${selection} exactly from clips/source.mp4 (ffmpeg -ss/-t, h264/yuv420p ` +
            're-encode @ 30 fps) and stage its audio',
          target: 'clips/decisions.json',
          writes: 'clips/trimmed/<id>.mp4',
        },
        {
          action:
            'compose the one-scene FilmProps (1080×1920 @ 30 fps, clip layout + faces + ' +
            'rebased face track)',
          target: 'clips/analysis',
        },
        {
          action: `render ${selection} as a one-scene clip film (h264)`,
          writes: 'renders/clips/<id>.mp4',
          gate: 'render',
        },
        {
          action: 'sample the FIRST frame of the scene span as the parity still (same composition)',
          writes: 'qa/stills/clips/<id>.png',
        },
        {
          action: 'run the loudness gate and write the qa report (sha256 of mp4 + still)',
          writes: 'qa/clips/<id>.report.json',
          gate: 'qa',
        },
      ];
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') refusePlanMode(ctx, 'clip-render');
      const projectDir = resolveProjectDir(ctx);
      const selectedIds = [...new Set(argStringList(ctx.args, 'id'))];

      // The sealed decision is the entry ticket: without it (or without any
      // approved entry) there is no render.
      let decisions: ClipDecision;
      try {
        const raw = await readJsonDocument(
          join(projectDir, 'clips', 'decisions.json'),
          'clips/decisions.json',
          'run clip-approve to seal the approved ranges first — without this seal there is no render',
        );
        const parsed = ClipDecisionSchema.safeParse(raw);
        if (!parsed.success) {
          throw new Error(
            `clips/decisions.json is not a sealed ClipDecision — ${zodIssues(parsed.error.issues)}; ` +
              're-run clip-approve to seal it.',
          );
        }
        decisions = parsed.data;
      } catch (error) {
        return ctx.fail(`clip-render: ${errorText(error)}`);
      }
      const approvedById = new Map(
        decisions.decisions
          .filter((entry) => entry.status === 'approved')
          .map((entry) => [entry.range.id, entry]),
      );
      if (approvedById.size === 0) {
        return ctx.fail(
          'clip-render: clips/decisions.json seals zero approved ranges — run clip-approve to ' +
            'approve at least one range first (without an approved seal there is no render).',
        );
      }
      for (const id of selectedIds) {
        if (!approvedById.has(id)) {
          return ctx.fail(
            `clip-render: --id "${id}" is not an approved range in clips/decisions.json ` +
              `(approved: ${[...approvedById.keys()].join(', ')}) — approve it with ` +
              'clip-approve or drop the flag to render every approved range.',
          );
        }
      }
      const selection =
        selectedIds.length > 0
          ? selectedIds.map((id) => approvedById.get(id)!.range)
          : [...approvedById.values()].map((entry) => entry.range);

      try {
        const sourceDoc = await readJsonDocument(
          join(projectDir, 'clips', 'source.json'),
          'clips/source.json',
          'run clip-frames first',
        );
        const source = (sourceDoc ?? {}) as Record<string, unknown>;
        const width = typeof source.width === 'number' ? source.width : undefined;
        const height = typeof source.height === 'number' ? source.height : undefined;
        if (width === undefined || height === undefined || width <= 0 || height <= 0) {
          throw new Error(
            'clips/source.json needs finite "width" and "height" — run clip-frames first.',
          );
        }
        const context: ClipRenderContext = {
          projectDir,
          project: await loadProject(projectDir),
          sourceRelative: 'clips/source.mp4',
          analyses: await readAnalysisFrames(projectDir),
          sourceSize: { width, height },
        };
        for (const range of selection) {
          await renderApprovedClip({ deps, context, range, out: ctx.out });
        }
      } catch (error) {
        return ctx.fail(`clip-render: ${errorText(error)}`);
      }
      ctx.out(
        `clip-render: ${selection.length} approved clip(s) rendered — render + qa gates moved.`,
      );
      return { exitCode: 0 };
    },
  };

  return [clipRender];
}

/** The registry's clip render command (specs/clip.ts part 3/3). */
export const clipRenderSpecs: CommandSpec[] = buildClipRenderSpecs();

// ---------------------------------------------------------------------------
// End of part 3/3 (render verb) — the final section of this file.
