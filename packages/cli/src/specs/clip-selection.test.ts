import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paidPlanDigest, sha256Hex, sha256Json, type PaidOperationFilter, type PaidOperationRecord } from '@videomaker/core';
import {
  ClipSelectionAttemptEvidenceSchema, ClipSelectionRequestSchema, ClipSelectionResultV2Schema,
  type ClipSelectionRequest, type ClipSelectionResultV2, type ClipSelectionTranscript,
} from '@videomaker/schemas';
import type { TypesafeEvaluationRequest, TypesafeEvaluationResponse } from '@videomaker/providers';
import { runSpecs } from '../runtime';
import { allSpecs } from '../all-specs';
import { buildClipSelectionSpecs, type ClipSelectionDeps } from './clip-selection';
import {
  buildSelectionCandidates, buildSelectionEvaluationRequest,
  TYPESAFE_INPUT_PRICE_PER_MILLION, TYPESAFE_MAX_CALL_USD,
} from '../pipeline/clip-selection';
import { buildPaidPlan, FileSpendLedger } from '../pipeline/spend-ledger';

const temporaryRoots: string[] = [];
afterEach(async () => { for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true }); });

const request: ClipSelectionRequest = ClipSelectionRequestSchema.parse({
  schemaVersion: 1, transcript: '../source/transcript.json', audience: 'Fundadores', objective: 'Aprendizajes concretos',
  maxClips: 2, duration: { minSec: 20, maxSec: 40 }, maxCandidates: 10,
});
async function fixture(empty = false): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vm-clips-select-'));
  temporaryRoots.push(root);
  await mkdir(join(root, 'analysis'));
  await mkdir(join(root, 'source'));
  await writeFile(join(root, 'analysis', 'clip-selection.request.json'), JSON.stringify(request));
  await writeFile(join(root, 'source', 'transcript.json'), JSON.stringify({
    schemaVersion: 1, videoId: 'demo', language: 'es', durationSec: 60,
    segments: empty ? [] : Array.from({ length: 3 }, (_, index) => ({ id: `s${index}`, startSec: index * 20, endSec: (index + 1) * 20, speaker: 'A', text: `Una idea útil y completa número ${index}.` })),
  }));
  return root;
}
function responseFor(payload: TypesafeEvaluationRequest): TypesafeEvaluationResponse {
  return {
    model: payload.model,
    answers: Object.fromEntries(Object.entries(payload.questions).map(([id, question]) => [id,
      question.type === 'noul' ? { type: 'noul', noul: .98 } : {
        type: 'score', score: 4, confidence: 1,
        legend: Object.fromEntries(question.criteria.map((level, index) => [String(index), level])),
        probabilities: Object.fromEntries(question.criteria.map((_, index) => [String(index), index === 4 ? 1 : 0])),
      },
    ])),
    usage: { input_tokens: 1000, output_tokens: 32 },
  };
}
async function run(root: string, deps: ClipSelectionDeps, flags: string[] = ['--submit', '--spend-cap', '1']) {
  const lines: string[] = [];
  const exitCode = await runSpecs(buildClipSelectionSpecs(deps), ['clips-select', '--project', root, '--request', 'analysis/clip-selection.request.json', ...flags], { cwd: root, out: line => { lines.push(line); } });
  return { exitCode, lines };
}
async function result(root: string): Promise<ClipSelectionResultV2> {
  return ClipSelectionResultV2Schema.parse(JSON.parse(await readFile(join(root, 'analysis', 'clip-selection.result.json'), 'utf8')));
}

async function customFixture(selectionRequest: ClipSelectionRequest, transcript: ClipSelectionTranscript): Promise<string> {
  const root = await fixture();
  await writeFile(join(root, 'analysis', 'clip-selection.request.json'), JSON.stringify(selectionRequest));
  await writeFile(join(root, 'source', 'transcript.json'), JSON.stringify(transcript));
  return root;
}

interface GoldenCacheFixture {
  root: string;
  cachePath: string;
  cacheText: string;
  attempt: PaidOperationRecord;
}

/** Frozen V1 cache bytes and digests: do not regenerate when migrating the result. */
async function goldenV1CacheFixture(): Promise<GoldenCacheFixture> {
  const selectionRequest: ClipSelectionRequest = {
    ...request, maxClips: 1, maxCandidates: 1, duration: { minSec: 20, maxSec: 20 },
  };
  const transcript: ClipSelectionTranscript = {
    schemaVersion: 1, videoId: 'golden-v1', language: 'es', durationSec: 20,
    segments: [{ id: 's0', startSec: 0, endSec: 20, speaker: 'A', text: 'Idea completa.' }],
  };
  const root = await customFixture(selectionRequest, transcript);
  const candidate = buildSelectionCandidates(transcript, selectionRequest).candidates[0];
  const payload = buildSelectionEvaluationRequest(candidate, transcript, selectionRequest);
  const response = responseFor(payload);
  const selectionDigest = sha256Json({ request: selectionRequest, transcript, rubricVersion: 1, policyVersion: 1 });
  expect(selectionDigest).toBe('6a21f7c9dc73b991010cdb5aa747807f7d086f86361a87f8f5d56f40f324c9af');
  const digest = sha256Json({ selectionDigest, candidate, payload, rubricVersion: 1, policyVersion: 1 });
  expect(digest).toBe('7a728ea2db3e65df395840ce0f0a4598721706219cb39f5f50d19f172f540d53');
  const cacheRelative = `analysis/.clip-selection-cache/${digest}.json`;
  const cachePath = join(root, cacheRelative);
  const cacheText = `${JSON.stringify({ schemaVersion: 1, inputDigest: digest, attemptId: 'golden-v1-attempt', response }, null, 2)}\n`;
  expect(sha256Hex(cacheText)).toBe('1809a8f9298e5e8ece67e619a17e9287902ecf8a4cad198f6d97bd6002cc49ea');
  const plan = buildPaidPlan({
    command: 'clips-select', subject: `clips-select:${digest}`,
    inputs: { digest, model: selectionRequest.model }, outputs: [cacheRelative],
    estimatedCostUsd: TYPESAFE_MAX_CALL_USD, spendCapUsd: TYPESAFE_MAX_CALL_USD, maxAttempts: 1,
  });
  expect(paidPlanDigest(plan)).toBe('29c3463900531f2dabcf49429b2460b0a25817ab034a7de59cd0e92c19467426');
  const pending: PaidOperationRecord = {
    schemaVersion: 1, attemptId: 'golden-v1-attempt', planDigest: paidPlanDigest(plan),
    command: 'clips-select', subject: plan.subject, state: 'uncertain',
    reservedUsd: TYPESAFE_MAX_CALL_USD, createdAt: '2026-10-02T00:00:00.000Z',
  };
  const attempt: PaidOperationRecord = {
    ...pending, state: 'completed',
    reservedUsd: response.usage.input_tokens * TYPESAFE_INPUT_PRICE_PER_MILLION / 1_000_000,
    receipt: { requestId: `typesafe-response:${sha256Json(response)}` },
  };
  const ledger = new FileSpendLedger(join(root, 'qa', 'spend.json'));
  await ledger.append(pending);
  await ledger.append({ ...attempt, state: 'submitted' });
  await ledger.append(attempt);
  await mkdir(join(root, 'analysis', '.clip-selection-cache'));
  await writeFile(cachePath, cacheText);
  return { root, cachePath, cacheText, attempt };
}

describe('clips-select declarative CLI', () => {
  test('registered once, paid, plan-safe, with no publication gates', () => {
    const matches = allSpecs().filter(spec => spec.verb === 'clips-select');
    expect(matches).toHaveLength(1);
    expect(matches[0].paid).toBe(true);
    expect(matches[0].supportsPlan).toBe(true);
    expect(matches[0].movesGates).toEqual([]);
  });
  test('dry run validates files and reports cost without evaluating or writing', async () => {
    const root = await fixture();
    const before = (await readdir(root, { recursive: true })).sort();
    let calls = 0;
    const outcome = await run(root, { evaluate: async () => { calls++; throw new Error('must stay offline'); } }, ['--dry-run']);
    expect(outcome.exitCode).toBe(0);
    expect(calls).toBe(0);
    expect(outcome.lines.join('\n')).toContain('jev-1.13.0');
    expect(outcome.lines.join('\n')).toContain('clip-selection.report.mdx');
    expect((await readdir(root, { recursive: true })).sort()).toEqual(before);
  });
  test('run refuses plan mode directly', async () => {
    const spec = buildClipSelectionSpecs()[0];
    await expect(Promise.resolve(spec.run({ args: {}, cwd: '.', mode: 'plan', out: () => {}, fail: message => { throw new Error(message); } }))).rejects.toThrow('refuses plan mode');
  });
  test('missing submit/cap and insufficient cap never reach provider', async () => {
    const root = await fixture();
    let calls = 0;
    const deps: ClipSelectionDeps = { evaluate: async payload => { calls++; return responseFor(payload); } };
    for (const flags of [[], ['--spend-cap', '1'], ['--submit', '--spend-cap', '0'], ['--submit', '--spend-cap', '0.001']]) {
      expect((await run(root, deps, flags)).exitCode).not.toBe(0);
    }
    expect(calls).toBe(0);
    expect(await Bun.file(join(root, 'qa', 'spend.json')).exists()).toBe(false);
    expect(await Bun.file(join(root, '.clips-select.lock')).exists()).toBe(false);
  });
  test('saves validated JSON/MDX and durable intent before each call; reuses cache at zero spend', async () => {
    const root = await fixture();
    let calls = 0;
    const deps: ClipSelectionDeps = { evaluate: async payload => {
      calls++;
      const ledger = JSON.parse(await readFile(join(root, 'qa', 'spend.json'), 'utf8'));
      expect(ledger.attempts.at(-1).state).toBe('uncertain');
      return responseFor(payload);
    }, now: () => new Date('2026-10-02T00:00:00.000Z') };
    expect((await run(root, deps)).exitCode).toBe(0);
    const saved = await result(root);
    expect(saved.selectedIds).toHaveLength(2);
    expect(saved.entries.some(entry => entry.route === 'duplicate')).toBe(true);
    expect(saved.entries.some(entry => entry.route === 'not_selected')).toBe(true);
    expect(saved.entries.every(entry => entry.approvedForPublication === false)).toBe(true);
    expect(saved.spend.newCalls).toBe(calls);
    expect(saved.spend.confirmedActualUsd).toBeCloseTo(calls * .000042, 10);
    expect(saved.spend.historicalReservedUsd).toBeCloseTo(calls * TYPESAFE_MAX_CALL_USD, 10);
    expect(saved.spend.openReservedUsd).toBe(0);
    expect(saved.entries.every(entry => entry.lifecycle === 'evaluated' && entry.attempt?.state === 'completed')).toBe(true);
    expect(saved.entries.every(entry => entry.evaluation?.quality === 100)).toBe(true);
    expect(await readFile(join(root, 'analysis', 'clip-selection.report.mdx'), 'utf8')).toContain('<Stats>');
    const beforeCalls = calls;
    const beforeLedger = await readFile(join(root, 'qa', 'spend.json'), 'utf8');
    const cachePaths = saved.entries.map(entry => join(root, entry.evaluation!.responsePath));
    const beforeCaches = await Promise.all(cachePaths.map(path => readFile(path, 'utf8')));
    expect((await run(root, deps, ['--spend-cap', '0'])).exitCode).toBe(0);
    const reused = await result(root);
    expect(calls).toBe(beforeCalls);
    expect(reused.spend.newCalls).toBe(0);
    expect(reused.spend.cachedCalls).toBe(saved.entries.length);
    expect(reused.spend.confirmedActualUsd).toBe(saved.spend.confirmedActualUsd);
    expect(reused.spend.historicalReservedUsd).toBe(saved.spend.historicalReservedUsd);
    expect(reused.spend.openReservedUsd).toBe(0);
    expect(reused.spend.inputTokens).toBe(0);
    expect(reused.spend.outputTokens).toBe(0);
    expect(await readFile(join(root, 'qa', 'spend.json'), 'utf8')).toBe(beforeLedger);
    expect(await Promise.all(cachePaths.map(path => readFile(path, 'utf8')))).toEqual(beforeCaches);
    expect(reused.selectedIds).toEqual(saved.selectedIds);
  });
  test('unknown outcome saves partial result, stops subsequent spend and blocks retry even with new cap', async () => {
    const root = await fixture();
    let calls = 0;
    const deps: ClipSelectionDeps = { evaluate: async () => { calls++; throw new Error('secret-provider-key-must-not-leak'); } };
    expect((await run(root, deps)).exitCode).toBe(1);
    const saved = await result(root);
    expect(saved.status).toBe('partial');
    expect(saved.selectedIds).toEqual([]);
    expect(saved.entries.every(entry => entry.evaluation === null)).toBe(true);
    expect(saved.entries[0].errorCode).toBe('SUBMIT_FAILED');
    expect(saved.entries[0].lifecycle).toBe('uncertain');
    expect(saved.entries[0].attempt?.state).toBe('uncertain');
    expect(saved.spend.openReservedUsd).toBe(TYPESAFE_MAX_CALL_USD);
    expect(saved.spend.historicalReservedUsd).toBe(TYPESAFE_MAX_CALL_USD);
    expect(saved.spend.confirmedActualUsd).toBe(0);
    expect(saved.entries.slice(1).every(entry => entry.errorCode === 'BATCH_STOPPED')).toBe(true);
    expect(saved.entries.slice(1).every(entry => entry.lifecycle === 'not_evaluated' && entry.attempt === null && entry.route === null)).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('secret-provider-key');
    expect(calls).toBe(1);
    expect((await run(root, deps, ['--submit', '--spend-cap', '5'])).exitCode).toBe(1);
    expect(calls).toBe(1);
    expect(await Bun.file(join(root, '.clips-select.lock')).exists()).toBe(false);
  });
  test('invalid response is uncertain, not low quality, and cannot be retried', async () => {
    const root = await fixture();
    const outcome = await run(root, { evaluate: async payload => ({ ...responseFor(payload), model: 'unknown' }) });
    expect(outcome.exitCode).toBe(1);
    expect((await result(root)).entries[0].evaluation).toBeNull();
    expect((await result(root)).entries[0].lifecycle).toBe('uncertain');
  });
  test('rejects malformed caches without another paid call', async () => {
    const root = await fixture();
    let calls = 0;
    const deps: ClipSelectionDeps = { evaluate: async payload => { calls++; return responseFor(payload); } };
    await run(root, deps);
    const saved = await result(root);
    const cachePath = join(root, saved.entries[0].evaluation!.responsePath);
    await writeFile(cachePath, '{"response": "tampered"}');
    const count = calls;
    expect((await run(root, deps)).exitCode).toBe(1);
    expect(calls).toBe(count);
  });
  test('changed transcript invalidates cache', async () => {
    const root = await fixture();
    let calls = 0;
    const deps: ClipSelectionDeps = { evaluate: async payload => { calls++; return responseFor(payload); } };
    await run(root, deps);
    const count = calls;
    const path = join(root, 'source', 'transcript.json');
    const source = JSON.parse(await readFile(path, 'utf8'));
    source.segments[0].text = 'Aprendizaje diferente.';
    await writeFile(path, JSON.stringify(source));
    expect((await run(root, deps)).exitCode).toBe(0);
    expect(calls).toBeGreaterThan(count);
  });
  test('empty transcript produces valid empty selection with no calls, secrets or approval', async () => {
    const root = await fixture(true);
    expect((await run(root, { evaluate: async () => { throw new Error('offline'); } }, ['--spend-cap', '0'])).exitCode).toBe(0);
    const saved = await result(root);
    expect(saved.selectedIds).toEqual([]);
    expect(saved.entries).toEqual([]);
    expect(saved.spend.newCalls).toBe(0);
    expect(saved.warnings.some(warning => warning.includes('No valid candidate'))).toBe(true);
  });
  test('project containment permits sibling source but rejects traversal and symlink escapes', async () => {
    const root = await fixture();
    const path = join(root, 'analysis', 'clip-selection.request.json');
    await writeFile(path, JSON.stringify({ ...request, transcript: '../../outside.json' }));
    expect((await run(root, {}, ['--dry-run'])).exitCode).not.toBe(0);
    const outside = await mkdtemp(join(tmpdir(), 'vm-clips-outside-'));
    temporaryRoots.push(outside);
    await symlink(outside, join(root, 'escape'));
    await writeFile(path, JSON.stringify({ ...request, transcript: '../escape/transcript.json' }));
    expect((await run(root, {}, ['--dry-run'])).exitCode).not.toBe(0);
  });
  test('preexisting process lock fails without evaluation or removal', async () => {
    const root = await fixture();
    await writeFile(join(root, '.clips-select.lock'), 'existing owner');
    expect((await run(root, { evaluate: async () => { throw new Error('must not call'); } })).exitCode).toBe(1);
    expect(await readFile(join(root, '.clips-select.lock'), 'utf8')).toBe('existing owner');
  });
  test('missing credential fails before paid intent and sanitizes resolution errors', async () => {
    const root = await fixture();
    const outcome = await run(root, { secrets: { getSecret: async () => { throw new Error('secret-must-not-leak'); } } });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.lines.join('\n')).toContain('TYPE_SAFE_AI');
    expect(outcome.lines.join('\n')).not.toContain('secret-must-not-leak');
    expect(await Bun.file(join(root, 'qa', 'spend.json')).exists()).toBe(false);
    const saved = await result(root);
    expect(saved.entries[0].lifecycle).toBe('failed');
    expect(saved.entries[0].errorCode).toBe('CREDENTIAL');
    expect(saved.entries.every(entry => entry.attempt === null && entry.route === null)).toBe(true);
    expect(saved.spend.openReservedUsd).toBe(0);
    expect(saved.spend.historicalReservedUsd).toBe(0);
  });
  test('oversized payload preflight rejects without resolving secrets or writing paid intent', async () => {
    const root = await fixture();
    await writeFile(join(root, 'analysis', 'clip-selection.request.json'), JSON.stringify({ ...request, audience: 'a'.repeat(19_000), objective: 'b'.repeat(19_000) }));
    let resolved = 0;
    const deps: ClipSelectionDeps = { secrets: { getSecret: async () => { resolved++; return 'no-network'; } } };
    expect((await run(root, deps, ['--dry-run'])).exitCode).toBe(1);
    expect((await run(root, deps)).exitCode).toBe(1);
    expect(resolved).toBe(0);
    expect(await Bun.file(join(root, 'qa', 'spend.json')).exists()).toBe(false);
  });
  test('format-only edits do not invalidate semantic cache', async () => {
    const root = await fixture();
    let calls = 0;
    const deps: ClipSelectionDeps = { evaluate: async payload => { calls++; return responseFor(payload); } };
    await run(root, deps);
    const count = calls;
    await writeFile(join(root, 'analysis', 'clip-selection.request.json'), JSON.stringify(request, null, 2));
    expect((await run(root, deps, ['--spend-cap', '0'])).exitCode).toBe(0);
    expect(calls).toBe(count);
  });
  test('run deadline stops the batch and preserves failure state', async () => {
    const root = await fixture();
    await writeFile(join(root, 'analysis', 'clip-selection.request.json'), JSON.stringify({ ...request, deadlineMs: 100 }));
    const deadline = new AbortController();
    const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    let calls = 0;
    const outcome = await run(root, { evaluate: async (_payload, signal) => {
      calls++;
      const { promise, reject } = Promise.withResolvers<TypesafeEvaluationResponse>();
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      deadline.abort();
      return promise;
    } }).finally(() => timeout.mockRestore());
    expect(outcome.exitCode).toBe(1);
    expect(calls).toBe(1);
    expect((await result(root)).status).toBe('partial');
    const saved = await result(root);
    expect(saved.entries[0].lifecycle).toBe('uncertain');
    expect(saved.entries[0].attempt?.state).toBe('uncertain');
    expect(saved.entries.slice(1).every(entry => entry.lifecycle === 'not_evaluated')).toBe(true);
    expect(saved.spend.openReservedUsd).toBe(TYPESAFE_MAX_CALL_USD);
  });

  test('500-candidate execution preserves 9 evaluated, 1 uncertain and 490 untouched; retry submits nothing', async () => {
    const selectionRequest: ClipSelectionRequest = {
      ...request, maxCandidates: 500, maxClips: 50, duration: { minSec: 20, maxSec: 20 },
    };
    const transcript: ClipSelectionTranscript = {
      schemaVersion: 1, videoId: 'offline-500', language: 'es', durationSec: 10_000,
      segments: Array.from({ length: 500 }, (_, index) => ({
        id: `s${index}`, startSec: index * 20, endSec: (index + 1) * 20,
        speaker: 'A', text: `Aprendizaje concreto y completo ${index}.`,
      })),
    };
    const root = await customFixture(selectionRequest, transcript);
    let calls = 0;
    const deps: ClipSelectionDeps = {
      evaluate: async payload => {
        calls++;
        if (calls === 10) throw new Error('offline unknown tenth outcome');
        return responseFor(payload);
      },
    };
    expect((await run(root, deps, ['--submit', '--spend-cap', '2'])).exitCode).toBe(1);
    const saved = await result(root);
    expect(saved.schemaVersion).toBe(2);
    expect(saved.provenance).toBe('automatic-partial');
    expect(saved.entries).toHaveLength(500);
    expect(saved.entries.filter(entry => entry.lifecycle === 'evaluated')).toHaveLength(9);
    expect(saved.entries.filter(entry => entry.lifecycle === 'uncertain')).toHaveLength(1);
    expect(saved.entries.filter(entry => entry.lifecycle === 'not_evaluated')).toHaveLength(490);
    expect(saved.entries.filter(entry => entry.lifecycle === 'failed')).toHaveLength(0);
    expect(saved.entries.slice(9).every(entry => entry.route === null && entry.evaluation === null)).toBe(true);
    expect(saved.entries.slice(10).every(entry => entry.attempt === null && entry.errorCode === 'BATCH_STOPPED')).toBe(true);
    expect(calls).toBe(10);
    expect(saved.spend.newCalls).toBe(10);
    expect(saved.spend.inputTokens).toBe(9_000);
    expect(saved.spend.outputTokens).toBe(288);
    expect(saved.spend.confirmedActualUsd).toBeCloseTo(9 * .000042, 12);
    expect(saved.spend.historicalReservedUsd).toBeCloseTo(10 * TYPESAFE_MAX_CALL_USD, 12);
    expect(saved.spend.openReservedUsd).toBe(TYPESAFE_MAX_CALL_USD);
    const ledger = new FileSpendLedger(join(root, 'qa', 'spend.json'));
    const latest = await ledger.list();
    expect(latest).toHaveLength(10);
    expect(latest.filter(attempt => attempt.state === 'completed')).toHaveLength(9);
    const open = latest.filter(attempt => attempt.state === 'uncertain' || attempt.state === 'submitted');
    expect(open).toHaveLength(1);
    const openAttempt = open[0];
    const savedAttempt = saved.entries[9]?.attempt;
    if (!openAttempt || !savedAttempt) throw new Error('Expected the tenth candidate to retain its open paid attempt');
    expect(openAttempt.reservedUsd).toBe(TYPESAFE_MAX_CALL_USD);
    expect(savedAttempt).toEqual(ClipSelectionAttemptEvidenceSchema.parse(openAttempt));
    const history = await ledger.history();
    expect(history.length).toBeGreaterThan(latest.length);
    expect(new Set(history.map(attempt => attempt.attemptId)).size).toBe(10);
    expect(history.reduce((sum, attempt) => sum + attempt.reservedUsd, 0)).toBeGreaterThan(saved.spend.historicalReservedUsd);
    expect(await ledger.history({ subject: openAttempt.subject, state: 'uncertain' })).toHaveLength(2);
    const ledgerBytes = await readFile(ledger.path, 'utf8');
    const resultBytes = await readFile(join(root, 'analysis', 'clip-selection.result.json'), 'utf8');
    expect((await run(root, deps, ['--submit', '--spend-cap', '5'])).exitCode).toBe(1);
    expect(calls).toBe(10);
    expect(await readFile(ledger.path, 'utf8')).toBe(ledgerBytes);
    expect(await readFile(join(root, 'analysis', 'clip-selection.result.json'), 'utf8')).toBe(resultBytes);
    expect(await ledger.get(openAttempt.attemptId)).toEqual(openAttempt);
  }, 30_000);

  test('golden V1 cache keeps the same SHA and paid plan identity while producing V2 with zero calls and ledger writes', async () => {
    const { root, cachePath, cacheText, attempt } = await goldenV1CacheFixture();
    const ledger = new FileSpendLedger(join(root, 'qa', 'spend.json'));
    const ledgerBytes = await readFile(ledger.path, 'utf8');
    let calls = 0;
    expect((await run(root, { evaluate: async () => { calls++; throw new Error('must not submit'); } }, ['--spend-cap', '0'])).exitCode).toBe(0);
    const saved = await result(root);
    expect(saved.schemaVersion).toBe(2);
    expect(saved.provenance).toBe('automatic-complete');
    expect(saved.selectionDigest).toBe('6a21f7c9dc73b991010cdb5aa747807f7d086f86361a87f8f5d56f40f324c9af');
    const cachedEntry = saved.entries[0];
    if (!cachedEntry?.attempt) throw new Error('Expected the golden cache to retain its paid attempt');
    expect(cachedEntry.cached).toBe(true);
    expect(cachedEntry.attempt).toEqual(ClipSelectionAttemptEvidenceSchema.parse(attempt));
    expect(saved.spend.newCalls).toBe(0);
    expect(saved.spend.cachedCalls).toBe(1);
    expect(saved.spend.inputTokens).toBe(0);
    expect(saved.spend.outputTokens).toBe(0);
    expect(saved.spend.confirmedActualUsd).toBe(attempt.reservedUsd);
    expect(saved.spend.historicalReservedUsd).toBe(TYPESAFE_MAX_CALL_USD);
    expect(saved.spend.openReservedUsd).toBe(0);
    expect(calls).toBe(0);
    expect(await readFile(ledger.path, 'utf8')).toBe(ledgerBytes);
    expect(await readFile(cachePath, 'utf8')).toBe(cacheText);
    expect(sha256Hex(await readFile(cachePath, 'utf8'))).toBe('1809a8f9298e5e8ece67e619a17e9287902ecf8a4cad198f6d97bd6002cc49ea');
  });

  test('deadline during credential resolution is not_evaluated with no paid evidence', async () => {
    const root = await fixture();
    await writeFile(join(root, 'analysis', 'clip-selection.request.json'), JSON.stringify({ ...request, deadlineMs: 100, timeoutMs: 1_000 }));
    const deadline = new AbortController();
    const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    let lookups = 0;
    const outcome = await run(root, { secrets: {
      getSecret: async () => { lookups++; deadline.abort(); return new Promise<string>(() => {}); },
    } }).finally(() => timeout.mockRestore());
    expect(outcome.exitCode).toBe(1);
    expect(lookups).toBe(1);
    const saved = await result(root);
    expect(saved.entries.every(entry => entry.lifecycle === 'not_evaluated' && entry.attempt === null && entry.route === null)).toBe(true);
    expect(saved.entries[0].errorCode).toBe('DEADLINE_EXCEEDED');
    expect(saved.spend.newCalls).toBe(0);
    expect(saved.spend.historicalReservedUsd).toBe(0);
    expect(saved.spend.openReservedUsd).toBe(0);
    expect(await Bun.file(join(root, 'qa', 'spend.json')).exists()).toBe(false);
  });

  test('deadline during the paid gate exits before intent and does not fabricate an uncertain attempt', async () => {
    const root = await fixture();
    await writeFile(join(root, 'analysis', 'clip-selection.request.json'), JSON.stringify({ ...request, deadlineMs: 100 }));
    const deadline = new AbortController();
    const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const list = FileSpendLedger.prototype.list;
    const delayedGate = spyOn(FileSpendLedger.prototype, 'list').mockImplementation(async function (this: FileSpendLedger, filter?: PaidOperationFilter) {
      if (filter?.planDigest !== undefined) deadline.abort();
      return list.call(this, filter);
    });
    let calls = 0;
    try {
      expect((await run(root, { evaluate: async payload => { calls++; return responseFor(payload); } })).exitCode).toBe(1);
    } finally {
      delayedGate.mockRestore();
      timeout.mockRestore();
    }
    const saved = await result(root);
    expect(calls).toBe(0);
    expect(saved.entries.every(entry => entry.lifecycle === 'not_evaluated' && entry.attempt === null)).toBe(true);
    expect(saved.entries[0].errorCode).toBe('DEADLINE_EXCEEDED');
    expect(saved.spend.newCalls).toBe(0);
    expect(saved.spend.historicalReservedUsd).toBe(0);
    expect(saved.spend.openReservedUsd).toBe(0);
    expect(await Bun.file(join(root, 'qa', 'spend.json')).exists()).toBe(false);
  });

  test('proven prewire intent-write failure is failed with no fabricated paid attempt', async () => {
    const root = await fixture();
    const failure = spyOn(FileSpendLedger.prototype, 'append').mockImplementation(async () => {
      throw new Error('offline prewire write failed');
    });
    let calls = 0;
    try {
      expect((await run(root, { evaluate: async payload => { calls++; return responseFor(payload); } })).exitCode).toBe(1);
      expect(failure).toHaveBeenCalledTimes(1);
    } finally {
      failure.mockRestore();
    }
    const saved = await result(root);
    expect(calls).toBe(0);
    expect(saved.entries[0].lifecycle).toBe('failed');
    expect(saved.entries.every(entry => entry.attempt === null && entry.route === null)).toBe(true);
    expect(saved.entries.slice(1).every(entry => entry.lifecycle === 'not_evaluated')).toBe(true);
    expect(saved.spend.newCalls).toBe(0);
    expect(saved.spend.confirmedActualUsd).toBe(0);
    expect(saved.spend.historicalReservedUsd).toBe(0);
    expect(saved.spend.openReservedUsd).toBe(0);
    expect(await Bun.file(join(root, 'qa', 'spend.json')).exists()).toBe(false);
  });

  test('durable intent append-then-throw remains uncertain and reserved even with zero evaluator calls', async () => {
    const root = await fixture();
    const append = FileSpendLedger.prototype.append;
    const failure = spyOn(FileSpendLedger.prototype, 'append').mockImplementation(async function (this: FileSpendLedger, record: PaidOperationRecord) {
      await append.call(this, record);
      throw new Error('offline error after durable append');
    });
    let calls = 0;
    try {
      expect((await run(root, { evaluate: async payload => { calls++; return responseFor(payload); } })).exitCode).toBe(1);
    } finally {
      failure.mockRestore();
    }
    const saved = await result(root);
    expect(calls).toBe(0);
    expect(saved.entries[0].lifecycle).toBe('uncertain');
    expect(saved.entries[0].attempt?.state).toBe('uncertain');
    expect(saved.entries[0].attempt?.reservedUsd).toBe(TYPESAFE_MAX_CALL_USD);
    expect(saved.entries[0].evaluation).toBeNull();
    expect(saved.entries[0].route).toBeNull();
    expect(saved.spend.newCalls).toBe(0);
    expect(saved.spend.confirmedActualUsd).toBe(0);
    expect(saved.spend.openReservedUsd).toBe(TYPESAFE_MAX_CALL_USD);
    expect(saved.spend.historicalReservedUsd).toBe(TYPESAFE_MAX_CALL_USD);
    const ledger = new FileSpendLedger(join(root, 'qa', 'spend.json'));
    const savedAttempt = saved.entries[0]?.attempt;
    if (!savedAttempt) throw new Error('Expected durable intent to retain its uncertain paid attempt');
    expect(await ledger.list()).toEqual([savedAttempt]);
    const ledgerBytes = await readFile(ledger.path, 'utf8');
    expect((await run(root, { evaluate: async payload => { calls++; return responseFor(payload); } })).exitCode).toBe(1);
    expect(calls).toBe(0);
    expect(await readFile(ledger.path, 'utf8')).toBe(ledgerBytes);
    expect((await ledger.list())[0].state).toBe('uncertain');
  });

  test('deadline after durable intent but before evaluator preserves the existing open reservation', async () => {
    const root = await fixture();
    const deadline = new AbortController();
    const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const append = FileSpendLedger.prototype.append;
    const abortAfterIntent = spyOn(FileSpendLedger.prototype, 'append').mockImplementation(async function (this: FileSpendLedger, record: PaidOperationRecord) {
      await append.call(this, record);
      deadline.abort();
    });
    let calls = 0;
    try {
      expect((await run(root, { evaluate: async payload => { calls++; return responseFor(payload); } })).exitCode).toBe(1);
    } finally {
      abortAfterIntent.mockRestore();
      timeout.mockRestore();
    }
    const saved = await result(root);
    expect(calls).toBe(0);
    expect(saved.entries[0].lifecycle).toBe('uncertain');
    expect(saved.entries[0].errorCode).toBe('DEADLINE_EXCEEDED');
    expect(saved.entries[0].attempt?.reservedUsd).toBe(TYPESAFE_MAX_CALL_USD);
    expect(saved.entries.slice(1).every(entry => entry.lifecycle === 'not_evaluated' && entry.attempt === null)).toBe(true);
    expect(saved.spend.newCalls).toBe(0);
    expect(saved.spend.openReservedUsd).toBe(TYPESAFE_MAX_CALL_USD);
    expect(saved.spend.historicalReservedUsd).toBe(TYPESAFE_MAX_CALL_USD);
    const ledger = new FileSpendLedger(join(root, 'qa', 'spend.json'));
    const savedAttempt = saved.entries[0]?.attempt;
    if (!savedAttempt) throw new Error('Expected the deadline to retain its open paid attempt');
    expect(await ledger.list()).toEqual([savedAttempt]);
    const ledgerBytes = await readFile(ledger.path, 'utf8');
    expect((await run(root, { evaluate: async payload => { calls++; return responseFor(payload); } })).exitCode).toBe(1);
    expect(calls).toBe(0);
    expect(await readFile(ledger.path, 'utf8')).toBe(ledgerBytes);
  });

  test('validated response with a failed cache replacement stays uncertain and unranked', async () => {
    const root = await fixture();
    let calls = 0;
    const deps: ClipSelectionDeps = { evaluate: async payload => {
      calls++;
      const pending = (await new FileSpendLedger(join(root, 'qa', 'spend.json')).list())[0];
      await mkdir(join(root, 'analysis', '.clip-selection-cache', `${pending.subject.slice('clips-select:'.length)}.json`));
      return responseFor(payload);
    } };
    expect((await run(root, deps)).exitCode).toBe(1);
    const saved = await result(root);
    expect(saved.entries[0].lifecycle).toBe('uncertain');
    expect(saved.entries[0].evaluation).toBeNull();
    expect(saved.entries[0].route).toBeNull();
    expect(saved.entries[0].attempt?.reservedUsd).toBe(TYPESAFE_MAX_CALL_USD);
    expect(saved.selectedIds).toEqual([]);
    expect(saved.spend.inputTokens).toBe(1_000);
    expect(saved.spend.confirmedActualUsd).toBe(0);
    expect(saved.spend.openReservedUsd).toBe(TYPESAFE_MAX_CALL_USD);
    const ledgerBytes = await readFile(join(root, 'qa', 'spend.json'), 'utf8');
    expect((await run(root, deps)).exitCode).toBe(1);
    expect(calls).toBe(1);
    expect(await readFile(join(root, 'qa', 'spend.json'), 'utf8')).toBe(ledgerBytes);
  });

  test('completion write failure retains the submitted bound even after a validated zero-token response', async () => {
    const root = await fixture();
    const append = FileSpendLedger.prototype.append;
    const failure = spyOn(FileSpendLedger.prototype, 'append').mockImplementation(async function (this: FileSpendLedger, record: PaidOperationRecord) {
      if (record.state === 'completed') throw new Error('offline completion write failed');
      await append.call(this, record);
    });
    let calls = 0;
    try {
      expect((await run(root, { evaluate: async payload => {
        calls++;
        return { ...responseFor(payload), usage: { input_tokens: 0, output_tokens: 32 } };
      } })).exitCode).toBe(1);
    } finally {
      failure.mockRestore();
    }
    const saved = await result(root);
    expect(saved.entries[0].lifecycle).toBe('uncertain');
    expect(saved.entries[0].attempt?.state).toBe('submitted');
    expect(saved.entries[0].attempt?.receipt).toBeDefined();
    expect(saved.entries[0].attempt?.reservedUsd).toBe(TYPESAFE_MAX_CALL_USD);
    expect(saved.entries[0].evaluation).toBeNull();
    expect(saved.entries[0].route).toBeNull();
    expect(saved.spend.confirmedActualUsd).toBe(0);
    expect(saved.spend.openReservedUsd).toBe(TYPESAFE_MAX_CALL_USD);
    expect(ClipSelectionResultV2Schema.safeParse({
      ...saved, spend: { ...saved.spend, openReservedUsd: 0 },
    }).success).toBe(false);
    expect(ClipSelectionResultV2Schema.safeParse({
      ...saved, entries: [{ ...saved.entries[0], lifecycle: 'failed' }, ...saved.entries.slice(1)],
    }).success).toBe(false);
    const ledgerBytes = await readFile(join(root, 'qa', 'spend.json'), 'utf8');
    expect((await run(root, { evaluate: async () => { calls++; throw new Error('must not retry'); } })).exitCode).toBe(1);
    expect(calls).toBe(1);
    expect(await readFile(join(root, 'qa', 'spend.json'), 'utf8')).toBe(ledgerBytes);
  });

  test('completion append-then-throw uses the validated durable completed proof, not a fabricated uncertain outcome', async () => {
    const root = await fixture();
    const append = FileSpendLedger.prototype.append;
    const failure = spyOn(FileSpendLedger.prototype, 'append').mockImplementation(async function (this: FileSpendLedger, record: PaidOperationRecord) {
      await append.call(this, record);
      if (record.state === 'completed') throw new Error('offline error after completed write');
    });
    let calls = 0;
    try {
      expect((await run(root, { evaluate: async payload => { calls++; return responseFor(payload); } })).exitCode).toBe(1);
    } finally {
      failure.mockRestore();
    }
    const saved = await result(root);
    expect(calls).toBe(1);
    expect(saved.entries[0].lifecycle).toBe('evaluated');
    expect(saved.entries[0].attempt?.state).toBe('completed');
    expect(saved.entries[0].evaluation?.quality).toBe(100);
    expect(saved.entries.slice(1).every(entry => entry.lifecycle === 'not_evaluated')).toBe(true);
    expect(saved.spend.confirmedActualUsd).toBeCloseTo(.000042, 12);
    expect(saved.spend.openReservedUsd).toBe(0);
    expect(saved.spend.historicalReservedUsd).toBe(TYPESAFE_MAX_CALL_USD);
    const savedAttempt = saved.entries[0]?.attempt;
    const completedAttempt = (await new FileSpendLedger(join(root, 'qa', 'spend.json')).list())[0];
    if (!savedAttempt || !completedAttempt) throw new Error('Expected the validated durable completed paid attempt');
    expect(completedAttempt).toEqual(savedAttempt);
  });

  test('paid evidence without reusable cache, wrong paid bounds, and invalid cached usage never submit again', async () => {
    for (const corruption of ['missing', 'wrong-cost', 'invalid-usage'] as const) {
      const { root, cachePath, cacheText, attempt } = await goldenV1CacheFixture();
      const ledger = new FileSpendLedger(join(root, 'qa', 'spend.json'));
      if (corruption === 'missing') await rm(cachePath);
      if (corruption === 'wrong-cost') await ledger.append({ ...attempt, reservedUsd: TYPESAFE_MAX_CALL_USD * 2 });
      if (corruption === 'invalid-usage') {
        const cache = JSON.parse(cacheText);
        cache.response.usage.input_tokens = 64_001;
        await writeFile(cachePath, JSON.stringify(cache));
      }
      const ledgerBytes = await readFile(ledger.path, 'utf8');
      let calls = 0;
      expect((await run(root, { evaluate: async payload => { calls++; return responseFor(payload); } })).exitCode).toBe(1);
      expect(calls).toBe(0);
      expect(await readFile(ledger.path, 'utf8')).toBe(ledgerBytes);
    }
  });

  test('selection spend ignores unrelated completed and open ledger attempts without altering them', async () => {
    const { root, attempt } = await goldenV1CacheFixture();
    const ledger = new FileSpendLedger(join(root, 'qa', 'spend.json'));
    const unrelated: PaidOperationRecord = {
      ...attempt, attemptId: 'unrelated-completed', subject: 'clips-select:unrelated-selection',
      reservedUsd: 10,
    };
    await ledger.append(unrelated);
    await ledger.append({
      ...unrelated, attemptId: 'unrelated-open', state: 'uncertain',
      reservedUsd: 15, receipt: undefined,
    });
    const ledgerBytes = await readFile(ledger.path, 'utf8');
    expect((await run(root, { evaluate: async () => { throw new Error('must not submit'); } }, ['--spend-cap', '0'])).exitCode).toBe(0);
    const saved = await result(root);
    expect(saved.spend.confirmedActualUsd).toBe(attempt.reservedUsd);
    expect(saved.spend.historicalReservedUsd).toBe(TYPESAFE_MAX_CALL_USD);
    expect(saved.spend.openReservedUsd).toBe(0);
    expect(await readFile(ledger.path, 'utf8')).toBe(ledgerBytes);
    expect((await ledger.get('unrelated-open'))?.state).toBe('uncertain');
  });
});
