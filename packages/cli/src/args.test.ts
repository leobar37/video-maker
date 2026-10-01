/**
 * Argv contract for the studio grouped commands (P-003, contracts.md §6):
 * exact `group sub` normalization BEFORE registry lookup, positional `<id>`
 * → spec arg `id`, arity/usage refusals, global flags before/after and the
 * stable `--json` error envelope on usage errors. Pure argv tests: no
 * workspace writes (plan/reads only).
 */
import { describe, expect, test } from 'bun:test';

import { allSpecs } from './all-specs';
import { ArgParseError, parseArgs } from './args';
import { runSpecs } from './runtime';
import { studioSpecs } from './specs/studio';
import { groupedVerbDisplay, normalizeGroupedVerb, studioArgvAdapter } from './specs/studio-pairs';
import type { CommandSpec } from './spec-types';

function capture(): { lines: string[]; out: (line: string) => void } {
  const lines: string[] = [];
  return { lines, out: (line: string) => void lines.push(line) };
}

function specByVerb(verb: string): CommandSpec {
  const spec = studioSpecs.find((entry) => entry.verb === verb);
  if (!spec) throw new Error(`spec faltante en studioSpecs: ${verb}`);
  return spec;
}

describe('normalización grupo+subcomando (lista blanca exacta)', () => {
  test('pareja exacta `client create` → verbo interno client-create', () => {
    const normalized = normalizeGroupedVerb({ verb: 'client', rest: ['create', 'c1', '--name', 'Foo'] });
    expect(normalized.verb).toBe('client-create');
    expect(normalized.rest).toEqual(['c1', '--name', 'Foo']);
  });

  test('solo se aceptan subcomandos de la lista blanca (no concatenar cualquier token)', () => {
    const normalized = normalizeGroupedVerb({ verb: 'client', rest: ['frobnicate'] });
    expect(normalized.verb).toBe('client');
    expect(normalized.rest).toEqual(['frobnicate']);
  });

  test('los valores/tokens de flags nunca se consumen como subcomando', () => {
    expect(normalizeGroupedVerb({ verb: 'client', rest: ['--name', 'create'] })).toEqual({
      verb: 'client',
      rest: ['--name', 'create'],
    });
    expect(normalizeGroupedVerb({ verb: 'client', rest: [] })).toEqual({ verb: 'client', rest: [] });
  });

  test('verbos legacy de un solo token no se tocan', () => {
    expect(normalizeGroupedVerb({ verb: 'inspect', rest: ['--project', 'p1'] })).toEqual({
      verb: 'inspect',
      rest: ['--project', 'p1'],
    });
  });

  test('todas las parejas del contrato se normalizan a su spec registrada', () => {
    const pairs: Array<[string, string, string]> = [
      ['client', 'create', 'client-create'],
      ['client', 'list', 'client-list'],
      ['client', 'show', 'client-show'],
      ['preset', 'create', 'preset-create'],
      ['preset', 'list', 'preset-list'],
      ['preset', 'show', 'preset-show'],
      ['project', 'create', 'project-create'],
      ['project', 'list', 'project-list'],
      ['project', 'show', 'project-show'],
      ['project', 'checkpoint', 'project-checkpoint'],
      ['asset', 'create', 'asset-create'],
      ['asset', 'inspect', 'asset-inspect'],
      ['asset', 'snapshot', 'asset-snapshot'],
      ['asset', 'history', 'asset-history'],
      ['asset', 'diff', 'asset-diff'],
      ['asset', 'restore', 'asset-restore'],
      ['asset', 'render', 'asset-render'],
    ];
    for (const [group, sub, internal] of pairs) {
      expect(normalizeGroupedVerb({ verb: group, rest: [sub] })).toEqual({ verb: internal, rest: [] });
      expect(specByVerb(internal).verb).toBe(internal);
      expect(groupedVerbDisplay(internal)).toBe(`${group} ${sub}`);
    }
  });

  test('sync tiene specs reales desde P-004; dashboard tiene specs reales desde P-005', () => {
    const verbs = allSpecs().map((spec) => spec.verb);
    expect(verbs).toContain('sync-push');
    expect(verbs).toContain('sync-verify');
    expect(verbs).toContain('sync-recover');
    expect(verbs).toContain('dashboard-serve');
    expect(verbs).toContain('dashboard-url');
    // Los módulos de cada grupo viven separados: studioSpecs (P-003) queda intacto.
    expect(studioSpecs.some((spec) => spec.verb.startsWith('sync-'))).toBe(false);
    expect(studioSpecs.some((spec) => spec.verb.startsWith('dashboard-'))).toBe(false);
  });
});

describe('posicional <id> → flag id de la spec y aridad', () => {
  test('el posicional llena el arg `id` declarado primero; el flag conserva su slot', () => {
    const parsed = parseArgs(specByVerb('client-create').args, ['c1', '--name', 'Foo']);
    expect(parsed.id).toBe('c1');
    expect(parsed.name).toBe('Foo');
  });

  test('formas equivalentes: flag primero, posicional después; --flag=valor', () => {
    const args = specByVerb('client-create').args;
    const flagged = parseArgs(args, ['--name', 'Foo', 'c1']);
    expect(flagged.id).toBe('c1');
    expect(flagged.name).toBe('Foo');
    const eqForm = parseArgs(args, ['c1', '--name=Foo']);
    expect(eqForm.id).toBe('c1');
    expect(eqForm.name).toBe('Foo');
  });

  test('cada spec con <id> positional lo declara como primer arg requerido `id`', () => {
    const withPositionalId = [
      'client-create',
      'client-show',
      'preset-create',
      'preset-show',
      'project-create',
      'project-show',
      'project-checkpoint',
      'asset-create',
      'asset-inspect',
      'asset-snapshot',
      'asset-history',
      'asset-diff',
      'asset-restore',
      'asset-render',
    ];
    for (const verb of withPositionalId) {
      const first = specByVerb(verb).args[0]!;
      expect(`${verb}: ${first.name}`).toBe(`${verb}: id`);
      expect(first.required).toBe(true);
    }
  });

  test('aridad estricta studio: extra posicional se rechaza en runtime (exit 2)', async () => {
    const io = capture();
    const code = await runSpecs(studioSpecs, ['client', 'create', 'c1', 'extra', '--name', 'Foo'], {
      cwd: '/tmp',
      out: io.out,
    });
    expect(code).toBe(2);
    expect(io.lines.join('\n')).toContain('posicional');
  });

  test('aridad estricta studio: `client list unexpected` NO lo consume como workspace (exit 2)', async () => {
    const io = capture();
    const code = await runSpecs(studioSpecs, ['client', 'list', 'unexpected', '--plan'], { cwd: '/tmp', out: io.out });
    expect(code).toBe(2);
    const text = io.lines.join('\n');
    expect(text).toContain('posicionales');
    expect(text).not.toContain('plan:');
  });

  test('aridad estricta studio: id posicional + --id duplicado se rechaza', () => {
    const args = specByVerb('client-show').args;
    expect(() => studioArgvAdapter(args, ['c1', '--id', 'c2'])).toThrow('dos veces');
  });

  test('adaptador studio: convierte el único posicional en --id= sin tocar flags ni sus valores', () => {
    expect(studioArgvAdapter(specByVerb('client-create').args, ['c1', '--name', 'Foo'])).toEqual([
      '--id=c1',
      '--name',
      'Foo',
    ]);
    // El posicional se convierte en --id= (al frente); los flags conservan
    // su orden relativo.
    expect(studioArgvAdapter(specByVerb('client-create').args, ['--name=Foo', 'c1'])).toEqual([
      '--id=c1',
      '--name=Foo',
    ]);
    // El valor de un flag nunca es posicional: 'create' es el valor de --name.
    expect(studioArgvAdapter(specByVerb('client-create').args, ['--name', 'create', 'c1'])).toEqual([
      '--id=c1',
      '--name',
      'create',
    ]);
    // Booleanos con literal explícito no convierten el literal en posicional.
    expect(studioArgvAdapter(specByVerb('asset-render').args, ['a1', '--execute', 'false'])).toEqual([
      '--id=a1',
      '--execute',
      'false',
    ]);
    // Specs sin id (sync/dashboard a futuro): cero posicionales.
    const listArgs = [{ name: 'workspace', kind: 'string' as const, description: 'ws' }];
    expect(() => studioArgvAdapter(listArgs, ['nope'])).toThrow('no acepta posicionales');
    expect(studioArgvAdapter(listArgs, [])).toEqual([]);
  });

  test('aridad: id faltante falla nombrando --id', () => {
    expect(() => parseArgs(specByVerb('client-create').args, ['--name', 'Foo'])).toThrow('--id');
    expect(() => parseArgs(specByVerb('asset-snapshot').args, ['--project', 'p1', '--note', 'n'])).toThrow('--id');
  });

  test('csv de presets/revisions se declara string y la spec lo interpreta; flags desconocidos fallan', () => {
    expect(() => parseArgs(specByVerb('asset-create').args, ['a1', '--preset', 'x'])).toThrow('--preset');
    expect(() => parseArgs(specByVerb('project-checkpoint').args, ['p1', '--revision', 'x'])).toThrow('--revision');
  });
});

describe('flags globales antes/después de la pareja y help', () => {
  test('--plan antes de la pareja: `vm --plan client list` (solo lectura)', async () => {
    const io = capture();
    const code = await runSpecs(studioSpecs, ['--plan', 'client', 'list'], { cwd: '/tmp', out: io.out });
    expect(code).toBe(0);
    expect(io.lines.join('\n')).toContain('plan: client-list');
  });

  test('--plan después de la pareja: `vm client list --plan`', async () => {
    const io = capture();
    const code = await runSpecs(studioSpecs, ['client', 'list', '--plan'], { cwd: '/tmp', out: io.out });
    expect(code).toBe(0);
    expect(io.lines.join('\n')).toContain('plan: client-list');
  });

  test('--dry-run en el medio también normaliza la pareja', async () => {
    const io = capture();
    const code = await runSpecs(studioSpecs, ['client', '--dry-run', 'list'], { cwd: '/tmp', out: io.out });
    expect(code).toBe(0);
    expect(io.lines.join('\n')).toContain('plan: client-list');
  });

  test('pareja no whitelisteada: error accionable mostrando parejas, exit 2', async () => {
    const io = capture();
    const code = await runSpecs(studioSpecs, ['client', 'frobnicate'], { cwd: '/tmp', out: io.out });
    expect(code).toBe(2);
    const text = io.lines.join('\n');
    expect(text).toContain('verbo desconocido');
    expect(text).toContain('client create');
  });

  test('help global muestra parejas (nunca verbos internos con guion)', async () => {
    const io = capture();
    const code = await runSpecs(studioSpecs, ['--help'], { cwd: '/tmp', out: io.out });
    expect(code).toBe(0);
    const text = io.lines.join('\n');
    expect(text).toContain('asset snapshot');
    expect(text).toContain('project checkpoint');
    expect(text).not.toContain('asset-snapshot');
  });

  test('help específico muestra los argumentos del comando agrupado', async () => {
    const io = capture();
    const code = await runSpecs(studioSpecs, ['client', 'create', '--help'], { cwd: '/tmp', out: io.out });
    expect(code).toBe(0);
    const text = io.lines.join('\n');
    expect(text).toContain('--name');
    expect(text).toContain('--workspace');
  });
});

describe('envelope JSON de errores de uso (malformed input)', () => {
  test('parse error con --json imprime SOLO el envelope y exit 2', async () => {
    const io = capture();
    const code = await runSpecs(studioSpecs, ['client', 'create', '--json'], { cwd: '/tmp', out: io.out });
    expect(code).toBe(2);
    expect(io.lines.length).toBe(1);
    const envelope = JSON.parse(io.lines[0]!) as { ok: boolean; error: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_INPUT');
  });

  test('verbo desconocido con --json: envelope estable y exit 2', async () => {
    const io = capture();
    const code = await runSpecs(studioSpecs, ['client', 'frobnicate', '--json'], { cwd: '/tmp', out: io.out });
    expect(code).toBe(2);
    expect(io.lines.length).toBe(1);
    const envelope = JSON.parse(io.lines[0]!) as { ok: boolean; error: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_INPUT');
  });

  test('ArgParseError sigue existiendo para consumo directo del parser', () => {
    expect(() => parseArgs(specByVerb('client-show').args, [])).toThrow(ArgParseError);
  });

  test('aridad studio con --json: envelope INVALID_INPUT y exit 2', async () => {
    const io = capture();
    const code = await runSpecs(studioSpecs, ['client', 'create', 'c1', 'extra', '--name', 'Foo', '--json'], {
      cwd: '/tmp',
      out: io.out,
    });
    expect(code).toBe(2);
    expect(io.lines.length).toBe(1);
    const envelope = JSON.parse(io.lines[0]!) as { ok: boolean; error: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('INVALID_INPUT');
  });

  test('GOLDEN legacy: parse error con --json mantiene el texto clásico (sin envelope)', async () => {
    const legacy: CommandSpec = {
      verb: 'legacy-thing',
      summary: 'spec legacy de prueba',
      args: [{ name: 'scene', kind: 'string', required: true, description: 'escena' }],
      supportsPlan: true,
      writes: [],
      movesGates: [],
      plan: () => [],
      run: () => ({ exitCode: 0 }),
    };
    const io = capture();
    const code = await runSpecs([legacy], ['legacy-thing', '--json'], { cwd: '/tmp', out: io.out });
    expect(code).toBe(2);
    expect(io.lines[0]).toContain('error: ');
    expect(io.lines[0]).toContain('--scene');
    expect(() => JSON.parse(io.lines[0]!)).toThrow();
  });

  test('GOLDEN legacy: verbo desconocido con --json mantiene el texto clásico', async () => {
    const io = capture();
    const code = await runSpecs(studioSpecs, ['frobnicate', '--json'], { cwd: '/tmp', out: io.out });
    expect(code).toBe(2);
    expect(io.lines[0]).toContain('error: verbo desconocido "frobnicate"');
    expect(() => JSON.parse(io.lines[0]!)).toThrow();
  });
});
