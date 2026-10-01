/**
 * clipAnalysisSpecs contract: the analysis trio as DATA — registry surface,
 * plan() purity (NFR-002: zero process/fetch/secret calls), run() refusing
 * plan mode, the paid `--submit`/`--spend-cap` refusals, and per-shard cost
 * estimates against fixtures with fully faked process seams.
 */
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProcessRunner } from '@videomaker/providers';

import { allSpecs } from '../all-specs';
import { runSpecs } from '../runtime';
import type { CommandSpec } from '../spec-types';
import { CliFailError, makeTestContext, makeTestDeps } from '../pipeline/test-support';
import { frameAnalysisJson, type ShardFrame } from '../pipeline/agent';
import { estimateShardCostUsd } from '../pipeline/backends/omp-sdk';
import { FileSpendLedger, spendLedgerPath } from '../pipeline/spend-ledger';
import { buildClipAnalysisSpecs, clipAnalysisSpecs } from './clip';

function specByVerb(specs: CommandSpec[], verb: string): CommandSpec {
  const spec = specs.find((entry) => entry.verb === verb);
  if (!spec) throw new Error(`missing spec ${verb}`);
  return spec;
}

/** SHA-256 of the three bytes `abc` (fixed digest, no self-comparison). */
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

/** Fake ffprobe output: 1080×1920 @ 30 fps, 5.2 s. */
const PROBE_JSON = JSON.stringify({
  streams: [{ width: 1080, height: 1920, r_frame_rate: '30/1' }],
  format: { duration: '5.2' },
});

/**
 * `clips/` fixture: 6 frames (f-000001..f-000006 at t=0..5) and two shards —
 * shard-001 analyzable [f-000001, f-000002], shard-002 analyzable
 * [f-000004..f-000006] with f-000003 as context-only.
 */
async function makeClipsProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vm-clip-'));
  await mkdir(join(dir, 'clips', 'frames'), { recursive: true });
  const frames = {
    schemaVersion: 1,
    frames: Array.from({ length: 6 }, (_, index) => ({
      frame_id: `f-${String(index + 1).padStart(6, '0')}`,
      t: index,
      path: `clips/frames/f-${String(index + 1).padStart(6, '0')}.jpg`,
      rol: 'key',
    })),
  };
  const shards = {
    schemaVersion: 1,
    shardSize: 60,
    shards: [
      {
        id: 'shard-001',
        frameIds: ['f-000001', 'f-000002'],
        contextOnlyFrameIds: [],
        prevSummary: '',
      },
      {
        id: 'shard-002',
        frameIds: ['f-000003', 'f-000004', 'f-000005', 'f-000006'],
        contextOnlyFrameIds: ['f-000003'],
        prevSummary: 'previous window summary',
      },
    ],
  };
  await writeFile(
    join(dir, 'clips', 'source.json'),
    JSON.stringify({
      schemaVersion: 1,
      path: 'source.mp4',
      durationSeconds: 6,
      width: 1080,
      height: 1920,
      fps: 30,
      sha256: SHA256_ABC,
    }),
  );
  await writeFile(join(dir, 'clips', 'frames.json'), JSON.stringify(frames));
  await writeFile(join(dir, 'clips', 'shards.json'), JSON.stringify(shards));
  await writeFile(
    join(dir, 'clips', 'transcript.json'),
    JSON.stringify({
      schemaVersion: 1,
      language: 'es',
      words: [
        { word: 'hola', start: 0, end: 0.4 },
        { word: 'mundo', start: 0.5, end: 1 },
        { word: 'final', start: 4, end: 4.5 },
      ],
    }),
  );
  return dir;
}

interface RecordedCall {
  command: string;
  args: string[];
}

function fakeProcess(
  handle: (command: string, args: string[]) => { code: number; stdout: string; stderr: string },
): { runner: ProcessRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    runner: {
      async run(command, args) {
        calls.push({ command, args: [...args] });
        return handle(command, args);
      },
    },
  };
}

/** Raw FrameAnalysis JSON echoing the frames listed in an omp prompt. */
function echoAnalysis(prompt: string): string {
  const frames: ShardFrame[] = [];
  for (const match of prompt.matchAll(/frame_id=(f-\d{6}) t=([\d.]+)s/g)) {
    frames.push({ frame_id: match[1]!, t: Number(match[2]), path: '' });
  }
  return frameAnalysisJson(frames);
}

describe('clipAnalysisSpecs registry surface', () => {
  test('registers clip-frames / clip-transcribe / clip-analyze with plan support', () => {
    expect(clipAnalysisSpecs.map((spec) => spec.verb)).toEqual([
      'clip-frames',
      'clip-transcribe',
      'clip-analyze',
    ]);
    for (const verb of ['clip-frames', 'clip-transcribe', 'clip-analyze']) {
      expect(allSpecs().some((spec) => spec.verb === verb)).toBe(true);
    }
    for (const spec of clipAnalysisSpecs) {
      expect(spec.supportsPlan).toBe(true);
    }
    expect(specByVerb(clipAnalysisSpecs, 'clip-frames').args.map((arg) => arg.name)).toEqual([
      'project',
      'src',
      'frame-every',
      'shard-size',
      'context-frames',
      'keys',
      'key-fps',
      'key-margin',
    ]);
    const srcArg = specByVerb(clipAnalysisSpecs, 'clip-frames').args[1];
    expect(srcArg?.name).toBe('src');
    // --src is enforced in run() only, so `clip-frames . --plan` works flagless.
    expect(srcArg?.required).toBeUndefined();
    const analyze = specByVerb(clipAnalysisSpecs, 'clip-analyze');
    expect(analyze.paid).toBe(true);
    expect(analyze.supportsPlan).toBe(true);
    expect(analyze.args.map((arg) => arg.name)).toEqual([
      'project',
      'submit',
      'spend-cap',
      'backend',
      'max-shards',
      'jobs',
      'timeout-ms',
      'objective',
    ]);
    expect(analyze.movesGates).toEqual(['spend']);
  });
});

describe('plan() purity (NFR-002)', () => {
  test('no process, fetch or secret calls for any verb', async () => {
    const dir = await makeClipsProject();
    const base = makeTestDeps();
    const processCalls: string[] = [];
    const deps = {
      ...base,
      process: {
        async run(command: string) {
          processCalls.push(command);
          return { code: 0, stdout: '', stderr: '' };
        },
      },
    };
    for (const spec of buildClipAnalysisSpecs(deps)) {
      const steps = await spec.plan(makeTestContext({ project: dir }, { mode: 'plan' }));
      expect(Array.isArray(steps)).toBe(true);
    }
    expect(processCalls).toEqual([]);
    expect(base.calls.fetch).toBe(0);
    expect(base.calls.secrets).toEqual([]);
    expect(base.calls.submits).toEqual([]);
  });

  test('clip-analyze --plan estimates per-shard cost without invoking any runner', async () => {
    const dir = await makeClipsProject();
    const base = makeTestDeps();
    const processCalls: string[] = [];
    const deps = {
      ...base,
      process: {
        async run(command: string) {
          processCalls.push(command);
          return { code: 0, stdout: '', stderr: '' };
        },
      },
    };
    const analyze = specByVerb(buildClipAnalysisSpecs(deps), 'clip-analyze');
    const steps = await analyze.plan(makeTestContext({ project: dir }, { mode: 'plan' }));
    expect(processCalls).toEqual([]);
    const shardSteps = steps.filter((step) => step.writes?.startsWith('clips/analysis/'));
    expect(shardSteps.map((step) => step.writes)).toEqual([
      'clips/analysis/shard-001.json',
      'clips/analysis/shard-002.json',
    ]);
    // shard-001: 2 analyzable frames; shard-002: 4 frames minus 1 context = 3.
    expect(shardSteps[0]?.costUsd).toBe(estimateShardCostUsd(2));
    expect(shardSteps[1]?.costUsd).toBe(estimateShardCostUsd(3));
    const summary = steps[steps.length - 1];
    expect(summary?.writes).toBe('qa/spend.json');
    expect(summary?.gate).toBe('spend');
    expect(summary?.costUsd).toBe(estimateShardCostUsd(2) + estimateShardCostUsd(3));
  });

  test('missing clips/ data plans zero shards, zero cost, exit 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-empty-'));
    const analyze = specByVerb(clipAnalysisSpecs, 'clip-analyze');
    const steps = await analyze.plan(makeTestContext({ project: dir }, { mode: 'plan' }));
    expect(steps).toEqual([]);
    const lines: string[] = [];
    const exitCode = await runSpecs(clipAnalysisSpecs, ['clip-analyze', '.', '--plan'], {
      cwd: dir,
      out: (line) => lines.push(line),
    });
    expect(exitCode).toBe(0);
  });
});

describe('run() refuses plan mode', () => {
  test('every verb rejects mode === plan', async () => {
    const dir = await makeClipsProject();
    for (const spec of buildClipAnalysisSpecs(makeTestDeps())) {
      const args: Record<string, string | number | boolean | string[]> =
        spec.verb === 'clip-frames'
          ? { project: dir, src: 'source.mp4' }
          : { project: dir, submit: true, 'spend-cap': 1 };
      await expect(spec.run(makeTestContext(args, { mode: 'plan' }))).rejects.toThrow(
        /refuses plan mode/,
      );
    }
  });
});

describe('clip-analyze paid refusals', () => {
  test('fails actionably without --submit and/or --spend-cap', async () => {
    const dir = await makeClipsProject();
    const analyze = specByVerb(buildClipAnalysisSpecs(makeTestDeps()), 'clip-analyze');
    const cases: { args: Record<string, string | number | boolean | string[]>; missing: string[] }[] = [
      { args: {}, missing: ['--submit', '--spend-cap'] },
      { args: { submit: true }, missing: ['--spend-cap'] },
      { args: { 'spend-cap': 1 }, missing: ['--submit'] },
    ];
    for (const { args, missing } of cases) {
      try {
        await analyze.run(makeTestContext({ project: dir, ...args }, { mode: 'run' }));
        throw new Error(`clip-analyze ran with args ${JSON.stringify(args)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(CliFailError);
        const message = (error as Error).message;
        for (const flag of missing) expect(message).toContain(flag);
      }
    }
  });
});

describe('clip-analyze run() over faked process seams', () => {
  test('writes validated analyses and journals each shard cost', async () => {
    const dir = await makeClipsProject();
    const prompts: string[] = [];
    const fake = fakeProcess((command, args) => {
      if (command !== 'omp') return { code: 0, stdout: '', stderr: '' };
      const prompt = args[args.length - 1] ?? '';
      prompts.push(prompt);
      return { code: 0, stdout: echoAnalysis(prompt), stderr: '' };
    });
    const lines: string[] = [];
    const analyze = specByVerb(
      buildClipAnalysisSpecs({ ...makeTestDeps(), process: fake.runner }),
      'clip-analyze',
    );
    const result = await analyze.run(
      makeTestContext(
        { project: dir, submit: true, 'spend-cap': 1, objective: 'keep the faces' },
        { mode: 'run', lines },
      ),
    );
    expect(result.exitCode).toBe(0);
    for (const shardId of ['shard-001', 'shard-002']) {
      const doc = JSON.parse(
        await readFile(join(dir, 'clips', 'analysis', `${shardId}.json`), 'utf8'),
      );
      expect(doc.schemaVersion).toBe(1);
      expect(doc.shardId).toBe(shardId);
      expect(doc.sourceSha256).toBe(SHA256_ABC);
      expect(doc.status).toBe('ok');
      expect(doc.reason).toBeUndefined();
    }
    const first = JSON.parse(
      await readFile(join(dir, 'clips', 'analysis', 'shard-001.json'), 'utf8'),
    );
    expect(first.frames.map((frame: { frame_id: string }) => frame.frame_id)).toEqual([
      'f-000001',
      'f-000002',
    ]);
    const second = JSON.parse(
      await readFile(join(dir, 'clips', 'analysis', 'shard-002.json'), 'utf8'),
    );
    expect(second.frames.map((frame: { frame_id: string }) => frame.frame_id)).toEqual([
      'f-000003',
      'f-000004',
      'f-000005',
      'f-000006',
    ]);
    // One small vision call per shard; prompts carry objective + transcript slice.
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('keep the faces');
    expect(prompts[0]).toContain('hola mundo');
    expect(prompts[1]).toContain('final');
    // Each shard's cost is journalled exactly once (submit → completed).
    const ledger = await new FileSpendLedger(spendLedgerPath(dir)).list();
    expect(ledger).toHaveLength(2);
    expect(ledger.every((record) => record.state === 'completed')).toBe(true);
    expect(ledger.map((record) => record.reservedUsd)).toEqual([
      estimateShardCostUsd(2),
      estimateShardCostUsd(3),
    ]);
    expect(lines.some((line) => line.includes('$0.0040'))).toBe(true);
    expect(lines.some((line) => line.includes('$0.0060'))).toBe(true);
    expect(lines[lines.length - 1]).toContain('2 ok');
  });

  test('garbage model output becomes an uncertain hole, never invented frames', async () => {
    const dir = await makeClipsProject();
    const fake = fakeProcess((command) => {
      if (command !== 'omp') return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: 'not json at all', stderr: '' };
    });
    const lines: string[] = [];
    const analyze = specByVerb(
      buildClipAnalysisSpecs({ ...makeTestDeps(), process: fake.runner }),
      'clip-analyze',
    );
    const result = await analyze.run(
      makeTestContext(
        { project: dir, submit: true, 'spend-cap': 1, 'max-shards': 1 },
        { mode: 'run', lines },
      ),
    );
    expect(result.exitCode).toBe(0);
    const doc = JSON.parse(
      await readFile(join(dir, 'clips', 'analysis', 'shard-001.json'), 'utf8'),
    );
    expect(doc.status).toBe('uncertain');
    expect(doc.frames).toEqual([]);
    expect(typeof doc.reason).toBe('string');
    // The spend still happened and is journalled (submit-once, no retry).
    expect(fake.calls.filter((call) => call.command === 'omp')).toHaveLength(2);
    const ledger = await new FileSpendLedger(spendLedgerPath(dir)).list();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.state).toBe('completed');
    expect(lines.some((line) => line.includes('uncertain'))).toBe(true);
  });

  test('stops actionably when a shard would exceed the spend cap', async () => {
    const dir = await makeClipsProject();
    const fake = fakeProcess((command, args) => {
      if (command !== 'omp') return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: echoAnalysis(args[args.length - 1] ?? ''), stderr: '' };
    });
    const analyze = specByVerb(
      buildClipAnalysisSpecs({ ...makeTestDeps(), process: fake.runner }),
      'clip-analyze',
    );
    try {
      await analyze.run(
        makeTestContext(
          {
            project: dir,
            submit: true,
            'spend-cap': estimateShardCostUsd(2) + 0.001,
          },
          { mode: 'run' },
        ),
      );
      throw new Error('clip-analyze spent over the cap');
    } catch (error) {
      expect(error).toBeInstanceOf(CliFailError);
      const message = (error as Error).message;
      expect(message).toContain('shard-002');
      expect(message).toContain('--spend-cap');
    }
    // shard-001 landed and is journalled; shard-002 was never submitted.
    const first = await readFile(join(dir, 'clips', 'analysis', 'shard-001.json'), 'utf8');
    expect(JSON.parse(first).status).toBe('ok');
    expect(fake.calls.filter((call) => call.command === 'omp')).toHaveLength(1);
    const ledger = await new FileSpendLedger(spendLedgerPath(dir)).list();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.reservedUsd).toBe(estimateShardCostUsd(2));
  });

  test('a re-run skips journalled shards instead of re-spending', async () => {
    const dir = await makeClipsProject();
    const fake = fakeProcess((command, args) => {
      if (command !== 'omp') return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: echoAnalysis(args[args.length - 1] ?? ''), stderr: '' };
    });
    const analyze = specByVerb(
      buildClipAnalysisSpecs({ ...makeTestDeps(), process: fake.runner }),
      'clip-analyze',
    );
    const args: Record<string, string | number | boolean | string[]> = {
      project: dir,
      submit: true,
      'spend-cap': 1,
    };
    await analyze.run(makeTestContext(args, { mode: 'run' }));
    const callsAfterFirst = fake.calls.filter((call) => call.command === 'omp').length;
    const lines: string[] = [];
    const result = await analyze.run(makeTestContext(args, { mode: 'run', lines }));
    expect(result.exitCode).toBe(0);
    expect(fake.calls.filter((call) => call.command === 'omp')).toHaveLength(callsAfterFirst);
    const ledger = await new FileSpendLedger(spendLedgerPath(dir)).list();
    expect(ledger).toHaveLength(2);
    // Exactly two per-shard skip lines (the summary must not repeat 'skipped'),
    // and the summary reports the same two shards as already journalled.
    const skipLines = lines.filter((line) => line.includes('skipped'));
    expect(skipLines).toHaveLength(2);
    expect(skipLines.every((line) => line.includes('skipped shard-'))).toBe(true);
    expect(lines[lines.length - 1]).toContain('2 already journalled');
  });
});

describe('clip-frames --src handling', () => {
  test('plan exits 0 with no --src (workflow step 0: clip-frames <project> --plan)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-no-src-'));
    const lines: string[] = [];
    const exitCode = await runSpecs(clipAnalysisSpecs, ['clip-frames', '.', '--plan'], {
      cwd: dir,
      out: (line) => lines.push(line),
    });
    expect(exitCode).toBe(0);
    expect(lines.join('\n')).toContain('clips/frames.json');
  });

  test('run without --src fails actionably naming --src', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-no-src-'));
    const clipFrames = specByVerb(buildClipAnalysisSpecs(makeTestDeps()), 'clip-frames');
    try {
      await clipFrames.run(makeTestContext({ project: dir }, { mode: 'run' }));
      throw new Error('clip-frames ran without --src');
    } catch (error) {
      expect(error).toBeInstanceOf(CliFailError);
      expect((error as Error).message).toContain('--src');
    }
  });

  test('--keys without clips/proposals.json fails actionably (run clip-propose first)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-keys-no-props-'));
    const clipFrames = specByVerb(buildClipAnalysisSpecs(makeTestDeps()), 'clip-frames');
    try {
      await clipFrames.run(makeTestContext({ project: dir, keys: true }, { mode: 'run' }));
      throw new Error('clip-frames --keys ran without proposals');
    } catch (error) {
      expect(error).toBeInstanceOf(CliFailError);
      expect((error as Error).message).toContain('clip-propose');
    }
  });
});

describe('clip-frames run() over faked process seams', () => {
  test('extracts frames and writes source/frames/shards manifests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-frames-'));
    await writeFile(join(dir, 'source.mp4'), 'abc');
    const fake = fakeProcess((command) => {
      if (command === 'ffprobe') return { code: 0, stdout: PROBE_JSON, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const lines: string[] = [];
    const clipFrames = specByVerb(
      buildClipAnalysisSpecs({ ...makeTestDeps(), process: fake.runner }),
      'clip-frames',
    );
    const result = await clipFrames.run(
      makeTestContext(
        { project: '.', src: 'source.mp4', 'frame-every': 2 },
        { cwd: dir, mode: 'run', lines },
      ),
    );
    expect(result.exitCode).toBe(0);
    const source = JSON.parse(await readFile(join(dir, 'clips', 'source.json'), 'utf8'));
    expect(source.sha256).toBe(SHA256_ABC);
    const frames = JSON.parse(await readFile(join(dir, 'clips', 'frames.json'), 'utf8'));
    // 5.2 s probed, one sample every 2 s → t = 0, 2, 4.
    expect(frames.frames.map((frame: { t: number }) => frame.t)).toEqual([0, 2, 4]);
    const shards = JSON.parse(await readFile(join(dir, 'clips', 'shards.json'), 'utf8'));
    expect(shards.shards).toHaveLength(1);
    expect(fake.calls.filter((call) => call.command === 'ffmpeg')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Part 2/3 — clipDecisionSpecs: the decision verbs as DATA — registry surface,
// plan() purity (NFR-002), run() refusing plan mode, the deterministic seal
// (`clip-approve` rejects nothing-free lunches) and the offline artifacts of
// propose/ranges/polish/locate/strip/viewer over faked process seams.
// ---------------------------------------------------------------------------
import { writeFileSync } from 'node:fs';

import {
  ClipDecisionSchema,
  ClipRangeSchema,
  scoringWeightsFor,
  type ClipRange,
  type ClipSocial,
} from '@videomaker/schemas';

import { pathExists } from '../args';
import { buildClipDecisionSpecs, clipDecisionSpecs } from './clip';

/** Distinct 64-hex digest (mismatch fixtures never touch the network). */
const SHA256_OTHER = '0'.repeat(64);

/**
 * `clips/` fixture for the decision verbs: 16 keyframes (t = 0, 2, …, 30), a
 * dense 100-word transcript (0.3 s spacing — `proposeWindows` seeds windows
 * from it) and one analysis shard over frames f-000002…f-000007. The source
 * probes 60 s, sha256 SHA256_ABC.
 */
async function makeDecisionProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vm-clip-dec-'));
  await mkdir(join(dir, 'clips', 'frames'), { recursive: true });
  await mkdir(join(dir, 'clips', 'analysis'), { recursive: true });
  const frameId = (index: number) => `f-${String(index + 1).padStart(6, '0')}`;
  await writeFile(
    join(dir, 'clips', 'source.json'),
    JSON.stringify({
      schemaVersion: 1,
      path: 'source.mp4',
      durationSeconds: 60,
      width: 1080,
      height: 1920,
      fps: 30,
      sha256: SHA256_ABC,
    }),
  );
  await writeFile(
    join(dir, 'clips', 'frames.json'),
    JSON.stringify({
      schemaVersion: 1,
      frames: Array.from({ length: 16 }, (_, index) => ({
        frame_id: frameId(index),
        t: index * 2,
        path: `clips/frames/${frameId(index)}.jpg`,
        rol: 'key',
      })),
    }),
  );
  await writeFile(
    join(dir, 'clips', 'transcript.json'),
    JSON.stringify({
      schemaVersion: 1,
      language: 'en',
      words: Array.from({ length: 100 }, (_, index) => ({
        word: index % 20 === 19 ? 'really?' : `word${index}`,
        start: Number((index * 0.3).toFixed(2)),
        end: Number((index * 0.3 + 0.25).toFixed(2)),
      })),
    }),
  );
  await writeFile(
    join(dir, 'clips', 'analysis', 'shard-001.json'),
    JSON.stringify({
      schemaVersion: 1,
      shardId: 'shard-001',
      sourceSha256: SHA256_ABC,
      status: 'ok',
      frames: [2, 4, 6, 8, 10, 12].map((t, index) => ({
        schemaVersion: 1,
        frame_id: frameId(index + 1),
        t,
        speakers: [
          {
            id: index % 2 === 0 ? 'speaker-a' : 'speaker-b',
            bbox: [100, 100, 250, 250],
            speaking: true,
          },
        ],
        sceneCut: false,
        energy: 0.8,
        topic: 'funny cats',
        highlight: 0.9,
      })),
    }),
  );
  return dir;
}

/** A schema-valid `ClipRange` fixture (one bbox per face, presence 0.9). */
function demoRange(
  id: string,
  start: number,
  end: number,
  options: { layout?: 'single' | 'duo'; faceCount?: number; title?: string } = {},
): ClipRange {
  const faceCount = options.faceCount ?? (options.layout === 'duo' ? 2 : 1);
  return {
    schemaVersion: 1,
    id,
    start,
    end,
    score: 0.5,
    breakdown: {
      highlight: 0.5,
      hook: 0.5,
      density: 0.5,
      emotion: 0.5,
      novelty: 0.5,
      closure: 0.5,
    },
    layout: options.layout ?? 'single',
    faces: Array.from({ length: faceCount }, (_, index) => ({
      id: `speaker-${String.fromCharCode(97 + index)}`,
      bbox: [100, 100, 250, 250],
      presence: 0.9,
    })),
    social: {
      title: options.title ?? `Highlight ${id}`,
      description: `Clip ${id} description.`,
      hashtags: ['clip', 'demo'],
    },
  };
}

/** Writes a `PolishedRangesDocument` fixture at `clips/decisions-ready.json`. */
async function writeDecisionReady(
  dir: string,
  sourceSha256: string,
  ranges: ClipRange[],
): Promise<void> {
  await writeFile(
    join(dir, 'clips', 'decisions-ready.json'),
    JSON.stringify({ schemaVersion: 1, sourceSha256, backend: 'omp', ranges }, null, 2),
  );
}

describe('clipDecisionSpecs registry surface', () => {
  test('registers the seven decision verbs with plan support and no paid flags', () => {
    expect(clipDecisionSpecs.map((spec) => spec.verb)).toEqual([
      'clip-propose',
      'clip-ranges',
      'clip-polish',
      'clip-approve',
      'clip-locate',
      'clip-strip',
      'clip-viewer',
    ]);
    for (const spec of clipDecisionSpecs) {
      expect(spec.supportsPlan).toBe(true);
      expect(spec.paid ?? false).toBe(false);
      expect(allSpecs().some((entry) => entry.verb === spec.verb)).toBe(true);
    }
    expect(specByVerb(clipDecisionSpecs, 'clip-approve').args.map((arg) => arg.name)).toEqual([
      'project',
      'id',
    ]);
  });
});

describe('decision plan() purity (NFR-002)', () => {
  test('no process, fetch or secret calls for any verb', async () => {
    const dir = await makeDecisionProject();
    const base = makeTestDeps();
    const processCalls: string[] = [];
    const deps = {
      ...base,
      process: {
        async run(command: string) {
          processCalls.push(command);
          return { code: 0, stdout: '', stderr: '' };
        },
      },
    };
    for (const spec of buildClipDecisionSpecs(deps)) {
      const steps = await spec.plan(makeTestContext({ project: dir }, { mode: 'plan' }));
      expect(Array.isArray(steps)).toBe(true);
      expect(
        steps.every((step) => typeof step.action === 'string' && step.action.length > 0),
      ).toBe(true);
    }
    expect(processCalls).toEqual([]);
    expect(base.calls.fetch).toBe(0);
    expect(base.calls.secrets).toEqual([]);
    expect(base.calls.submits).toEqual([]);
  });

  test('every verb exits 0 under --plan through the runtime', async () => {
    const dir = await makeDecisionProject();
    for (const spec of buildClipDecisionSpecs(makeTestDeps())) {
      const lines: string[] = [];
      const exitCode = await runSpecs([spec], [spec.verb, dir, '--plan'], {
        cwd: dir,
        out: (line) => lines.push(line),
      });
      expect(exitCode).toBe(0);
    }
  });
});

describe('decision run() refuses plan mode', () => {
  test('every verb rejects mode === plan', async () => {
    const dir = await makeDecisionProject();
    for (const spec of buildClipDecisionSpecs(makeTestDeps())) {
      await expect(spec.run(makeTestContext({ project: dir }, { mode: 'plan' }))).rejects.toThrow(
        /refuses plan mode/,
      );
    }
  });
});

describe('clip-propose run()', () => {
  test('writes proposal windows grown from the transcript heuristics', async () => {
    const dir = await makeDecisionProject();
    const lines: string[] = [];
    const propose = specByVerb(buildClipDecisionSpecs(makeTestDeps()), 'clip-propose');
    const result = await propose.run(
      makeTestContext({ project: dir, min: 5, max: 10 }, { mode: 'run', lines }),
    );
    expect(result.exitCode).toBe(0);
    const doc = JSON.parse(await readFile(join(dir, 'clips', 'proposals.json'), 'utf8'));
    expect(doc.schemaVersion).toBe(1);
    expect(doc.windows.length).toBeGreaterThan(0);
    for (const window of doc.windows) {
      expect(typeof window.id).toBe('string');
      expect(window.end).toBeGreaterThan(window.start);
      expect(window.preScore).toBeGreaterThanOrEqual(0);
      expect(window.preScore).toBeLessThanOrEqual(1);
      expect(typeof window.reason).toBe('string');
    }
    expect(lines[lines.length - 1]).toContain('clips/proposals.json');
  });

  test('empty transcript proposes zero windows and still exits 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-empty-tr-'));
    await mkdir(join(dir, 'clips'), { recursive: true });
    await writeFile(
      join(dir, 'clips', 'transcript.json'),
      JSON.stringify({ schemaVersion: 1, language: 'en', words: [] }),
    );
    const propose = specByVerb(buildClipDecisionSpecs(makeTestDeps()), 'clip-propose');
    const result = await propose.run(makeTestContext({ project: dir }, { mode: 'run' }));
    expect(result.exitCode).toBe(0);
    const doc = JSON.parse(await readFile(join(dir, 'clips', 'proposals.json'), 'utf8'));
    expect(doc.windows).toEqual([]);
  });
});

describe('clip-ranges run()', () => {
  test('writes a schema-valid bare ClipRange[] from transcript + analyses', async () => {
    const dir = await makeDecisionProject();
    const ranges = specByVerb(buildClipDecisionSpecs(makeTestDeps()), 'clip-ranges');
    const result = await ranges.run(
      makeTestContext({ project: dir, min: 5, max: 10 }, { mode: 'run' }),
    );
    expect(result.exitCode).toBe(0);
    const raw = JSON.parse(await readFile(join(dir, 'clips', 'candidates.json'), 'utf8'));
    expect(Array.isArray(raw)).toBe(true);
    expect(raw.length).toBeGreaterThan(0);
    for (const entry of raw) {
      expect(ClipRangeSchema.parse(entry).id).toBe(entry.id);
    }
    expect(raw[0].id).toBe('clip-01');
  });

  test('--init-weights writes clips/scoring.json from the preset and exits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-clip-weights-'));
    const ranges = specByVerb(buildClipDecisionSpecs(makeTestDeps()), 'clip-ranges');
    const result = await ranges.run(
      makeTestContext({ project: dir, preset: 'podcast', 'init-weights': true }, { mode: 'run' }),
    );
    expect(result.exitCode).toBe(0);
    const doc = JSON.parse(await readFile(join(dir, 'clips', 'scoring.json'), 'utf8'));
    expect(doc).toEqual(scoringWeightsFor('podcast'));
    expect(await pathExists(join(dir, 'clips', 'candidates.json'))).toBe(false);
  });

  test('--review journals the critic round in revisions[] and stops on pass', async () => {
    const dir = await makeDecisionProject();
    const fake = fakeProcess(() => ({
      code: 0,
      stdout: JSON.stringify({ verdicts: [{ id: 'clip-01', verdict: 'pass' }] }),
      stderr: '',
    }));
    const ranges = specByVerb(
      buildClipDecisionSpecs({ ...makeTestDeps(), process: fake.runner }),
      'clip-ranges',
    );
    const result = await ranges.run(
      makeTestContext({ project: dir, min: 5, max: 10, review: true }, { mode: 'run' }),
    );
    expect(result.exitCode).toBe(0);
    const raw = JSON.parse(await readFile(join(dir, 'clips', 'candidates.json'), 'utf8')) as Array<{
      id: string;
      revisions?: unknown[];
    }>;
    const first = raw.find((entry) => entry.id === 'clip-01');
    expect(first?.revisions).toEqual([{ round: 1, verdict: 'pass', issues: [], applied: true }]);
    const other = raw.find((entry) => entry.id !== 'clip-01');
    expect(other?.revisions).toBeUndefined();
    expect(fake.calls.filter((call) => call.command === 'omp')).toHaveLength(1);
  });

  test('--explain prints the breakdown of one candidate and writes nothing', async () => {
    const dir = await makeDecisionProject();
    const ranges = specByVerb(buildClipDecisionSpecs(makeTestDeps()), 'clip-ranges');
    const lines: string[] = [];
    const result = await ranges.run(
      makeTestContext({ project: dir, min: 5, max: 10, explain: 'clip-01' }, { mode: 'run', lines }),
    );
    expect(result.exitCode).toBe(0);
    const printed = lines.join('\n');
    expect(printed).toContain('Candidate "clip-01"');
    expect(printed).toContain('total:');
    expect(await pathExists(join(dir, 'clips', 'candidates.json'))).toBe(false);
  });

  test('--explain on an unknown id fails actionably', async () => {
    const dir = await makeDecisionProject();
    const ranges = specByVerb(buildClipDecisionSpecs(makeTestDeps()), 'clip-ranges');
    try {
      await ranges.run(
        makeTestContext({ project: dir, min: 5, max: 10, explain: 'clip-99' }, { mode: 'run' }),
      );
      throw new Error('clip-ranges explained an unknown id');
    } catch (error) {
      expect(error).toBeInstanceOf(CliFailError);
      expect((error as Error).message).toContain('clip-99');
    }
  });

  test('--social-drafts supplies the drafted social copy', async () => {
    const dir = await makeDecisionProject();
    const drafts: Record<string, ClipSocial> = {
      'clip-01': {
        title: 'Drafted title',
        description: 'Drafted description.',
        hashtags: ['draft'],
      },
    };
    const draftsPath = join(dir, 'social-drafts.json');
    await writeFile(draftsPath, JSON.stringify(drafts));
    const ranges = specByVerb(buildClipDecisionSpecs(makeTestDeps()), 'clip-ranges');
    const result = await ranges.run(
      makeTestContext(
        { project: dir, min: 5, max: 10, 'social-drafts': draftsPath },
        { mode: 'run' },
      ),
    );
    expect(result.exitCode).toBe(0);
    const raw = JSON.parse(await readFile(join(dir, 'clips', 'candidates.json'), 'utf8'));
    const first = raw.find((entry: { id: string }) => entry.id === 'clip-01');
    expect(first.social.title).toBe('Drafted title');
    expect(first.social.hashtags).toEqual(['draft']);
  });
});

describe('clip-polish run()', () => {
  test('polishes candidates into decisions-ready.json sealed to the source sha256', async () => {
    const dir = await makeDecisionProject();
    const specs = buildClipDecisionSpecs(makeTestDeps());
    await specByVerb(specs, 'clip-ranges').run(
      makeTestContext({ project: dir, min: 5, max: 10 }, { mode: 'run' }),
    );
    const polish = specByVerb(specs, 'clip-polish');
    const result = await polish.run(makeTestContext({ project: dir }, { mode: 'run' }));
    expect(result.exitCode).toBe(0);
    const doc = JSON.parse(await readFile(join(dir, 'clips', 'decisions-ready.json'), 'utf8'));
    expect(doc.schemaVersion).toBe(1);
    expect(doc.sourceSha256).toBe(SHA256_ABC);
    expect(doc.backend).toBe('omp');
    expect(Array.isArray(doc.ranges)).toBe(true);
    expect(doc.ranges.length).toBeGreaterThan(0);
    for (const range of doc.ranges) {
      expect(ClipRangeSchema.parse(range).id).toBe(range.id);
    }
  });
});

describe('clip-approve run() — the deterministic seal', () => {
  test('rejects a seal request with no approved ids', async () => {
    const dir = await makeDecisionProject();
    await writeDecisionReady(dir, SHA256_ABC, [demoRange('clip-01', 1, 10)]);
    const approve = specByVerb(buildClipDecisionSpecs(makeTestDeps()), 'clip-approve');
    try {
      await approve.run(makeTestContext({ project: dir }, { mode: 'run' }));
      throw new Error('clip-approve sealed zero ranges');
    } catch (error) {
      expect(error).toBeInstanceOf(CliFailError);
      expect((error as Error).message).toContain('no approved ranges');
    }
    expect(await pathExists(join(dir, 'clips', 'decisions.json'))).toBe(false);
  });

  test('rejects a decisions-ready sha256 different from clips/source.json', async () => {
    const dir = await makeDecisionProject();
    await writeDecisionReady(dir, SHA256_OTHER, [demoRange('clip-01', 1, 10)]);
    const approve = specByVerb(buildClipDecisionSpecs(makeTestDeps()), 'clip-approve');
    try {
      await approve.run(
        makeTestContext({ project: dir, id: ['clip-01'] }, { mode: 'run' }),
      );
      throw new Error('clip-approve sealed a mismatched source');
    } catch (error) {
      expect(error).toBeInstanceOf(CliFailError);
      const message = (error as Error).message;
      expect(message).toContain('sha256');
      expect(message).toContain('mismatch');
    }
    expect(await pathExists(join(dir, 'clips', 'decisions.json'))).toBe(false);
  });

  test('rejects an unknown --id', async () => {
    const dir = await makeDecisionProject();
    await writeDecisionReady(dir, SHA256_ABC, [demoRange('clip-01', 1, 10)]);
    const approve = specByVerb(buildClipDecisionSpecs(makeTestDeps()), 'clip-approve');
    try {
      await approve.run(
        makeTestContext({ project: dir, id: ['clip-99'] }, { mode: 'run' }),
      );
      throw new Error('clip-approve sealed an unknown id');
    } catch (error) {
      expect(error).toBeInstanceOf(CliFailError);
      const message = (error as Error).message;
      expect(message).toContain('unknown');
      expect(message).toContain('clip-99');
    }
    expect(await pathExists(join(dir, 'clips', 'decisions.json'))).toBe(false);
  });

  test('rejects a selected range breaking a seal invariant', async () => {
    const dir = await makeDecisionProject();
    const approve = specByVerb(buildClipDecisionSpecs(makeTestDeps()), 'clip-approve');

    // end beyond the 60 s source duration.
    await writeDecisionReady(dir, SHA256_ABC, [demoRange('clip-01', 55, 90)]);
    try {
      await approve.run(makeTestContext({ project: dir, id: ['clip-01'] }, { mode: 'run' }));
      throw new Error('clip-approve sealed a range beyond the source duration');
    } catch (error) {
      expect(error).toBeInstanceOf(CliFailError);
      const message = (error as Error).message;
      expect(message).toContain('duration');
    }

    // layout 'duo' without exactly 2 faces.
    await writeDecisionReady(dir, SHA256_ABC, [
      demoRange('clip-02', 1, 10, { layout: 'duo', faceCount: 1 }),
    ]);
    try {
      await approve.run(makeTestContext({ project: dir, id: ['clip-02'] }, { mode: 'run' }));
      throw new Error('clip-approve sealed a duo without 2 faces');
    } catch (error) {
      expect(error).toBeInstanceOf(CliFailError);
      const message = (error as Error).message;
      expect(message).toContain('duo');
      expect(message).toContain('2 faces');
    }
  });

  test('seals decisions.json on a valid fixture without mutating the ranges', async () => {
    const dir = await makeDecisionProject();
    const readyRanges = [
      demoRange('clip-01', 1, 10),
      demoRange('clip-02', 12, 20, { layout: 'duo', faceCount: 2 }),
    ];
    await writeDecisionReady(dir, SHA256_ABC, readyRanges);
    const approve = specByVerb(buildClipDecisionSpecs(makeTestDeps()), 'clip-approve');
    const lines: string[] = [];
    const result = await approve.run(
      makeTestContext({ project: dir, id: ['clip-01'] }, { mode: 'run', lines }),
    );
    expect(result.exitCode).toBe(0);
    const doc = JSON.parse(await readFile(join(dir, 'clips', 'decisions.json'), 'utf8'));
    expect(ClipDecisionSchema.parse(doc).sourceSha256).toBe(SHA256_ABC);
    expect(doc.backend).toBe('omp');
    expect(
      doc.decisions.map((entry: { range: { id: string }; status: string }) => [
        entry.range.id,
        entry.status,
      ]),
    ).toEqual([
      ['clip-01', 'approved'],
      ['clip-02', 'rejected'],
    ]);
    // The verifier never mutates ranges: decisions.json carries them verbatim.
    expect(doc.decisions.map((entry: { range: ClipRange }) => entry.range)).toEqual(readyRanges);
    expect(lines.some((line) => line.includes('clip-01'))).toBe(true);
    expect(lines[lines.length - 1]).toContain('clips/decisions.json');
  });
});

describe('clip-locate run()', () => {
  test('prints the exact frame path, frame_id, t, neighbor paths and the transcript slice', async () => {
    const dir = await makeDecisionProject();
    const locate = specByVerb(buildClipDecisionSpecs(makeTestDeps()), 'clip-locate');
    const lines: string[] = [];
    const result = await locate.run(
      makeTestContext({ project: dir, at: '4' }, { mode: 'run', lines }),
    );
    expect(result.exitCode).toBe(0);
    const printed = lines.join('\n');
    expect(printed).toContain('f-000003');
    expect(printed).toContain('t=4');
    expect(printed).toContain('clips/frames/f-000003.jpg');
    expect(printed).toContain('clips/frames/f-000002.jpg');
    expect(printed).toContain('clips/frames/f-000004.jpg');
    expect(printed).toContain('transcript');
    expect(printed).toContain('word');
  });

  test('resolves by frame_id too and fails actionably without --at', async () => {
    const dir = await makeDecisionProject();
    const locate = specByVerb(buildClipDecisionSpecs(makeTestDeps()), 'clip-locate');
    const byId: string[] = [];
    const result = await locate.run(
      makeTestContext({ project: dir, at: 'f-000003' }, { mode: 'run', lines: byId }),
    );
    expect(result.exitCode).toBe(0);
    expect(byId.join('\n')).toContain('clips/frames/f-000003.jpg');
    try {
      await locate.run(makeTestContext({ project: dir }, { mode: 'run' }));
      throw new Error('clip-locate ran without --at');
    } catch (error) {
      expect(error).toBeInstanceOf(CliFailError);
      expect((error as Error).message).toContain('--at');
    }
  });
});

describe('clip-strip run()', () => {
  test('grids the window frames into clips/strips/<from>-<to>.jpg', async () => {
    const dir = await makeDecisionProject();
    const calls: string[][] = [];
    const fakeRunner = {
      async run(command: string, args: string[]) {
        calls.push([command, ...args]);
        if (command === 'ffmpeg') {
          writeFileSync(args[args.length - 1]!, 'fake jpg');
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };
    const strip = specByVerb(
      buildClipDecisionSpecs({ ...makeTestDeps(), process: fakeRunner }),
      'clip-strip',
    );
    const lines: string[] = [];
    const result = await strip.run(
      makeTestContext({ project: dir, from: 0, to: 4 }, { mode: 'run', lines }),
    );
    expect(result.exitCode).toBe(0);
    expect(await pathExists(join(dir, 'clips', 'strips', '0-4.jpg'))).toBe(true);
    expect(calls.filter((call) => call[0] === 'ffmpeg')).toHaveLength(1);
    // Row-major grid of the window's frames (t = 0, 2, 4), labeled by frame_id.
    const ffmpegArgs = calls.find((call) => call[0] === 'ffmpeg')!.join(' ');
    expect(ffmpegArgs).toContain('f-000001');
    expect(ffmpegArgs).toContain('f-000003');
    expect(lines[lines.length - 1]).toContain('clips/strips/0-4.jpg');
  });

  test('fails actionably without --from/--to and outside a sane window', async () => {
    const dir = await makeDecisionProject();
    const strip = specByVerb(buildClipDecisionSpecs(makeTestDeps()), 'clip-strip');
    // No args; inverted bounds; a window with no sampled frames (frames end at t=30).
    const cases: Array<Record<string, string | number | boolean | string[]>> = [
      { project: dir },
      { project: dir, from: 4, to: 1 },
      { project: dir, from: 40, to: 50 },
    ];
    for (const args of cases) {
      try {
        await strip.run(makeTestContext(args, { mode: 'run' }));
        throw new Error(`clip-strip ran with args ${JSON.stringify(args)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(CliFailError);
      }
    }
  });
});

describe('clip-viewer run()', () => {
  test('writes the read-only dashboard with cards, stills, statuses and the objective header', async () => {
    const dir = await makeDecisionProject();
    const ranges = [
      demoRange('clip-01', 0, 10, { title: '<script>alert(1)</script> highlight' }),
      demoRange('clip-02', 12, 20, { layout: 'duo', faceCount: 2 }),
    ];
    await writeFile(join(dir, 'clips', 'candidates.json'), JSON.stringify(ranges));
    await writeFile(
      join(dir, 'clips', 'decisions.json'),
      JSON.stringify({
        schemaVersion: 1,
        sourceSha256: SHA256_ABC,
        backend: 'omp',
        decisions: [
          { range: ranges[0], status: 'approved' },
          { range: ranges[1], status: 'rejected' },
        ],
      }),
    );
    const viewer = specByVerb(buildClipDecisionSpecs(makeTestDeps()), 'clip-viewer');
    const result = await viewer.run(
      makeTestContext({ project: dir, objective: 'funny moments only' }, { mode: 'run' }),
    );
    expect(result.exitCode).toBe(0);
    const html = await readFile(join(dir, 'clips', 'dashboard', 'index.html'), 'utf8');
    expect(html).toContain('funny moments only');
    expect(html).toContain('<article class="card" data-status=');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('approved');
    expect(html).toContain('rejected');
    // still = frame nearest the range midpoint (0–10 → 5 s → t=4, tie to lower
    // t), as a dashboard-relative poster path.
    expect(html).toContain('../frames/f-000003.jpg');
    // frame_ids span [12, 20] internally (f-000007…f-000011) but the
    // human-facing dashboard never renders that list.
    expect(html).not.toContain('f-000011');
    expect(html).toContain('2 clips · 1 approved · 0 rendered · read-only');
    expect(html).toContain('<div class="grid">');
  });

  test('renders candidate status when no decisions exist yet', async () => {
    const dir = await makeDecisionProject();
    await writeFile(
      join(dir, 'clips', 'candidates.json'),
      JSON.stringify([demoRange('clip-01', 0, 10)]),
    );
    const viewer = specByVerb(buildClipDecisionSpecs(makeTestDeps()), 'clip-viewer');
    const result = await viewer.run(makeTestContext({ project: dir }, { mode: 'run' }));
    expect(result.exitCode).toBe(0);
    const html = await readFile(join(dir, 'clips', 'dashboard', 'index.html'), 'utf8');
    expect(html).toContain('candidate');
    expect(html).toContain('<h1>Clip dashboard</h1>');
  });
});

// ---------------------------------------------------------------------------
// Part 3/3 — clipRenderSpecs: the render verb as DATA — registry surface,
// plan() purity (NFR-002), run() refusing plan mode, the sealed-decision gate
// (`clip-approve` or no render), exact trim args, the pinned one-scene
// FilmProps (clip intent + faces + rebased track) and the sha256 qa report,
// over faked RenderSeam + ffmpeg/process seams (never a real render).
// ---------------------------------------------------------------------------
import { rm } from 'node:fs/promises';

import { sha256File } from '@videomaker/core';
import type { FilmProps } from '@videomaker/motion-remotion';

import { makeTestProject } from '../pipeline/test-support';
import { buildClipRenderSpecs, clipRenderSpecs } from './clip';

/**
 * Render fixture: a registry project (video.json) plus the sealed clip state
 * — `clips/source.json` probing a 1280×720 landscape source (so the track
 * viewport is provably NOT the 1080×1920 canvas), a real `clips/source.mp4`
 * stub the fake ffmpeg copies, analyzed frames around the ranges
 * (t = 8, 10, 11, 20, 21 + one duo frame at 33) and `clips/decisions.json`
 * sealing two approved ranges (single + duo) and one rejection.
 */
async function makeRenderProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vm-clip-render-'));
  await makeTestProject(dir);
  await mkdir(join(dir, 'clips', 'analysis'), { recursive: true });
  await writeFile(join(dir, 'clips', 'source.mp4'), 'fake source mp4 bytes');
  await writeFile(
    join(dir, 'clips', 'source.json'),
    JSON.stringify({
      schemaVersion: 1,
      path: 'source.mp4',
      durationSeconds: 60,
      width: 1280,
      height: 720,
      fps: 30,
      sha256: SHA256_ABC,
    }),
  );
  const analysisFrame = (
    index: number,
    t: number,
    speakerIds: string[] = ['speaker-a'],
  ): Record<string, unknown> => ({
    schemaVersion: 1,
    frame_id: `f-${String(index).padStart(6, '0')}`,
    t,
    speakers: speakerIds.map((id) => ({
      id,
      bbox: [100, 100, 250, 250],
      speaking: id === 'speaker-a',
    })),
    sceneCut: false,
    energy: 0.8,
    topic: 'funny cats',
    highlight: 0.9,
  });
  await writeFile(
    join(dir, 'clips', 'analysis', 'shard-001.json'),
    JSON.stringify({
      schemaVersion: 1,
      frames: [
        analysisFrame(1, 8),
        analysisFrame(2, 10),
        analysisFrame(3, 11),
        analysisFrame(4, 20),
        analysisFrame(5, 21),
        analysisFrame(6, 33, ['speaker-a', 'speaker-b']),
      ],
    }),
  );
  await writeFile(
    join(dir, 'clips', 'decisions.json'),
    JSON.stringify({
      schemaVersion: 1,
      sourceSha256: SHA256_ABC,
      backend: 'omp',
      decisions: [
        { range: demoRange('clip-01', 10, 20), status: 'approved' },
        { range: demoRange('clip-02', 30, 45, { layout: 'duo', faceCount: 2 }), status: 'approved' },
        { range: demoRange('clip-03', 50, 55), status: 'rejected' },
      ],
    }),
  );
  return dir;
}

describe('clipRenderSpecs registry surface', () => {
  test('registers clip-render with plan support, the render/qa gates and no paid flags', () => {
    expect(clipRenderSpecs.map((spec) => spec.verb)).toEqual(['clip-render']);
    const render = specByVerb(clipRenderSpecs, 'clip-render');
    expect(render.supportsPlan).toBe(true);
    expect(render.paid ?? false).toBe(false);
    expect(render.movesGates).toEqual(['render', 'qa']);
    expect(render.writes).toEqual([
      'renders/clips/<id>.mp4',
      'qa/stills/clips/<id>.png',
      'qa/clips/<id>.report.json',
    ]);
    expect(render.args.map((arg) => arg.name)).toEqual(['project', 'id']);
    expect(render.args.find((arg) => arg.name === 'id')?.kind).toBe('string[]');
    expect(allSpecs().some((entry) => entry.verb === 'clip-render')).toBe(true);
  });
});

describe('clip-render plan() purity (NFR-002)', () => {
  test('static steps trim → props → render → still → loudness/qa report; zero seams touched', async () => {
    const dir = await makeRenderProject();
    const base = makeTestDeps();
    const processCalls: string[] = [];
    const deps = {
      ...base,
      process: {
        async run(command: string) {
          processCalls.push(command);
          return { code: 0, stdout: '', stderr: '' };
        },
      },
    };
    const render = specByVerb(buildClipRenderSpecs(deps), 'clip-render');
    const steps = await render.plan(
      makeTestContext({ project: dir, id: ['clip-01'] }, { mode: 'plan' }),
    );
    expect(steps).toHaveLength(5);
    expect(steps[0]!.action).toContain('trim');
    expect(steps[0]!.writes).toBe('clips/trimmed/<id>.mp4');
    expect(steps[1]!.action).toContain('FilmProps');
    expect(steps[2]!.action).toContain('render');
    expect(steps[2]!.writes).toBe('renders/clips/<id>.mp4');
    expect(steps[2]!.gate).toBe('render');
    expect(steps[3]!.action).toContain('still');
    expect(steps[3]!.writes).toBe('qa/stills/clips/<id>.png');
    expect(steps[4]!.action).toContain('loudness');
    expect(steps[4]!.writes).toBe('qa/clips/<id>.report.json');
    expect(steps[4]!.gate).toBe('qa');
    // Pure planning: no subprocesses, no network, no secrets, no render.
    expect(processCalls).toEqual([]);
    expect(base.calls.ffmpeg).toEqual([]);
    expect(base.calls.renderVideo).toEqual([]);
    expect(base.calls.renderStill).toEqual([]);
    expect(base.calls.fetch).toBe(0);
    expect(base.calls.secrets).toEqual([]);
    expect(base.calls.submits).toEqual([]);
  });

  test('exits 0 under --plan through the runtime', async () => {
    const dir = await makeRenderProject();
    const lines: string[] = [];
    const exitCode = await runSpecs(clipRenderSpecs, ['clip-render', dir, '--plan'], {
      cwd: dir,
      out: (line) => lines.push(line),
    });
    expect(exitCode).toBe(0);
  });
});

describe('clip-render run() refuses plan mode', () => {
  test('rejects mode === plan', async () => {
    const dir = await makeRenderProject();
    const render = specByVerb(buildClipRenderSpecs(makeTestDeps()), 'clip-render');
    await expect(render.run(makeTestContext({ project: dir }, { mode: 'plan' }))).rejects.toThrow(
      /refuses plan mode/,
    );
  });
});

describe('clip-render run() — the sealed-decision gate', () => {
  test('refuses without clips/decisions.json, naming clip-approve', async () => {
    const dir = await makeRenderProject();
    await rm(join(dir, 'clips', 'decisions.json'));
    const deps = makeTestDeps();
    const render = specByVerb(buildClipRenderSpecs(deps), 'clip-render');
    try {
      await render.run(makeTestContext({ project: dir }, { mode: 'run' }));
      throw new Error('clip-render ran without the clip-approve seal');
    } catch (error) {
      expect(error).toBeInstanceOf(CliFailError);
      const message = (error as Error).message;
      expect(message).toContain('clip-approve');
      expect(message).toContain('decisions.json');
    }
    expect(deps.calls.renderVideo).toEqual([]);
    expect(deps.calls.ffmpeg).toEqual([]);
  });

  test('refuses a seal with zero approved entries, naming clip-approve', async () => {
    const dir = await makeRenderProject();
    await writeFile(
      join(dir, 'clips', 'decisions.json'),
      JSON.stringify({
        schemaVersion: 1,
        sourceSha256: SHA256_ABC,
        backend: 'omp',
        decisions: [{ range: demoRange('clip-01', 10, 20), status: 'rejected' }],
      }),
    );
    const deps = makeTestDeps();
    const render = specByVerb(buildClipRenderSpecs(deps), 'clip-render');
    try {
      await render.run(makeTestContext({ project: dir }, { mode: 'run' }));
      throw new Error('clip-render ran with zero approved entries');
    } catch (error) {
      expect(error).toBeInstanceOf(CliFailError);
      const message = (error as Error).message;
      expect(message).toContain('clip-approve');
      expect(message).toContain('zero approved');
    }
    expect(deps.calls.renderVideo).toEqual([]);
  });

  test('refuses unknown or unapproved --id selections', async () => {
    const dir = await makeRenderProject();
    const deps = makeTestDeps();
    const render = specByVerb(buildClipRenderSpecs(deps), 'clip-render');
    for (const id of ['clip-03', 'clip-99']) {
      try {
        await render.run(makeTestContext({ project: dir, id: [id] }, { mode: 'run' }));
        throw new Error(`clip-render rendered unapproved --id ${id}`);
      } catch (error) {
        expect(error).toBeInstanceOf(CliFailError);
        const message = (error as Error).message;
        expect(message).toContain(id);
        expect(message).toContain('clip-approve');
      }
    }
    expect(deps.calls.renderVideo).toEqual([]);
  });
});

// The exact-trim args and the one-scene FilmProps pins below are ALSO
// enforced at the pipeline level (pure, fake-process) in
// ../pipeline/clip.test.ts part 5/5 — here they pin the same seams through
// the CLI end to end.
describe('clip-render run()', () => {
  test('renders only the sealed approved ranges with exact trims and the qa report', async () => {
    const dir = await makeRenderProject();
    const deps = makeTestDeps();
    const render = specByVerb(buildClipRenderSpecs(deps), 'clip-render');
    const lines: string[] = [];
    const result = await render.run(makeTestContext({ project: dir }, { mode: 'run', lines }));
    expect(result.exitCode).toBe(0);

    // Only the two APPROVED ranges render; the sealed rejection stays skipped.
    expect(deps.calls.renderVideo.map((options) => options.outputLocation)).toEqual([
      join(dir, 'renders', 'clips', 'clip-01.mp4'),
      join(dir, 'renders', 'clips', 'clip-02.mp4'),
    ]);
    expect(deps.calls.renderStill).toHaveLength(2);
    expect(await pathExists(join(dir, 'renders', 'clips', 'clip-03.mp4'))).toBe(false);

    // The render wiring of `runAssemble`: BOTH render calls bundle with the
    // project's public dir and staging writes into `<project>/public/media/clips/`.
    expect(deps.calls.renderVideo[0]!.publicDir).toBe(join(dir, 'public'));
    expect(deps.calls.renderStill[0]!.publicDir).toBe(join(dir, 'public'));
    expect(await pathExists(join(dir, 'public', 'media', 'clips', 'clip-01.mp4'))).toBe(true);
    expect(await pathExists(join(dir, 'public', 'media', 'clips', 'clip-01.wav'))).toBe(true);

    // Exact trim args: -ss <start> -t <end - start> over clips/source.mp4.
    const trims = deps.calls.ffmpeg.filter((args) => args.includes('-an'));
    expect(trims.map((args) => args.slice(0, 7))).toEqual([
      ['-y', '-ss', '10', '-i', join(dir, 'clips', 'source.mp4'), '-t', '10'],
      ['-y', '-ss', '30', '-i', join(dir, 'clips', 'source.mp4'), '-t', '15'],
    ]);
    for (const args of trims) {
      expect(args).toContain('libx264');
      expect(args).toContain('yuv420p');
      expect(args).toContain('30');
    }
    expect(trims[0]![trims[0]!.length - 1]).toBe(join(dir, 'clips', 'trimmed', 'clip-01.mp4'));

    // The trim's audio is extracted ONCE to a WAV; the trimmed video is
    // video-only (-an), so the render can never double it.
    const audioCuts = deps.calls.ffmpeg.filter((args) => args.includes('pcm_s16le'));
    expect(audioCuts.map((args) => args.slice(0, 7))).toEqual([
      ['-y', '-ss', '10', '-i', join(dir, 'clips', 'source.mp4'), '-t', '10'],
      ['-y', '-ss', '30', '-i', join(dir, 'clips', 'source.mp4'), '-t', '15'],
    ]);
    expect(audioCuts[0]![audioCuts[0]!.length - 1]).toBe(join(dir, 'clips', 'trimmed', 'clip-01.wav'));

    // The loudness stage caps every AAC re-encode at the VIDEO span
    // (expectedDurationInFrames / fps = 300 / 30 = 10 s), never the
    // audio-inclusive container length.
    const clipOneApplies = deps.calls.ffmpeg.filter(
      (args) =>
        args.join(' ').includes('print_format=summary') &&
        args.includes(join(dir, 'renders', 'clips', 'clip-01.mp4')),
    );
    expect(clipOneApplies.length).toBeGreaterThan(0);
    for (const args of clipOneApplies) {
      expect(args.slice(args.indexOf('-t'), args.indexOf('-t') + 2)).toEqual(['-t', '10']);
    }

    // Still parity by construction: same inputProps + same frame count as the
    // video render, sampling the FIRST frame of the scene span.
    expect(deps.calls.renderStill[0]!.frame).toBe(0);
    expect(deps.calls.renderStill[0]!.expectedDurationInFrames).toBe(
      deps.calls.renderVideo[0]!.expectedDurationInFrames,
    );
    expect(deps.calls.renderStill[0]!.inputProps).toBe(deps.calls.renderVideo[0]!.inputProps);

    // The qa report pins both artifacts by sha256 (FR-011-style evidence).
    const report = JSON.parse(
      await readFile(join(dir, 'qa', 'clips', 'clip-01.report.json'), 'utf8'),
    );
    expect(report).toEqual({
      schemaVersion: 1,
      id: 'clip-01',
      mp4: 'renders/clips/clip-01.mp4',
      mp4Sha256: await sha256File(join(dir, 'renders', 'clips', 'clip-01.mp4')),
      still: 'qa/stills/clips/clip-01.png',
      stillSha256: await sha256File(join(dir, 'qa', 'stills', 'clips', 'clip-01.png')),
      width: 1080,
      height: 1920,
      fps: 30,
      durationFrames: 300,
      expectedDurationSeconds: 10,
      loudness: { integratedLufs: -14, truePeakDbtp: -1.5, verdict: 'pass' },
    });
    expect(lines.some((line) => line.includes('clip-01'))).toBe(true);
    expect(lines.some((line) => line.includes('clip-02'))).toBe(true);
    expect(lines[lines.length - 1]).toContain('2 approved clip(s)');
  });

  test('pins the one-scene FilmProps: canvas, clip intent, faces and the rebased track', async () => {
    const dir = await makeRenderProject();
    const deps = makeTestDeps();
    await specByVerb(buildClipRenderSpecs(deps), 'clip-render').run(
      makeTestContext({ project: dir, id: ['clip-01'] }, { mode: 'run' }),
    );
    const props = deps.calls.renderVideo[0]!.inputProps as unknown as FilmProps;
    expect(props.width).toBe(1080);
    expect(props.height).toBe(1920);
    expect(props.fps).toBe(30);
    expect(props.scenes).toHaveLength(1);
    const scene = props.scenes[0]!;
    expect(scene.id).toBe('clip-01');
    expect(scene.intent).toBe('clip-vertical');
    expect(scene.source).toBe('clip');
    expect(scene.layout).toBe('single');
    expect(scene.durationInSeconds).toBe(10);
    expect(scene.faces).toEqual([{ id: 'speaker-a', bbox: [100, 100, 250, 250], presence: 0.9 }]);
    expect(scene.mediaSrc).toBe('/public/media/clips/clip-01.mp4');
    expect(scene.mediaDurationSeconds).toBe(10);
    expect(scene.mediaWidth).toBe(1280);
    expect(scene.mediaHeight).toBe(720);
    // The trim's audio plays exactly once: scene audio, never a film master.
    expect(scene.audioSrc).toBe('media/clips/clip-01.wav');
    expect(scene.audioDurationSeconds).toBe(10);
    expect(props.narration).toBeUndefined();
    // The track viewport is the SOURCE frame, not the vertical canvas.
    expect(scene.track?.viewport).toEqual({ width: 1280, height: 720 });
    // Frames at source t = 10, 11, 20 REBASED to the clip clock (0, 1, 10 s)
    // before quantization — outside frames (t = 8, 21) never leak in.
    expect(scene.track?.interactions.map((event) => event.t)).toEqual([0, 1, 10]);
    expect(scene.track?.interactions.map((event) => event.segmentId)).toEqual([
      'f-000002',
      'f-000003',
      'f-000004',
    ]);
    expect(scene.track?.interactions[0]?.action).toBe('select');
  });

  test('--id renders just the named approved range (duo → clip-podcast)', async () => {
    const dir = await makeRenderProject();
    const deps = makeTestDeps();
    const lines: string[] = [];
    const result = await specByVerb(buildClipRenderSpecs(deps), 'clip-render').run(
      makeTestContext({ project: dir, id: ['clip-02'] }, { mode: 'run', lines }),
    );
    expect(result.exitCode).toBe(0);
    expect(deps.calls.renderVideo.map((options) => options.outputLocation)).toEqual([
      join(dir, 'renders', 'clips', 'clip-02.mp4'),
    ]);
    const props = deps.calls.renderVideo[0]!.inputProps as unknown as FilmProps;
    const scene = props.scenes[0]!;
    expect(scene.id).toBe('clip-02');
    expect(scene.intent).toBe('clip-podcast');
    expect(scene.layout).toBe('duo');
    expect(scene.faces).toHaveLength(2);
    expect(scene.durationInSeconds).toBe(15);
    expect(await pathExists(join(dir, 'qa', 'clips', 'clip-02.report.json'))).toBe(true);
  });
});
