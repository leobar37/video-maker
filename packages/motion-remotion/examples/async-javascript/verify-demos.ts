#!/usr/bin/env bun
/**
 * examples/async-javascript/verify-demos.ts
 *
 * Comando: bun packages/motion-remotion/examples/async-javascript/verify-demos.ts
 *
 * Runner de evidencias para el guion `javascript-asincrono`. Por cada escena:
 *  - escribe un harness temporal `.mjs` en un directorio aislado (mkdtemp),
 *  - lo ejecuta con un runtime Node real (node:child_process),
 *  - captura stdout y lo compara con `expectedOutput` del guion,
 *  - limpia los temporales en `finally`.
 *
 * Escenas especiales:
 *  - 02-esperas: conceptual (no se ejecuta nada), se etiqueta como tal.
 *  - 12-concurrencia: mide ambas fases (secuencial/concurrente) con `wait(1000)`
 *    real; solo se exige el orden de dependencias (secuencial > concurrente),
 *    nunca valores exactos de 1s/2s.
 *  - 13-fetch: servidor HTTP efímero `node:http` en 127.0.0.1 (nunca externo)
 *    con /ok -> {"message":"Datos recibidos"} y /missing -> 404; el código se
 *    ejecuta dos veces, una por cada salida.
 *
 * Sin red externa, sin APIs, sin secretos. Timeout del hijo: 10s. Salida 1 si
 * alguna escena no coincide. La evidencia se escribe en
 * projects/tutorials/javascript-asincrono/qa/demo-results.json
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const SCRIPT_ID = 'javascript-asincrono';
const CHILD_TIMEOUT_MS = 10_000;
const MEASUREMENTS_PREFIX = '__MEASUREMENTS__';

const ROOT = resolve(import.meta.dir, '../../../..');
const SCRIPT_PATH = resolve(ROOT, 'projects/tutorials', SCRIPT_ID, 'script.json');
const QA_DIR = resolve(ROOT, 'projects/tutorials', SCRIPT_ID, 'qa');
const OUTPUT_PATH = resolve(QA_DIR, 'demo-results.json');

// Helper inyectado en las escenas que usan `wait` sin declararlo (08 ya lo trae).
const WAIT_HELPER =
  'const wait = (ms) => { const { promise, resolve } = Promise.withResolvers(); setTimeout(resolve, ms); return promise; };';

interface ScriptScene {
  id: string;
  code: string;
  expectedOutput: string[];
}

interface ScriptDoc {
  schemaVersion: number;
  id: string;
  scenes: ScriptScene[];
}

interface Measurements {
  sequentialMs: number;
  concurrentMs: number;
}

interface SceneResult {
  id: string;
  codeSha256: string;
  expectedOutput: string[];
  actualOutput: string[];
  passed: boolean;
  durationMs: number;
  measurements?: Measurements;
  kind: 'executed' | 'conceptual';
}

interface DemoResults {
  schemaVersion: 1;
  runtime: string;
  nodeVersion: string;
  verifiedAt: string;
  scenes: SceneResult[];
}

interface ChildResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

/** Runtime Node: NODE_BIN explícito, luego PATH, luego ubicaciones conocidas. */
function resolveNodeBin(): string {
  const explicit = process.env.NODE_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  const fromPath = typeof Bun !== 'undefined' ? Bun.which('node') : null;
  if (fromPath) return fromPath;
  const candidates = [
    '/tmp/node-dist/node/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    join(homedir(), '.local/bin/node'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Runtime Node no encontrado. Define NODE_BIN o instala Node en el PATH.');
}

/**
 * Construye el fuente del harness para una escena: el código del guion más
 * únicamente los imports/wrappers necesarios (nunca se altera la semántica).
 */
function buildSource(scene: ScriptScene, nodeVersion: string): string {
  const lines: string[] = [
    `// Harness temporal generado por verify-demos.ts - runtime Node ${nodeVersion}.`,
    '// Solo se añaden imports/harness mínimos; el código de la escena va verbatim.',
  ];
  if (['05-', '06-', '14-'].some((prefix) => scene.id.startsWith(prefix))) {
    lines.push('// El event loop del navegador se explica en el video como diagrama simplificado;');
    lines.push('// en Node este ejemplo produce el mismo orden de salida mostrado.');
  }

  if (scene.id.startsWith('12-')) {
    // Medición de las dos fases del guion conservando el orden de dependencias.
    const concurrentStart = scene.code.indexOf('// Concurrente:');
    if (concurrentStart < 0) throw new Error('La escena 12 debe delimitar sus dos bloques medidos.');
    lines.push(WAIT_HELPER);
    lines.push('{');
    lines.push('  const __t0 = performance.now();');
    lines.push(scene.code.slice(0, concurrentStart));
    lines.push('  const sequentialMs = performance.now() - __t0;');
    lines.push('  const __t1 = performance.now();');
    lines.push(scene.code.slice(concurrentStart));
    lines.push('  const concurrentMs = performance.now() - __t1;');
    lines.push(`  console.log('${MEASUREMENTS_PREFIX}' + JSON.stringify({ sequentialMs, concurrentMs }));`);
    lines.push('}');
    return lines.join('\n') + '\n';
  }

  if (scene.id.startsWith('13-')) {
    // Servidor efímero solo loopback; el código del guion se ejecuta dentro de
    // `attempt(url)` para cubrir la respuesta OK y la 404.
    lines.push("import { createServer } from 'node:http';");
    lines.push('const server = createServer((req, res) => {');
    lines.push("  if (req.url === '/ok') {");
    lines.push("    res.writeHead(200, { 'content-type': 'application/json' });");
    lines.push("    res.end(JSON.stringify({ message: 'Datos recibidos' }));");
    lines.push('    return;');
    lines.push('  }');
    lines.push("  res.writeHead(404, { 'content-type': 'application/json' });");
    lines.push("  res.end(JSON.stringify({ error: 'not found' }));");
    lines.push('});');
    lines.push('const __listening = Promise.withResolvers();');
    lines.push("server.listen(0, '127.0.0.1', __listening.resolve);");
    lines.push('await __listening.promise;');
    lines.push('const __address = server.address();');
    lines.push("const __port = typeof __address === 'object' && __address ? __address.port : 0;");
    lines.push('async function attempt(url) {');
    lines.push(
      scene.code
        .split('\n')
        .map((line) => '  ' + line)
        .join('\n'),
    );
    lines.push('}');
    lines.push('try {');
    lines.push("  await attempt('http://127.0.0.1:' + __port + '/ok');");
    lines.push("  await attempt('http://127.0.0.1:' + __port + '/missing');");
    lines.push('} finally {');
    lines.push('  const __closed = Promise.withResolvers();');
    lines.push('  server.close(() => __closed.resolve());');
    lines.push('  await __closed.promise;');
    lines.push('}');
    return lines.join('\n') + '\n';
  }

  if (scene.id.startsWith('04-')) {
    lines.push("import { writeFile, readFile } from 'node:fs';");
  } else if (/wait\s*\(/.test(scene.code) && !/\b(?:const|let|var)\s+wait\b/.test(scene.code)) {
    lines.push(WAIT_HELPER);
  }
  lines.push(scene.code);
  return lines.join('\n') + '\n';
}

function runNode(nodeBin: string, file: string, cwd: string): Promise<ChildResult> {
  const { promise, resolve: resolveRun } = Promise.withResolvers<ChildResult>();
  const start = performance.now();
  const child = spawn(nodeBin, [file], {
    cwd,
    env: { ...process.env, NODE_OPTIONS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let settled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, CHILD_TIMEOUT_MS);
  const finish = (exitCode: number | null): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveRun({ stdout, stderr, exitCode, timedOut, durationMs: Math.round(performance.now() - start) });
  };
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.on('error', (error: Error) => {
    stderr += error.message;
    finish(null);
  });
  child.on('close', (code) => finish(code));
  return promise;
}

function extractMeasurements(lines: string[]): Measurements | null {
  const marker = lines.find((line) => line.startsWith(MEASUREMENTS_PREFIX));
  if (!marker) return null;
  try {
    const parsed = JSON.parse(marker.slice(MEASUREMENTS_PREFIX.length)) as Partial<Measurements>;
    if (typeof parsed.sequentialMs !== 'number' || typeof parsed.concurrentMs !== 'number') return null;
    return { sequentialMs: parsed.sequentialMs, concurrentMs: parsed.concurrentMs };
  } catch {
    return null;
  }
}

function computePassed(
  scene: ScriptScene,
  actualOutput: string[],
  measurements: Measurements | null,
  result: ChildResult,
): boolean {
  if (result.timedOut || result.exitCode !== 0) return false;
  const outputOk =
    actualOutput.length === scene.expectedOutput.length &&
    actualOutput.every((value, index) => value === scene.expectedOutput[index]);
  if (scene.id.startsWith('12-')) {
    // Solo el orden de dependencias: la fase secuencial suma dos esperas, la
    // concurrente las solapa. Sin asertar valores exactos de tiempo.
    return outputOk && measurements !== null && measurements.sequentialMs > measurements.concurrentMs;
  }
  return outputOk;
}

async function main(): Promise<number> {
  const script = JSON.parse(await readFile(SCRIPT_PATH, 'utf8')) as ScriptDoc;
  const nodeBin = resolveNodeBin();
  const versionProbe = spawnSync(nodeBin, ['--version'], { encoding: 'utf8' });
  const nodeVersion = (versionProbe.stdout ?? '').trim() || 'unknown';

  const tmpRoot = await mkdtemp(join(tmpdir(), 'async-js-demos-'));
  const scenes: SceneResult[] = [];
  try {
    for (const scene of script.scenes) {
      const codeSha256 = createHash('sha256').update(scene.code).digest('hex');

      if (scene.id.startsWith('02-')) {
        scenes.push({
          id: scene.id,
          codeSha256,
          expectedOutput: scene.expectedOutput,
          actualOutput: [],
          passed: true,
          durationMs: 0,
          kind: 'conceptual',
        });
        continue;
      }

      const sceneDir = join(tmpRoot, scene.id);
      await mkdir(sceneDir, { recursive: true });
      const sceneFile = join(sceneDir, 'scene.mjs');
      await writeFile(sceneFile, buildSource(scene, nodeVersion), 'utf8');

      const result = await runNode(nodeBin, sceneFile, sceneDir);
      const lines = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const measurements = scene.id.startsWith('12-') ? extractMeasurements(lines) : null;
      const actualOutput = lines.filter((line) => !line.startsWith(MEASUREMENTS_PREFIX));
      const passed = computePassed(scene, actualOutput, measurements, result);
      const entry: SceneResult = {
        id: scene.id,
        codeSha256,
        expectedOutput: scene.expectedOutput,
        actualOutput,
        passed,
        durationMs: result.durationMs,
        kind: 'executed',
      };
      if (measurements) entry.measurements = measurements;
      scenes.push(entry);
    }
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }

  const results: DemoResults = {
    schemaVersion: 1,
    runtime: 'node',
    nodeVersion,
    verifiedAt: new Date().toISOString(),
    scenes,
  };
  await mkdir(QA_DIR, { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(results, null, 2) + '\n', 'utf8');

  const failed = scenes.filter((scene) => !scene.passed);
  const executed = scenes.filter((scene) => scene.kind === 'executed').length;
  const conceptual = scenes.length - executed;
  console.log(
    `Demos ${script.id}: ${scenes.length} escenas (${executed} ejecutadas, ${conceptual} conceptual) con Node ${nodeVersion}.`,
  );
  if (failed.length > 0) {
    console.log(`Fallidas: ${failed.map((scene) => scene.id).join(', ')}`);
  } else {
    console.log('Todas las salidas coinciden con el guion.');
  }
  console.log(`Evidencia: ${relative(ROOT, OUTPUT_PATH)}`);
  return failed.length > 0 ? 1 : 0;
}

const code = await main();
process.exit(code);
