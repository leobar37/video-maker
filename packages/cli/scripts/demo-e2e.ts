#!/usr/bin/env bun
/**
 * `bun run demo:e2e -- [--spend-cap <usd>] [--mode <live|offline>] [--project <dir>]
 *    [--allow-music-provider]` — end-to-end demo run of the video pipeline.
 *
 * `live` mode resolves credentials lazily in run mode and performs the real
 * paid submits (TTS, and music generation only with `--allow-music-provider`
 * plus cap headroom) through the core paid-operation engine; every attempt is
 * journalled with its receipt in `qa/spend.json`. `offline` mode runs the SAME
 * pipeline shape with locally synthesized narration and music ($0 journal
 * entries marked `offline:`) so the run needs no credentials and never spends.
 *
 * The driver refuses paid operations without an explicit `--spend-cap`
 * (printing the planned costs first), self-checks its own artifacts for
 * plausible secrets (NFR-001: values are never printed), verifies the render
 * with ffprobe and the loudness tolerance, and writes the final report to
 * `projects/demo/hello/qa/metrics.json`. Publication is `--dry-run` only.
 */
import { runE2e } from '../src/e2e/run';

async function main(): Promise<void> {
  const result = await runE2e({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    out: (line) => process.stdout.write(`${line}\n`),
  });
  process.exitCode = result.exitCode;
}

main().catch((error) => {
  process.stderr.write(`demo-e2e: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
