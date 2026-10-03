import { describe, expect, test } from 'bun:test';
import {
  ClipSelectionAttemptEvidenceSchema,
  ClipSelectionRequestSchema,
  ClipSelectionResultEntryV1Schema,
  ClipSelectionResultEntryV2Schema,
  ClipSelectionResultLatestSchema,
  ClipSelectionResultSchema,
  ClipSelectionResultV1Schema,
  ClipSelectionResultV2Schema,
  ClipSelectionSpendV2Schema,
  ClipSelectionTranscriptSchema,
  type ClipSelectionAttemptEvidence,
  type ClipSelectionCandidate,
  type ClipSelectionEvaluation,
  type ClipSelectionResult,
  type ClipSelectionResultEntry,
  type ClipSelectionResultEntryV2,
  type ClipSelectionResultLatest,
  type ClipSelectionResultV1,
  type ClipSelectionResultV2,
} from './clip-selection';

const transcript = {
  schemaVersion: 1, videoId: 'demo', language: 'es', durationSec: 60,
  segments: [
    { id: 's1', startSec: 0, endSec: 20, speaker: 'A', text: 'Primera frase.' },
    { id: 's2', startSec: 20, endSec: 40, speaker: 'A', text: 'Segunda frase.' },
  ],
};
const request = { schemaVersion: 1, transcript: '../source/transcript.json', audience: 'Fundadores', objective: 'Aprendizajes útiles', maxClips: 3, duration: { minSec: 20, maxSec: 60 } };

describe('clip selection contracts', () => {
  test('request defaults are explicit and pin model/pricing version', () => {
    const parsed = ClipSelectionRequestSchema.parse(request);
    expect(parsed.model).toBe('jev-1.13.0');
    expect(parsed.maxCandidates).toBe(100);
    expect(parsed.timeoutMs).toBe(10_000);
    expect(parsed.deadlineMs).toBe(120_000);
  });
  test('rejects unknown fields, aliases, invalid duration and missing objective', () => {
    for (const invalid of [
      { ...request, approval: true }, { ...request, model: 'jev-latest' },
      { ...request, duration: { minSec: 60, maxSec: 20 } }, { ...request, objective: '' },
      { ...request, maxCandidates: 501 }, { ...request, maxClips: 0 },
    ]) expect(ClipSelectionRequestSchema.safeParse(invalid).success).toBe(false);
  });
  test('accepts timed, ordered, unique segments and an empty transcript', () => {
    expect(ClipSelectionTranscriptSchema.safeParse(transcript).success).toBe(true);
    expect(ClipSelectionTranscriptSchema.safeParse({ ...transcript, segments: [] }).success).toBe(true);
  });
  test('rejects duplicate IDs, overlaps, out-of-source and non-finite timestamps', () => {
    for (const second of [
      { ...transcript.segments[1], id: 's1' },
      { ...transcript.segments[1], startSec: 19 },
      { ...transcript.segments[1], endSec: 61 },
      { ...transcript.segments[1], startSec: 45 },
      { ...transcript.segments[1], endSec: Infinity },
    ]) expect(ClipSelectionTranscriptSchema.safeParse({ ...transcript, segments: [transcript.segments[0], second] }).success).toBe(false);
  });
  test('rejects text without time alignment and blank segment text', () => {
    expect(ClipSelectionTranscriptSchema.safeParse({ text: 'Un transcript sin tiempos.' }).success).toBe(false);
    expect(ClipSelectionTranscriptSchema.safeParse({ ...transcript, segments: [{ ...transcript.segments[0], text: ' ' }] }).success).toBe(false);
  });
});

const createdAt = '2026-10-02T00:00:00.000Z';
const maxCallUsd = .002688;
const confirmedCallUsd = .0000042;
const evaluation: ClipSelectionEvaluation = {
  quality: 90, minScoreConfidence: .99,
  signals: { hook: 90, value: 90, autonomy: 90, closure: 90 },
  gates: { standalone: .99, faithful: .99 }, model: 'jev-1.13.0',
  usage: { input_tokens: 100, output_tokens: 20 },
  responseSha256: 'a'.repeat(64), responsePath: 'cache/response.json',
};

function candidate(id: string): ClipSelectionCandidate {
  return { id, sourceRange: { startSec: 0, endSec: 30 }, sourceSegments: ['s1'], speaker: 'A', text: `Texto ${id}.` };
}

function attempt(id: string, state: 'completed' | 'uncertain' = 'completed'): ClipSelectionAttemptEvidence {
  return {
    schemaVersion: 1, attemptId: `attempt-${id}`, planDigest: 'b'.repeat(64),
    command: 'clips-select', subject: `selection-${id}`, state, createdAt,
    reservedUsd: state === 'completed' ? confirmedCallUsd : maxCallUsd,
    ...(state === 'completed' ? { receipt: { requestId: `typesafe-response:${evaluation.responseSha256}` } } : {}),
  };
}

function evaluatedEntry(id: string): ClipSelectionResultEntryV2 {
  return {
    candidate: candidate(id), lifecycle: 'evaluated', route: 'suggested', evaluation,
    reasonCodes: ['COMPLETE_IDEA'], attempt: attempt(id), cached: false,
    cutStatus: 'needs_audio_video_review', approvedForPublication: false,
  };
}

function unevaluatedEntry(id: string, lifecycle: 'not_evaluated' | 'failed' | 'uncertain'): ClipSelectionResultEntryV2 {
  return {
    candidate: candidate(id), lifecycle, route: null, evaluation: null,
    reasonCodes: [lifecycle === 'not_evaluated' ? 'BATCH_STOPPED' : lifecycle === 'failed' ? 'EVALUATION_FAILED' : 'PAID_OUTCOME_UNCERTAIN'],
    attempt: lifecycle === 'uncertain' ? attempt(id, 'uncertain') : null,
    cached: false, cutStatus: 'needs_audio_video_review', approvedForPublication: false,
  };
}

function resultV1(): ClipSelectionResultV1 {
  const evaluated: ClipSelectionResultEntry = {
    candidate: candidate('valid'), route: 'suggested', evaluation, reasonCodes: ['COMPLETE_IDEA'],
    cached: false, cutStatus: 'needs_audio_video_review', approvedForPublication: false,
  };
  return {
    schemaVersion: 1, status: 'partial', videoId: 'demo',
    requestSha256: 'c'.repeat(64), transcriptSha256: 'd'.repeat(64), selectionDigest: 'e'.repeat(64),
    createdAt, rubricVersion: 1, policyVersion: 1, model: 'jev-1.13.0',
    selectedIds: ['valid'], reviewIds: [], entries: [
      evaluated,
      { ...evaluated, candidate: candidate('legacy-stopped'), route: 'evaluation_failed', evaluation: null, reasonCodes: ['EVALUATION_FAILED'], errorCode: 'BATCH_STOPPED' },
    ],
    warnings: ['Historical v1 classification is preserved.'],
    spend: { capUsd: 1, reservedUsd: 2 * maxCallUsd, actualUsd: confirmedCallUsd, inputTokens: 100, outputTokens: 20, newCalls: 2, cachedCalls: 0 },
    approvedForPublication: false,
  };
}

function resultV2(entries: ClipSelectionResultEntryV2[] = [evaluatedEntry('valid')]): ClipSelectionResultV2 {
  const complete = entries.every(entry => entry.lifecycle === 'evaluated');
  const attempts = entries.flatMap(entry => entry.attempt ? [entry.attempt] : []);
  return {
    schemaVersion: 2, status: complete ? 'complete' : 'partial',
    provenance: complete ? 'automatic-complete' : 'automatic-partial',
    videoId: 'demo', requestSha256: 'c'.repeat(64), transcriptSha256: 'd'.repeat(64),
    selectionDigest: 'e'.repeat(64), createdAt, rubricVersion: 1, policyVersion: 1, model: 'jev-1.13.0',
    selectedIds: entries.filter(entry => entry.route === 'suggested').map(entry => entry.candidate.id),
    reviewIds: entries.filter(entry => entry.route === 'review').map(entry => entry.candidate.id),
    entries, warnings: [],
    spend: {
      capUsd: 2,
      confirmedActualUsd: attempts.filter(item => item.state === 'completed').reduce((sum, item) => sum + item.reservedUsd, 0),
      historicalReservedUsd: attempts.length * maxCallUsd,
      openReservedUsd: attempts.filter(item => item.state === 'uncertain' || item.state === 'submitted').reduce((sum, item) => sum + item.reservedUsd, 0),
      inputTokens: entries.filter(entry => !entry.cached).reduce((sum, entry) => sum + (entry.evaluation?.usage.input_tokens ?? 0), 0),
      outputTokens: entries.filter(entry => !entry.cached).reduce((sum, entry) => sum + (entry.evaluation?.usage.output_tokens ?? 0), 0),
      newCalls: entries.filter(entry => !entry.cached && entry.attempt !== null).length,
      cachedCalls: entries.filter(entry => entry.cached).length,
    },
    approvedForPublication: false,
  };
}

describe('versioned clip selection results', () => {
  test('reads v1 unchanged, including its historical stopped-as-failed classification and reserve name', () => {
    const original = resultV1();
    const legacy: ClipSelectionResult = ClipSelectionResultV1Schema.parse(original);
    expect(legacy).toEqual(original);
    expect(ClipSelectionResultSchema.parse(original)).toEqual(original);
    expect(legacy.entries[1].route).toBe('evaluation_failed');
    expect(legacy.entries[1].errorCode).toBe('BATCH_STOPPED');
    expect(legacy.spend.reservedUsd).toBe(2 * maxCallUsd);
    expect(ClipSelectionResultV2Schema.safeParse(original).success).toBe(false);
  });

  test('retains strict v1 metrics, duplicate, version and unknown-field rules', () => {
    const legacyEntry = resultV1().entries[0];
    for (const invalid of [
      { ...legacyEntry, evaluation: null },
      { ...legacyEntry, route: 'evaluation_failed' },
      { ...legacyEntry, route: 'duplicate' },
      { ...legacyEntry, lifecycle: 'evaluated' },
      { ...legacyEntry, approvedForPublication: true },
    ]) expect(ClipSelectionResultEntryV1Schema.safeParse(invalid).success).toBe(false);
    const original = resultV1();
    for (const invalid of [
      { ...original, provenance: 'automatic-partial' },
      { ...original, schemaVersion: 3 },
      { ...original, rubricVersion: 2 },
      { ...original, policyVersion: 2 },
      { ...original, spend: { ...original.spend, openReservedUsd: maxCallUsd } },
    ]) expect(ClipSelectionResultSchema.safeParse(invalid).success).toBe(false);
  });

  test('reads v2 through the compatibility reader and explicitly latest contract without transforming evidence', () => {
    const original = resultV2([evaluatedEntry('valid'), unevaluatedEntry('unknown', 'uncertain')]);
    const latest: ClipSelectionResultLatest = ClipSelectionResultLatestSchema.parse(original);
    expect(latest).toEqual(original);
    expect(ClipSelectionResultSchema.parse(original)).toEqual(original);
    expect(latest.entries[1].attempt).toEqual(original.entries[1].attempt);
    expect(ClipSelectionResultV1Schema.safeParse(original).success).toBe(false);
  });

  test('represents all four lifecycles separately from editorial route', () => {
    const entries = [
      evaluatedEntry('valid'), unevaluatedEntry('stopped', 'not_evaluated'),
      unevaluatedEntry('local-failure', 'failed'), unevaluatedEntry('unknown', 'uncertain'),
    ];
    expect(ClipSelectionResultV2Schema.safeParse(resultV2(entries)).success).toBe(true);
    for (const entry of entries) expect(ClipSelectionResultEntryV2Schema.parse(entry)).toEqual(entry);
    expect(entries.slice(1).every(entry => entry.route === null && entry.evaluation === null)).toBe(true);
  });

  test('rejects missing or malformed evaluated metrics and fabricated metrics on other lifecycles', () => {
    const valid = evaluatedEntry('valid');
    for (const invalid of [
      { ...valid, evaluation: null },
      { ...valid, route: null },
      { ...valid, attempt: null },
      { ...valid, evaluation: { ...evaluation, quality: NaN } },
      { ...valid, evaluation: { ...evaluation, signals: { ...evaluation.signals, hook: 101 } } },
      { ...valid, evaluation: { ...evaluation, responseSha256: 'not-a-hash' } },
      { ...valid, evaluation: { ...evaluation, extra: 'untrusted' } },
      ...(['not_evaluated', 'failed', 'uncertain'] as const).map(lifecycle => ({
        ...unevaluatedEntry(lifecycle, lifecycle), evaluation,
      })),
    ]) expect(ClipSelectionResultEntryV2Schema.safeParse(invalid).success).toBe(false);
  });

  test('excludes non-evaluated entries from editorial routes, cache and duplicate references', () => {
    const stopped = unevaluatedEntry('stopped', 'not_evaluated');
    for (const invalid of [
      { ...stopped, route: 'suggested' }, { ...stopped, route: 'evaluation_failed' },
      { ...stopped, cached: true }, { ...stopped, reasonCodes: [] },
      { ...stopped, reasonCodes: [' '] }, { ...stopped, duplicateOf: 'valid' },
      { ...stopped, attempt: attempt('stopped', 'uncertain') },
      { ...stopped, approvedForPublication: true },
    ]) expect(ClipSelectionResultEntryV2Schema.safeParse(invalid).success).toBe(false);
    const valid = evaluatedEntry('valid');
    expect(ClipSelectionResultEntryV2Schema.safeParse({ ...valid, route: 'duplicate' }).success).toBe(false);
    expect(ClipSelectionResultEntryV2Schema.safeParse({ ...valid, duplicateOf: 'other' }).success).toBe(false);
  });

  test('does not relabel an uncertain paid attempt as failed, skipped, cached, or evaluated', () => {
    const unknown = unevaluatedEntry('unknown', 'uncertain');
    for (const invalid of [
      { ...unknown, attempt: null },
      { ...unknown, attempt: { ...unknown.attempt, reservedUsd: 0 } },
      { ...unknown, lifecycle: 'failed' }, { ...unknown, lifecycle: 'not_evaluated' },
      { ...unknown, cached: true },
      { ...evaluatedEntry('unknown'), attempt: unknown.attempt },
      { ...unknown, attempt: attempt('unknown') },
    ]) expect(ClipSelectionResultEntryV2Schema.safeParse(invalid).success).toBe(false);
  });

  test('requires original receipt and explicit reconciliation evidence for proven paid outcomes', () => {
    const completed = attempt('valid');
    const submitted: ClipSelectionAttemptEvidence = { ...completed, state: 'submitted', reservedUsd: maxCallUsd };
    expect(ClipSelectionAttemptEvidenceSchema.safeParse(submitted).success).toBe(true);
    expect(ClipSelectionResultEntryV2Schema.safeParse({ ...unevaluatedEntry('valid', 'uncertain'), attempt: submitted }).success).toBe(true);
    const reconciled: ClipSelectionAttemptEvidence = {
      ...attempt('failed', 'uncertain'), state: 'reconciled',
      reconciliation: { by: 'operator', at: createdAt, evidence: 'qa/charge-evidence.json' },
    };
    expect(ClipSelectionResultEntryV2Schema.safeParse({ ...unevaluatedEntry('failed', 'failed'), attempt: reconciled }).success).toBe(true);
    for (const invalid of [
      { ...completed, receipt: undefined },
      { ...submitted, receipt: undefined },
      { ...attempt('unknown', 'uncertain'), receipt: completed.receipt },
      { ...reconciled, reconciliation: undefined },
      { ...reconciled, reconciliation: { ...reconciled.reconciliation, evidence: ' ' } },
      { ...completed, reconciliation: reconciled.reconciliation },
      { ...completed, planDigest: 'different-key' },
      { ...completed, command: 'another-command' },
      { ...completed, reservedUsd: Infinity },
      { ...completed, changedOriginalEvidence: true },
    ]) expect(ClipSelectionAttemptEvidenceSchema.safeParse(invalid).success).toBe(false);
  });

  test('500 entries retain nine valid evaluations, one uncertain attempt, and 490 not evaluated', () => {
    const entries = [
      ...Array.from({ length: 9 }, (_, index) => evaluatedEntry(`valid-${index}`)),
      unevaluatedEntry('unknown', 'uncertain'),
      ...Array.from({ length: 490 }, (_, index) => unevaluatedEntry(`stopped-${index}`, 'not_evaluated')),
    ];
    const original = resultV2(entries);
    const parsed = ClipSelectionResultSchema.parse(original);
    expect(parsed.schemaVersion).toBe(2);
    if (parsed.schemaVersion !== 2) throw new Error('Expected the v2 branch.');
    expect(parsed.entries).toHaveLength(500);
    expect(parsed.entries.filter(entry => entry.lifecycle === 'evaluated')).toHaveLength(9);
    expect(parsed.entries.filter(entry => entry.lifecycle === 'uncertain')).toHaveLength(1);
    expect(parsed.entries.filter(entry => entry.lifecycle === 'not_evaluated')).toHaveLength(490);
    expect(parsed.entries.filter(entry => entry.lifecycle === 'failed')).toHaveLength(0);
    expect(parsed.selectedIds).toHaveLength(9);
    expect(parsed.spend.newCalls).toBe(10);
    expect(parsed.spend.confirmedActualUsd).toBeCloseTo(9 * confirmedCallUsd, 12);
    expect(parsed.spend.historicalReservedUsd).toBeCloseTo(10 * maxCallUsd, 12);
    expect(parsed.spend.openReservedUsd).toBe(maxCallUsd);
    expect(parsed.entries[9].attempt).toEqual(attempt('unknown', 'uncertain'));
    expect(parsed.approvedForPublication).toBe(false);
  });

  test('provenance is explicit and cannot misrepresent partial automatic selection', () => {
    const complete = resultV2();
    const partial = resultV2([unevaluatedEntry('stopped', 'not_evaluated')]);
    for (const original of [complete, partial]) {
      expect(ClipSelectionResultV2Schema.safeParse({ ...original, provenance: 'editorial-local' }).success).toBe(true);
    }
    for (const invalid of [
      { ...complete, provenance: 'automatic-partial' }, { ...partial, provenance: 'automatic-complete' },
      { ...complete, provenance: 'automatic' }, { ...complete, provenance: undefined },
      { ...complete, status: 'partial' }, { ...partial, status: 'complete' },
      { ...partial, approvedForPublication: true },
    ]) expect(ClipSelectionResultV2Schema.safeParse(invalid).success).toBe(false);
    expect(ClipSelectionResultV2Schema.safeParse(resultV2([])).success).toBe(true);
  });

  test('rejects malformed spend, legacy aliases, fractional counts and inadequate historical reserve', () => {
    const original = resultV2([evaluatedEntry('valid'), unevaluatedEntry('unknown', 'uncertain')]);
    for (const invalid of [
      { ...original.spend, confirmedActualUsd: -1 }, { ...original.spend, confirmedActualUsd: NaN },
      { ...original.spend, openReservedUsd: Infinity }, { ...original.spend, historicalReservedUsd: -1 },
      { ...original.spend, capUsd: -1 }, { ...original.spend, inputTokens: 1.5 },
      { ...original.spend, outputTokens: -1 }, { ...original.spend, newCalls: .5 },
      { ...original.spend, cachedCalls: -1 },
      { ...original.spend, historicalReservedUsd: original.spend.openReservedUsd },
      { ...original.spend, reservedUsd: maxCallUsd }, { ...original.spend, actualUsd: confirmedCallUsd },
    ]) expect(ClipSelectionSpendV2Schema.safeParse(invalid).success).toBe(false);
  });

  test('keeps open reserves distinct from original reservations and confirmed charges', () => {
    const original = resultV2([evaluatedEntry('valid'), unevaluatedEntry('unknown', 'uncertain')]);
    expect(ClipSelectionResultV2Schema.safeParse(original).success).toBe(true);
    for (const spend of [
      { ...original.spend, openReservedUsd: 0 },
      { ...original.spend, openReservedUsd: original.spend.historicalReservedUsd },
      { ...original.spend, openReservedUsd: original.spend.openReservedUsd + confirmedCallUsd },
      { ...original.spend, confirmedActualUsd: 0 },
    ]) expect(ClipSelectionResultV2Schema.safeParse({ ...original, spend }).success).toBe(false);
    const cached = resultV2([{ ...evaluatedEntry('valid'), cached: true }]);
    expect(cached.spend.newCalls).toBe(0);
    expect(cached.spend.cachedCalls).toBe(1);
    expect(cached.spend.openReservedUsd).toBe(0);
    expect(cached.spend.confirmedActualUsd).toBe(confirmedCallUsd);
    expect(ClipSelectionResultV2Schema.safeParse(cached).success).toBe(true);
  });

  test('does not count one paid attempt twice or include skipped IDs in selected/review lists', () => {
    const valid = evaluatedEntry('valid');
    const unknown = unevaluatedEntry('unknown', 'uncertain');
    const original = resultV2([valid, unknown]);
    for (const invalid of [
      { ...original, selectedIds: ['unknown'] }, { ...original, selectedIds: ['valid', 'valid'] },
      { ...original, selectedIds: [] }, { ...original, reviewIds: ['unknown'] },
      { ...original, entries: [valid, { ...unknown, candidate: valid.candidate }] },
      resultV2([valid, { ...evaluatedEntry('other'), attempt: valid.attempt }]),
      resultV2([unknown, { ...unevaluatedEntry('other', 'uncertain'), attempt: unknown.attempt }]),
      resultV2(Array.from({ length: 501 }, (_, index) => unevaluatedEntry(`stopped-${index}`, 'not_evaluated'))),
    ]) expect(ClipSelectionResultV2Schema.safeParse(invalid).success).toBe(false);
  });

  test('duplicate links reference a distinct suggested candidate in the same result', () => {
    const selected = evaluatedEntry('selected');
    const duplicate: ClipSelectionResultEntryV2 = { ...evaluatedEntry('duplicate'), route: 'duplicate', duplicateOf: 'selected' };
    expect(ClipSelectionResultV2Schema.safeParse(resultV2([selected, duplicate])).success).toBe(true);
    for (const duplicateOf of ['duplicate', 'missing']) {
      expect(ClipSelectionResultV2Schema.safeParse(resultV2([selected, { ...duplicate, duplicateOf }])).success).toBe(false);
    }
  });
});
