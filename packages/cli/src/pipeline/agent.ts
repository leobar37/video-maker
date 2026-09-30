/**
 * Backend-agnostic agent seam for clip shard analysis.
 *
 * The CLI never talks to a model vendor directly: a backend only implements
 * `AgentRunner` and returns RAW model JSON text. Parsing and schema validation
 * live in the policy layer (`runShardAnalysis`) so every backend is held to the
 * same contract — model garbage is rejected, never coerced or invented.
 */
import { FrameAnalysisSchema, type FrameAnalysis } from '@videomaker/schemas';

/** One frame handed to the agent for analysis (ids match `FRAME_ID_PATTERN`). */
export interface ShardFrame {
  frame_id: string;
  /** Seconds from the start of the source. */
  t: number;
  /** Path to the extracted frame image on disk. */
  path: string;
}

/** Context for one analysis shard. */
export interface AgentShardContext {
  shardId: string;
  sourceSha256: string;
  objective: string;
  transcriptSlice: string;
  prevSummary?: string;
}

/** A question the decision step may ask the agent to answer. */
export interface AgentQuestion {
  id: string;
  prompt: string;
}

/**
 * The only surface a model backend must implement. Both methods return the RAW
 * model text — validation happens in the policy layer, never in backends.
 */
export interface AgentRunner {
  analyzeShard(frames: ShardFrame[], ctx: AgentShardContext): Promise<string>;
  decide(state: string, questions?: AgentQuestion[]): Promise<string>;
}

/** Thrown when a runner call exceeds its time budget (an error, not `uncertain`). */
export class AgentTimeoutError extends Error {
  readonly shardId: string;
  readonly timeoutMs: number;

  constructor(shardId: string, timeoutMs: number) {
    super(
      `Agent shard ${shardId} did not answer within ${timeoutMs} ms. ` +
        'Retry the command, lower --max-shards so each shard is smaller, ' +
        'or check that the agent backend is reachable and healthy.',
    );
    this.name = 'AgentTimeoutError';
    this.shardId = shardId;
    this.timeoutMs = timeoutMs;
  }
}

/** Result of one validated shard analysis: parsed frames or an explicit hole. */
export type ShardAnalysisOutcome =
  | { status: 'ok'; analyses: FrameAnalysis[] }
  | { status: 'uncertain'; reason: string };

const DEFAULT_AGENT_TIMEOUT_MS = 120_000;

/** Failure of one attempt: everything that makes the raw text unusable. */
type ParseFailure = { ok: false; reason: string };
type ParseOutcome = { ok: true; analyses: FrameAnalysis[] } | ParseFailure;

function parseShardAnalyses(raw: string, frames: ShardFrame[]): ParseOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `response is not valid JSON: ${String(error)}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'response must be a JSON array of FrameAnalysis entries.' };
  }
  const requested = new Set(frames.map((frame) => frame.frame_id));
  const analyses: FrameAnalysis[] = [];
  for (const [index, entry] of parsed.entries()) {
    const result = FrameAnalysisSchema.safeParse(entry);
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      return { ok: false, reason: `entry ${index} is not a valid FrameAnalysis — ${detail}` };
    }
    if (!requested.has(result.data.frame_id)) {
      return {
        ok: false,
        reason: `entry ${index} has unknown frame_id ${result.data.frame_id}; only requested frames may be analyzed.`,
      };
    }
    analyses.push(result.data);
  }
  return { ok: true, analyses };
}

/** Races one runner call against the timeout budget. */
async function callWithTimeout(
  call: Promise<string>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), timeoutMs);
    call.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Policy wrapper: validates a shard response against `FrameAnalysisSchema` and
 * retries exactly once on garbage (bad JSON, invalid entries, unknown frame
 * ids) with an English reprimand appended to the transcript slice. A timeout
 * THROWS `AgentTimeoutError`; a second failure yields `uncertain`. Analyses are
 * never invented for missing frames.
 */
export async function runShardAnalysis(
  runner: AgentRunner,
  frames: ShardFrame[],
  ctx: AgentShardContext,
  options?: { timeoutMs?: number },
): Promise<ShardAnalysisOutcome> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const first = parseShardAnalyses(
    await callWithTimeout(
      runner.analyzeShard(frames, ctx),
      timeoutMs,
      () => new AgentTimeoutError(ctx.shardId, timeoutMs),
    ),
    frames,
  );
  if (first.ok) {
    return { status: 'ok', analyses: first.analyses };
  }
  const retryCtx: AgentShardContext = {
    ...ctx,
    transcriptSlice:
      `${ctx.transcriptSlice}\n[retry-1] Previous response was invalid JSON against the FrameAnalysis schema ` +
      `(${first.reason}). Reply with ONLY a JSON array of FrameAnalysis objects — one entry per requested ` +
      'frame_id, no prose, no code fences.',
  };
  const second = parseShardAnalyses(
    await callWithTimeout(
      runner.analyzeShard(frames, retryCtx),
      timeoutMs,
      () => new AgentTimeoutError(ctx.shardId, timeoutMs),
    ),
    frames,
  );
  if (second.ok) {
    return { status: 'ok', analyses: second.analyses };
  }
  return {
    status: 'uncertain',
    reason: `shard ${ctx.shardId} analysis invalid after 1 retry — first attempt: ${first.reason}; retry: ${second.reason}`,
  };
}

/** One recorded call of a `FakeAgentRunner`. */
export interface FakeAgentCallRecord {
  kind: 'analyzeShard' | 'decide';
  /** 0-based index of this call across the runner's whole life. */
  callIndex: number;
  frames?: ShardFrame[];
  ctx?: AgentShardContext;
  state?: string;
  questions?: AgentQuestion[];
}

/** A scripted response: raw text, an error to throw, or a function producing either. */
export type FakeAgentResponse =
  | string
  | Error
  | ((call: { kind: 'analyzeShard' | 'decide'; callIndex: number }) => string | Error);

/**
 * Programmable in-memory `AgentRunner` for tests. Responses are consumed in
 * call order; every call is recorded in `calls` (including the full ctx of
 * retries) so assertions can inspect what the policy layer actually sent.
 */
export class FakeAgentRunner implements AgentRunner {
  readonly calls: FakeAgentCallRecord[] = [];
  private readonly responses: readonly FakeAgentResponse[];

  constructor(responses: FakeAgentResponse[]) {
    this.responses = [...responses];
  }

  async analyzeShard(frames: ShardFrame[], ctx: AgentShardContext): Promise<string> {
    return this.respond('analyzeShard', { frames, ctx });
  }

  async decide(state: string, questions?: AgentQuestion[]): Promise<string> {
    return this.respond('decide', { state, questions });
  }

  private respond(
    kind: FakeAgentCallRecord['kind'],
    args: Omit<FakeAgentCallRecord, 'kind' | 'callIndex'>,
  ): string {
    const record: FakeAgentCallRecord = { kind, callIndex: this.calls.length, ...args };
    this.calls.push(record);
    const scripted = this.responses[record.callIndex];
    if (scripted === undefined) {
      throw new Error(
        `FakeAgentRunner script exhausted at ${kind} call #${record.callIndex}: add another entry ` +
          'to the responses array passed to the constructor.',
      );
    }
    const value =
      typeof scripted === 'function'
        ? scripted({ kind: record.kind, callIndex: record.callIndex })
        : scripted;
    if (value instanceof Error) {
      throw value;
    }
    return value;
  }
}

/**
 * Builds valid raw `FrameAnalysis` JSON for the fake runner — stable public
 * test API. `overrides` is aligned by index with `frames`.
 */
export function frameAnalysisJson(
  frames: ShardFrame[],
  overrides?: Partial<FrameAnalysis>[],
): string {
  const entries = frames.map((frame, index) => {
    const base: FrameAnalysis = {
      schemaVersion: 1,
      frame_id: frame.frame_id,
      t: frame.t,
      speakers: [],
      sceneCut: false,
      energy: 0.5,
      topic: 'general',
      highlight: 0.5,
    };
    for (const [key, value] of Object.entries(overrides?.[index] ?? {})) {
      if (value !== undefined) {
        (base as unknown as Record<string, unknown>)[key] = value;
      }
    }
    return base;
  });
  return JSON.stringify(entries, null, 2);
}
