/**
 * clip-cut spec contract: plan mode reads local files only, run mode drives the
 * pure pipeline through the injected process runner and writes the manifest.
 */
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProcessResult, ProcessRunner } from '@videomaker/providers';
import { makeTestContext, makeTestDeps } from '../pipeline/test-support';
import type { CommandSpec } from '../spec-types';
import { buildClipCutSpecs, clipCutSpecs } from './clip-cut';

function specByVerb(specs: CommandSpec[], verb: string): CommandSpec {
  const spec = specs.find((entry) => entry.verb === verb);
  if (!spec) throw new Error(`missing spec ${verb}`);
  return spec;
}

const ABSOLUTE_SILENCES = [
  { startSec: 12.0, endSec: 12.6 },
  { startSec: 40.0, endSec: 40.8 },
];

/** Records argv: ffprobe reports A/V streams; ffmpeg reports window-relative silences. */
function fakeProcess(): { calls: string[][]; runner: ProcessRunner } {
  const calls: string[][] = [];
  return {
    calls,
    runner: {
      async run(command: string, args: readonly string[]): Promise<ProcessResult> {
        calls.push([command, ...args]);
        if (command === 'ffprobe') {
          return {
            code: 0,
            stdout: JSON.stringify({
              streams: [{ codec_type: 'video' }, { codec_type: 'audio' }],
            }),
            stderr: '',
          };
        }
        // `-ss X` resets timestamps, so silencedetect reports times relative to X.
        const sliceStart = Number(args[args.indexOf('-ss') + 1] ?? 0);
        const lines = ABSOLUTE_SILENCES.flatMap((silence) => [
          `[silencedetect @ 0x1] silence_start: ${silence.startSec - sliceStart}`,
          `[silencedetect @ 0x1] silence_end: ${silence.endSec - sliceStart} | silence_duration: 0.6`,
        ]);
        return { code: 0, stdout: '', stderr: lines.join('\n') };
      },
    } as ProcessRunner,
  };
}

async function projectWithPlan(clipCount = 1): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vm-clip-cut-'));
  await mkdir(join(dir, 'clips'), { recursive: true });
  await writeFile(join(dir, 'clips/source.mp4'), 'x');
  await writeFile(
    join(dir, 'clips/clip-plan.json'),
    JSON.stringify({
      clips: Array.from({ length: clipCount }, (_, index) => ({
        id: `c${index + 1}`,
        startSec: 12.7 + index * 60,
        endSec: 40.4 + index * 60,
      })),
    }),
  );
  await writeFile(
    join(dir, 'source-reactions.json'),
    JSON.stringify({ events: [{ peakSec: 30, riseDb: 9 }] }),
  );
  return dir;
}

describe('clip-cut registry surface', () => {
  test('exposes one plan-capable, unpaid verb writing renders/clips', () => {
    expect(clipCutSpecs.map((spec) => spec.verb)).toEqual(['clip-cut']);
    expect(clipCutSpecs[0]!.supportsPlan).toBe(true);
    expect(clipCutSpecs[0]!.paid).toBeUndefined();
    expect(clipCutSpecs[0]!.writes).toContain('renders/clips/manifest.json');
  });
});

describe('clip-cut plan (local reads only)', () => {
  test('lists the clip count and layout without running ffmpeg', async () => {
    const dir = await projectWithPlan();
    const { calls, runner } = fakeProcess();
    const deps = { ...makeTestDeps(), process: runner };
    const ctx = makeTestContext({ project: dir, layout: 'crop' }, { mode: 'plan' });
    const steps = await specByVerb(buildClipCutSpecs(deps), 'clip-cut').plan!(ctx);
    expect(steps[0]!.action).toContain('Cut 1 clip(s)');
    expect(steps[0]!.action).toContain('layout crop');
    expect(calls).toHaveLength(0);
  });

  test('fails on a missing plan', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-cut-noplan-'));
    const deps = { ...makeTestDeps(), process: fakeProcess().runner };
    const ctx = makeTestContext({ project: dir }, { mode: 'plan' });
    await expect(specByVerb(buildClipCutSpecs(deps), 'clip-cut').plan!(ctx)).rejects.toThrow(
      /cannot read clip plan/,
    );
  });
});

describe('clip-cut run', () => {
  test('snaps to silence, cuts and writes the manifest', async () => {
    const dir = await projectWithPlan();
    const { calls, runner } = fakeProcess();
    const deps = { ...makeTestDeps(), process: runner };
    const lines: string[] = [];
    const ctx = makeTestContext(
      { project: dir, peaks: 'source-reactions.json' },
      { mode: 'run', lines },
    );
    const result = await specByVerb(buildClipCutSpecs(deps), 'clip-cut').run!(ctx);
    expect(result.exitCode).toBe(0);

    const manifest = JSON.parse(await readFile(join(dir, 'renders/clips/manifest.json'), 'utf8'));
    expect(lines[0]).toContain('clip-cut: 1 clip(s)');
    expect(manifest.clips[0].id).toBe('c1');
    // start 12.7 -> silence end 12.6 ; end 40.4 -> silence start 40.0
    expect(manifest.clips[0].sourceStartSec).toBe(12.6);
    expect(manifest.clips[0].sourceEndSec).toBe(40);
    expect(manifest.clips[0].cover).toMatch(/c1\.png$/);

    const cut = calls.find((call) => call[0] === 'ffmpeg' && call.includes('-filter_complex'));
    expect(cut).toBeDefined();
    expect(cut!.join(' ')).toContain('loudnorm=I=-16:TP=-2:LRA=11');
    const still = calls.filter((call) => call[0] === 'ffmpeg' && call.includes('-frames:v'));
    expect(still).toHaveLength(1);
    expect(still[0]![still[0]!.indexOf('-ss') + 1]).toBe('30');
  });

  test('jobs > 1 still renders every clip exactly once', async () => {
    const dir = await projectWithPlan(3);
    const { calls, runner } = fakeProcess();
    const deps = { ...makeTestDeps(), process: runner };
    const lines: string[] = [];
    const ctx = makeTestContext({ project: dir, jobs: 3 }, { mode: 'run', lines });
    const result = await specByVerb(buildClipCutSpecs(deps), 'clip-cut').run!(ctx);
    expect(result.exitCode).toBe(0);
    expect(lines[0]).toContain('clip-cut: 3 clip(s)');
    const manifest = JSON.parse(await readFile(join(dir, 'renders/clips/manifest.json'), 'utf8'));
    expect(manifest.clips.map((c: { id: string }) => c.id)).toEqual(['c1', 'c2', 'c3']);
    const cuts = calls.filter((call) => call[0] === 'ffmpeg' && call.includes('-filter_complex'));
    expect(cuts).toHaveLength(3);
  });
});
