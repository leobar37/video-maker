import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  completeOperation, paidPlanDigest, resolveInsideProject, sha256Hex, sha256Json, submitOnce,
  type PaidOperationPlan, type PaidOperationRecord, type PaidOperationStore,
} from '@videomaker/core';
import {
  createSecretSource, createTypesafeEvaluator, validateTypesafeRequest, validateTypesafeResponse,
  type SecretSource, type TypesafeEvaluationRequest, type TypesafeEvaluationResponse,
} from '@videomaker/providers';
import {
  ClipSelectionRequestSchema, ClipSelectionTranscriptSchema, ClipSelectionResultV2Schema,
  ClipSelectionAttemptEvidenceSchema, ClipSelectionResultEntryV2Schema,
  type ClipSelectionCandidate, type ClipSelectionRequest, type ClipSelectionResultV2,
  type ClipSelectionResultEntryV2, type ClipSelectionSpendV2, type ClipSelectionTranscript,
} from '@videomaker/schemas';
import { PROJECT_ARG, resolveProjectDir } from '../args';
import {
  buildSelectionCandidates, buildSelectionEvaluationRequest, finalizeSelectionEntriesV2,
  renderSelectionReport, routeSelectionEvaluation, selectionEvaluation,
  CLIP_SELECTION_POLICY_VERSION, CLIP_SELECTION_RUBRIC_VERSION,
  TYPESAFE_INPUT_PRICE_PER_MILLION, TYPESAFE_MAX_CALL_USD,
} from '../pipeline/clip-selection';
import { buildPaidPlan, FileSpendLedger, spendCapFromArgs, spendLedgerPath } from '../pipeline/spend-ledger';
import type { CommandRunContext, CommandSpec, PlanStep } from '../spec-types';

export interface ClipSelectionDeps {
  /** Injectable offline seam; default adapter resolves credentials lazily. */
  evaluate?: (request: TypesafeEvaluationRequest, signal: AbortSignal, timeoutMs: number) => Promise<TypesafeEvaluationResponse>;
  secrets?: SecretSource;
  now?: () => Date;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** Atomic file replacement; no fixed temp path shared between executions. */
async function atomicWrite(path: string, value: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (!isMissing(error)) throw error; });
  }
}

async function containedFile(root: string, base: string, fragment: string): Promise<string> {
  if (isAbsolute(fragment) || fragment.includes('\\') || fragment.trim() === '') throw new Error('Input paths must be relative and non-empty.');
  return resolveInsideProject(root, relative(root, resolve(base, fragment)));
}

async function jsonInput(path: string, limit: number): Promise<{ value: unknown; text: string }> {
  const info = await stat(path);
  if (!info.isFile() || info.size > limit) throw new Error(`Invalid input size/type: ${path}.`);
  const text = await readFile(path, 'utf8');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`Invalid JSON: ${path}.`); }
  return { value, text };
}

interface PreparedSelection {
  root: string;
  requestPath: string;
  request: ClipSelectionRequest;
  transcript: ClipSelectionTranscript;
  requestSha256: string;
  transcriptSha256: string;
  selectionDigest: string;
  candidates: ClipSelectionCandidate[];
  proposedCount: number;
  resultPath: string;
  reportPath: string;
  cacheDir: string;
}

async function prepareSelection(ctx: CommandRunContext): Promise<PreparedSelection> {
  const root = await realpath(resolveProjectDir(ctx));
  const requestArg = ctx.args.request;
  if (typeof requestArg !== 'string') throw new Error('--request is required.');
  const requestPath = await containedFile(root, root, requestArg);
  const input = await jsonInput(requestPath, 64_000);
  const request = ClipSelectionRequestSchema.parse(input.value);
  const transcriptPath = await containedFile(root, dirname(requestPath), request.transcript);
  const transcriptInput = await jsonInput(transcriptPath, 8_000_000);
  const transcript = ClipSelectionTranscriptSchema.parse(transcriptInput.value);
  const { candidates, proposedCount } = buildSelectionCandidates(transcript, request);
  const requestSha256 = sha256Hex(input.text);
  const transcriptSha256 = sha256Hex(transcriptInput.text);
  const selectionDigest = sha256Json({ request, transcript, rubricVersion: CLIP_SELECTION_RUBRIC_VERSION, policyVersion: CLIP_SELECTION_POLICY_VERSION });
  const outputDir = dirname(requestPath);
  const resultPath = await containedFile(root, outputDir, 'clip-selection.result.json');
  const reportPath = await containedFile(root, outputDir, 'clip-selection.report.mdx');
  if ([requestPath, transcriptPath].includes(resultPath) || [requestPath, transcriptPath].includes(reportPath)) throw new Error('Selection outputs must not overwrite input files.');
  const cacheDir = await containedFile(root, outputDir, '.clip-selection-cache');
  await resolveInsideProject(root, relative(root, spendLedgerPath(root)));
  return { root, requestPath, request, transcript, requestSha256, transcriptSha256, selectionDigest, candidates, proposedCount, resultPath, reportPath, cacheDir };
}

interface SelectionJob {
  candidate: ClipSelectionCandidate;
  payload: TypesafeEvaluationRequest;
  digest: string;
  cachePath: string;
  cacheRelative: string;
  subject: string;
  cached?: TypesafeEvaluationResponse;
  attemptId?: string;
}

function selectionPaidPlan(job: SelectionJob, model: ClipSelectionRequest['model']): PaidOperationPlan {
  return buildPaidPlan({
    command: 'clips-select', subject: job.subject,
    inputs: { digest: job.digest, model },
    outputs: [job.cacheRelative], estimatedCostUsd: TYPESAFE_MAX_CALL_USD,
    // Stable per-call plan cap; changing CLI cap must not permit duplicate submit.
    spendCapUsd: TYPESAFE_MAX_CALL_USD, maxAttempts: 1,
  });
}

async function selectionJobs(prepared: PreparedSelection, ledger?: FileSpendLedger): Promise<SelectionJob[]> {
  const jobs: SelectionJob[] = [];
  for (const candidate of prepared.candidates) {
    const payload = buildSelectionEvaluationRequest(candidate, prepared.transcript, prepared.request);
    validateTypesafeRequest(payload);
    const digest = sha256Json({ selectionDigest: prepared.selectionDigest, candidate, payload, rubricVersion: CLIP_SELECTION_RUBRIC_VERSION, policyVersion: CLIP_SELECTION_POLICY_VERSION });
    const cachePath = await containedFile(prepared.root, prepared.cacheDir, `${digest}.json`);
    const job: SelectionJob = { candidate, payload, digest, cachePath, cacheRelative: relative(prepared.root, cachePath), subject: `clips-select:${digest}` };
    let cached: unknown;
    try { cached = (await jsonInput(cachePath, 1_000_000)).value; } catch (error) { if (!isMissing(error)) throw error; }
    if (cached !== undefined) {
      if (!cached || typeof cached !== 'object' || !('inputDigest' in cached) || cached.inputDigest !== digest || !('response' in cached) || !('attemptId' in cached) || typeof cached.attemptId !== 'string') {
        throw new Error(`Invalid selection cache: ${job.cacheRelative}.`);
      }
      const response = validateTypesafeResponse(cached.response, payload);
      if (ledger) {
        const attempt = await ledger.get(cached.attemptId);
        const actualUsd = response.usage.input_tokens * TYPESAFE_INPUT_PRICE_PER_MILLION / 1_000_000;
        if (!attempt || attempt.command !== 'clips-select' || attempt.subject !== job.subject ||
          attempt.planDigest !== paidPlanDigest(selectionPaidPlan(job, prepared.request.model)) ||
          attempt.state !== 'completed' || Math.abs(attempt.reservedUsd - actualUsd) > 1e-12 ||
          attempt.receipt?.requestId !== `typesafe-response:${sha256Json(response)}`) {
          throw new Error(`Cache has no completed paid evidence: ${job.cacheRelative}; reconcile the spend ledger before reuse.`);
        }
      }
      job.cached = response;
      job.attemptId = cached.attemptId;
    }
    jobs.push(job);
  }
  return jobs;
}

function evaluatedEntry(
  job: SelectionJob,
  response: TypesafeEvaluationResponse,
  attempt: PaidOperationRecord | undefined,
): ClipSelectionResultEntryV2 {
  if (!attempt || attempt.subject !== job.subject ||
    attempt.receipt?.requestId !== `typesafe-response:${sha256Json(response)}`) {
    throw new Error('Evaluation has no matching durable paid evidence.');
  }
  const evaluation = selectionEvaluation(response, job.cacheRelative);
  return ClipSelectionResultEntryV2Schema.parse({
    candidate: job.candidate, lifecycle: 'evaluated', ...routeSelectionEvaluation(evaluation),
    evaluation, attempt: ClipSelectionAttemptEvidenceSchema.parse(attempt),
    cached: Boolean(job.cached), cutStatus: 'needs_audio_video_review', approvedForPublication: false,
  });
}

function failureEntry(
  candidate: ClipSelectionCandidate,
  errorCode: string,
  attempt: PaidOperationRecord | undefined,
): ClipSelectionResultEntryV2 {
  const lifecycle = attempt ? attempt.state === 'reconciled' ? 'failed' : 'uncertain' :
    errorCode === 'BATCH_STOPPED' || errorCode === 'DEADLINE_EXCEEDED' ? 'not_evaluated' : 'failed';
  return {
    candidate, lifecycle, route: null, evaluation: null,
    reasonCodes: [lifecycle === 'uncertain' ? 'PAID_OUTCOME_UNKNOWN' :
      lifecycle === 'not_evaluated' ? 'NOT_EVALUATED' : 'EVALUATION_FAILED'],
    errorCode, attempt: attempt ? ClipSelectionAttemptEvidenceSchema.parse(attempt) : null,
    cached: false, cutStatus: 'needs_audio_video_review', approvedForPublication: false,
  };
}

function safeErrorCode(error: unknown): string {
  // Do not persist arbitrary provider/error text, which can contain credentials.
  const known: Record<string, true> = {
    INVALID_REQUEST: true, PAYLOAD_LIMIT: true, CREDENTIAL: true, HTTP: true, NETWORK: true,
    TIMEOUT: true, ABORTED: true, DEADLINE_EXCEEDED: true, INVALID_RESPONSE: true, SUBMIT_FAILED: true,
    UNRESOLVED_ATTEMPT: true, ATTEMPTS_EXHAUSTED: true, SPEND_CAP_EXCEEDED: true,
  };
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && known[error.code]) return error.code;
  return 'EVALUATION_ERROR';
}

async function executeSelection(ctx: CommandRunContext, prepared: PreparedSelection, deps: ClipSelectionDeps): Promise<ClipSelectionResultV2> {
  const capUsd = spendCapFromArgs('clips-select', ctx.args);
  const lockPath = await containedFile(prepared.root, prepared.root, '.clips-select.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch { throw new Error('clips-select is already locked. If a previous process crashed, review its spend ledger before removing .clips-select.lock.'); }
  try {
    await lock.writeFile(JSON.stringify({ command: 'clips-select', pid: process.pid, selectionDigest: prepared.selectionDigest }));
    const ledger = new FileSpendLedger(spendLedgerPath(prepared.root));
    const jobs = await selectionJobs(prepared, ledger);
    const history = await ledger.list();
    const subjects = new Set(jobs.map(job => job.subject));
    const related = history.filter(attempt => subjects.has(attempt.subject));
    const unresolved = related.find(attempt => attempt.state === 'uncertain' || attempt.state === 'submitted');
    if (unresolved) throw new Error(`Paid attempt ${unresolved.attemptId} is ${unresolved.state}; reconcile before running clips-select again.`);
    const uncached = jobs.filter(job => !job.cached);
    if (uncached.length && ctx.args.submit !== true) throw new Error('New Typesafe calls require --submit (sends transcript externally) and explicit --spend-cap.');
    const previousUsd = related.reduce((sum, attempt) => sum + attempt.reservedUsd, 0);
    const upperUsd = uncached.length * TYPESAFE_MAX_CALL_USD;
    if (uncached.length && previousUsd + upperUsd > capUsd + 1e-12) {
      throw new Error(`Spend cap $${capUsd} is below the conservative bound $${(previousUsd + upperUsd).toFixed(8)} (${uncached.length} new calls). Use --dry-run to inspect the plan.`);
    }
    for (const job of uncached) {
      if (related.some(attempt => attempt.subject === job.subject)) throw new Error(`Paid evidence exists without reusable cache for ${job.candidate.id}; restore/reconcile evidence instead of submitting again.`);
    }
    const now = deps.now ?? (() => new Date());
    const deadline = AbortSignal.timeout(prepared.request.deadlineMs);
    let evaluate = deps.evaluate;
    let credentialFailed = false;
    if (!evaluate && uncached.length) {
      // Resolve credentials before journalling any paid intent. Missing keys are
      // provably pre-submit failures, not uncertain provider charges.
      const authDeadline = AbortSignal.any([deadline, AbortSignal.timeout(prepared.request.timeoutMs)]);
      const { promise: cancelled, reject: rejectAuth } = Promise.withResolvers<never>();
      const abortAuth = () => rejectAuth(new Error('Credential lookup cancelled.'));
      authDeadline.addEventListener('abort', abortAuth, { once: true });
      if (authDeadline.aborted) abortAuth();
      let apiKey: string | undefined;
      try {
        apiKey = await Promise.race([(deps.secrets ?? createSecretSource()).getSecret('TYPE_SAFE_AI', 'run'), cancelled]);
        if (!apiKey.trim()) throw new Error('Empty key.');
      } catch {
        credentialFailed = !deadline.aborted;
        ctx.out('TYPE_SAFE_AI resolution failed or timed out; no Typesafe evaluations submitted.');
      } finally {
        authDeadline.removeEventListener('abort', abortAuth);
      }
      if (apiKey !== undefined) {
        const resolvedKey = apiKey;
        const secrets: SecretSource = { getSecret: async () => resolvedKey };
        evaluate = (payload, signal, timeoutMs) => createTypesafeEvaluator({ secrets, timeoutMs }).evaluate(payload, signal);
      }
    }
    if (uncached.length) await mkdir(prepared.cacheDir, { recursive: true, mode: 0o700 });
    const entries: ClipSelectionResultEntryV2[] = [];
    const spend: ClipSelectionSpendV2 = {
      capUsd, confirmedActualUsd: 0, historicalReservedUsd: 0, openReservedUsd: 0,
      inputTokens: 0, outputTokens: 0, newCalls: 0, cachedCalls: 0,
    };
    let stopped = false;
    for (const job of jobs) {
      if (stopped && !job.cached) { entries.push(failureEntry(job.candidate, 'BATCH_STOPPED', undefined)); continue; }
      let response = job.cached;
      let prewireErrorCode: string | undefined;
      try {
        if (response) spend.cachedCalls++;
        else {
          if (deadline.aborted) { entries.push(failureEntry(job.candidate, 'DEADLINE_EXCEEDED', undefined)); stopped = true; continue; }
          if (credentialFailed) { entries.push(failureEntry(job.candidate, 'CREDENTIAL', undefined)); stopped = true; continue; }
          const plan = selectionPaidPlan(job, prepared.request.model);
          const attemptId = randomUUID();
          job.attemptId = attemptId;
          let intentWritten = false;
          const submitStore: PaidOperationStore = {
            get: id => ledger.get(id),
            list: filter => ledger.list(filter),
            // A failed append can still have landed. Suppress core's generic
            // uncertainty only when validated on-disk evidence proves no intent.
            append: async record => {
              if (intentWritten || await ledger.get(record.attemptId)) await ledger.append(record);
            },
          };
          await submitOnce({
            store: submitStore, plan, attemptId, now,
            submit: async () => {
              // The submit gate itself awaits the ledger; recheck the deadline
              // before writing an intent or invoking the evaluator.
              if (deadline.aborted) {
                prewireErrorCode = 'DEADLINE_EXCEEDED';
                throw new Error('Deadline exceeded before submit.');
              }
              // Durable intent BEFORE network; a crash cannot erase a possible charge.
              const pending: PaidOperationRecord = {
                schemaVersion: 1, attemptId, planDigest: paidPlanDigest(plan), command: 'clips-select',
                subject: job.subject, state: 'uncertain', reservedUsd: TYPESAFE_MAX_CALL_USD, createdAt: now().toISOString(),
              };
              await ledger.append(pending);
              intentWritten = true;
              if (deadline.aborted) {
                prewireErrorCode = 'DEADLINE_EXCEEDED';
                throw new Error('Deadline exceeded after durable intent; reconcile before retry.');
              }
              spend.newCalls++;
              // Usage counters describe only responses observed in this invocation.
              response = validateTypesafeResponse(await evaluate!(job.payload, deadline, prepared.request.timeoutMs), job.payload);
              spend.inputTokens += response.usage.input_tokens;
              spend.outputTokens += response.usage.output_tokens;
              await atomicWrite(job.cachePath, `${JSON.stringify({ schemaVersion: 1, inputDigest: job.digest, attemptId, response }, null, 2)}\n`);
              // A synchronous validated response is local proof, not a fabricated provider job ID.
              return { requestId: `typesafe-response:${sha256Json(response)}` };
            },
          });
          const actualUsd = response!.usage.input_tokens * TYPESAFE_INPUT_PRICE_PER_MILLION / 1_000_000;
          // Keep the full bound while submitted. Only a durable completion may
          // replace it with the confirmed charge, including zero-token responses.
          const completionStore: PaidOperationStore = {
            get: id => ledger.get(id),
            list: filter => ledger.list(filter),
            append: completed => ledger.append({ ...completed, reservedUsd: actualUsd }),
          };
          await completeOperation(completionStore, attemptId, now);
        }
        const attempt = job.attemptId ? await ledger.get(job.attemptId) : undefined;
        entries.push(evaluatedEntry(job, response!, attempt));
      } catch (error) {
        const attempt = job.attemptId ? await ledger.get(job.attemptId) : undefined;
        // An append may throw after its atomic replacement landed. The latest
        // validated journal record, not the thrown exception, decides completion.
        if (response && attempt?.state === 'completed') {
          entries.push(evaluatedEntry(job, response, attempt));
        } else {
          entries.push(failureEntry(job.candidate, prewireErrorCode ?? safeErrorCode(error), attempt));
        }
        stopped = true; // Never continue spending after an unknown outcome.
      }
    }
    // Ledger money is selection-scoped, not invocation-scoped: completed cache
    // reuse retains historical costs, but never charges or journals them again.
    const latest = (await ledger.list()).filter(attempt => subjects.has(attempt.subject));
    const reservations = new Map<string, number>();
    for (const attempt of await ledger.history()) {
      if (subjects.has(attempt.subject)) {
        reservations.set(attempt.attemptId, Math.max(reservations.get(attempt.attemptId) ?? 0, attempt.reservedUsd));
      }
    }
    spend.historicalReservedUsd = [...reservations.values()].reduce((sum, reserve) => sum + reserve, 0);
    spend.confirmedActualUsd = latest.filter(attempt => attempt.state === 'completed')
      .reduce((sum, attempt) => sum + attempt.reservedUsd, 0);
    spend.openReservedUsd = latest.filter(attempt => attempt.state === 'uncertain' || attempt.state === 'submitted')
      .reduce((sum, attempt) => sum + attempt.reservedUsd, 0);
    const finalized = finalizeSelectionEntriesV2(entries, prepared.request.maxClips);
    const warnings = [
      'Thresholds and weights are initial editorial policy, not calibrated guarantees. Review audio/video before cutting.',
      'Candidates use contiguous segment boundaries, <=256 segments per window, one speaker, and gaps <=2s; word-level cut accuracy is not certified.',
      'Deduplication covers temporal overlap and identical text, not paraphrases at distant timestamps.',
    ];
    if (prepared.proposedCount > jobs.length) warnings.push(`Uniformly sampled ${jobs.length} of ${prepared.proposedCount} proposed windows across the source.`);
    if (!jobs.length) warnings.push('No valid candidate windows fit the requested duration and speaker continuity.');
    if (stopped) warnings.push('Evaluation stopped after an error/deadline; inspect qa/spend.json and reconcile uncertain attempts before any retry.');
    const complete = finalized.every(entry => entry.lifecycle === 'evaluated');
    const result = ClipSelectionResultV2Schema.parse({
      schemaVersion: 2, status: complete ? 'complete' : 'partial',
      provenance: complete ? 'automatic-complete' : 'automatic-partial', videoId: prepared.transcript.videoId,
      requestSha256: prepared.requestSha256, transcriptSha256: prepared.transcriptSha256,
      selectionDigest: prepared.selectionDigest, createdAt: now().toISOString(),
      rubricVersion: CLIP_SELECTION_RUBRIC_VERSION, policyVersion: CLIP_SELECTION_POLICY_VERSION,
      model: prepared.request.model, selectedIds: finalized.filter(entry => entry.route === 'suggested').map(entry => entry.candidate.id),
      reviewIds: finalized.filter(entry => entry.route === 'review').map(entry => entry.candidate.id),
      entries: finalized, warnings, spend, approvedForPublication: false,
    });
    // Keep the lock through both atomic output replacements.
    await resolveInsideProject(prepared.root, relative(prepared.root, prepared.resultPath));
    await resolveInsideProject(prepared.root, relative(prepared.root, prepared.reportPath));
    await atomicWrite(prepared.reportPath, renderSelectionReport(result));
    await atomicWrite(prepared.resultPath, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export function buildClipSelectionSpecs(deps: ClipSelectionDeps = {}): CommandSpec[] {
  const spec: CommandSpec = {
    verb: 'clips-select',
    summary: 'Selecciona ventanas de un transcript con Typesafe y escribe resultado JSON y reporte MDX; no corta ni publica.',
    args: [
      PROJECT_ARG,
      { name: 'request', kind: 'string', required: true, description: 'Solicitud JSON relativa a --project; transcript relativo a la solicitud y contenido dentro del proyecto.' },
      { name: 'submit', kind: 'boolean', default: false, description: 'Autoriza enviar el transcript a Typesafe para llamadas nuevas.' },
      { name: 'spend-cap', kind: 'number', description: 'Tope USD explícito para la selección; --spend-cap 0 permite reutilizar solo caché.' },
    ],
    paid: true, supportsPlan: true,
    writes: ['analysis/clip-selection.result.json', 'analysis/clip-selection.report.mdx', 'analysis/.clip-selection-cache/*.json', 'qa/spend.json'],
    movesGates: [],
    async plan(ctx): Promise<PlanStep[]> {
      const prepared = await prepareSelection(ctx);
      const jobs = await selectionJobs(prepared);
      const newCalls = jobs.filter(job => !job.cached).length;
      return [
        { action: `Validar solicitud y transcript; ${prepared.proposedCount} ventanas propuestas, ${jobs.length} candidatas (${jobs.length - newCalls} respuestas en caché, evidencia pendiente de validar en run).`, target: relative(prepared.root, prepared.requestPath) },
        { action: `Evaluar hasta ${newCalls} candidatas con ${prepared.request.model}; 4 Score + 2 Noul por llamada. Precio fijado: $0.042/M tokens entrada, salida gratis; reserva conservadora de 64k tokens/llamada. Requiere --submit y --spend-cap en run.`, costUsd: newCalls * TYPESAFE_MAX_CALL_USD },
        { action: 'Aplicar gates, ranking y deduplicación; guardar selección no aprobada.', writes: relative(prepared.root, prepared.resultPath) },
        { action: 'Escribir reporte MDX para revisión editorial y audiovisual.', writes: relative(prepared.root, prepared.reportPath) },
      ];
    },
    async run(ctx) {
      if (ctx.mode !== 'run') return ctx.fail('clips-select.run refuses plan mode.', 2);
      try {
        const prepared = await prepareSelection(ctx);
        const result = await executeSelection(ctx, prepared, deps);
        ctx.out(`clips-select: ${result.selectedIds.length} sugeridos, ${result.reviewIds.length} por revisar; ${result.spend.newCalls} llamadas nuevas, ${result.spend.cachedCalls} caché.`);
        ctx.out(`Resultado: ${prepared.resultPath}`);
        ctx.out(`Reporte: ${prepared.reportPath}`);
        return { exitCode: result.status === 'complete' ? 0 : 1 };
      } catch (error) {
        // Local validation/ledger errors are actionable; provider errors are caught above as stable codes.
        const message = error instanceof Error ? error.message : 'Selection failed.';
        return ctx.fail(message, 1);
      }
    },
  };
  return [spec];
}

export const clipSelectionSpecs = buildClipSelectionSpecs();
