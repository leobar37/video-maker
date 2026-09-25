import { afterAll, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { loadProject, sha256File } from '@videomaker/core';

import { runSpecs } from '../runtime';
import { inspectSpecs } from './inspect';
import type { PlanStep } from '../spec-types';

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(join(import.meta.dir, '.tmp-inspect-'));
  tempDirs.push(dir);
  return dir;
}

interface RunOutput {
  code: number;
  lines: string[];
}

async function runInspect(argv: string[], cwd: string): Promise<RunOutput> {
  const lines: string[] = [];
  const code = await runSpecs(inspectSpecs, argv, { cwd, out: (line) => lines.push(line) });
  return { code, lines };
}

async function scaffold(root: string, name: string, id: string): Promise<string> {
  const result = await runInspect(
    ['new', '--project', name, '--product', 'demo', '--id', id, '--title', `Video ${id}`],
    root,
  );
  expect(result.code).toBe(0);
  return join(root, name);
}

async function editConfig(projectDir: string, mutate: (config: Record<string, unknown>) => void): Promise<void> {
  const path = join(projectDir, 'video.json');
  const config = JSON.parse(await fsp.readFile(path, 'utf8')) as Record<string, unknown>;
  mutate(config);
  await fsp.writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** Recursive snapshot: relative path → content hash + mtime (detects any write). */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      const stat = await fsp.stat(absolute);
      snapshot[absolute.slice(root.length)] = `${await sha256File(absolute)}@${stat.mtimeMs}`;
    }
  }
  await walk(root);
  return snapshot;
}

describe('new: scaffolder idempotente', () => {
  test('crea config + directorios canónicos dejando las escenas pendientes', async () => {
    const root = await makeTempDir();
    const projectDir = await scaffold(root, 'proj', '01-demo');
    const project = await loadProject(projectDir);
    expect(project.slug).toBe('demo/01-demo');
    for (const subdir of ['script', 'scenes', 'remotion', 'qa', 'renders', 'assets']) {
      const stat = await fsp.stat(join(projectDir, subdir));
      expect(stat.isDirectory()).toBe(true);
    }
    expect(project.config.scenes.every((scene) => scene.status === 'pending')).toBe(true);
    const narration = await fsp.readFile(join(projectDir, 'script', 'narration.md'), 'utf8');
    expect(narration).toContain('01-demo');
  });

  test('la segunda ejecución es un no-op byte a byte', async () => {
    const root = await makeTempDir();
    const projectDir = await scaffold(root, 'proj', '01-demo');
    const before = await snapshotTree(root);
    const second = await runInspect(['new', '--project', 'proj', '--product', 'demo', '--id', '01-demo'], root);
    expect(second.code).toBe(0);
    expect(second.lines.join('\n')).toContain('no-op');
    expect(await snapshotTree(root)).toEqual(before);
  });

  test('id inválido falla sin escribir nada', async () => {
    const root = await makeTempDir();
    const result = await runInspect(['new', '--project', 'proj', '--id', 'Bad Slug'], root);
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toContain('id inválido');
  });
});

describe('preflight: chequeos locales sin red', () => {
  test('proyecto recién creado pasa el preflight', async () => {
    const root = await makeTempDir();
    await scaffold(root, 'proj', '01-demo');
    const result = await runInspect(['preflight', '--project', 'proj'], root);
    expect(result.code).toBe(0);
    expect(result.lines.join('\n')).not.toContain('[FAIL]');
  });

  test('video.json corrupto reporta falla y exit != 0', async () => {
    const root = await makeTempDir();
    const projectDir = await scaffold(root, 'proj', '01-demo');
    await fsp.writeFile(join(projectDir, 'video.json'), '{ roto');
    const result = await runInspect(['preflight', '--project', 'proj', '--json'], root);
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toContain('video.json');
  });

  test('directorio faltante y asset ausente en escena activa fallan', async () => {
    const root = await makeTempDir();
    const projectDir = await scaffold(root, 'proj', '01-demo');
    await fsp.rm(join(projectDir, 'renders'), { recursive: true });
    await editConfig(projectDir, (config) => {
      const scenes = config.scenes as Array<Record<string, unknown>>;
      scenes[0]!.status = 'active';
      scenes[0]!.narration = 'Narración real.';
      scenes[0]!.intent = 'intent real';
      scenes[0]!.source = 'avatar';
      scenes[0]!.avatar = { image: 'assets/falta.png', audio: 'assets/falta.wav' };
    });
    const result = await runInspect(['preflight', '--project', 'proj'], root);
    expect(result.code).not.toBe(0);
    const text = result.lines.join('\n');
    expect(text).toContain('dir renders/');
    expect(text).toContain('assets/falta.png');
    // Los assets de la escena activa ausentes son falla, no solo aviso.
    expect(text).toMatch(/\[FAIL\] asset assets\/falta\.png/);
  });
});

describe('status: gates derivados de artefactos (FR-009)', () => {
  test('los gates cambian cuando aparecen (y desaparecen) artefactos', async () => {
    const root = await makeTempDir();
    const projectDir = await scaffold(root, 'proj', '01-demo');

    // Estado inicial: sin artefactos de producción todo está pendiente.
    let result = await runInspect(['status', '--project', 'proj', '--check', 'render'], root);
    expect(result.code).toBe(1);

    await fsp.writeFile(join(projectDir, 'renders', 'final.mp4'), 'fake-video');
    result = await runInspect(['status', '--project', 'proj', '--check', 'render'], root);
    expect(result.code).toBe(0);

    await fsp.writeFile(
      join(projectDir, 'qa', 'report.json'),
      `${JSON.stringify({ schemaVersion: 1, checks: [{ code: 'demo', status: 'pass' }] }, null, 2)}\n`,
    );
    result = await runInspect(['status', '--project', 'proj', '--check', 'qa'], root);
    expect(result.code).toBe(0);

    // Quitar el artefacto devuelve el gate a pendiente: no hay estado editable.
    await fsp.rm(join(projectDir, 'renders', 'final.mp4'));
    result = await runInspect(['status', '--project', 'proj', '--check', 'render'], root);
    expect(result.code).toBe(1);
  });

  test('el storyboard se satisface al activar las escenas con texto real', async () => {
    const root = await makeTempDir();
    const projectDir = await scaffold(root, 'proj', '01-demo');
    expect((await runInspect(['status', '--project', 'proj', '--check', 'storyboard'], root)).code).toBe(1);
    await editConfig(projectDir, (config) => {
      for (const scene of config.scenes as Array<Record<string, unknown>>) {
        scene.status = 'active';
        scene.intent = 'intent definitivo';
        scene.narration = `Narración definitiva de ${String(scene.id)}.`;
      }
    });
    expect((await runInspect(['status', '--project', 'proj', '--check', 'storyboard'], root)).code).toBe(0);
  });

  test('--check con gate desconocido falla con la lista válida', async () => {
    const root = await makeTempDir();
    await scaffold(root, 'proj', '01-demo');
    const result = await runInspect(['status', '--project', 'proj', '--check', 'nope'], root);
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toContain('storyboard');
  });
});

describe('catalog + find: índice de proyectos (FR-010)', () => {
  test('catalog genera el índice y find filtra por texto/status/bundle', async () => {
    const root = await makeTempDir();
    await scaffold(root, 'p1', '01-one');
    await scaffold(root, 'p2', '02-two');

    const catalog = await runInspect(['catalog', '--root', '.'], root);
    expect(catalog.code).toBe(0);
    const index = JSON.parse(await fsp.readFile(join(root, 'videos.json'), 'utf8')) as {
      videos: Array<{ id: string }>;
    };
    expect(index.videos.map((entry) => entry.id)).toEqual(['demo/01-one', 'demo/02-two']);

    const byText = await runInspect(['find', '--text', 'one'], root);
    expect(byText.code).toBe(0);
    expect(byText.lines.join('\n')).toContain('demo/01-one');
    expect(byText.lines.join('\n')).not.toContain('demo/02-two');

    const missing = await runInspect(['find', '--missing', 'bundle', '--json'], root);
    expect(missing.code).toBe(0);
    expect(JSON.parse(missing.lines.join('\n')) as unknown[]).toHaveLength(2);

    // Evidencia de bundle en p1 → sale del filtro --missing bundle.
    await fsp.writeFile(join(root, 'p1', 'qa', 'archive.json'), '{}\n');
    await runInspect(['catalog', '--root', '.'], root);
    const afterBundle = await runInspect(['find', '--missing', 'bundle'], root);
    expect(afterBundle.lines.join('\n')).toContain('demo/02-two');
    expect(afterBundle.lines.join('\n')).not.toContain('demo/01-one');
  });

  test('filtra por tag y por status published', async () => {
    const root = await makeTempDir();
    const projectDir = await scaffold(root, 'p1', '01-one');
    await editConfig(projectDir, (config) => {
      config.tags = ['lanzamiento'];
    });
    await fsp.mkdir(join(projectDir, 'qa', 'publication', 'a1'), { recursive: true });
    await fsp.writeFile(
      join(projectDir, 'qa', 'publication', 'a1', 'journal.json'),
      `${JSON.stringify({ schemaVersion: 1, stages: ['complete'] }, null, 2)}\n`,
    );
    await runInspect(['catalog', '--root', '.'], root);

    const byTag = await runInspect(['find', '--tag', 'lanzamiento', '--json'], root);
    expect(JSON.parse(byTag.lines.join('\n')) as unknown[]).toHaveLength(1);
    const published = await runInspect(['find', '--status', 'published', '--json'], root);
    expect(JSON.parse(published.lines.join('\n')) as unknown[]).toHaveLength(1);
    const draft = await runInspect(['find', '--status', 'draft', '--json'], root);
    expect(JSON.parse(draft.lines.join('\n')) as unknown[]).toHaveLength(0);
  });

  test('find sin índice falla sugiriendo catalog', async () => {
    const root = await makeTempDir();
    const result = await runInspect(['find'], root);
    expect(result.code).not.toBe(0);
    expect(result.lines.join('\n')).toContain('vm catalog');
  });

  test('find valida los valores de --missing y --status', async () => {
    const root = await makeTempDir();
    await runInspect(['catalog', '--root', '.'], root);
    expect((await runInspect(['find', '--missing', 'otra'], root)).code).not.toBe(0);
    expect((await runInspect(['find', '--status', 'otro'], root)).code).not.toBe(0);
  });
});

describe('plan: agregado offline de lo que haría el pipeline', () => {
  test('lista los pasos de los gates pendientes sin tocar la red', async () => {
    const root = await makeTempDir();
    const projectDir = await scaffold(root, 'proj', '01-demo');
    const result = await runInspect(['plan', '--project', 'proj', '--json'], root);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.lines.join('\n')) as { steps: PlanStep[] };
    const gates = payload.steps.map((step) => step.gate);
    expect(gates).toContain('storyboard');
    expect(gates).toContain('render');
    expect(gates).toContain('publish');

    // Activar la escena demo agrega pasos de assets concretos.
    await editConfig(projectDir, (config) => {
      const scenes = config.scenes as Array<Record<string, unknown>>;
      const demo = scenes.find((scene) => scene.id === 's2-demo')!;
      demo.status = 'active';
      demo.intent = 'intent definitivo';
      demo.narration = 'Narración definitiva.';
    });
    const withAssets = await runInspect(['plan', '--project', 'proj', '--json'], root);
    const writes = (JSON.parse(withAssets.lines.join('\n')) as { steps: PlanStep[] }).steps.map(
      (step) => step.writes,
    );
    expect(writes).toContain('script/audio/narration.wav');
    expect(writes).toContain('scenes/s2-demo/capture.mp4');
  });

  test('una escena fal-video aporta el costo estimado al plan', async () => {
    const root = await makeTempDir();
    const projectDir = await scaffold(root, 'proj', '01-demo');
    await editConfig(projectDir, (config) => {
      const scenes = config.scenes as Array<Record<string, unknown>>;
      const hook = scenes.find((scene) => scene.id === 's1-hook')!;
      hook.status = 'active';
      hook.intent = 'intent definitivo';
      hook.narration = 'Narración definitiva.';
      hook.source = 'fal-video';
      hook.falVideo = {
        provider: 'fal',
        qualityTier: 'support',
        preset: 'preset-demo',
        initialImage: 'assets/ini.png',
        promptFile: 'assets/prompt.txt',
        duration: 4,
        maxAttempts: 2,
        budgetUsd: 0.5,
      };
    });
    const result = await runInspect(['plan', '--project', 'proj', '--json'], root);
    const payload = JSON.parse(result.lines.join('\n')) as { steps: PlanStep[] };
    const step = payload.steps.find((entry) => entry.writes === 'scenes/s1-hook/generated.mp4');
    expect(step?.costUsd).toBe(0.5);
    expect(step?.gate).toBe('assets');
  });
});
