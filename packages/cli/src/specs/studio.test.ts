/**
 * End-to-end tests for the studio CLI specs (P-003). Everything goes through
 * the real runtime (`runSpecs`/`runCli`) against a temp workspace:
 *
 * - CLI fixture: a project WITHOUT clients and another with two brands
 *   (two presets from different clients on one asset); an output produced
 *   OUTSIDE the CLI (plain fs write, the open-workshop way); then
 *   snapshot/history/diff/restore through the CLI — never rendering.
 * - `--plan`/`--dry-run` on every command: zero writes, zero subprocess,
 *   proven by before/after tree snapshots plus a sentinel script that WOULD
 *   create a file if a subprocess had been spawned.
 * - `asset render`: preview without --execute; real execution only with
 *   --execute (direct spawn, no shell, confined cwd, symlink parents
 *   rejected); a failing recipe never creates a revision; no recipe is an
 *   actionable error; the CLI never searches templates nor renders.
 * - `--json` queries print ONLY the stable envelope; typed errors keep exit
 *   codes (2 input/usage, 1 operational). Legacy verbs stay intact.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli, runSpecs } from '../runtime';
import { studioSpecs } from './studio';

// ---------------------------------------------------------------------------

function capture(): { lines: string[]; out: (line: string) => void } {
  const lines: string[] = [];
  return { lines, out: (line: string) => void lines.push(line) };
}

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

interface TreeEntry {
  size: number;
  mtimeMs: number;
}

/** Recursive snapshot of path → (size, mtime); missing roots are empty. */
async function treeSnapshot(root: string): Promise<Map<string, TreeEntry>> {
  const entries = new Map<string, TreeEntry>();
  let rootInfo;
  try {
    rootInfo = await stat(root);
  } catch {
    return entries;
  }
  if (!rootInfo.isDirectory()) return entries;
  const walk = async (dir: string): Promise<void> => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, item.name);
      if (item.isDirectory()) {
        await walk(abs);
        continue;
      }
      const info = await stat(abs);
      entries.set(abs, { size: info.size, mtimeMs: info.mtimeMs });
    }
  };
  await walk(root);
  return entries;
}

interface RunResult {
  code: number;
  lines: string[];
}

async function run(argv: string[], cwd: string): Promise<RunResult> {
  const io = capture();
  const code = await runSpecs(studioSpecs, argv, { cwd, out: io.out });
  return { code, lines: io.lines };
}

interface Envelope {
  schemaVersion: number;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

/** `--json` responses are exactly one stable envelope document on stdout. */
function parseEnvelope(result: RunResult): Envelope {
  expect(result.lines.length).toBe(1);
  return JSON.parse(result.lines[0]!) as Envelope;
}

/**
 * Reads a string field off outside-controlled envelope data: the
 * objectContaining assertion validates the shape first, so the recorded cast
 * below only re-states what was just checked (and String() avoids trusting it).
 */
function stringField(value: unknown, key: string): string {
  expect(value).toEqual(expect.objectContaining({ [key]: expect.any(String) }));
  const record: Record<string, unknown> = value as Record<string, unknown>;
  return String(record[key]);
}

/** Real 1x1 PNG (valid signature, so snapshot signature checks pass). */
const PNG_BYTES = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (char) => char.charCodeAt(0),
);

/** Agent-style direct edit of asset.json (the CLI is not the only writer). */
async function editAssetJson(
  ws: string,
  projectId: string,
  assetId: string,
  mutate: (asset: Record<string, unknown>) => void,
): Promise<void> {
  const path = join(ws, 'projects', projectId, 'assets', assetId, 'asset.json');
  const doc = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  mutate(doc);
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
}

async function assetDirOf(ws: string, projectId: string, assetId: string): Promise<string> {
  return join(ws, 'projects', projectId, 'assets', assetId);
}

/** Runs argv with --plan and proves the workspace tree is byte-identical. */
async function expectPlanIsPure(argv: string[], cwd: string, ws: string): Promise<RunResult> {
  const before = await treeSnapshot(ws);
  const result = await run([...argv, '--plan'], cwd);
  expect(result.code).toBe(0);
  expect(result.lines.join('\n')).toContain('plan:');
  const after = await treeSnapshot(ws);
  expect(after.size).toBe(before.size);
  for (const [path, entry] of before) {
    expect(after.get(path)).toEqual(entry);
  }
  return result;
}

// ---------------------------------------------------------------------------

describe('fixture CLI: proyecto sin cliente, dos marcas, output fuera de la CLI', () => {
  let tmp = '';
  let ws = '';
  let versionA = '';
  let versionB = '';
  let revisionR1 = '';
  let revisionR2 = '';

  beforeAll(async () => {
    tmp = await makeTempDir('vm-studio-cli-');
    ws = join(tmp, 'ws');
    await mkdir(ws, { recursive: true });
  });

  test('clientes, presets de dos marcas, proyectos (uno sin cliente) y asset con dos presets', async () => {
    expect((await run(['client', 'create', 'acme', '--name', 'Acme Corp', '--workspace', ws], tmp)).code).toBe(0);
    expect((await run(['client', 'create', 'globex', '--name', 'Globex', '--workspace', ws], tmp)).code).toBe(0);

    const presetAFile = join(tmp, 'brand-a.json');
    await writeFile(presetAFile, JSON.stringify({ name: 'Acme v1', identity: { palette: ['#ff0000'], tone: 'bold' } }));
    const presetBFile = join(tmp, 'brand-b.json');
    await writeFile(presetBFile, JSON.stringify({ name: 'Globex v1', identity: { palette: ['#00ff00'] } }));
    const createdA = parseEnvelope(await run(['preset', 'create', 'brand-a', '--client', 'acme', '--file', presetAFile, '--workspace', ws, '--json'], tmp));
    const createdB = parseEnvelope(await run(['preset', 'create', 'brand-b', '--client', 'globex', '--file', presetBFile, '--workspace', ws, '--json'], tmp));
    expect(createdA.ok).toBe(true);
    expect(createdB.ok).toBe(true);
    versionA = stringField(createdA.data, 'versionId');
    versionB = stringField(createdB.data, 'versionId');
    expect(versionA).not.toBe(versionB);

    // Proyecto SIN cliente es válido; otro con dos clientes.
    const solo = parseEnvelope(await run(['project', 'create', 'solo-proj', '--name', 'Sin cliente', '--workspace', ws, '--json'], tmp));
    expect(solo.data).toEqual(expect.objectContaining({ clientIds: [] }));
    expect((await run(['project', 'create', 'dual-proj', '--name', 'Dos marcas', '--clients', 'acme,globex', '--workspace', ws], tmp)).code).toBe(0);

    const asset = parseEnvelope(
      await run(['asset', 'create', 'hero', '--project', 'dual-proj', '--kind', 'image', '--presets', `brand-a@${versionA},brand-b@${versionB}`, '--workspace', ws, '--json'], tmp),
    );
    expect(asset.data).toEqual(
      expect.objectContaining({
        presetRefs: [
          { presetId: 'brand-a', versionId: versionA },
          { presetId: 'brand-b', versionId: versionB },
        ],
      }),
    );
  });

  test('el agente declara outputs editando asset.json y produce el archivo FUERA de la CLI', async () => {
    await editAssetJson(ws, 'dual-proj', 'hero', (asset) => {
      asset.title = 'Hero cover';
      asset.sources = ['index.html'];
      asset.inputs = ['inputs/logo.png'];
      asset.outputs = [{ name: 'cover', path: 'outputs/cover.png', mediaType: 'image/png', role: 'deliverable' }];
    });
    const dir = await assetDirOf(ws, 'dual-proj', 'hero');
    await writeFile(join(dir, 'index.html'), '<h1>hero r1</h1>');
    await mkdir(join(dir, 'inputs'), { recursive: true });
    await writeFile(join(dir, 'inputs', 'logo.png'), PNG_BYTES);
    // Output producido fuera de la CLI (sin render de la CLI).
    await mkdir(join(dir, 'outputs'), { recursive: true });
    await writeFile(join(dir, 'outputs', 'cover.png'), PNG_BYTES);
  });

  test('inspect muestra fuentes/presets resueltos/outputs reales vía --json', async () => {
    const inspection = parseEnvelope(await run(['asset', 'inspect', 'hero', '--project', 'dual-proj', '--workspace', ws, '--json'], tmp));
    expect(inspection.ok).toBe(true);
    expect(inspection.data).toEqual(
      expect.objectContaining({
        sources: [{ path: 'index.html', present: true }],
        outputs: [expect.objectContaining({ name: 'cover', present: true })],
        presets: [
          expect.objectContaining({ preset: expect.objectContaining({ clientId: 'acme' }) }),
          expect.objectContaining({ preset: expect.objectContaining({ clientId: 'globex' }) }),
        ],
      }),
    );
  });

  test('snapshot r1 → cambia el output fuera de la CLI → snapshot r2; history y diff por CLI', async () => {
    const r1 = parseEnvelope(await run(['asset', 'snapshot', 'hero', '--project', 'dual-proj', '--note', 'r1', '--workspace', ws, '--json'], tmp));
    expect(r1.ok).toBe(true);
    expect(r1.data).toEqual(expect.objectContaining({ rootHash: expect.stringMatching(/^[0-9a-f]{64}$/) }));
    revisionR1 = stringField(r1.data, 'revisionId');

    const dir = await assetDirOf(ws, 'dual-proj', 'hero');
    const changed = new Uint8Array(PNG_BYTES);
    changed[20] = (changed[20]! + 1) % 256;
    await writeFile(join(dir, 'outputs', 'cover.png'), changed);
    await writeFile(join(dir, 'index.html'), '<h1>hero r2</h1>');

    const r2 = parseEnvelope(await run(['asset', 'snapshot', 'hero', '--project', 'dual-proj', '--note', 'r2', '--workspace', ws, '--json'], tmp));
    revisionR2 = stringField(r2.data, 'revisionId');
    expect(revisionR2).not.toBe(revisionR1);
    expect(r2.data).toEqual(expect.objectContaining({ parentRevisionId: revisionR1 }));

    const history = parseEnvelope(await run(['asset', 'history', 'hero', '--project', 'dual-proj', '--workspace', ws, '--json'], tmp));
    expect(history.data).toEqual([
      expect.objectContaining({ revisionId: revisionR1, note: 'r1' }),
      expect.objectContaining({ revisionId: revisionR2, note: 'r2' }),
    ]);

    const diff = parseEnvelope(
      await run(['asset', 'diff', 'hero', '--project', 'dual-proj', '--from', revisionR1, '--to', revisionR2, '--workspace', ws, '--json'], tmp),
    );
    expect(diff.data).toEqual(
      expect.objectContaining({
        outputs: expect.objectContaining({ added: [], removed: [], modified: ['cover'] }),
        files: expect.objectContaining({
          added: [],
          removed: [],
          modified: expect.arrayContaining(['index.html', 'outputs/cover.png']),
        }),
      }),
    );
  });

  test('restore de r1 en directorio vacío devuelve los bytes exactos de r1 (sin regenerar)', async () => {
    const outDir = join(tmp, 'restore-r1');
    const restored = parseEnvelope(
      await run(['asset', 'restore', 'hero', '--project', 'dual-proj', '--revision', revisionR1, '--out', outDir, '--workspace', ws, '--json'], tmp),
    );
    expect(restored.ok).toBe(true);
    const r1Cover = await readFile(join(outDir, 'outputs', 'cover.png'));
    expect(Buffer.from(r1Cover).equals(Buffer.from(PNG_BYTES))).toBe(true);
    const r1Html = await readFile(join(outDir, 'index.html'), 'utf8');
    expect(r1Html).toBe('<h1>hero r1</h1>');
    expect(restored.data).toEqual(
      expect.objectContaining({ files: expect.arrayContaining([expect.objectContaining({ path: 'outputs/cover.png' })]) }),
    );
  });

  test('restore en directorio NO vacío falla (CONFLICT) sin sobrescribir nada', async () => {
    const outDir = join(tmp, 'restore-dirty');
    await mkdir(join(outDir, 'outputs'), { recursive: true });
    await writeFile(join(outDir, 'outputs', 'cover.png'), Buffer.from([0xde, 0xad]));
    const result = await run(['asset', 'restore', 'hero', '--project', 'dual-proj', '--revision', revisionR2, '--out', outDir, '--workspace', ws, '--json'], tmp);
    expect(result.code).toBe(1);
    expect(parseEnvelope(result).error?.code).toBe('CONFLICT');
    expect(await readFile(join(outDir, 'outputs', 'cover.png'))).toEqual(Buffer.from([0xde, 0xad]));
  });

  test('project checkpoint fija r1; revisión inexistente falla NOT_FOUND exit 2', async () => {
    const checkpoint = parseEnvelope(
      await run(['project', 'checkpoint', 'dual-proj', '--revisions', `hero@${revisionR1}`, '--workspace', ws, '--json'], tmp),
    );
    expect(checkpoint.ok).toBe(true);
    const checkpointId = stringField(checkpoint.data, 'checkpointId');
    await expect(stat(join(ws, 'checkpoints', 'dual-proj', `${checkpointId}.json`))).resolves.toBeTruthy();

    const missing = await run(['project', 'checkpoint', 'dual-proj', '--revisions', 'hero@no-existe', '--workspace', ws, '--json'], tmp);
    expect(missing.code).toBe(2);
    expect(parseEnvelope(missing).error?.code).toBe('NOT_FOUND');
  });

  test('queries --json imprimen SOLO el envelope estable', async () => {
    for (const argv of [
      ['client', 'list'],
      ['client', 'show', 'acme'],
      ['preset', 'list'],
      ['project', 'list'],
      ['project', 'show', 'solo-proj'],
      ['asset', 'history', 'hero', '--project', 'dual-proj'],
      ['asset', 'inspect', 'hero', '--project', 'dual-proj'],
    ]) {
      const result = await run([...argv, '--workspace', ws, '--json'], tmp);
      expect(result.code).toBe(0);
      const envelope = parseEnvelope(result);
      expect(envelope.schemaVersion).toBe(1);
      expect(envelope.ok).toBe(true);
    }
  });

  test('show de cliente inexistente: NOT_FOUND, exit 2 y envelope de error', async () => {
    const result = await run(['client', 'show', 'no-existe', '--workspace', ws, '--json'], tmp);
    expect(result.code).toBe(2);
    expect(parseEnvelope(result).error?.code).toBe('NOT_FOUND');
  });
});

describe('dry-run/plan: cero writes, cero subprocess (árbol antes/después + centinela)', () => {
  let tmp = '';
  let ws = '';
  let revisionId = '';

  beforeAll(async () => {
    tmp = await makeTempDir('vm-studio-plan-');
    ws = join(tmp, 'ws');
    await run(['client', 'create', 'acme', '--name', 'Acme', '--workspace', ws], tmp);
    const presetFile = join(tmp, 'p.json');
    await writeFile(presetFile, JSON.stringify({ name: 'P1' }));
    const preset = parseEnvelope(await run(['preset', 'create', 'p1', '--client', 'acme', '--file', presetFile, '--workspace', ws, '--json'], tmp));
    const version = stringField(preset.data, 'versionId');
    await run(['project', 'create', 'p1-proj', '--name', 'P', '--workspace', ws], tmp);
    await run(['asset', 'create', 'a1', '--project', 'p1-proj', '--kind', 'image', '--presets', `p1@${version}`, '--workspace', ws], tmp);
    const dir = await assetDirOf(ws, 'p1-proj', 'a1');
    await mkdir(join(dir, 'workroom'), { recursive: true });
    await mkdir(join(dir, 'inputs'), { recursive: true });
    await writeFile(join(dir, 'inputs', 'logo.png'), PNG_BYTES);
    // Centinela: si un --plan llegara a ejecutar la recipe, este script crearía
    // outputs/cover.png — su ausencia es la prueba de "sin subprocess".
    const script = join(dir, 'workroom', 'render.sh');
    await writeFile(script, '#!/bin/sh\ncp inputs/logo.png outputs/cover.png\n');
    await chmod(script, 0o755);
    // Output existente (producido fuera de la CLI) con bytes DISTINTOS de
    // inputs/logo.png: si el centinela llegara a ejecutarse, el tree snapshot
    // del dry-run detectaría el reemplazo por mtime/tamaño.
    const placeholder = new Uint8Array(PNG_BYTES);
    placeholder[20] = (placeholder[20]! + 7) % 256;
    await mkdir(join(dir, 'outputs'), { recursive: true });
    await writeFile(join(dir, 'outputs', 'cover.png'), placeholder);
    await editAssetJson(ws, 'p1-proj', 'a1', (asset) => {
      asset.outputs = [{ name: 'cover', path: 'outputs/cover.png', mediaType: 'image/png', role: 'deliverable' }];
      asset.recipe = { argv: [script], cwd: '.', outputs: ['outputs/cover.png'] };
    });
    // Una revisión real para que restore/checkpoint en modo plan puedan leerla.
    const snapshot = parseEnvelope(await run(['asset', 'snapshot', 'a1', '--project', 'p1-proj', '--note', 'base', '--workspace', ws, '--json'], tmp));
    revisionId = stringField(snapshot.data, 'revisionId');
  });

  test('todos los comandos mutadores y queries son puros en --plan', async () => {
    const argvs: string[][] = [
      ['client', 'create', 'new-client', '--name', 'Nuevo'],
      ['client', 'list'],
      ['client', 'show', 'acme'],
      ['preset', 'create', 'p2', '--client', 'acme', '--file', join(tmp, 'p.json')],
      ['preset', 'list'],
      ['project', 'create', 'new-proj', '--name', 'N', '--clients', 'acme'],
      ['project', 'checkpoint', 'p1-proj', '--revisions', `a1@${revisionId}`],
      ['asset', 'create', 'a2', '--project', 'p1-proj', '--kind', 'svg'],
      ['asset', 'inspect', 'a1', '--project', 'p1-proj'],
      ['asset', 'snapshot', 'a1', '--project', 'p1-proj', '--note', 'plan note'],
      ['asset', 'history', 'a1', '--project', 'p1-proj'],
      ['asset', 'restore', 'a1', '--project', 'p1-proj', '--revision', revisionId, '--out', join(tmp, 'rest')],
      ['asset', 'render', 'a1', '--project', 'p1-proj'],
    ];
    for (const argv of argvs) {
      await expectPlanIsPure([...argv, '--workspace', ws], tmp, ws);
    }
  });

  test('--plan --json imprime SOLO el envelope con steps (sin texto "plan:")', async () => {
    const before = await treeSnapshot(ws);
    const result = await run(['project', 'checkpoint', 'p1-proj', '--revisions', `a1@${revisionId}`, '--plan', '--json', '--workspace', ws], tmp);
    expect(result.code).toBe(0);
    expect(result.lines.length).toBe(1);
    const envelope = JSON.parse(result.lines[0]!) as { ok: boolean; data?: { verb?: string; steps?: unknown[] } };
    expect(envelope.ok).toBe(true);
    expect(envelope.data?.verb).toBe('project-checkpoint');
    expect((envelope.data?.steps?.length ?? 0)).toBeGreaterThan(0);
    expect(result.lines.join('\n')).not.toContain('plan: ');
    const after = await treeSnapshot(ws);
    expect(after.size).toBe(before.size);
    for (const [path, entry] of before) expect(after.get(path)).toEqual(entry);
  });

  test('--dry-run --json en asset render: envelope con argv de límites inequívocos', async () => {
    const result = await run(['asset', 'render', 'a1', '--project', 'p1-proj', '--dry-run', '--json', '--workspace', ws], tmp);
    expect(result.code).toBe(0);
    expect(result.lines.length).toBe(1);
    const envelope = JSON.parse(result.lines[0]!) as { ok: boolean; data?: { verb?: string; steps?: Array<{ action?: string }> } };
    expect(envelope.ok).toBe(true);
    expect(envelope.data?.verb).toBe('asset-render');
    const action = envelope.data?.steps?.[0]?.action ?? '';
    expect(action.startsWith('ejecutar SIN shell: [')).toBe(true);
    expect(action).toContain('workroom/render.sh');
    expect(action.endsWith('(cwd confinado al asset)')).toBe(true);
  });

  test('--dry-run equivale a --plan y el centinela de subprocess queda intacto', async () => {
    const before = await treeSnapshot(ws);
    const result = await run(['asset', 'render', 'a1', '--project', 'p1-proj', '--dry-run', '--workspace', ws], tmp);
    expect(result.code).toBe(0);
    const text = result.lines.join('\n');
    expect(text).toContain('render.sh');
    expect(text).toContain('outputs/cover.png');
    expect(text).toContain('NO crea revisiones');
    const after = await treeSnapshot(ws);
    expect(after.size).toBe(before.size);
    for (const [path, entry] of before) expect(after.get(path)).toEqual(entry);
    // El output sellado sigue siendo el placeholder: la recipe NO se ejecutó.
    const cover = await readFile(join(await assetDirOf(ws, 'p1-proj', 'a1'), 'outputs', 'cover.png'));
    expect(cover[20]).toBe((PNG_BYTES[20]! + 7) % 256);

    const history = parseEnvelope(await run(['asset', 'history', 'a1', '--project', 'p1-proj', '--workspace', ws, '--json'], tmp));
    expect(history.data).toEqual([expect.objectContaining({ revisionId, note: 'base' })]);
  });
});

describe('asset render: recipe explícita, --execute opt-in, cwd confinado', () => {
  let tmp = '';
  let ws = '';

  beforeAll(async () => {
    tmp = await makeTempDir('vm-studio-render-');
    ws = join(tmp, 'ws');
    await run(['project', 'create', 'p1', '--name', 'P1', '--workspace', ws], tmp);
    for (const assetId of ['ok', 'boom', 'sin-recipe']) {
      await run(['asset', 'create', assetId, '--project', 'p1', '--kind', 'image', '--workspace', ws], tmp);
    }

    const okDir = await assetDirOf(ws, 'p1', 'ok');
    await mkdir(join(okDir, 'workroom'), { recursive: true });
    await mkdir(join(okDir, 'inputs'), { recursive: true });
    await writeFile(join(okDir, 'inputs', 'logo.png'), PNG_BYTES);
    const script = join(okDir, 'workroom', 'render.sh');
    await writeFile(
      script,
      '#!/bin/sh\necho "recipe-stdout-A"\necho "recipe-stderr-B" >&2\ncp inputs/logo.png outputs/cover.png\n',
    );
    await chmod(script, 0o755);
    await editAssetJson(ws, 'p1', 'ok', (asset) => {
      asset.outputs = [{ name: 'cover', path: 'outputs/cover.png', mediaType: 'image/png', role: 'deliverable' }];
      asset.recipe = { argv: ['workroom/render.sh'], cwd: '.', outputs: ['outputs/cover.png'] };
    });

    const boomDir = await assetDirOf(ws, 'p1', 'boom');
    await mkdir(join(boomDir, 'workroom'), { recursive: true });
    const failScript = join(boomDir, 'workroom', 'fail.sh');
    await writeFile(failScript, '#!/bin/sh\necho "fallando a propósito" >&2\nexit 7\n');
    await chmod(failScript, 0o755);
    await editAssetJson(ws, 'p1', 'boom', (asset) => {
      asset.outputs = [{ name: 'never', path: 'outputs/never.png', mediaType: 'image/png', role: 'deliverable' }];
      asset.recipe = { argv: ['workroom/fail.sh'], cwd: '.', outputs: ['outputs/never.png'] };
    });
  });

  test('sin --execute: preview de argv/cwd/outputs reales, cero ejecución', async () => {
    const result = await run(['asset', 'render', 'ok', '--project', 'p1', '--workspace', ws], tmp);
    expect(result.code).toBe(0);
    const text = result.lines.join('\n');
    expect(text).toContain('workroom/render.sh');
    expect(text).toContain('outputs/cover.png');
    expect(text).toContain('--execute');
    await expect(stat(join(await assetDirOf(ws, 'p1', 'ok'), 'outputs', 'cover.png'))).rejects.toThrow();
  });

  test('--execute: spawn directo sin shell, produce los outputs, NO crea revisión', async () => {
    const result = await run(['asset', 'render', 'ok', '--project', 'p1', '--execute', '--workspace', ws, '--json'], tmp);
    expect(result.code).toBe(0);
    expect(parseEnvelope(result).data).toEqual(expect.objectContaining({ executed: true }));
    const cover = await readFile(join(await assetDirOf(ws, 'p1', 'ok'), 'outputs', 'cover.png'));
    expect(Buffer.from(cover).equals(Buffer.from(PNG_BYTES))).toBe(true);
    // El render nunca sella revisiones: el árbol revisions/ ni siquiera existe.
    expect(await readdir(join(ws, 'revisions')).catch(() => null)).toBeNull();
  });

  test('--execute --json: stdout del recipe va a stderr; stdout SOLO envelope; sin revisión', async () => {
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    let result: RunResult;
    try {
      result = await run(['asset', 'render', 'ok', '--project', 'p1', '--execute', '--workspace', ws, '--json'], tmp);
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(result.code).toBe(0);
    // El stdout pertenece al envelope: el "recipe-stdout-A" del proceso NUNCA
    // aparece ahí (fue desviado a stderr); stderr sí llevó ambos streams.
    expect(result.lines.length).toBe(1);
    const envelope = JSON.parse(result.lines[0]!) as { ok: boolean; data?: { executed?: boolean } };
    expect(envelope.ok).toBe(true);
    expect(envelope.data?.executed).toBe(true);
    const diagnostics = stderrChunks.join('');
    expect(diagnostics).toContain('recipe-stdout-A');
    expect(diagnostics).toContain('recipe-stderr-B');
    expect(result.lines[0]).not.toContain('recipe-stdout-A');
    // Sin revisión implícita.
    expect(await readdir(join(ws, 'revisions')).catch(() => null)).toBeNull();
  });

  test('recipe que falla (exit 7): exit 1, envelope RECIPE_FAILED, sin revisión', async () => {
    const result = await run(['asset', 'render', 'boom', '--project', 'p1', '--execute', '--workspace', ws, '--json'], tmp);
    expect(result.code).toBe(1);
    expect(parseEnvelope(result).error?.code).toBe('RECIPE_FAILED');
    await expect(stat(join(await assetDirOf(ws, 'p1', 'boom'), 'outputs', 'never.png'))).rejects.toThrow();
    expect(await readdir(join(ws, 'revisions', 'p1', 'boom')).catch(() => [])).toEqual([]);
  });

  test('asset sin recipe: error accionable (exit 2) que no busca templates ni renderers', async () => {
    const result = await run(['asset', 'render', 'sin-recipe', '--project', 'p1', '--workspace', ws, '--json'], tmp);
    expect(result.code).toBe(2);
    const envelope = parseEnvelope(result);
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(envelope.error?.message).toContain('recipe');
    expect(envelope.error?.message).toContain('asset.json');
  });

  test('cwd que atraviesa un symlink padre se rechaza (PATH_UNSAFE) sin ejecutar nada', async () => {
    const outside = join(tmp, 'outside');
    await mkdir(outside, { recursive: true });
    await run(['asset', 'create', 'escape', '--project', 'p1', '--kind', 'other', '--workspace', ws], tmp);
    const escapeDir = await assetDirOf(ws, 'p1', 'escape');
    await symlink(outside, join(escapeDir, 'dirlink'));
    await editAssetJson(ws, 'p1', 'escape', (asset) => {
      asset.outputs = [{ name: 'mark', path: 'outputs/marker.txt', mediaType: 'text/plain', role: 'deliverable' }];
      asset.recipe = { argv: ['touch', 'escaped.marker'], cwd: 'dirlink', outputs: ['outputs/marker.txt'] };
    });
    const result = await run(['asset', 'render', 'escape', '--project', 'p1', '--execute', '--workspace', ws, '--json'], tmp);
    // PATH_UNSAFE es error de input declarado (asset.json) → exit 2.
    expect(result.code).toBe(2);
    expect(parseEnvelope(result).error?.code).toBe('PATH_UNSAFE');
    await expect(stat(join(outside, 'escaped.marker'))).rejects.toThrow();
  });

  test('snapshot/restore NUNCA llaman render: sella el output tal cual y lo restaura idéntico', async () => {
    const snapshot = parseEnvelope(await run(['asset', 'snapshot', 'ok', '--project', 'p1', '--note', 'con render previo', '--workspace', ws, '--json'], tmp));
    expect(snapshot.ok).toBe(true);
    const revision = stringField(snapshot.data, 'revisionId');
    const outDir = join(tmp, 'restored-ok');
    const restored = parseEnvelope(
      await run(['asset', 'restore', 'ok', '--project', 'p1', '--revision', revision, '--out', outDir, '--workspace', ws, '--json'], tmp),
    );
    expect(restored.ok).toBe(true);
    const bytes = await readFile(join(outDir, 'outputs', 'cover.png'));
    expect(Buffer.from(bytes).equals(Buffer.from(PNG_BYTES))).toBe(true);
  });
});

describe('workspace por defecto y verbos legacy intactos', () => {
  test('sin --workspace usa <cwd>/workspace', async () => {
    const tmp = await makeTempDir('vm-studio-default-');
    const result = await run(['client', 'create', 'c1', '--name', 'C1'], tmp);
    expect(result.code).toBe(0);
    await expect(stat(join(tmp, 'workspace', 'clients', 'c1', 'client.json'))).resolves.toBeTruthy();
  });

  test('runCli: `version` y help global siguen funcionando con el grupo studio registrado', async () => {
    const version = capture();
    expect((await runCli(['version'], { cwd: '/tmp', out: version.out }))).toBe(0);
    expect(version.lines[0]).toContain('vm ');

    const help = capture();
    expect((await runCli(['--help'], { cwd: '/tmp', out: help.out }))).toBe(0);
    const text = help.lines.join('\n');
    expect(text).toContain('client create');
    expect(text).toContain('bundle');
    expect(text).not.toContain('client-create');
  });

  test('registro completo de specs no colisiona con los verbos legacy', () => {
    const legacyVerbs = new Set(['version', 'bundle', 'hydrate', 'archive', 'inspect', 'qa']);
    for (const spec of studioSpecs) {
      expect(legacyVerbs.has(spec.verb)).toBe(false);
      expect(spec.supportsPlan).toBe(true);
    }
  });
});

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});
