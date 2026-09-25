/**
 * Concrete implementations of the injectable primitives from `./ports`:
 * a wall-clock and a Bun-backed process runner (used for the ffmpeg
 * transcode steps behind the media adapters).
 */
import type { Clock, ProcessResult, ProcessRunner } from './ports';

/** Wall clock. Tests inject a fixed `Clock` instead. */
export const systemClock: Clock = {
  now: () => new Date(),
};

/**
 * `ProcessRunner` over `Bun.spawn`: inherits nothing extra, captures stdout/
 * stderr and never raises on non-zero exit codes — the caller decides.
 */
export const bunProcessRunner: ProcessRunner = {
  async run(
    command: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<ProcessResult> {
    const proc = Bun.spawn([command, ...args], {
      cwd: opts?.cwd,
      env: { ...process.env, ...(opts?.env ?? {}) },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  },
};
