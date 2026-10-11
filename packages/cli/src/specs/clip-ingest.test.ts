/**
 * clip-ingest contract: plan mode validates args and never touches the process
 * runner or the network; run mode drives yt-dlp once per section (or once for
 * the whole source) and never echoes proxy credentials.
 */
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProcessResult, ProcessRunner } from '@videomaker/providers';
import { makeTestContext, makeTestDeps } from '../pipeline/test-support';
import type { CommandSpec } from '../spec-types';
import { buildClipIngestSpecs, clipIngestSpecs } from './clip-ingest';

function specByVerb(specs: CommandSpec[], verb: string): CommandSpec {
  const spec = specs.find((entry) => entry.verb === verb);
  if (!spec) throw new Error(`missing spec ${verb}`);
  return spec;
}

/** Fake yt-dlp: records argv and materializes the `-o` target. */
function recordingProcess(): { calls: string[][]; runner: ProcessRunner } {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      async run(_command: string, args: readonly string[]): Promise<ProcessResult> {
        calls.push([...args]);
        const at = args.indexOf('-o');
        if (at >= 0 && args[at + 1]) writeFileSync(args[at + 1] as string, 'x');
        return { code: 0, stdout: '', stderr: '' };
      },
    } as ProcessRunner,
  };
}

describe('clip-ingest registry surface', () => {
  test('exposes one plan-capable, unpaid verb', () => {
    expect(clipIngestSpecs.map((spec) => spec.verb)).toEqual(['clip-ingest']);
    expect(clipIngestSpecs[0]!.supportsPlan).toBe(true);
    expect(clipIngestSpecs[0]!.paid).toBeUndefined();
    expect(clipIngestSpecs[0]!.movesGates).toEqual([]);
  });
});

describe('clip-ingest plan (pure)', () => {
  test('lists the sections and redacts proxy credentials', async () => {
    const { calls, runner } = recordingProcess();
    const deps = { ...makeTestDeps(), process: runner };
    const ctx = makeTestContext(
      {
        project: 'proj',
        url: 'https://youtu.be/x',
        proxy: 'http://user:secret@127.0.0.1:8118',
        section: ['1700-1760', '1800-1860'],
      },
      { mode: 'plan' },
    );
    const steps = await specByVerb(buildClipIngestSpecs(deps), 'clip-ingest').plan!(ctx);
    expect(steps[0]!.action).toContain('2 section(s)');
    expect(steps[0]!.action).toContain('127.0.0.1:8118');
    expect(steps[0]!.action).not.toContain('secret');
    expect(calls).toHaveLength(0);
  });

  test('mentions reuse when --reuse-existing is set', async () => {
    const deps = { ...makeTestDeps(), process: recordingProcess().runner };
    const ctx = makeTestContext(
      { project: 'p', url: 'https://youtu.be/x', 'reuse-existing': true },
      { mode: 'plan' },
    );
    const steps = await specByVerb(buildClipIngestSpecs(deps), 'clip-ingest').plan!(ctx);
    expect(steps[0]!.action).toContain('Keep the existing clips/source.mp4');
  });

  test('rejects a malformed section without touching the process', () => {
    const { calls, runner } = recordingProcess();
    const deps = { ...makeTestDeps(), process: runner };
    const ctx = makeTestContext({ project: 'p', url: 'u', section: ['nope'] }, { mode: 'plan' });
    const spec = specByVerb(buildClipIngestSpecs(deps), 'clip-ingest');
    expect(() => spec.plan!(ctx)).toThrow(/cannot read "nope"/);
    expect(calls).toHaveLength(0);
  });
});

describe('clip-ingest run', () => {
  test('downloads one file per section through yt-dlp with the proxy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-ingest-'));
    const { calls, runner } = recordingProcess();
    const deps = { ...makeTestDeps(), process: runner };
    const lines: string[] = [];
    const ctx = makeTestContext(
      { project: dir, url: 'https://youtu.be/x', proxy: 'http://127.0.0.1:8118', section: ['10-20', '30-40'] },
      { mode: 'run', lines },
    );
    const result = await specByVerb(buildClipIngestSpecs(deps), 'clip-ingest').run!(ctx);
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('--download-sections');
    expect(calls[0]).toContain('*10-20');
    expect(calls[0]).toContain('--proxy');
    const payload = JSON.parse(lines[0]!);
    expect(payload.count).toBe(2);
    expect(payload.paths[0]).toMatch(/clips\/sections\/01-10-20\.mp4$/);
    expect(payload.paths[1]).toMatch(/02-30-40\.mp4$/);
  });

  test('fetches the whole source when no section is given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-ingest-full-'));
    const { calls, runner } = recordingProcess();
    const deps = { ...makeTestDeps(), process: runner };
    const lines: string[] = [];
    const ctx = makeTestContext({ project: dir, url: 'https://youtu.be/x' }, { mode: 'run', lines });
    await specByVerb(buildClipIngestSpecs(deps), 'clip-ingest').run!(ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('--download-sections');
    expect(JSON.parse(lines[0]!).source).toMatch(/clips\/source\.mp4$/);
  });

  test('refuses side effects in plan mode', async () => {
    const deps = { ...makeTestDeps(), process: recordingProcess().runner };
    const ctx = makeTestContext({ project: 'p', url: 'u' }, { mode: 'plan' });
    await expect(specByVerb(buildClipIngestSpecs(deps), 'clip-ingest').run!(ctx)).rejects.toThrow(
      /plan mode/,
    );
  });
});
