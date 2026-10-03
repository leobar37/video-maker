import { describe, expect, test } from 'bun:test';
import { sha256Json } from '@videomaker/core';
import {
  ClipSelectionRequestSchema, ClipSelectionTranscriptSchema, ClipSelectionResultSchema,
  ClipSelectionResultEntryV2Schema, ClipSelectionResultV2Schema, SCHEMA_VERSIONS,
  type ClipSelectionEvaluation, type ClipSelectionResultEntry, type ClipSelectionResultEntryV2,
  type ClipSelectionResultV2,
} from '@videomaker/schemas';
import {
  buildSelectionCandidates, buildSelectionEvaluationRequest, finalizeSelectionEntries,
  finalizeSelectionEntriesV2, renderSelectionReport, routeSelectionEvaluation,
} from './clip-selection';

const request = ClipSelectionRequestSchema.parse({ schemaVersion: 1, transcript: 'transcript.json', audience: 'Fundadores', objective: 'Aprendizajes', maxClips: 3, duration: { minSec: 20, maxSec: 40 } });
const transcript = ClipSelectionTranscriptSchema.parse({ schemaVersion: 1, videoId: 'demo', language: 'es', durationSec: 200, segments: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, startSec: i * 20, endSec: i * 20 + 20, speaker: 'A', text: `Frase completa número ${i}.` })) });
const evaluation: ClipSelectionEvaluation = {
  quality: 95, minScoreConfidence: .91, signals: { hook: 95, value: 95, autonomy: 95, closure: 95 },
  gates: { standalone: .98, faithful: .98 }, model: 'jev-1.13.0',
  usage: { input_tokens: 100, output_tokens: 20 }, responseSha256: 'a'.repeat(64), responsePath: 'cache/response.json',
};
function entry(id: string, start: number, end: number, quality: number): ClipSelectionResultEntry {
  return { candidate: { id, sourceRange: { startSec: start, endSec: end }, sourceSegments: [id], speaker: 'A', text: `Texto ${id}.` }, evaluation: { ...evaluation, quality }, route: 'suggested', reasonCodes: [], cached: false, cutStatus: 'needs_audio_video_review', approvedForPublication: false };
}

function entryV2(id: string, start: number, end: number, quality: number): ClipSelectionResultEntryV2 {
  return ClipSelectionResultEntryV2Schema.parse({
    ...entry(id, start, end, quality), lifecycle: 'evaluated',
    attempt: {
      schemaVersion: 1, attemptId: `attempt-${id}`, planDigest: 'c'.repeat(64), command: 'clips-select',
      subject: id, state: 'completed', reservedUsd: .0000042, createdAt: '2026-10-02T00:00:00.000Z',
      receipt: { requestId: `request-${id}`, statusUrl: `https://example.invalid/status/${id}`, responseUrl: `https://example.invalid/response/${id}` },
    },
  });
}

function pendingEntry(id: string, lifecycle: 'not_evaluated' | 'failed' | 'uncertain'): ClipSelectionResultEntryV2 {
  return ClipSelectionResultEntryV2Schema.parse({
    ...entry(id, 1000, 1020, 95), lifecycle, route: null, evaluation: null,
    reasonCodes: [lifecycle === 'uncertain' ? 'PROVIDER_OUTCOME_UNKNOWN' : 'LOCAL_EVALUATION_UNAVAILABLE'],
    attempt: lifecycle === 'uncertain' ? {
      schemaVersion: 1, attemptId: `attempt-${id}`, planDigest: 'c'.repeat(64), command: 'clips-select',
      subject: id, state: 'uncertain', reservedUsd: .002688, createdAt: '2026-10-02T00:00:00.000Z',
    } : null,
  });
}

function partialResult(): ClipSelectionResultV2 {
  const evaluated = Array.from({ length: 9 }, (_, index) => {
    const value = entryV2(`evaluated-${index}`, index * 30, index * 30 + 20, 95 - index);
    value.route = index < 4 ? 'suggested' : index < 6 ? 'review' : 'rejected';
    value.cached = index < 4;
    return value;
  });
  const entries = finalizeSelectionEntriesV2([
    ...evaluated, pendingEntry('unknown', 'uncertain'),
    ...Array.from({ length: 490 }, (_, index) => pendingEntry(`pending-${index}`, 'not_evaluated')),
  ], 2);
  return ClipSelectionResultV2Schema.parse({
    schemaVersion: 2, status: 'partial', provenance: 'automatic-partial', videoId: 'partial-demo',
    requestSha256: 'a'.repeat(64), transcriptSha256: 'b'.repeat(64), selectionDigest: 'c'.repeat(64),
    createdAt: '2026-10-02T00:00:00.000Z', rubricVersion: 1, policyVersion: 1, model: 'jev-1.13.0',
    selectedIds: entries.filter(value => value.route === 'suggested').map(value => value.candidate.id),
    reviewIds: entries.filter(value => value.route === 'review').map(value => value.candidate.id),
    entries, warnings: [], approvedForPublication: false,
    spend: { capUsd: 1, confirmedActualUsd: .0000378, openReservedUsd: .002688, historicalReservedUsd: .02688, inputTokens: 500, outputTokens: 100, newCalls: 6, cachedCalls: 4 },
  });
}

describe('clip selection editorial engine', () => {
  test('bounded contiguous windows preserve literal segments and source clock', () => {
    const result = buildSelectionCandidates(transcript, request);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates).toEqual(buildSelectionCandidates(transcript, request).candidates);
    for (const candidate of result.candidates) {
      const duration = candidate.sourceRange.endSec - candidate.sourceRange.startSec;
      expect(duration).toBeGreaterThanOrEqual(20);
      expect(duration).toBeLessThanOrEqual(40);
      expect(candidate.text).toBe(transcript.segments.filter(segment => candidate.sourceSegments.includes(segment.id)).map(segment => segment.text).join(' '));
    }
  });
  test('uniform sampling covers source, not just the first minute', () => {
    const result = buildSelectionCandidates(transcript, { ...request, maxCandidates: 3 });
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[2].sourceRange.startSec).toBeGreaterThanOrEqual(120);
    expect(new Set(result.candidates.map(candidate => candidate.id)).size).toBe(3);
  });
  test('speaker changes and gaps never produce a crossing window', () => {
    const changed = structuredClone(transcript);
    changed.segments[1].speaker = 'B';
    const result = buildSelectionCandidates(changed, request);
    expect(result.candidates.some(candidate => candidate.sourceSegments.includes('s0') && candidate.sourceSegments.includes('s1'))).toBe(false);
    changed.segments[1].speaker = 'A';
    changed.segments[1].startSec = 23;
    expect(buildSelectionCandidates(changed, request).candidates.some(candidate => candidate.sourceSegments.includes('s0') && candidate.sourceSegments.includes('s1'))).toBe(false);
  });
  test('empty transcripts and unsatisfiable durations return no candidates', () => {
    expect(buildSelectionCandidates({ ...transcript, segments: [] }, request).candidates).toEqual([]);
    expect(buildSelectionCandidates(transcript, { ...request, duration: { minSec: 300, maxSec: 400 } }).candidates).toEqual([]);
  });
  test('payload distinguishes quoted clip from bounded context and asks six atomic questions', () => {
    const candidate = buildSelectionCandidates(transcript, request).candidates[3];
    const payload = buildSelectionEvaluationRequest(candidate, transcript, request);
    expect(payload.state.clip).toBe(candidate.text);
    expect(Object.keys(payload.questions)).toHaveLength(6);
    expect(payload.questions.hook.instructions).toContain('untrusted quoted data');
    expect(payload.questions.autonomy.instructions).toContain('without contextBefore');
    expect(payload.questions.faithful.instructions).toContain('conditions and negations');
  });
  test('comedy mode evaluates entertainment and punchlines instead of educational learning', () => {
    const candidate = buildSelectionCandidates(transcript, request).candidates[0];
    const payload = buildSelectionEvaluationRequest(candidate, transcript, { ...request, contentType: 'comedy' });
    expect(payload.state.contentType).toBe('comedy');
    expect(payload.questions.value.instructions).toContain('entertainment value');
    expect(payload.questions.value.instructions).toContain('Do not require educational');
    expect(payload.questions.closure.instructions).toContain('punchline');
    expect(payload.questions.standalone.type).toBe('noul');
    expect(buildSelectionEvaluationRequest(candidate, transcript, request).questions.value.instructions).toContain('useful learning');
  });
  test('gates cannot be offset by strong quality; uncertainty is review', () => {
    expect(routeSelectionEvaluation(evaluation).route).toBe('suggested');
    expect(routeSelectionEvaluation({ ...evaluation, gates: { standalone: .20, faithful: 1 } }).route).toBe('rejected');
    expect(routeSelectionEvaluation({ ...evaluation, gates: { standalone: 1, faithful: .10 } }).reasonCodes).toContain('CONTEXT_DISTORTION');
    expect(routeSelectionEvaluation({ ...evaluation, gates: { standalone: .71, faithful: 1 } }).route).toBe('review');
    expect(routeSelectionEvaluation({ ...evaluation, minScoreConfidence: .58 }).route).toBe('review');
    expect(routeSelectionEvaluation({ ...evaluation, quality: 40 }).route).toBe('rejected');
  });
  test('ranking is stable, dedups at overlap >50%, honors K and does not mutate inputs', () => {
    const input = [entry('later', 100, 130, 90), entry('best', 0, 32, 95), entry('dupe', 8, 44, 92), entry('third', 200, 230, 80)];
    const result = finalizeSelectionEntries(input, 2);
    expect(result.filter(value => value.route === 'suggested').map(value => value.candidate.id)).toEqual(['best', 'later']);
    expect(result.find(value => value.candidate.id === 'dupe')?.duplicateOf).toBe('best');
    expect(result.find(value => value.candidate.id === 'third')?.route).toBe('not_selected');
    expect(input.every(value => value.route === 'suggested')).toBe(true);
    expect(finalizeSelectionEntries([entry('b', 60, 80, 90), entry('a', 0, 20, 90)], 2)[0].candidate.id).toBe('a');
  });
  test('reports escape transcript MDX/HTML and never turn suggestions into approval', () => {
    const e = entry('safe', 0, 20, 95);
    e.candidate.text = '<script>alert(1)</script> <Stat value="999" /> {secret} [click](javascript:bad)';
    const report = renderSelectionReport({
      schemaVersion: 1, status: 'complete', videoId: '<img src=x>', requestSha256: 'a'.repeat(64), transcriptSha256: 'b'.repeat(64),
      selectionDigest: 'c'.repeat(64), createdAt: '2026-10-02T00:00:00.000Z', rubricVersion: 1, policyVersion: 1, model: 'jev-1.13.0',
      selectedIds: ['safe'], reviewIds: [], entries: [e], warnings: [],
      spend: { capUsd: 1, reservedUsd: .002688, actualUsd: .0000042, inputTokens: 100, outputTokens: 20, newCalls: 1, cachedCalls: 0 }, approvedForPublication: false,
    });
    expect(report).not.toContain('<script>');
    expect(report).not.toContain('<Stat value="999"');
    expect(report).not.toContain('{secret}');
    expect(report).toContain('&lt;script&gt;');
    expect(report).toContain('Ningún clip está aprobado');
  });
  test('request payload, identities and uniform sample windows retain their golden digests', () => {
    const sample = buildSelectionCandidates(transcript, { ...request, maxCandidates: 3 });
    expect(sample.proposedCount).toBe(19);
    expect(sample.candidates).toEqual([
      { id: 'candidate-2-3', sourceRange: { startSec: 20, endSec: 60 }, sourceSegments: ['s1', 's2'], speaker: 'A', text: 'Frase completa número 1. Frase completa número 2.' },
      { id: 'candidate-5-6', sourceRange: { startSec: 80, endSec: 120 }, sourceSegments: ['s4', 's5'], speaker: 'A', text: 'Frase completa número 4. Frase completa número 5.' },
      { id: 'candidate-8-9', sourceRange: { startSec: 140, endSec: 180 }, sourceSegments: ['s7', 's8'], speaker: 'A', text: 'Frase completa número 7. Frase completa número 8.' },
    ]);
    expect(sha256Json(sample.candidates)).toBe('ac583f4748a5b0c3266c2aa84114756267c409a7c364a74b24042ff40d122111');
    expect(sha256Json(request)).toBe('07ca6f77b259d4c2bfae63492161e5acd002ff84caba6e41030f27a6ecd60f34');
    const payload = buildSelectionEvaluationRequest(sample.candidates[0], transcript, request);
    expect(payload.state).toEqual({
      audience: 'Fundadores', objective: 'Aprendizajes', language: 'es', contentType: 'educational',
      clip: 'Frase completa número 1. Frase completa número 2.', contextBefore: 'Frase completa número 0.',
      contextAfter: 'Frase completa número 3. Frase completa número 4.',
    });
    expect(sha256Json(payload)).toBe('5538cfe91d2e89cb45a9450a0f754f1cd14d61865f5695cbed54be48077ec7b3');
  });
});

// DO_NOT_RUN during delegated edits: the orchestrator owns the final offline gates.
describe('clip selection V2 ranking and readable versioned evidence', () => {
  test('only valid evaluated entries rank; every other lifecycle and attempt stays unchanged', () => {
    const suggested = entryV2('best', 0, 20, 95);
    const failed = pendingEntry('failed', 'failed');
    failed.attempt = {
      schemaVersion: 1, attemptId: 'attempt-failed', planDigest: 'c'.repeat(64), command: 'clips-select',
      subject: 'failed', state: 'reconciled', reservedUsd: .002688, createdAt: '2026-10-02T00:00:00.000Z',
      reconciliation: { by: 'operator', at: '2026-10-02T01:00:00.000Z', evidence: 'Provider confirmed no submit; original reservation retained as evidence.' },
    };
    const input = Object.freeze([
      pendingEntry('unknown', 'uncertain'), pendingEntry('pending', 'not_evaluated'), failed, suggested,
    ]);
    const snapshot = structuredClone(input);
    const result = finalizeSelectionEntriesV2(input, 1);
    expect(result.filter(value => value.route === 'suggested').map(value => value.candidate.id)).toEqual(['best']);
    expect(result[0].candidate.id).toBe('best');
    for (const original of input) {
      const finalized = result.find(value => value.candidate.id === original.candidate.id);
      expect(finalized?.lifecycle).toBe(original.lifecycle);
      expect(finalized?.attempt).toEqual(original.attempt);
      if (original.lifecycle !== 'evaluated') expect(finalized).toEqual(original);
    }
    expect(input).toEqual(snapshot);
    expect(() => finalizeSelectionEntriesV2([{ ...suggested, evaluation: null }], 1)).toThrow();
    expect(() => finalizeSelectionEntriesV2([{ ...pendingEntry('invalid', 'not_evaluated'), route: 'suggested' }], 1)).toThrow();
  });

  test('V2 ranking retains V1 tie breaks, overlap/text dedup and clip limit without rewriting paid evidence', () => {
    const input = [
      entryV2('later', 100, 130, 90), entryV2('best', 0, 32, 95),
      entryV2('dupe', 8, 44, 92), entryV2('third', 200, 230, 80),
    ];
    input[0].cached = true;
    input[0].attempt = {
      ...input[0].attempt!,
      state: 'reconciled',
      reconciliation: { by: 'operator', at: '2026-10-02T01:00:00.000Z', evidence: 'Original receipt independently verified.' },
    };
    const snapshot = structuredClone(input);
    const result = finalizeSelectionEntriesV2(input, 2);
    expect(result.filter(value => value.route === 'suggested').map(value => value.candidate.id)).toEqual(['best', 'later']);
    expect(result.find(value => value.candidate.id === 'dupe')?.duplicateOf).toBe('best');
    expect(result.find(value => value.candidate.id === 'third')?.route).toBe('not_selected');
    for (const value of result) {
      const original = input.find(other => other.candidate.id === value.candidate.id);
      if (!original) throw new Error(`Missing original fixture for candidate ${value.candidate.id}`);
      expect(value.attempt).toEqual(original.attempt);
      expect(value.lifecycle).toBe(original.lifecycle);
      expect(value.cached).toBe(original.cached);
    }
    expect(input).toEqual(snapshot);
    expect(result.map(value => [value.candidate.id, value.route, value.reasonCodes, value.duplicateOf])).toEqual(
      finalizeSelectionEntries(input.map(value => entry(value.candidate.id, value.candidate.sourceRange.startSec, value.candidate.sourceRange.endSec, value.evaluation!.quality)), 2)
        .map(value => [value.candidate.id, value.route, value.reasonCodes, value.duplicateOf]),
    );
    expect(finalizeSelectionEntriesV2([entryV2('b', 60, 80, 90), entryV2('a', 0, 20, 90)], 2)[0].candidate.id).toBe('a');
    expect(finalizeSelectionEntriesV2([entryV2('b', 0, 20, 90), entryV2('a', 0, 20, 90)], 2)[0].candidate.id).toBe('a');
    expect(finalizeSelectionEntriesV2([entryV2('long', 0, 30, 90), entryV2('short', 0, 20, 90)], 2)[0].candidate.id).toBe('short');
    expect(finalizeSelectionEntriesV2([entryV2('a', 0, 20, 90), entryV2('b', 10, 30, 90)], 2).every(value => value.route === 'suggested')).toBe(true);
    const repeated = entryV2('repeated', 200, 220, 90);
    repeated.candidate.text = '  TEXTO a.  ';
    expect(finalizeSelectionEntriesV2([entryV2('a', 0, 20, 95), repeated], 2)[1].duplicateOf).toBe('a');
    expect(finalizeSelectionEntriesV2([entryV2('a', 0, 20, 95)], 0)[0].route).toBe('not_selected');
  });

  test('500-row partial report separates nine valid, one uncertain and 490 not evaluated from editorial routes', () => {
    const result = partialResult();
    const report = renderSelectionReport(result);
    expect(report).toContain('<Stat value="500" label="Candidatos" />');
    expect(report).toContain('Evaluados válidos (evaluated): **9**');
    expect(report).toContain('Resultado incierto (uncertain): **1**');
    expect(report).toContain('No evaluados (not_evaluated): **490**');
    expect(report).toContain('Fallidos confirmados (failed): **0**');
    expect(report).toContain('<Stat value="2" label="Sugeridos" />');
    expect(report).toContain('<Stat value="2" label="Por revisar" />');
    expect(report.split('\n').filter(line => /^\| (?:evaluated-|unknown |pending-)/.test(line))).toHaveLength(500);
    expect(report).toContain('**Procedencia:** automatic-partial');
    expect(report).toContain('Ruta editorial');
    expect(report).toContain('cargo final sigue desconocido');
    expect(report).toContain('approvedForPublication: false');
    expect(report).toContain('La IA no garantiza viralidad');
  });

  test('report scopes confirmed, still-open and historical money independently and includes cached payment evidence', () => {
    const result = partialResult();
    const report = renderSelectionReport(result);
    expect(report).toContain('Cargos confirmados (confirmedActualUsd): **$0.00003780**');
    expect(report).toContain('Reserva actualmente retenida (openReservedUsd): **$0.00268800**');
    expect(report).toContain('Reservas históricas (historicalReservedUsd): **$0.02688000**');
    expect(report).toContain('no son fondos actualmente retenidos');
    expect(report).toContain('incluidos los intentos reutilizados de caché y los nuevos');
    expect(report).toContain('Llamadas de esta ejecución: nuevas 6; reutilizadas de caché 4');
    expect(report).toContain('no se vuelven a contar los de caché): 500 entrada / 100 salida');
    expect(report).toContain('Los intentos inciertos no se contabilizan como cargo cero');
    expect(report).toContain('attempt-unknown: uncertain');
    expect(report).toContain('attempt-evaluated-0: completed');
    expect(report).toContain('reservedUsd del último estado');
    expect(report).toContain('No es necesariamente la reserva histórica original del intento');
    expect(renderSelectionReport(ClipSelectionResultV2Schema.parse({ ...result, provenance: 'editorial-local' }))).toContain('**Procedencia:** editorial-local');
    const cacheOnly = ClipSelectionResultV2Schema.parse({
      ...result, spend: { ...result.spend, inputTokens: 0, outputTokens: 0, newCalls: 0, cachedCalls: 9 },
      entries: result.entries.map(value => ({ ...value, cached: value.lifecycle === 'evaluated' })),
    });
    const cacheReport = renderSelectionReport(cacheOnly);
    expect(cacheReport).toContain('Cargos confirmados (confirmedActualUsd): **$0.00003780**');
    expect(cacheReport).toContain('Llamadas de esta ejecución: nuevas 0; reutilizadas de caché 9');
    expect(cacheReport).toContain('no se vuelven a contar los de caché): 0 entrada / 0 salida');
  });

  test('complete automatic provenance remains distinct from local or partial selection', () => {
    const entries = [entryV2('complete', 0, 20, 95)];
    const result = ClipSelectionResultV2Schema.parse({
      ...partialResult(), entries, status: 'complete', provenance: 'automatic-complete',
      selectedIds: ['complete'], reviewIds: [],
      spend: { capUsd: 1, confirmedActualUsd: .0000042, historicalReservedUsd: .002688, openReservedUsd: 0, inputTokens: 100, outputTokens: 20, newCalls: 1, cachedCalls: 0 },
    });
    const report = renderSelectionReport(result);
    expect(report).toContain('**Procedencia:** automatic-complete');
    expect(report).toContain('Evaluados válidos (evaluated): **1**');
    expect(report).toContain('Reserva actualmente retenida (openReservedUsd): **$0.00000000**');
    expect(report).toContain('Cargos confirmados (confirmedActualUsd): **$0.00000420**');
  });

  test('V1 documents remain readable as ambiguous legacy evidence, with no invented V2 lifecycle or accounting', () => {
    const legacy = {
      schemaVersion: 1, status: 'partial', videoId: 'old-demo', requestSha256: 'a'.repeat(64), transcriptSha256: 'b'.repeat(64),
      selectionDigest: 'c'.repeat(64), createdAt: '2026-10-02T00:00:00.000Z', rubricVersion: 1, policyVersion: 1, model: 'jev-1.13.0',
      selectedIds: ['old'], reviewIds: [], entries: [
        entry('old', 0, 20, 95),
        { ...entry('legacy-failure', 30, 50, 95), route: 'evaluation_failed', evaluation: null, reasonCodes: ['LEGACY_PROVIDER_ERROR'] },
      ], warnings: [],
      spend: { capUsd: 1, reservedUsd: .002688, actualUsd: .0000042, inputTokens: 100, outputTokens: 20, newCalls: 1, cachedCalls: 0 },
      approvedForPublication: false,
    };
    const parsed = ClipSelectionResultSchema.parse(legacy);
    const snapshot = structuredClone(parsed);
    const report = renderSelectionReport(parsed);
    expect(parsed.schemaVersion).toBe(1);
    expect(report).toContain('Artefacto legado V1');
    expect(report).toContain('Evidencia ambigua');
    expect(report).toContain('evaluation&#95;failed');
    expect(report).toContain('actualUsd $0.00000420; reservedUsd $0.00268800');
    expect(report).not.toContain('Evaluados válidos (evaluated)');
    expect(report).not.toContain('confirmedActualUsd');
    expect(report).not.toContain('automatic-partial');
    expect(parsed).toEqual(snapshot);
    expect(SCHEMA_VERSIONS.clipSelectionResult).toBe(2);
    expect(ClipSelectionResultSchema.parse(partialResult()).schemaVersion).toBe(2);
  });

  test('untrusted V2 IDs, transcript, reasons, errors and warnings cannot execute MDX or break tables', () => {
    const result = partialResult();
    const payload = '<script>alert(1)</script> <Stat value="999" /> {secret} [click](javascript:bad) | `raw` \\\\{danger}\nimport Evil from "evil"';
    const suggested = result.entries.find(value => value.route === 'suggested')!;
    const previousId = suggested.candidate.id;
    suggested.candidate.id = payload;
    result.selectedIds = result.selectedIds.map(id => id === previousId ? payload : id);
    suggested.candidate.text = payload;
    suggested.reasonCodes = [payload];
    const pending = result.entries.find(value => value.lifecycle === 'not_evaluated')!;
    pending.errorCode = payload;
    pending.reasonCodes = [payload];
    result.videoId = payload;
    result.warnings = [payload];
    const report = renderSelectionReport(ClipSelectionResultV2Schema.parse(result));
    expect(report).not.toContain('<script>');
    expect(report).not.toContain('<Stat value="999"');
    expect(report).not.toContain('{secret}');
    expect(report).not.toContain('{danger}');
    expect(report).not.toContain('[click](javascript:bad)');
    expect(report).not.toContain('\nimport Evil');
    expect(report).toContain('&lt;script&gt;');
    expect(report).toContain('&#123;secret&#125;');
    expect(report).toContain('&#124;');
    expect(report).toContain('&#96;raw&#96;');
    expect(report).toContain('&#92;');
    expect(result.entries.filter(value => value.lifecycle === 'evaluated')).toHaveLength(9);
  });
});
