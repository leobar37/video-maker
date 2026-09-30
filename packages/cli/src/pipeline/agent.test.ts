/**
 * Agent seam: the policy wrapper rejects model garbage with exactly one retry,
 * never fabricates analyses, and turns hangs into an actionable timeout error.
 */
import { describe, expect, test } from 'bun:test';

import { FrameAnalysisSchema, type FrameAnalysis } from '@videomaker/schemas';

import {
  AgentTimeoutError,
  FakeAgentRunner,
  frameAnalysisJson,
  runShardAnalysis,
  type AgentRunner,
  type AgentShardContext,
  type ShardFrame,
} from './agent';

const FRAMES: ShardFrame[] = [
  { frame_id: 'f-000001', t: 0, path: 'frames/f-000001.jpg' },
  { frame_id: 'f-000002', t: 1.5, path: 'frames/f-000002.jpg' },
];

const CTX: AgentShardContext = {
  shardId: 'shard-0001',
  sourceSha256: 'a'.repeat(64),
  objective: 'Find the hook of the video.',
  transcriptSlice: 'Welcome back to the show.',
};

const EXPECTED_ANALYSES: FrameAnalysis[] = FRAMES.map((frame) => ({
  schemaVersion: 1,
  frame_id: frame.frame_id,
  t: frame.t,
  speakers: [],
  sceneCut: false,
  energy: 0.5,
  topic: 'general',
  highlight: 0.5,
}));

describe('runShardAnalysis', () => {
  test('happy path: parses the raw JSON into FrameAnalysis entries', async () => {
    const runner = new FakeAgentRunner([frameAnalysisJson(FRAMES)]);
    const outcome = await runShardAnalysis(runner, FRAMES, CTX);
    expect(outcome).toEqual({ status: 'ok', analyses: EXPECTED_ANALYSES });
    if (outcome.status !== 'ok') throw new Error('expected ok');
    for (const analysis of outcome.analyses) {
      expect(FrameAnalysisSchema.safeParse(analysis).success).toBe(true);
    }
    expect(runner.calls.length).toBe(1);
  });

  test('valid empty array is ok with zero analyses', async () => {
    const runner = new FakeAgentRunner(['[]']);
    const outcome = await runShardAnalysis(runner, FRAMES, CTX);
    expect(outcome).toEqual({ status: 'ok', analyses: [] });
  });

  test('invalid JSON retries exactly once with a reprimand in the retry ctx', async () => {
    const seenCallIndexes: number[] = [];
    const runner = new FakeAgentRunner([
      'definitely not json {',
      (call) => {
        seenCallIndexes.push(call.callIndex);
        return frameAnalysisJson(FRAMES);
      },
    ]);
    const outcome = await runShardAnalysis(runner, FRAMES, CTX);
    expect(outcome).toEqual({ status: 'ok', analyses: EXPECTED_ANALYSES });
    expect(runner.calls.length).toBe(2);
    expect(seenCallIndexes).toEqual([1]);

    const retry = runner.calls[1];
    expect(retry.kind).toBe('analyzeShard');
    expect(retry.frames).toBe(FRAMES);
    expect(retry.ctx?.transcriptSlice.startsWith(`${CTX.transcriptSlice}\n[retry-1]`)).toBe(true);
    expect(retry.ctx?.transcriptSlice).toContain('FrameAnalysis');
    // Everything except the transcript slice is unchanged.
    expect({ ...retry.ctx, transcriptSlice: '' }).toEqual({ ...CTX, transcriptSlice: '' });
  });

  test('persistently invalid output is uncertain and never fabricates frames', async () => {
    const runner = new FakeAgentRunner(['{ not json', '{"frame_id":"f-000001"}']);
    const outcome = await runShardAnalysis(runner, FRAMES, CTX);
    expect(outcome.status).toBe('uncertain');
    expect('analyses' in outcome).toBe(false);
    if (outcome.status !== 'uncertain') throw new Error('expected uncertain');
    expect(outcome.reason).toContain('shard-0001');
    expect(outcome.reason).toContain('first attempt');
    expect(outcome.reason).toContain('retry');
    expect(runner.calls.length).toBe(2);
  });

  test('unknown frame_id in the payload is garbage: retry, then uncertain', async () => {
    const foreign = frameAnalysisJson(FRAMES, [{ frame_id: 'f-999999' }]);
    const runner = new FakeAgentRunner([foreign, foreign]);
    const outcome = await runShardAnalysis(runner, FRAMES, CTX);
    expect(outcome.status).toBe('uncertain');
    expect('analyses' in outcome).toBe(false);
    if (outcome.status !== 'uncertain') throw new Error('expected uncertain');
    expect(outcome.reason).toContain('f-999999');
    expect(runner.calls.length).toBe(2);
    expect(runner.calls[1].ctx?.transcriptSlice).toContain('[retry-1]');
  });

  test('a never-resolving runner throws AgentTimeoutError with an actionable message', async () => {
    const hang: AgentRunner = {
      analyzeShard: () => new Promise<string>(() => {}),
      decide: () => Promise.resolve(''),
    };
    let caught: unknown;
    try {
      await runShardAnalysis(hang, FRAMES, CTX, { timeoutMs: 25 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentTimeoutError);
    const message = (caught as Error).message;
    expect(message).toContain('shard-0001');
    expect(message).toContain('25 ms');
    expect(message).toContain('--max-shards');
    expect(message).toContain('Retry');
    expect(message).toContain('backend');
  });

  test('a runner error propagates instead of being masked as uncertain', async () => {
    const runner = new FakeAgentRunner([new Error('backend down')]);
    await expect(runShardAnalysis(runner, FRAMES, CTX)).rejects.toThrow('backend down');
    expect(runner.calls.length).toBe(1);
  });

  test('the fake throws an actionable error once the script is exhausted', async () => {
    const runner = new FakeAgentRunner([]);
    await expect(runner.analyzeShard(FRAMES, CTX)).rejects.toThrow('script exhausted');
  });
});

describe('FakeAgentRunner.decide', () => {
  test('passes the raw text through and records state and questions', async () => {
    const questions = [{ id: 'q-hook', prompt: 'Is this the hook?' }];
    const runner = new FakeAgentRunner(['{"keep":true}']);
    const raw = await runner.decide('STATE-1', questions);
    expect(raw).toBe('{"keep":true}');
    expect(runner.calls).toEqual([
      { kind: 'decide', callIndex: 0, state: 'STATE-1', questions },
    ]);
  });

  test('works without questions', async () => {
    const runner = new FakeAgentRunner(['raw decision text']);
    expect(await runner.decide('STATE-2')).toBe('raw decision text');
    expect(runner.calls[0].questions).toBeUndefined();
  });
});
