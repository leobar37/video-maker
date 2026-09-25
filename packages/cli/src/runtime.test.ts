import { describe, expect, test } from 'bun:test';

import { ArgParseError, parseArgs } from './args';
import { createRegistry, formatRegistryHelp } from './registry';
import { runRegistry, runSpecs } from './runtime';
import type { CommandArgSpec, CommandRunContext, CommandResult, CommandSpec, PlanStep } from './spec-types';

function capture(): { lines: string[]; out: (line: string) => void } {
  const lines: string[] = [];
  return { lines, out: (line: string) => void lines.push(line) };
}

function adHocSpec(overrides: Partial<CommandSpec> & Pick<CommandSpec, 'verb'>): CommandSpec {
  return {
    summary: 'spec de prueba',
    args: [],
    supportsPlan: true,
    writes: [],
    movesGates: [],
    plan(): PlanStep[] {
      return [];
    },
    run(): CommandResult {
      return { exitCode: 0 };
    },
    ...overrides,
  };
}

describe('parseArgs (tipos, defaults, requeridos)', () => {
  const args: CommandArgSpec[] = [
    { name: 'project', kind: 'string', default: '.', description: 'dir' },
    { name: 'count', kind: 'number', default: 1, description: 'n' },
    { name: 'loud', kind: 'boolean', default: true, description: 'b' },
    { name: 'tag', kind: 'string[]', default: [], description: 'tags' },
    { name: 'scene', kind: 'string', required: true, description: 'escena' },
  ];

  test('aplica defaults y acepta flags --k v y --k=v', () => {
    const parsed = parseArgs(args, ['--scene', 's1', '--count=7', '--loud', 'false']);
    expect(parsed.project).toBe('.');
    expect(parsed.count).toBe(7);
    expect(parsed.loud).toBe(false);
    expect(parsed.tag).toEqual([]);
    expect(parsed.scene).toBe('s1');
  });

  test('los posicionales llenan los args en orden de declaración (con o sin required)', () => {
    const pair: CommandArgSpec[] = [
      { name: 'project', kind: 'string', default: '.', description: 'dir' },
      { name: 'scene', kind: 'string', required: true, description: 'escena' },
    ];
    // Forma posicional documentada: `vm qa <project>` / `vm <cmd> <project> <scene>`.
    expect(parseArgs(pair, ['p1', 's1'])).toEqual({ project: 'p1', scene: 's1' });
    // El flag conserva su slot: el posicional pasa al siguiente arg sin asignar.
    expect(parseArgs(pair, ['s1', '--project', 'p1'])).toEqual({ project: 'p1', scene: 's1' });
  });

  test('la forma posicional documentada `vm qa <project>` funciona', () => {
    const qaArgs: CommandArgSpec[] = [
      { name: 'project', kind: 'string', default: '.', description: 'dir' },
      { name: 'video', kind: 'string', description: 'video a medir' },
    ];
    expect(parseArgs(qaArgs, ['projects/demo/hello'])).toEqual({ project: 'projects/demo/hello' });
    expect(parseArgs(qaArgs, [])).toEqual({ project: '.' });
    expect(parseArgs(qaArgs, ['--project', 'otro'])).toEqual({ project: 'otro' });
  });

  test('subcomando posicional + proyecto por flag (scene-log)', () => {
    const logArgs: CommandArgSpec[] = [
      { name: 'action', kind: 'string', required: true, description: 'record|list' },
      { name: 'project', kind: 'string', default: '.', description: 'dir' },
      { name: 'scene', kind: 'string', default: '', description: 'escena' },
    ];
    expect(parseArgs(logArgs, ['record', '--project', 'p1', '--scene', 's1'])).toEqual({
      action: 'record',
      project: 'p1',
      scene: 's1',
    });
    expect(parseArgs(logArgs, ['list'])).toEqual({ action: 'list', project: '.', scene: '' });
  });

  test('requerido sin default sigue fallando después de aplicar posicionales', () => {
    const pair: CommandArgSpec[] = [
      { name: 'project', kind: 'string', default: '.', description: 'dir' },
      { name: 'scene', kind: 'string', required: true, description: 'escena' },
    ];
    expect(() => parseArgs(pair, ['p1'])).toThrow('--scene');
  });

  test('string[] acumula valores repetidos', () => {
    const parsed = parseArgs(args, ['--scene', 's1', '--tag', 'a', '--tag', 'b']);
    expect(parsed.tag).toEqual(['a', 'b']);
  });

  test('flag desconocido falla con mensaje accionable', () => {
    expect(() => parseArgs(args, ['--nope', '1'])).toThrow(ArgParseError);
    expect(() => parseArgs(args, ['--nope', '1'])).toThrow('--nope');
  });

  test('faltante requerido falla nombrando el flag', () => {
    expect(() => parseArgs(args, [])).toThrow('--scene');
  });

  test('valor numérico inválido falla', () => {
    expect(() => parseArgs(args, ['--scene', 's1', '--count', 'x'])).toThrow('número');
  });

  test('posicional de más falla cuando todos los args ya fueron asignados', () => {
    const solo: CommandArgSpec[] = [
      { name: 'scene', kind: 'string', required: true, description: 'escena' },
    ];
    expect(() => parseArgs(solo, ['--scene', 's1', 'extra'])).toThrow('posicionales');
  });
});

describe('runtime: modos y códigos de salida', () => {
  test('modo plan imprime pasos y NUNCA ejecuta run() (sin red)', async () => {
    let ran = false;
    const spec = adHocSpec({
      verb: 'paid-thing',
      paid: true,
      plan(): PlanStep[] {
        return [{ action: 'llamar al proveedor', costUsd: 0.05, gate: 'assets' }];
      },
      async run(): Promise<CommandResult> {
        ran = true;
        // A real run would touch the network here; plan mode must not.
        await fetch('http://example.invalid');
        return { exitCode: 0 };
      },
    });
    const io = capture();
    const code = await runSpecs([spec], ['paid-thing', '--plan'], { cwd: '/tmp', out: io.out });
    expect(code).toBe(0);
    expect(ran).toBe(false);
    expect(io.lines.join('\n')).toContain('llamar al proveedor');
    expect(io.lines.join('\n')).toContain('cost: ~$0.05');
  });

  test('--dry-run equivale a --plan', async () => {
    let ran = false;
    const spec = adHocSpec({
      verb: 'thing',
      run(): CommandResult {
        ran = true;
        return { exitCode: 0 };
      },
    });
    const io = capture();
    const code = await runSpecs([spec], ['thing', '--dry-run'], { cwd: '/tmp', out: io.out });
    expect(code).toBe(0);
    expect(ran).toBe(false);
  });

  test('run mode ejecuta run() y propaga su exit code', async () => {
    const spec = adHocSpec({
      verb: 'thing',
      run(ctx: CommandRunContext): CommandResult {
        ctx.out(`mode=${ctx.mode}`);
        return { exitCode: 3 };
      },
    });
    const io = capture();
    const code = await runSpecs([spec], ['thing'], { cwd: '/tmp', out: io.out });
    expect(code).toBe(3);
    expect(io.lines).toContain('mode=run');
  });

  test('un comando sin soporte de plan rechaza --plan', async () => {
    const spec = adHocSpec({ verb: 'raw', supportsPlan: false });
    const io = capture();
    const code = await runSpecs([spec], ['raw', '--plan'], { cwd: '/tmp', out: io.out });
    expect(code).not.toBe(0);
    expect(io.lines.join('\n')).toContain('no soporta modo plan');
  });

  test('verbo desconocido: error accionable y exit != 0', async () => {
    const io = capture();
    const code = await runSpecs([adHocSpec({ verb: 'thing' })], ['nope'], { cwd: '/tmp', out: io.out });
    expect(code).not.toBe(0);
    expect(io.lines.join('\n')).toContain('desconocido');
    expect(io.lines.join('\n')).toContain('thing');
  });

  test('argumento requerido faltante: error accionable y exit != 0', async () => {
    const spec = adHocSpec({
      verb: 'thing',
      args: [{ name: 'scene', kind: 'string', required: true, description: 'escena' }],
    });
    const io = capture();
    const code = await runSpecs([spec], ['thing'], { cwd: '/tmp', out: io.out });
    expect(code).not.toBe(0);
    expect(io.lines.join('\n')).toContain('--scene');
  });

  test('ctx.fail corta con el código indicado', async () => {
    const spec = adHocSpec({
      verb: 'thing',
      run(ctx: CommandRunContext): CommandResult {
        return ctx.fail('no se pudo', 7);
      },
    });
    const io = capture();
    const code = await runSpecs([spec], ['thing'], { cwd: '/tmp', out: io.out });
    expect(code).toBe(7);
    expect(io.lines.join('\n')).toContain('no se pudo');
  });

  test('--help lista el registro completo', async () => {
    const io = capture();
    const code = await runSpecs(
      [adHocSpec({ verb: 'alpha' }), adHocSpec({ verb: 'beta' })],
      ['--help'],
      { cwd: '/tmp', out: io.out },
    );
    expect(code).toBe(0);
    const text = io.lines.join('\n');
    expect(text).toContain('alpha');
    expect(text).toContain('beta');
  });

  test('`<verbo> --help` muestra los argumentos del comando', async () => {
    const spec = adHocSpec({
      verb: 'thing',
      args: [{ name: 'scene', kind: 'string', required: true, description: 'escena a delegar' }],
    });
    const io = capture();
    const code = await runSpecs([spec], ['thing', '--help'], { cwd: '/tmp', out: io.out });
    expect(code).toBe(0);
    expect(io.lines.join('\n')).toContain('escena a delegar');
  });
});

describe('declaratividad (FR-013)', () => {
  test('registrar un spec nuevo en runtime lo vuelve ejecutable sin código de dispatch', async () => {
    const registry = createRegistry([adHocSpec({ verb: 'existing' })]);
    const executions: Array<Record<string, string | number | boolean | string[]>> = [];
    registry.register(
      adHocSpec({
        verb: 'brand-new',
        args: [{ name: 'scene', kind: 'string', required: true, description: 'escena' }],
        plan(): PlanStep[] {
          return [{ action: 'paso del nuevo comando' }];
        },
        run(ctx: CommandRunContext): CommandResult {
          executions.push(ctx.args);
          ctx.out('brand-new ejecutado');
          return { exitCode: 0 };
        },
      }),
    );
    const io = capture();
    const code = await runRegistry(registry, ['brand-new', 's1'], { cwd: '/tmp', out: io.out });
    expect(code).toBe(0);
    expect(executions[0]?.scene).toBe('s1');
    expect(io.lines).toContain('brand-new ejecutado');
    // Y el plan del nuevo comando viaja por el mismo runtime.
    const planIo = capture();
    const planCode = await runRegistry(registry, ['brand-new', '--plan', '--scene', 's1'], {
      cwd: '/tmp',
      out: planIo.out,
    });
    expect(planCode).toBe(0);
    expect(planIo.lines.join('\n')).toContain('paso del nuevo comando');
  });

  test('verbos duplicados se rechazan al registrar', () => {
    const registry = createRegistry([]);
    registry.register(adHocSpec({ verb: 'thing' }));
    expect(() => registry.register(adHocSpec({ verb: 'thing' }))).toThrow('duplicado');
  });

  test('un comando paid debe declarar soporte de plan (NFR-002)', () => {
    const registry = createRegistry([]);
    expect(() => registry.register(adHocSpec({ verb: 'spendy', paid: true, supportsPlan: false }))).toThrow(
      'supportsPlan',
    );
  });

  test('formatRegistryHelp enumera los verbs del registro', () => {
    const registry = createRegistry([adHocSpec({ verb: 'alpha' }), adHocSpec({ verb: 'beta' })]);
    const text = formatRegistryHelp(registry);
    expect(text).toContain('alpha');
    expect(text).toContain('beta');
  });
});
