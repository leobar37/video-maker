import { afterAll, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { sha256File } from '@videomaker/core';
import { SceneBriefSchema, SceneDelegationJournalSchema, SceneResultSchema } from '@videomaker/schemas';

import { runSpecs } from '../runtime';
import { inspectSpecs } from './inspect';
import { sceneSpecs } from './scene';

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(join(import.meta.dir, '.tmp-scene-'));
  tempDirs.push(dir);
  return dir;
}

interface RunOutput {
  code: number;
  lines: string[];
}

async function runScene(argv: string[], cwd: string): Promise<RunOutput> {
  const lines: string[] = [];
  const code = await runSpecs(sceneSpecs, argv, { cwd, out: (line) => lines.push(line) });
  return { code, lines };
}

/** Scaffolded project with `s1-hook` active (motion) and optionally its brief. */
async function makeSceneProject(options: { withBrief: boolean }): Promise<{ root: string; projectDir: string }> {
  const root = await makeTempDir();
  const scaffold = await runSpecs(
    inspectSpecs,
    ['new', '--project', 'proj', '--product', 'demo', '--id', '01-demo', '--title', 'Video demo'],
    { cwd: root, out: () => {} },
  );
  expect(scaffold).toBe(0);
  const projectDir = join(root, 'proj');
  const configPath = join(projectDir, 'video.json');
  const config = JSON.parse(await fsp.readFile(configPath, 'utf8')) as {
    scenes: Array<Record<string, unknown>>;
  };
  const hook = config.scenes.find((scene) => scene.id === 's1-hook')!;
  hook.status = 'active';
  hook.intent = 'hook del video';
  hook.narration = 'Una toma de apertura.';
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  if (options.withBrief) {
    const brief = await runScene(['scene-brief', 's1-hook', '--project', 'proj'], root);
    expect(brief.code).toBe(0);
  }
  return { root, projectDir };
}

async function writeResult(projectDir: string, result: Record<string, unknown>): Promise<void> {
  await fsp.writeFile(
    join(projectDir, 'scenes', 's1-hook.result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  );
}

describe('scene-brief (FR-014)', () => {
  test('emite un SceneBrief válido y project-relative para la escena', async () => {
    const { projectDir } = await makeSceneProject({ withBrief: true });
    const raw = JSON.parse(await fsp.readFile(join(projectDir, 'scenes', 's1-hook.brief.json'), 'utf8'));
    const brief = SceneBriefSchema.parse(raw);
    expect(brief.sceneId).toBe('s1-hook');
    expect(brief.agent).toBe('remotion-scene-designer');
    expect(brief.videoDir).toBe('demo/01-demo');
    expect(brief.outputPath).toBe('remotion/scenes/s1-hook.tsx');
    expect(brief.stillPath).toBe('qa/stills/s1-hook.png');
    expect(brief.contextFiles[0]).toBe('scenes/s1-hook.brief.json');
    expect(brief.durationSeconds).toBe(5);
    // Sin red: el branding resuelve del preset o cae en tokens neutros.
    expect(brief.branding.canvasFrom.length).toBeGreaterThan(0);
  });

  test('escena inexistente o pendiente falla con mensaje accionable', async () => {
    const { root } = await makeSceneProject({ withBrief: false });
    const missing = await runScene(['scene-brief', 's9-nope', '--project', 'proj'], root);
    expect(missing.code).not.toBe(0);
    expect(missing.lines.join('\n')).toContain('no existe');
    const pending = await runScene(['scene-brief', 's3-cta', '--project', 'proj'], root);
    expect(pending.code).not.toBe(0);
    expect(pending.lines.join('\n')).toContain('pending');
  });
});

describe('scene-log: journal de delegación', () => {
  test('record exige el brief y ata la entrada a su digest', async () => {
    const { root, projectDir } = await makeSceneProject({ withBrief: true });
    const result = await runScene(
      [
        'scene-log',
        'record',
        '--project',
        'proj',
        '--scene',
        's1-hook',
        '--agent',
        'remotion-scene-designer',
        '--agent-id',
        'agt-1',
        '--history',
        'history://h-1',
        '--started-at',
        '2026-09-25T10:00:00Z',
        '--ended-at',
        '2026-09-25T10:05:00Z',
        '--outcome',
        'ok',
        '--result-ref',
        'scenes/s1-hook.result.json',
      ],
      root,
    );
    expect(result.code).toBe(0);
    const journal = SceneDelegationJournalSchema.parse(
      JSON.parse(await fsp.readFile(join(projectDir, 'scenes', 's1-hook.delegation.json'), 'utf8')),
    );
    expect(journal.entries).toHaveLength(1);
    const entry = journal.entries[0]!;
    expect(entry.agentId).toBe('agt-1');
    expect(entry.historyRef).toBe('history://h-1');
    expect(entry.outcome).toBe('ok');
    expect(entry.briefDigest).toBe(await sha256File(join(projectDir, 'scenes', 's1-hook.brief.json')));

    const list = await runScene(['scene-log', 'list', '--project', 'proj', '--json'], root);
    expect(list.code).toBe(0);
    expect(JSON.parse(list.lines.join('\n')) as unknown[]).toHaveLength(1);
  });

  test('sin brief no hay delegación válida', async () => {
    const { root } = await makeSceneProject({ withBrief: false });
    const result = await runScene(
      [
        'scene-log',
        'record',
        '--project',
        'proj',
        '--scene',
        's1-hook',
        '--agent',
        'remotion-scene-designer',
        '--agent-id',
        'agt-1',
        '--history',
        'history://h-1',
        '--started-at',
        '2026-09-25T10:00:00Z',
        '--outcome',
        'running',
      ],
      root,
    );
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toContain('brief');
  });

  test('record valida los flags requeridos y el outcome', async () => {
    const { root } = await makeSceneProject({ withBrief: true });
    const base = ['scene-log', 'record', '--project', 'proj', '--scene', 's1-hook'];
    const missing = await runScene(base, root);
    expect(missing.code).not.toBe(0);
    expect(missing.lines.join('\n')).toContain('--agent');
    const badOutcome = await runScene(
      [
        ...base,
        '--agent',
        'a',
        '--agent-id',
        'b',
        '--history',
        'history://h',
        '--started-at',
        '2026-09-25T10:00:00Z',
        '--outcome',
        'maybe',
      ],
      root,
    );
    expect(badOutcome.code).not.toBe(0);
    expect(badOutcome.lines.join('\n')).toContain('--outcome');
  });
});

describe('scene-verify: evidencia independiente (FR-014)', () => {
  async function verifiedProject(): Promise<{ projectDir: string; root: string; outputSha256: string }> {
    const { root, projectDir } = await makeSceneProject({ withBrief: true });
    await fsp.mkdir(join(projectDir, 'remotion', 'scenes'), { recursive: true });
    await fsp.writeFile(join(projectDir, 'remotion', 'scenes', 's1-hook.tsx'), 'export default {};');
    const outputSha256 = await sha256File(join(projectDir, 'remotion', 'scenes', 's1-hook.tsx'));
    await writeResult(projectDir, {
      schemaVersion: 2,
      sceneId: 's1-hook',
      agent: 'remotion-scene-designer',
      executionStatus: 'ok',
      editorialVerdict: 'unreviewed',
      outputPath: 'remotion/scenes/s1-hook.tsx',
      outputSha256,
      diagnostics: [],
    });
    return { projectDir, root, outputSha256 };
  }

  test('round-trip: hashes reales verifican y el comando sale con 0', async () => {
    const { projectDir, root } = await verifiedProject();
    const result = await runScene(['scene-verify', 's1-hook', '--project', 'proj', '--json'], root);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.lines.join('\n')) as { ok: boolean };
    expect(payload.ok).toBe(true);
    // El SceneResult parsea con el contrato versionado.
    SceneResultSchema.parse(JSON.parse(await fsp.readFile(join(projectDir, 'scenes', 's1-hook.result.json'), 'utf8')));
  });

  test('un byte alterado en el artefacto invalida la verificación', async () => {
    const { projectDir, root } = await verifiedProject();
    await fsp.writeFile(join(projectDir, 'remotion', 'scenes', 's1-hook.tsx'), 'export default {}; // tampered');
    const result = await runScene(['scene-verify', 's1-hook', '--project', 'proj'], root);
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toContain('SHA-256 no coincide');
  });

  test('un hash mentiroso en el resultado no pasa', async () => {
    const { projectDir, root } = await verifiedProject();
    await writeResult(projectDir, {
      schemaVersion: 2,
      sceneId: 's1-hook',
      agent: 'remotion-scene-designer',
      executionStatus: 'ok',
      editorialVerdict: 'unreviewed',
      outputPath: 'remotion/scenes/s1-hook.tsx',
      outputSha256: 'a'.repeat(64),
      diagnostics: [],
    });
    const result = await runScene(['scene-verify', 's1-hook', '--project', 'proj'], root);
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toContain('SHA-256 no coincide');
  });

  test('outputPath que no corresponde al brief falla', async () => {
    const { projectDir, root, outputSha256 } = await verifiedProject();
    await fsp.writeFile(join(projectDir, 'remotion', 'scenes', 'otro.tsx'), 'x');
    await writeResult(projectDir, {
      schemaVersion: 2,
      sceneId: 's1-hook',
      agent: 'remotion-scene-designer',
      executionStatus: 'ok',
      editorialVerdict: 'unreviewed',
      outputPath: 'remotion/scenes/otro.tsx',
      outputSha256,
      diagnostics: [],
    });
    const result = await runScene(['scene-verify', 's1-hook', '--project', 'proj'], root);
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toContain('outputPath no corresponde');
  });

  test('veredicto editorial inconsistente con diagnósticos de error falla', async () => {
    const { projectDir, root, outputSha256 } = await verifiedProject();
    await writeResult(projectDir, {
      schemaVersion: 2,
      sceneId: 's1-hook',
      agent: 'remotion-scene-designer',
      executionStatus: 'ok',
      editorialVerdict: 'pass',
      outputPath: 'remotion/scenes/s1-hook.tsx',
      outputSha256,
      diagnostics: [{ level: 'error', message: 'algo roto' }],
    });
    const result = await runScene(['scene-verify', 's1-hook', '--project', 'proj'], root);
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toContain('SceneResult inválido');
  });

  test('una ejecución que no terminó en ok sale con exit != 0', async () => {
    const { projectDir, root } = await verifiedProject();
    await writeResult(projectDir, {
      schemaVersion: 2,
      sceneId: 's1-hook',
      agent: 'remotion-scene-designer',
      executionStatus: 'fail',
      editorialVerdict: 'blocked',
      diagnostics: [{ level: 'error', message: 'falló la generación' }],
    });
    const result = await runScene(['scene-verify', 's1-hook', '--project', 'proj'], root);
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toContain('no terminó en "ok"');
  });

  test('falta el resultado → exit != 0 con mensaje accionable', async () => {
    const { root } = await makeSceneProject({ withBrief: true });
    const result = await runScene(['scene-verify', 's1-hook', '--project', 'proj'], root);
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toContain('Falta el resultado');
  });
});
