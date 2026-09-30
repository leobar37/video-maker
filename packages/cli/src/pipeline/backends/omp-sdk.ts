/**
 * OMP backend for the `AgentRunner` seam — the `omp` binary IS the SDK.
 *
 * There is no OMP npm SDK: v18.4.3 exposes `-p/--print` and the guaranteed
 * transport is `omp -p --mode json` with the prompt as a single positional
 * argument (plan Open-Q7 fallback). Frame images travel as `@<path>`
 * attachment tokens, the OMP `@file` convention.
 *
 * Real `omp -p --mode json` stdout is an NDJSON event stream, not the model
 * text: the assistant reply rides in `message_end` events
 * (`message.role === 'assistant'`, `text` content parts). {@link extractModelText}
 * unwraps that envelope before the raw text reaches the policy layer.
 *
 * This module only produces RAW model text and process-level errors; JSON
 * parsing and schema validation live in the policy layer (`runShardAnalysis`)
 * so every backend is held to the same contract.
 */
import type { ProcessResult, ProcessRunner } from '@videomaker/providers';

import {
  AgentTimeoutError,
  type AgentQuestion,
  type AgentRunner,
  type AgentShardContext,
  type ShardFrame,
} from '../agent';

/** Default wall-clock budget for one `omp` invocation. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Replacement marker for any filesystem location in error text. */
const REDACTED = '<redacted>';

/** Any absolute `/home/<user>/...` path-looking sequence in free text. */
const HOME_PATH_PATTERN = /\/home\/[\w.-]+(?:\/[\w.@+-]+)*/g;

/** A single markdown code fence (```json … ``` or ``` … ```) wrapping the reply. */
const CODE_FENCE_PATTERN = /^```(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?[ \t]*```$/;

export interface OmpRunnerOptions {
  /** Injectable process seam — real subprocess runner in production, fake in tests. */
  process: ProcessRunner;
  /** OMP overlay config file, passed as `--config <overlayPath>` when set. */
  overlayPath?: string;
  /** Wall-clock budget per `omp` call; defaults to 120_000 ms. */
  timeoutMs?: number;
  /** Home directory to redact from error text (defaults to no home redaction). */
  homeDir?: string;
  /** Working directory for the `omp` process and a redaction prefix for error text. */
  cwd?: string;
}

/**
 * Vision cost metadata for `qa/spend.json` consumers (plan Open-Q2: a constant
 * rate — NO network call is made here to discover prices).
 */
export const VISION_RATE_USD_PER_FRAME = 0.002;

/** Pure estimate of one shard's vision spend: frames × rate. */
export function estimateShardCostUsd(
  frameCount: number,
  rateUsdPerFrame: number = VISION_RATE_USD_PER_FRAME,
): number {
  return frameCount * rateUsdPerFrame;
}

/**
 * Redacts filesystem layout from error text: every occurrence of the `homeDir`
 * or `cwd` prefix — plus the rest of the same whitespace-delimited token, so no
 * path fragment survives — becomes `<redacted>`, as does any other
 * `/home/<user>/...` sequence. Pure; never mutates its input.
 */
export function redactPaths(text: string, opts: { homeDir?: string; cwd?: string }): string {
  const prefixes = [opts.homeDir, opts.cwd]
    .filter((prefix): prefix is string => typeof prefix === 'string' && prefix.length > 1)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const prefix of prefixes) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`${escaped}[^\\s]*`, 'g'), REDACTED);
  }
  return out.replace(HOME_PATH_PATTERN, REDACTED);
}

/** Unwraps a single markdown code fence; any other text is returned untouched. */
function unwrapCodeFence(text: string): string {
  const fenced = CODE_FENCE_PATTERN.exec(text.trim());
  if (fenced === null) {
    return text;
  }
  return fenced[1].trim();
}

/**
 * Extracts the model text from `omp -p --mode json` stdout.
 *
 * Stdout is an NDJSON event stream: from every `message_end` event with
 * `message.role === 'assistant'`, the `text` content parts (`thinking` parts are
 * ignored) are concatenated, and the LAST assistant message that yields text
 * wins. A reply wrapped in a single markdown code fence is unwrapped so the
 * policy layer receives raw JSON text. When no assistant event exists — e.g.
 * plain model text or a raw JSON array from simpler transports/fakes — stdout
 * is returned unchanged.
 */
function extractModelText(stdout: string): string {
  let extracted: string | undefined;
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof event !== 'object' || event === null) {
      continue;
    }
    const record = event as Record<string, unknown>;
    if (record.type !== 'message_end') {
      continue;
    }
    const message = record.message;
    if (typeof message !== 'object' || message === null) {
      continue;
    }
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role !== 'assistant' || !Array.isArray(content)) {
      continue;
    }
    let text = '';
    for (const part of content) {
      if (typeof part !== 'object' || part === null) {
        continue;
      }
      const { type, text: partText } = part as { type?: unknown; text?: unknown };
      if (type === 'text' && typeof partText === 'string') {
        text += partText;
      }
    }
    if (text.length > 0) {
      extracted = text;
    }
  }
  return unwrapCodeFence(extracted ?? stdout);
}

/** Prompt for one vision shard: objective, transcript, and `@<path>` frame attachments. */
function buildAnalyzePrompt(frames: ShardFrame[], ctx: AgentShardContext): string {
  const lines = [
    'You are the vision-analysis agent of a short-vertical-clip pipeline.',
    'Analyze the attached video frames and answer with JSON only.',
    '',
    `Objective: ${ctx.objective}`,
    `Transcript slice for this window: ${ctx.transcriptSlice}`,
  ];
  if (ctx.prevSummary !== undefined && ctx.prevSummary.length > 0) {
    lines.push(`Summary of the previously analyzed window: ${ctx.prevSummary}`);
  }
  lines.push('', 'Frames (one image attachment per line; `@path` opens the file):');
  for (const frame of frames) {
    lines.push(`- frame_id=${frame.frame_id} t=${frame.t}s @${frame.path}`);
  }
  lines.push(
    '',
    'Return ONLY a JSON array with one FrameAnalysis object per frame, in the same order,',
    'echoing each frame_id and t exactly as given. Each object has the fields:',
    'schemaVersion (always 1), frame_id, t, speakers (array of {id, bbox, speaking}),',
    'sceneCut (boolean), energy (0-1), topic (string), highlight (0-1), note (optional string).',
    'No markdown fences, no commentary.',
  );
  return lines.join('\n');
}

/** Prompt for the decision step: the state text plus numbered questions. */
function buildDecidePrompt(state: string, questions?: AgentQuestion[]): string {
  const lines = [
    'You are the decision agent of a short-vertical-clip pipeline.',
    'Be decisive and answer only from the state below.',
    '',
    'State:',
    state,
    '',
  ];
  if (questions !== undefined && questions.length > 0) {
    lines.push('Questions:');
    let number = 1;
    for (const question of questions) {
      lines.push(`${number}. [${question.id}] ${question.prompt}`);
      number += 1;
    }
    lines.push('', 'Answer each question by its number.');
  } else {
    lines.push('Summarize the state and recommend the single best next step.');
  }
  return lines.join('\n');
}

/** One `omp` invocation with the timeout race and process-level error handling. */
async function invokeOmp(
  options: OmpRunnerOptions,
  timeoutMs: number,
  contextLabel: string,
  prompt: string,
): Promise<string> {
  const args = ['-p', '--mode', 'json'];
  if (options.overlayPath !== undefined) {
    args.push('--config', options.overlayPath);
  }
  args.push(prompt);
  const runOpts = options.cwd === undefined ? undefined : { cwd: options.cwd };
  // The executor runs synchronously, so `rejectTimer` is set before the timer
  // callback can fire; the handle is inferred to avoid a platform timer type.
  let rejectTimer: (error: unknown) => void;
  const timeout = new Promise<never>((_, reject) => {
    rejectTimer = reject;
  });
  const timer = setTimeout(() => {
    rejectTimer(new AgentTimeoutError(contextLabel, timeoutMs));
  }, timeoutMs);
  try {
    const result: ProcessResult = await Promise.race([
      options.process.run('omp', args, runOpts),
      timeout,
    ]);
    if (result.code !== 0) {
      const stderr = redactPaths(result.stderr, { homeDir: options.homeDir, cwd: options.cwd });
      throw new Error(`omp backend failed with exit code ${result.code} (${contextLabel}): ${stderr}`);
    }
    return extractModelText(result.stdout);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `AgentRunner` backed by `omp -p --mode json`. Both methods return the
 * extracted model text (envelope unwrapped, raw for the policy layer); on a
 * hang they throw `AgentTimeoutError`, on a nonzero exit an `Error` carrying
 * the exit code and REDACTED stderr.
 */
export function createOmpAgentRunner(options: OmpRunnerOptions): AgentRunner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async analyzeShard(frames: ShardFrame[], ctx: AgentShardContext): Promise<string> {
      return invokeOmp(options, timeoutMs, ctx.shardId, buildAnalyzePrompt(frames, ctx));
    },
    async decide(state: string, questions?: AgentQuestion[]): Promise<string> {
      return invokeOmp(options, timeoutMs, 'decide', buildDecidePrompt(state, questions));
    },
  };
}
