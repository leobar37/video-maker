/**
 * Driver argv contract: defaults, flag forms and every usage refusal.
 */
import { describe, expect, test } from 'bun:test';

import { E2eUsageError, parseE2eArgs } from './args';

describe('parseE2eArgs', () => {
  test('defaults: live mode, demo project, no cap, no music provider', () => {
    expect(parseE2eArgs([])).toEqual({
      mode: 'live',
      project: 'projects/demo/hello',
      spendCapUsd: undefined,
      allowMusicProvider: false,
    });
  });

  test('parses every flag (space and = forms)', () => {
    expect(
      parseE2eArgs([
        '--spend-cap',
        '1.5',
        '--mode=offline',
        '--project',
        'tmp/proj',
        '--allow-music-provider',
      ]),
    ).toEqual({
      mode: 'offline',
      project: 'tmp/proj',
      spendCapUsd: 1.5,
      allowMusicProvider: true,
    });
  });

  test('accepts a zero cap (explicitly free operations)', () => {
    expect(parseE2eArgs(['--spend-cap', '0']).spendCapUsd).toBe(0);
  });

  test('rejects unknown arguments with usage detail', () => {
    expect(() => parseE2eArgs(['--nope'])).toThrow(E2eUsageError);
    expect(() => parseE2eArgs(['--nope'])).toThrow('unknown argument --nope');
  });

  test('rejects invalid values', () => {
    expect(() => parseE2eArgs(['--spend-cap', 'abc'])).toThrow('--spend-cap');
    expect(() => parseE2eArgs(['--spend-cap', '-2'])).toThrow('--spend-cap');
    expect(() => parseE2eArgs(['--mode', 'staging'])).toThrow('--mode');
    expect(() => parseE2eArgs(['--project'])).toThrow('missing value');
    expect(() => parseE2eArgs(['--project', ''])).toThrow('--project');
  });
});
