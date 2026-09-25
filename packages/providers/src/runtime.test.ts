/**
 * runtime: the concrete `Clock` and `ProcessRunner` implementations behind the
 * ports. Processes are local only — no network anywhere.
 */
import { describe, expect, test } from 'bun:test';

import { bunProcessRunner, systemClock } from './runtime';

describe('systemClock', () => {
  test('returns a real current date', () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(now.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(now.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('bunProcessRunner', () => {
  test('captures stdout, stderr and the exit code', async () => {
    const result = await bunProcessRunner.run('echo', ['hola']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('hola');
    expect(result.stderr).toBe('');
  });

  test('non-zero exits are returned, not thrown', async () => {
    const result = await bunProcessRunner.run('false', []);
    expect(result.code).not.toBe(0);
  });
});
