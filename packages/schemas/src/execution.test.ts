import { describe, expect, test } from 'bun:test';

import {
  adaptVideoProgress,
  adaptVideoResult,
  VideoExecutionProposalV1Schema,
  VideoExecutionResultSchema,
  VideoExecutionResultV1Schema,
  VideoExecutionResultV2Schema,
  VideoProgressSchema,
  VideoProgressV1Schema,
  VideoProgressV2Schema,
  type VideoExecutionProposalV1,
  type VideoExecutionResultV1,
  type VideoExecutionResultV2,
  type VideoProgress,
  type VideoProgressV1,
  type VideoProgressV2,
} from './execution';

const proposalFixture: VideoExecutionProposalV1 = {
  schemaVersion: 1,
  product: 'demo-product',
  slug: '01-lanzamiento',
  title: 'Lanzamiento',
  brief: 'Explicar el problema y presentar la solución.',
};

const progressV1Fixture: VideoProgressV1 = {
  schemaVersion: 1,
  stage: 'audio',
  updatedAt: '2026-09-24T12:00:00.000Z',
  detail: 'Narración maestra generada.',
};

const resultV1Fixture: VideoExecutionResultV1 = {
  schemaVersion: 1,
  status: 'succeeded',
  product: 'demo-product',
  slug: '01-lanzamiento',
  title: 'Lanzamiento',
  video: {
    path: 'projects/demo-product/01-lanzamiento/out/final.mp4',
    sha256: 'a'.repeat(64),
    durationSeconds: 39.14,
    publicUrl: 'https://cdn.example.com/demo-product/final.mp4',
  },
  qa: { visual: 'passed', audio: 'passed', content: 'passed', technical: 'passed' },
  git: { commit: 'c673750', pullRequest: 'https://git.example.com/demo/pull/12' },
  completedAt: '2026-09-24T12:00:00.000Z',
};

function roundTrip<T>(schema: { parse: (raw: unknown) => T }, value: unknown): T {
  return schema.parse(JSON.parse(JSON.stringify(value)));
}

describe('VideoExecutionProposalV1Schema', () => {
  test('round-trips a representative proposal', () => {
    const parsed = VideoExecutionProposalV1Schema.parse(proposalFixture);
    expect(parsed).toEqual(proposalFixture);
    expect(VideoExecutionProposalV1Schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  test('trims slug/title/brief', () => {
    const parsed = VideoExecutionProposalV1Schema.parse({
      ...proposalFixture,
      slug: ' 01-lanzamiento ',
      title: '  Lanzamiento  ',
      brief: '  Texto  ',
    });
    expect(parsed.slug).toBe('01-lanzamiento');
    expect(parsed.title).toBe('Lanzamiento');
    expect(parsed.brief).toBe('Texto');
  });

  test('rejects a bad schemaVersion', () => {
    expect(VideoExecutionProposalV1Schema.safeParse({ ...proposalFixture, schemaVersion: 2 }).success).toBe(false);
  });

  test('rejects a slug outside the pattern', () => {
    for (const slug of ['Mayusculas', 'con_guion_bajo', '-inicia-con-guion', '']) {
      expect(VideoExecutionProposalV1Schema.safeParse({ ...proposalFixture, slug }).success).toBe(false);
    }
  });

  test('rejects empty title/brief', () => {
    expect(VideoExecutionProposalV1Schema.safeParse({ ...proposalFixture, title: '   ' }).success).toBe(false);
    expect(VideoExecutionProposalV1Schema.safeParse({ ...proposalFixture, brief: '   ' }).success).toBe(false);
  });
});

describe('VideoProgressSchema', () => {
  test('round-trips a V1 checkpoint', () => {
    const parsed = VideoProgressSchema.parse(progressV1Fixture);
    expect(parsed).toEqual(progressV1Fixture);
  });

  test('round-trips V2 checkpoints in every execution state', () => {
    const active: VideoProgressV2 = {
      schemaVersion: 2,
      stage: 'qa',
      updatedAt: '2026-09-24T12:00:00.000Z',
      executionStatus: 'active',
    };
    const waiting: VideoProgressV2 = {
      ...active,
      executionStatus: 'waiting-human',
      waitingFor: { id: 'review:cover', reason: 'Falta aprobar la portada.' },
    };
    const errored: VideoProgressV2 = {
      ...active,
      executionStatus: 'error',
      detail: 'Falló la síntesis de voz.',
    };
    for (const fixture of [active, waiting, errored]) {
      const parsed: VideoProgress = roundTrip(VideoProgressSchema, fixture);
      expect(parsed).toEqual(fixture);
    }
  });

  test('rejects a bad schemaVersion, stage or timestamp', () => {
    expect(VideoProgressV1Schema.safeParse({ ...progressV1Fixture, schemaVersion: 3 }).success).toBe(false);
    expect(VideoProgressV1Schema.safeParse({ ...progressV1Fixture, stage: 'rendering' }).success).toBe(false);
    expect(VideoProgressV1Schema.safeParse({ ...progressV1Fixture, updatedAt: 'ayer' }).success).toBe(false);
    expect(VideoProgressV1Schema.safeParse({ ...progressV1Fixture, detail: 7 }).success).toBe(false);
  });

  test('requires waitingFor only for waiting-human', () => {
    const base = { schemaVersion: 2, stage: 'qa', updatedAt: '2026-09-24T12:00:00.000Z' };
    expect(
      VideoProgressV2Schema.safeParse({ ...base, executionStatus: 'waiting-human' }).success,
    ).toBe(false);
    expect(
      VideoProgressV2Schema.safeParse({
        ...base,
        executionStatus: 'active',
        waitingFor: { id: 'x', reason: 'y' },
      }).success,
    ).toBe(false);
    expect(
      VideoProgressV2Schema.safeParse({
        ...base,
        executionStatus: 'waiting-human',
        waitingFor: { id: 'bad id!', reason: 'y' },
      }).success,
    ).toBe(false);
  });

  test('requires detail for error', () => {
    const base = { schemaVersion: 2, stage: 'qa', updatedAt: '2026-09-24T12:00:00.000Z' };
    expect(VideoProgressV2Schema.safeParse({ ...base, executionStatus: 'error' }).success).toBe(false);
    expect(
      VideoProgressV2Schema.safeParse({ ...base, executionStatus: 'error', detail: '  ' }).success,
    ).toBe(false);
  });

  test('adaptVideoProgress upgrades V1 and passes V2 through', () => {
    expect(adaptVideoProgress(VideoProgressSchema.parse(progressV1Fixture))).toEqual({
      ...progressV1Fixture,
      schemaVersion: 2,
      executionStatus: 'active',
    });
    const v2 = VideoProgressV2Schema.parse({
      schemaVersion: 2,
      stage: 'qa',
      updatedAt: '2026-09-24T12:00:00.000Z',
      executionStatus: 'error',
      detail: 'Fallo de render.',
    });
    expect(adaptVideoProgress(v2)).toEqual(v2);
  });
});

describe('VideoExecutionResultSchema', () => {
  test('round-trips V1 and V2 results', () => {
    const v1 = roundTrip(VideoExecutionResultSchema, resultV1Fixture);
    expect(v1).toEqual(resultV1Fixture);
    const v2Fixture: VideoExecutionResultV2 = {
      ...resultV1Fixture,
      schemaVersion: 2,
      executionStatus: 'succeeded',
    };
    const v2 = roundTrip(VideoExecutionResultSchema, v2Fixture);
    expect(v2).toEqual(v2Fixture);
  });

  test('rejects a bad schemaVersion or a V2 without executionStatus succeeded', () => {
    expect(VideoExecutionResultSchema.safeParse({ ...resultV1Fixture, schemaVersion: 0 }).success).toBe(false);
    expect(
      VideoExecutionResultV2Schema.safeParse({ ...resultV1Fixture, schemaVersion: 2 }).success,
    ).toBe(false);
  });

  test('rejects malformed hashes and non-http URLs', () => {
    const badSha = {
      ...resultV1Fixture,
      video: { ...resultV1Fixture.video, sha256: 'A'.repeat(64) },
    };
    expect(VideoExecutionResultSchema.safeParse(badSha).success).toBe(false);
    const shortSha = { ...resultV1Fixture, video: { ...resultV1Fixture.video, sha256: 'abc' } };
    expect(VideoExecutionResultSchema.safeParse(shortSha).success).toBe(false);
    const badUrl = {
      ...resultV1Fixture,
      video: { ...resultV1Fixture.video, publicUrl: 'ftp://cdn.example.com/final.mp4' },
    };
    expect(VideoExecutionResultSchema.safeParse(badUrl).success).toBe(false);
    const badCommit = {
      ...resultV1Fixture,
      git: { ...resultV1Fixture.git, commit: 'no-es-un-sha' },
    };
    expect(VideoExecutionResultSchema.safeParse(badCommit).success).toBe(false);
  });

  test('rejects traversal, absolute and non-mp4 artifact paths', () => {
    for (const path of [
      '../escape.mp4',
      'projects/../escape.mp4',
      '/absolute/final.mp4',
      'C:/windows/final.mp4',
      'videos\\demo\\final.mp4',
      'projects/demo/out/final.mov',
      '',
    ]) {
      const fixture = { ...resultV1Fixture, video: { ...resultV1Fixture.video, path } };
      expect(VideoExecutionResultSchema.safeParse(fixture).success).toBe(false);
    }
  });

  test('rejects incomplete evidence', () => {
    expect(
      VideoExecutionResultSchema.safeParse({ ...resultV1Fixture, video: undefined }).success,
    ).toBe(false);
    expect(
      VideoExecutionResultSchema.safeParse({
        ...resultV1Fixture,
        qa: { visual: 'passed', audio: 'passed', content: 'passed', technical: 'warning' },
      }).success,
    ).toBe(false);
    expect(
      VideoExecutionResultSchema.safeParse({
        ...resultV1Fixture,
        video: { ...resultV1Fixture.video, durationSeconds: 0 },
      }).success,
    ).toBe(false);
    expect(VideoExecutionResultSchema.safeParse({ ...resultV1Fixture, completedAt: 'nope' }).success).toBe(false);
  });

  test('adaptVideoResult upgrades V1 and passes V2 through', () => {
    expect(adaptVideoResult(VideoExecutionResultSchema.parse(resultV1Fixture))).toEqual({
      ...resultV1Fixture,
      schemaVersion: 2,
      executionStatus: 'succeeded',
    });
    const v2 = VideoExecutionResultV2Schema.parse({
      ...resultV1Fixture,
      schemaVersion: 2,
      executionStatus: 'succeeded',
    });
    expect(adaptVideoResult(v2)).toEqual(v2);
  });
});
