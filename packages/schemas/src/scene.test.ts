import { describe, expect, test } from 'bun:test';

import {
  SceneBriefSchema,
  SceneDelegationJournalSchema,
  SceneResultSchema,
  SceneResultV2Schema,
  SceneResultV3Schema,
  type SceneBrief,
  type SceneDelegationJournal,
  type SceneResultV2,
  type SceneResultV3,
} from './scene';

const sha = (char: string): string => char.repeat(64);

const resultV2Fixture: SceneResultV2 = {
  schemaVersion: 2,
  sceneId: 's1-intro',
  agent: 'remotion-scene-designer',
  executionStatus: 'ok',
  editorialVerdict: 'unreviewed',
  outputPath: 'projects/demo/01-intro/remotion/scenes/s1-intro.tsx',
  outputSha256: sha('b'),
  stillPath: 'projects/demo/01-intro/qa/stills/s1-intro.png',
  stillSha256: sha('c'),
  diagnostics: [{ level: 'info', message: 'Still verificado.' }],
  artifacts: [{ path: 'projects/demo/01-intro/scenes/s1-intro.tsx', sha256: sha('b') }],
};

const briefFixture: SceneBrief = {
  schemaVersion: 1,
  sceneId: 's1-intro',
  agent: 'remotion-scene-designer',
  videoDir: 'projects/demo/01-intro',
  intent: 'Abrir con el problema real.',
  narration: 'Todo producto tiene su identidad.',
  durationSeconds: 6.5,
  brandingPreset: 'demo-brand',
  branding: {
    canvasFrom: '#F5F0E8',
    canvasTo: '#FFFFFF',
    ink: '#1D3B34',
    accent: '#C9A227',
    fontDisplay: 'Sora',
    fontBody: 'Inter',
  },
  isBranded: true,
  outputPath: 'projects/demo/01-intro/remotion/scenes/s1-intro.tsx',
  stillPath: 'projects/demo/01-intro/qa/stills/s1-intro.png',
  contextFiles: ['projects/demo/01-intro/scenes/s1-intro.brief.json', 'docs/design-rules.md'],
  globalDirection: {
    title: 'Demo',
    styleReference: 'refs/style.md',
    cameraLanguage: 'primeros planos y paneos cortos',
  },
  neighbors: {
    previous: {
      id: 's0-hook',
      intent: 'Gancho',
      narration: 'Mira esto.',
      source: 'motion',
      durationSeconds: 4,
    },
    next: {
      id: 's2-demo',
      intent: 'Mostrar el producto',
      narration: 'Así funciona.',
      source: 'demo-app',
      durationSeconds: 8,
    },
  },
  source: 'motion',
};

function roundTrip<T>(schema: { parse: (raw: unknown) => T }, value: unknown): T {
  return schema.parse(JSON.parse(JSON.stringify(value)));
}

describe('SceneResultSchema', () => {
  test('round-trips a V2 result with sha256 evidence', () => {
    const parsed = roundTrip(SceneResultSchema, resultV2Fixture);
    expect(parsed).toEqual(resultV2Fixture);
  });

  test('normalizes a legacy V1 result to V2 with a derived editorial verdict', () => {
    const legacy = {
      sceneId: 's2-hook',
      agent: 'scene-writer',
      status: 'ok',
      outputPath: 'projects/demo/01-intro/scenes/s2-hook.yaml',
      diagnostics: [],
    };
    const parsed = SceneResultSchema.parse(legacy);
    expect(parsed).toEqual({
      sceneId: 's2-hook',
      agent: 'scene-writer',
      outputPath: 'projects/demo/01-intro/scenes/s2-hook.yaml',
      diagnostics: [],
      schemaVersion: 2,
      executionStatus: 'ok',
      editorialVerdict: 'unreviewed',
      outputSha256: undefined,
      stillSha256: undefined,
      artifacts: undefined,
      audiovisualVerdict: undefined,
    });
    const withError = SceneResultSchema.parse({
      ...legacy,
      schemaVersion: 1,
      status: 'fail',
      diagnostics: [{ level: 'error', message: 'Bloqueo editorial.' }],
    });
    expect(withError.editorialVerdict).toBe('blocked');
    expect(withError.executionStatus).toBe('fail');
  });

  test('round-trips a V3 waiting-human result', () => {
    const waiting: SceneResultV3 = {
      schemaVersion: 3,
      sceneId: 's3-avatar',
      agent: 'avatar-producer',
      executionStatus: 'waiting-human',
      editorialVerdict: 'unreviewed',
      waitingFor: {
        id: 'avatar-approval',
        code: 'HUMAN_APPROVAL',
        reason: 'Requiere revisión humana del clip.',
        nextAction: 'Revisar el clip y aprobarlo.',
      },
      diagnostics: [],
    };
    expect(roundTrip(SceneResultSchema, waiting)).toEqual(waiting);
    expect(SceneResultV3Schema.safeParse(waiting).success).toBe(true);
    expect(SceneResultV2Schema.safeParse(waiting).success).toBe(false);
  });

  test('requires outputPath + outputSha256 when executionStatus is ok', () => {
    const base = { ...resultV2Fixture, outputPath: undefined, outputSha256: undefined };
    expect(SceneResultV2Schema.safeParse(base).success).toBe(false);
    expect(SceneResultV2Schema.safeParse({ ...resultV2Fixture, outputSha256: undefined }).success).toBe(false);
    expect(SceneResultV2Schema.safeParse({ ...base, executionStatus: 'fail' }).success).toBe(true);
  });

  test('stillPath requires stillSha256', () => {
    expect(
      SceneResultV2Schema.safeParse({ ...resultV2Fixture, stillSha256: undefined }).success,
    ).toBe(false);
  });

  test('rejects editorialVerdict pass over a failing execution', () => {
    expect(
      SceneResultV2Schema.safeParse({
        ...resultV2Fixture,
        executionStatus: 'fail',
        editorialVerdict: 'pass',
      }).success,
    ).toBe(false);
    expect(
      SceneResultV2Schema.safeParse({
        ...resultV2Fixture,
        editorialVerdict: 'pass',
        diagnostics: [{ level: 'error', message: 'Fallo de arte.' }],
      }).success,
    ).toBe(false);
  });

  test('rejects malformed hashes and unknown schema versions', () => {
    expect(
      SceneResultV2Schema.safeParse({ ...resultV2Fixture, outputSha256: 'XYZ' }).success,
    ).toBe(false);
    expect(
      SceneResultV2Schema.safeParse({
        ...resultV2Fixture,
        artifacts: [{ path: 'x.tsx', sha256: sha('B') }],
      }).success,
    ).toBe(false);
    expect(SceneResultSchema.safeParse({ ...resultV2Fixture, schemaVersion: 9 }).success).toBe(false);
  });

  test('rejects a waiting-human executionStatus in V2 and a malformed V3 code', () => {
    expect(
      SceneResultV2Schema.safeParse({
        ...resultV2Fixture,
        executionStatus: 'waiting-human',
        editorialVerdict: 'blocked',
      }).success,
    ).toBe(false);
    expect(
      SceneResultV3Schema.safeParse({
        schemaVersion: 3,
        sceneId: 's3',
        agent: 'a',
        executionStatus: 'waiting-human',
        editorialVerdict: 'blocked',
        waitingFor: { id: 'x', code: 'not a code', reason: 'r', nextAction: 'n' },
        diagnostics: [],
      }).success,
    ).toBe(false);
    expect(
      SceneResultV3Schema.safeParse({
        schemaVersion: 3,
        sceneId: 's3',
        agent: 'a',
        executionStatus: 'waiting-human',
        editorialVerdict: 'pass',
        waitingFor: { id: 'x', code: 'HUMAN_APPROVAL', reason: 'r', nextAction: 'n' },
        diagnostics: [],
      }).success,
    ).toBe(false);
  });
});

describe('SceneBriefSchema', () => {
  test('round-trips a representative brief', () => {
    const parsed = roundTrip(SceneBriefSchema, briefFixture);
    expect(parsed).toEqual(briefFixture);
  });

  test('fills contract defaults and accepts an omitted schemaVersion', () => {
    const minimal = {
      sceneId: 's1',
      agent: 'scene-writer',
      videoDir: 'projects/demo/02-demo',
      intent: 'Mostrar el flujo.',
      durationSeconds: 5,
      brandingPreset: 'demo-brand',
      branding: briefFixture.branding,
      outputPath: 'projects/demo/02-demo/scenes/s1.yaml',
      stillPath: 'projects/demo/02-demo/qa/stills/s1.png',
      contextFiles: ['projects/demo/02-demo/scenes/s1.brief.json'],
    };
    const parsed = SceneBriefSchema.parse(minimal);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.narration).toBe('');
    expect(parsed.isBranded).toBe(true);
  });

  test('rejects an empty context package or bad duration', () => {
    expect(SceneBriefSchema.safeParse({ ...briefFixture, contextFiles: [] }).success).toBe(false);
    expect(SceneBriefSchema.safeParse({ ...briefFixture, durationSeconds: 0 }).success).toBe(false);
    expect(SceneBriefSchema.safeParse({ ...briefFixture, schemaVersion: 2 }).success).toBe(false);
    expect(
      SceneBriefSchema.safeParse({
        ...briefFixture,
        branding: { ...briefFixture.branding, fontBody: undefined },
      }).success,
    ).toBe(false);
    expect(
      SceneBriefSchema.safeParse({ ...briefFixture, neighbors: { previous: { id: 'x' } } }).success,
    ).toBe(false);
  });
});

describe('SceneDelegationJournalSchema', () => {
  const journalFixture: SceneDelegationJournal = {
    schemaVersion: 1,
    sceneId: 's1-intro',
    entries: [
      {
        schemaVersion: 1,
        sceneId: 's1-intro',
        agent: 'remotion-scene-designer',
        agentId: 'task-123',
        historyRef: 'history://123',
        briefPath: 'projects/demo/01-intro/scenes/s1-intro.brief.json',
        briefDigest: sha('d'),
        startedAt: '2026-09-24T12:00:00.000Z',
        endedAt: '2026-09-24T12:30:00.000Z',
        outcome: 'ok',
        resultRef: 'projects/demo/01-intro/scenes/s1-intro.result.json',
      },
    ],
  };

  test('round-trips the delegation trace', () => {
    expect(roundTrip(SceneDelegationJournalSchema, journalFixture)).toEqual(journalFixture);
  });

  test('rejects a malformed briefDigest', () => {
    expect(
      SceneDelegationJournalSchema.safeParse({
        ...journalFixture,
        entries: [{ ...journalFixture.entries[0], briefDigest: 'no-es-un-sha256' }],
      }).success,
    ).toBe(false);
  });
});
