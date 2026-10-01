/**
 * mediaSpecs contract (FR-013): the seven verbs as data, plan() pure (zero
 * network/secrets), assemble --dry-run working against a zero-artifact
 * scaffold, and paid runs refusing without the explicit spend cap.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandRunContext, CommandSpec } from '../spec-types';
import { CliFailError, makeTestContext, makeTestDeps, makeTestProject } from '../pipeline/test-support';
import { buildMediaSpecs, mediaSpecs } from './media';

function specByVerb(specs: CommandSpec[], verb: string): CommandSpec {
  const spec = specs.find((entry) => entry.verb === verb);
  if (!spec) throw new Error(`missing spec ${verb}`);
  return spec;
}

describe('mediaSpecs registry surface', () => {
  test('exports exactly the seven media/pipeline verbs', () => {
    expect(mediaSpecs.map((spec) => spec.verb)).toEqual([
      'gen-audio',
      'gen-music',
      'gen-media',
      'still',
      'assemble',
      'qa',
      'publish',
    ]);
    for (const spec of mediaSpecs) {
      expect(spec.supportsPlan).toBe(true);
      expect(spec.args.some((arg) => arg.name === 'project' && arg.default === '.')).toBe(true);
    }
    for (const verb of ['gen-audio', 'gen-music', 'gen-media', 'publish']) {
      const spec = specByVerb(mediaSpecs, verb);
      expect(spec.paid).toBe(true);
      expect(spec.args.some((arg) => arg.name === 'spend-cap' && arg.kind === 'number')).toBe(true);
    }
    // The orchestrator's assemble arg contract: only project/loudness/out;
    // project is flag-or-positional with default '.', the others are optional.
    const assemble = specByVerb(mediaSpecs, 'assemble');
    expect(assemble.args.map((arg) => arg.name)).toEqual(['project', 'loudness', 'out']);
    expect(assemble.args.find((arg) => arg.name === 'loudness')?.default).toBe(true);
    expect(assemble.args.find((arg) => arg.name === 'out')?.default).toBe('renders');
    const projectArg = assemble.args.find((arg) => arg.name === 'project');
    // required + default: positional `vm qa <project>` works AND `--project`
    // stays optional (defaults apply before the missing-required check).
    expect(projectArg?.required).toBe(true);
    expect(projectArg?.default).toBe('.');
    expect(assemble.args.filter((arg) => arg.name !== 'project').every((arg) => arg.required !== true)).toBe(true);
  });
});

describe('plan() purity (NFR-002)', () => {
  test('no fetch and no secret resolution for any verb', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-plan-'));
    await makeTestProject(dir);
    const deps = makeTestDeps();
    const specs = buildMediaSpecs(deps);
    const argsByVerb: Record<string, Record<string, string | number | boolean | string[]>> = {
      'gen-audio': { project: dir },
      'gen-music': { project: dir, use: 'bed-1' },
      'gen-media': { project: dir },
      still: { project: dir },
      assemble: { project: dir },
      qa: { project: dir },
      publish: { project: dir, account: '@demo', text: 'hola' },
    };
    for (const spec of specs) {
      const steps = await spec.plan(makeTestContext(argsByVerb[spec.verb] ?? { project: dir }, { mode: 'plan' }));
      expect(Array.isArray(steps)).toBe(true);
      expect(steps.length).toBeGreaterThan(0);
    }
    expect(deps.calls.fetch).toBe(0);
    expect(deps.calls.secrets).toEqual([]);
    expect(deps.calls.submits).toEqual([]);
    expect(deps.calls.renderVideo).toEqual([]);
  });

  test('run() refuses to execute in plan mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-plan-'));
    await makeTestProject(dir);
    const specs = buildMediaSpecs(makeTestDeps());
    for (const spec of specs) {
      const ctx: CommandRunContext = makeTestContext(
        { project: dir, 'spend-cap': 1 },
        { mode: 'plan' },
      );
      await expect(spec.run(ctx)).rejects.toThrow(/refuses plan mode/);
    }
  });
});

describe('spend-cap refusal (paid runs)', () => {
  test('paid verbs refuse run mode without an explicit --spend-cap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-cap-'));
    await makeTestProject(dir);
    const deps = makeTestDeps();
    const specs = buildMediaSpecs(deps);
    const cases: { verb: string; args: Record<string, string | number | boolean | string[]> }[] = [
      { verb: 'gen-audio', args: { project: dir } },
      { verb: 'gen-music', args: { project: dir, generate: true, provider: 'fal', prompt: 'x' } },
      { verb: 'gen-media', args: { project: dir } },
      { verb: 'publish', args: { project: dir, account: '@demo', text: 'hola' } },
    ];
    for (const { verb, args } of cases) {
      const spec = specByVerb(specs, verb);
      try {
        await spec.run(makeTestContext(args, { mode: 'run' }));
        throw new Error(`${verb} ran without --spend-cap`);
      } catch (error) {
        expect(error).toBeInstanceOf(CliFailError);
        expect((error as Error).message).toContain('--spend-cap');
      }
    }
    // Nothing was submitted before the refusal.
    expect(deps.calls.submits).toEqual([]);
    expect(deps.calls.publish).toBe(0);
  });
});

describe('assemble --dry-run against a zero-artifact scaffold', () => {
  test('plans the full pipeline, offline, mentioning missing prerequisites', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-dry-'));
    await makeTestProject(dir); // video.json + empty dirs only.
    const deps = makeTestDeps();
    const assemble = specByVerb(buildMediaSpecs(deps), 'assemble');
    const steps = await assemble.plan(
      makeTestContext({ project: dir }, { mode: 'plan', lines: [] }),
    );

    // narration check → film props → renderMedia → ducking → loudnorm → evidence.
    const order = steps.map((step) => step.action);
    expect(order[0]).toContain('narration master');
    expect(order[0]).toContain('MISSING');
    expect(order.some((action) => action.includes('film props'))).toBe(true);
    const renderIndex = order.findIndex((action) => action.includes('renderMedia'));
    const duckIndex = order.findIndex((action) => action.includes('ducking'));
    const loudnormIndex = order.findIndex((action) => action.includes('loudnorm'));
    expect(renderIndex).toBeGreaterThan(0);
    expect(duckIndex).toBeGreaterThan(renderIndex);
    expect(loudnormIndex).toBeGreaterThan(duckIndex);

    const renderStep = steps[renderIndex]!;
    expect(renderStep.writes).toBe('renders/test-video.mp4');
    expect(renderStep.gate).toBe('render');
    const evidenceStep = steps.find((step) => step.writes === 'qa/report.json');
    expect(evidenceStep?.gate).toBe('qa');

    // Offline and secret-free.
    expect(deps.calls.fetch).toBe(0);
    expect(deps.calls.secrets).toEqual([]);
    expect(deps.calls.renderVideo).toEqual([]);
  });

  test('the dry-run argv shape works: run() refuses it as plan mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-dry-'));
    await makeTestProject(dir);
    // runCli(['assemble', '--dry-run', '--project', tmp]) parses to this ctx.
    const assemble = specByVerb(buildMediaSpecs(makeTestDeps()), 'assemble');
    await expect(
      assemble.run(makeTestContext({ project: dir }, { mode: 'plan' })),
    ).rejects.toThrow(/refuses plan mode/);
  });
});

describe('other verbs plan offline', () => {
  test('gen-media plans per-scene paid steps with cost estimates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-plan-'));
    await makeTestProject(dir, {
      scenes: [
        {
          id: 'scene-v',
          intent: 'media-frame',
          source: 'fal-video',
          narration: 'Escena generada.',
          status: 'active',
          falVideo: {
            provider: 'fal',
            qualityTier: 'support',
            preset: 'fal-ai/kling-video',
            initialImage: 'assets/first.png',
            promptFile: 'scenes/scene-v/prompt.txt',
            duration: 5,
            maxAttempts: 1,
            budgetUsd: 0.8,
          },
        },
      ],
    });
    const deps = makeTestDeps();
    const genMedia = specByVerb(buildMediaSpecs(deps), 'gen-media');
    const steps = await genMedia.plan(makeTestContext({ project: dir }, { mode: 'plan' }));
    const submitStep = steps.find((step) => step.writes === 'scenes/scene-v/media/video.mp4');
    expect(submitStep?.costUsd).toBe(0.8);
    expect(submitStep?.action).toContain('MISSING');
    expect(steps[steps.length - 1]?.gate).toBe('spend');
    expect(deps.calls.fetch).toBe(0);
    expect(deps.calls.secrets).toEqual([]);
  });

  test('still plans one still per scene in qa/stills', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-plan-'));
    await makeTestProject(dir);
    const still = specByVerb(buildMediaSpecs(makeTestDeps()), 'still');
    const steps = await still.plan(makeTestContext({ project: dir }, { mode: 'plan' }));
    expect(steps.filter((step) => step.writes?.startsWith('qa/stills/'))).toHaveLength(2);
    expect(steps.some((step) => step.action.includes('filmTimingPlan'))).toBe(true);
  });
});

describe('publish social-post.json fallback', () => {
  test('run() lee account/text/media del proyecto cuando faltan flags', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-publish-'));
    await makeTestProject(dir);
    await writeFile(
      join(dir, 'social-post.json'),
      JSON.stringify({
        account: 'instagram:@bfc',
        text: 'hola bfc',
        media: ['https://cdn.example/cover.png'],
        tags: ['gym'],
        idempotencyKey: 'publish:test:bfc-01',
      }),
    );
    const publish = specByVerb(buildMediaSpecs(makeTestDeps()), 'publish');
    const result = await publish.run(
      makeTestContext({ project: dir, 'spend-cap': 2 }, { mode: 'run' }),
    );
    expect(result.exitCode).toBe(0);
    const journal = JSON.parse(
      await readFile(join(dir, 'qa', 'publication', 'publish-test-bfc-01', 'journal.json'), 'utf8'),
    ) as { post: { account: string; text: string; media: string[] } };
    expect(journal.post.account).toBe('instagram:@bfc');
    expect(journal.post.text).toBe('hola bfc');
    expect(journal.post.media).toEqual(['https://cdn.example/cover.png']);
  });

  test('run() exige flags o archivo válido', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-publish-'));
    await makeTestProject(dir);
    const publish = specByVerb(buildMediaSpecs(makeTestDeps()), 'publish');
    await expect(
      publish.run(makeTestContext({ project: dir, 'spend-cap': 2 }, { mode: 'run' })),
    ).rejects.toThrow(/--account and --text/);
    await writeFile(join(dir, 'social-post.json'), '{no-json');
    await expect(
      publish.run(makeTestContext({ project: dir, 'spend-cap': 2 }, { mode: 'run' })),
    ).rejects.toThrow(/social-post.json inválido/);
  });
});
