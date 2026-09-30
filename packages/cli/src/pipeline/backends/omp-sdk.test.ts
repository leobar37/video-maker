/**
 * OMP backend: transport flags, raw stdout passthrough, timeout, redacted
 * failures, cost math, and the backend registry (including the Jev seam).
 */
import { describe, expect, test } from 'bun:test';
import type { ProcessResult, ProcessRunner } from '@videomaker/providers';

import { AgentTimeoutError, type AgentShardContext, type ShardFrame } from '../agent';
import { BACKEND_IDS, createAgentRunner } from './index';
import { JevBackendNotImplementedError } from './jev';
import {
  createOmpAgentRunner,
  estimateShardCostUsd,
  redactPaths,
  VISION_RATE_USD_PER_FRAME,
} from './omp-sdk';

const FRAMES: ShardFrame[] = [
  { frame_id: 'f-000001', t: 0, path: 'frames/f-000001.jpg' },
  { frame_id: 'f-000002', t: 1.5, path: 'frames/f-000002.jpg' },
];

const CTX: AgentShardContext = {
  shardId: 'shard-0001',
  sourceSha256: 'a'.repeat(64),
  objective: 'Find the hook of the video.',
  transcriptSlice: 'Welcome back to the show.',
  prevSummary: 'The speaker introduces the topic.',
};

const RAW_MODEL_TEXT = '[{"frame_id":"f-000001"}]';

const MODEL_REPLY = '[{"frame_id":"f-000001","t":0}]';

/** NDJSON event envelope like real `omp -p --mode json` stdout. */
function ndjsonEnvelope(reply: string): string {
  return [
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 's-1',
      timestamp: '2026-09-29T00:00:00Z',
      cwd: '/home/alice/proj',
    }),
    JSON.stringify({ type: 'advisor_cost_changed' }),
    JSON.stringify({ type: 'agent_start' }),
    JSON.stringify({ type: 'turn_start' }),
    JSON.stringify({
      type: 'message_start',
      message: { role: 'user', content: [{ type: 'text', text: 'prompt text' }] },
    }),
    JSON.stringify({
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text: 'prompt text' }] },
    }),
    JSON.stringify({
      type: 'message_start',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'let me inspect the frames' }] },
    }),
    JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'let me inspect the frames' },
          { type: 'text', text: reply },
        ],
      },
    }),
    JSON.stringify({ type: 'turn_end' }),
  ].join('\n');
}

interface RecordedCall {
  command: string;
  args: string[];
  opts?: { cwd?: string; env?: Record<string, string> };
}

/** Scriptable `ProcessRunner` that records every invocation. */
class FakeProcessRunner implements ProcessRunner {
  readonly calls: RecordedCall[] = [];
  private readonly impl: (command: string, args: string[]) => Promise<ProcessResult> | ProcessResult;

  constructor(impl: (command: string, args: string[]) => Promise<ProcessResult> | ProcessResult) {
    this.impl = impl;
  }

  async run(
    command: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<ProcessResult> {
    this.calls.push({ command, args, opts });
    return this.impl(command, args);
  }
}

function succeedingRunner(stdout: string): FakeProcessRunner {
  return new FakeProcessRunner(() => ({ code: 0, stdout, stderr: '' }));
}

describe('createOmpAgentRunner — success path', () => {
  test('passes [-p, --mode, json] with the prompt positional and returns stdout raw', async () => {
    const fake = succeedingRunner(RAW_MODEL_TEXT);
    const runner = createOmpAgentRunner({ process: fake });

    const raw = await runner.analyzeShard(FRAMES, CTX);

    expect(raw).toBe(RAW_MODEL_TEXT);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call.command).toBe('omp');
    expect(call.args.slice(0, 3)).toEqual(['-p', '--mode', 'json']);
    expect(call.args).not.toContain('--config');
    expect(call.args).toHaveLength(4);
    const prompt = call.args[3];
    expect(prompt).toContain(`@${FRAMES[0].path}`);
    expect(prompt).toContain(`@${FRAMES[1].path}`);
    expect(prompt).toContain(CTX.objective);
    expect(prompt).toContain(CTX.transcriptSlice);
    expect(prompt).toContain(CTX.prevSummary as string);
    expect(prompt).toContain(FRAMES[0].frame_id);
    expect(prompt).toContain(FRAMES[1].frame_id);
  });

  test('adds --config <overlay> before the prompt when overlayPath is set', async () => {
    const fake = succeedingRunner(RAW_MODEL_TEXT);
    const runner = createOmpAgentRunner({ process: fake, overlayPath: '/overlay/omp.json' });

    await runner.analyzeShard(FRAMES, CTX);

    const call = fake.calls[0];
    expect(call.args.slice(0, 5)).toEqual([
      '-p',
      '--mode',
      'json',
      '--config',
      '/overlay/omp.json',
    ]);
    expect(call.args).toHaveLength(6);
  });

  test('decide builds a numbered decision prompt and returns stdout raw', async () => {
    const fake = succeedingRunner('{"decision":true}');
    const runner = createOmpAgentRunner({ process: fake, cwd: '/work/run' });

    const raw = await runner.decide('Windows A and B are candidates.', [
      { id: 'form', prompt: 'single or duo?' },
      { id: 'keep', prompt: 'keep or discard?' },
    ]);

    expect(raw).toBe('{"decision":true}');
    const call = fake.calls[0];
    expect(call.command).toBe('omp');
    expect(call.args.slice(0, 3)).toEqual(['-p', '--mode', 'json']);
    expect(call.opts).toEqual({ cwd: '/work/run' });
    const prompt = call.args[3];
    expect(prompt).toContain('Windows A and B are candidates.');
    expect(prompt).toContain('1. [form] single or duo?');
    expect(prompt).toContain('2. [keep] keep or discard?');
  });
});

describe('createOmpAgentRunner — NDJSON envelope extraction', () => {
  test('extracts the assistant reply, ignoring user and thinking parts', async () => {
    const fake = succeedingRunner(ndjsonEnvelope(MODEL_REPLY));
    const runner = createOmpAgentRunner({ process: fake });

    const raw = await runner.analyzeShard(FRAMES, CTX);

    expect(raw).toBe(MODEL_REPLY);
    expect(raw).not.toContain('prompt text');
    expect(raw).not.toContain('let me inspect');
  });

  test('unwraps a single markdown code fence around the reply', async () => {
    const jsonFenced = succeedingRunner(ndjsonEnvelope(`\`\`\`json\n${MODEL_REPLY}\n\`\`\``));
    const bareFenced = succeedingRunner(ndjsonEnvelope(`\`\`\`\n${MODEL_REPLY}\n\`\`\``));

    expect(await createOmpAgentRunner({ process: jsonFenced }).analyzeShard(FRAMES, CTX)).toBe(
      MODEL_REPLY,
    );
    expect(await createOmpAgentRunner({ process: bareFenced }).analyzeShard(FRAMES, CTX)).toBe(
      MODEL_REPLY,
    );
  });

  test('uses the last assistant message_end and concatenates text parts', async () => {
    const lastWins = new FakeProcessRunner(() => ({
      code: 0,
      stdout:
        ndjsonEnvelope('FIRST-REPLY') +
        '\n' +
        JSON.stringify({
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text: MODEL_REPLY }] },
        }),
      stderr: '',
    }));
    expect(await createOmpAgentRunner({ process: lastWins }).decide('state')).toBe(MODEL_REPLY);

    const partsJoined = succeedingRunner(
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'part-1 ' },
            { type: 'text', text: 'part-2' },
          ],
        },
      }),
    );
    expect(await createOmpAgentRunner({ process: partsJoined }).decide('state')).toBe('part-1 part-2');
  });

  test('falls back to stdout unchanged when there is no envelope', async () => {
    const plain = succeedingRunner('plain model text');
    expect(await createOmpAgentRunner({ process: plain }).decide('state')).toBe('plain model text');

    const rawArray = succeedingRunner(RAW_MODEL_TEXT);
    expect(await createOmpAgentRunner({ process: rawArray }).analyzeShard(FRAMES, CTX)).toBe(
      RAW_MODEL_TEXT,
    );
  });
});

describe('createOmpAgentRunner — timeout', () => {
  test('a hanging process.run plus a small timeoutMs throws AgentTimeoutError', async () => {
    const fake = new FakeProcessRunner(() => new Promise<ProcessResult>(() => {}));
    const runner = createOmpAgentRunner({ process: fake, timeoutMs: 20 });

    let caught: unknown = undefined;
    try {
      await runner.analyzeShard(FRAMES, CTX);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentTimeoutError);
    const timeout = caught as AgentTimeoutError;
    expect(timeout.shardId).toBe('shard-0001');
    expect(timeout.timeoutMs).toBe(20);
    expect(timeout.message).toContain('shard-0001');
    expect(timeout.message).toContain('20 ms');
    expect(timeout.message).toContain('Retry');
  });

  test('decide hangs also throw AgentTimeoutError with the decide context', async () => {
    const fake = new FakeProcessRunner(() => new Promise<ProcessResult>(() => {}));
    const runner = createOmpAgentRunner({ process: fake, timeoutMs: 20 });

    let caught: unknown = undefined;
    try {
      await runner.decide('state');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentTimeoutError);
    expect((caught as AgentTimeoutError).shardId).toBe('decide');
  });
});

describe('createOmpAgentRunner — nonzero exit', () => {
  test('throws an error with the exit code and REDACTED stderr', async () => {
    const fake = new FakeProcessRunner(() => ({
      code: 3,
      stdout: '',
      stderr:
        'error: cannot open /home/alice/work/run-1/frames/f-000001.jpg\n' +
        'ENOENT /home/alice/.omp/cache/model.bin',
    }));
    const runner = createOmpAgentRunner({
      process: fake,
      homeDir: '/home/alice',
      cwd: '/home/alice/work/run-1',
    });

    let caught: unknown = undefined;
    try {
      await runner.analyzeShard(FRAMES, CTX);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(AgentTimeoutError);
    const message = (caught as Error).message;
    expect(message).toContain('exit code 3');
    expect(message).toContain('<redacted>');
    expect(message).not.toContain('/home/alice');
    expect(message).not.toContain('work/run-1');
    expect(message).not.toContain('frames/f-000001.jpg');
  });
});

describe('redactPaths', () => {
  test('replaces the homeDir prefix and the rest of the path token', () => {
    expect(redactPaths('cannot open /home/alice/proj/a.jpg', { homeDir: '/home/alice' })).toBe(
      'cannot open <redacted>',
    );
  });

  test('replaces the cwd prefix', () => {
    expect(redactPaths('fail at /srv/ci/workspace-7/out.mp4 ok', { cwd: '/srv/ci/workspace-7' })).toBe(
      'fail at <redacted> ok',
    );
  });

  test('redacts both prefixes, longest first', () => {
    expect(
      redactPaths('/home/alice/work/x and /home/alice/y', {
        homeDir: '/home/alice',
        cwd: '/home/alice/work',
      }),
    ).toBe('<redacted> and <redacted>');
  });

  test('redacts any /home/<user>/... sequence even without explicit prefixes', () => {
    expect(redactPaths('boom /home/bob/x/y.txt done', {})).toBe('boom <redacted> done');
    expect(redactPaths('boom /home/bob.deep/dir-x/y.txt done', {})).toBe('boom <redacted> done');
  });

  test('leaves text without paths untouched and does not touch /etc paths', () => {
    expect(redactPaths('no paths here', { homeDir: '/home/alice' })).toBe('no paths here');
    expect(redactPaths('read /etc/hosts', {})).toBe('read /etc/hosts');
  });

  test('is pure — repeated calls give the same result', () => {
    const input = 'x /home/bob/y';
    const first = redactPaths(input, {});
    expect(redactPaths(input, {})).toBe(first);
    expect(input).toBe('x /home/bob/y');
  });
});

describe('estimateShardCostUsd', () => {
  test('multiplies frames by the default vision rate', () => {
    expect(VISION_RATE_USD_PER_FRAME).toBe(0.002);
    expect(estimateShardCostUsd(500)).toBe(500 * VISION_RATE_USD_PER_FRAME);
    expect(estimateShardCostUsd(3)).toBeCloseTo(0.006);
  });

  test('honors a custom rate and zero frames', () => {
    expect(estimateShardCostUsd(3, 0.01)).toBe(3 * 0.01);
    expect(estimateShardCostUsd(0)).toBe(0);
  });
});

describe('createAgentRunner registry', () => {
  test('BACKEND_IDS lists omp and jev', () => {
    expect(BACKEND_IDS).toEqual(['omp', 'jev']);
  });

  test("'omp' wires the OMP runner", async () => {
    const fake = succeedingRunner('ok');
    const runner = createAgentRunner('omp', { process: fake });
    await runner.decide('state');
    expect(fake.calls[0].command).toBe('omp');
    expect(fake.calls[0].args.slice(0, 3)).toEqual(['-p', '--mode', 'json']);
  });

  test("'jev' throws JevBackendNotImplementedError with an actionable message", () => {
    const fake = succeedingRunner('unused');
    expect(() => createAgentRunner('jev', { process: fake })).toThrow(JevBackendNotImplementedError);
    let caught: unknown = undefined;
    try {
      createAgentRunner('jev', { process: fake });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JevBackendNotImplementedError);
    expect((caught as Error).message).toContain('--backend omp');
  });
});
