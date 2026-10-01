/**
 * socialSpecs contract: cover / gen-image / carousel as data, pure builders
 * and gates against fixtures, plan() with zero network/secrets, and run()
 * refusing plan mode.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

import type { CommandSpec } from '../spec-types';
import { makeTestContext, makeTestDeps } from '../pipeline/test-support';
import {
  CAROUSEL_HEIGHT,
  CAROUSEL_WIDTH,
  COVER_HEIGHT,
  COVER_WIDTH,
  buildCoverHtml,
  carouselCheck,
  coverCheck,
  parsePngDimensions,
} from '../pipeline/cover';
import { aspectSize, estimateAttemptUsd, runGenImage } from '../pipeline/gen-image';
import { buildSocialSpecs, socialSpecs } from './social';

function specByVerb(specs: CommandSpec[], verb: string): CommandSpec {
  const spec = specs.find((entry) => entry.verb === verb);
  if (!spec) throw new Error(`missing spec ${verb}`);
  return spec;
}

/** Header-only PNG: signature + IHDR with the given dimensions. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const COVER_JSON = {
  slug: 'bfc',
  hook: 'El único fracaso es no empezar',
  support: 'Entrená con nosotros',
  cta: 'Ecribinos hoy',
  palette: { bg: '#111111', ink: '#ffffff', accent: '#d0f58c' },
};

describe('socialSpecs registry surface', () => {
  test('exports the three social verbs with plan support', () => {
    expect(socialSpecs.map((spec) => spec.verb)).toEqual(['cover', 'gen-image', 'carousel']);
    for (const spec of socialSpecs) {
      expect(spec.supportsPlan).toBe(true);
      expect(spec.movesGates).toEqual([]);
      expect(spec.args.some((arg) => arg.name === 'project' && arg.default === '.')).toBe(true);
    }
    expect(specByVerb(socialSpecs, 'gen-image').paid).toBe(true);
  });
});

describe('cover pipeline (pure)', () => {
  test('aspect sizes map the documented labels', () => {
    expect(aspectSize('9:16')).toEqual({ width: 768, height: 1344 });
    expect(aspectSize('4:5')).toEqual({ width: 960, height: 1200 });
    expect(() => aspectSize('2:3')).toThrow(/aspect-ratio desconocido/);
  });

  test('flux schnell estimate stays sub-cent', () => {
    const estimate = estimateAttemptUsd('9:16');
    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeLessThan(0.05);
  });

  test('buildCoverHtml keeps everything on the 1080x1920 canvas', () => {
    const html = buildCoverHtml(COVER_JSON);
    expect(html).toContain(`width:${COVER_WIDTH}px;height:${COVER_HEIGHT}px`);
    expect(html).toContain('El único fracaso es no empezar');
    expect(html).toContain('Ecribinos hoy');
    expect(html).not.toContain('<script');
  });

  test('parsePngDimensions reads IHDR and rejects garbage', () => {
    expect(parsePngDimensions(pngHeader(1080, 1920))).toEqual({ width: 1080, height: 1920 });
    expect(() => parsePngDimensions(new Uint8Array([1, 2, 3]))).toThrow(/no es un PNG/);
  });

  test('coverCheck fails without social-cover.json, passes with outputs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-cover-'));
    const missing = await coverCheck(dir);
    expect(missing.length).toBe(1);
    expect(missing[0]?.path).toContain('social-cover.json');

    await writeFile(join(dir, 'social-cover.json'), JSON.stringify(COVER_JSON));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'covers', 'social'), { recursive: true });
    await writeFile(join(dir, 'covers', 'cover.png'), pngHeader(COVER_WIDTH, COVER_HEIGHT));
    await writeFile(join(dir, 'covers', 'social', 'preview-3x4.png'), pngHeader(1080, 1440));
    await writeFile(join(dir, 'covers', 'social', 'preview-square.png'), pngHeader(1080, 1080));
    expect(await coverCheck(dir)).toEqual([]);
  });

  test('carouselCheck enforces count and exact 1080x1350', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-carousel-'));
    const one = await carouselCheck(dir);
    expect(one.issues.length).toBeGreaterThan(0);

    await writeFile(join(dir, '01.png'), pngHeader(CAROUSEL_WIDTH, CAROUSEL_HEIGHT));
    await writeFile(join(dir, '02.png'), pngHeader(CAROUSEL_WIDTH, CAROUSEL_HEIGHT));
    await writeFile(join(dir, '03-mal.png'), pngHeader(1080, 1080));
    const checked = await carouselCheck(dir);
    expect(checked.pages).toHaveLength(2);
    expect(checked.issues.map((issue) => issue.path).some((path) => path.endsWith('03-mal.png'))).toBe(true);
  });
});

describe('runGenImage submit flow (fake transport)', () => {
  async function realPng(): Promise<Uint8Array> {
    const buffer = await sharp({ create: { width: 768, height: 1344, channels: 3, background: '#181818' } })
      .png()
      .toBuffer();
    return new Uint8Array(buffer);
  }

  function fakeFal(imageBytes: Uint8Array, statusSeq: string[] = ['IN_PROGRESS', 'COMPLETED']) {
    let polls = 0;
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      calls.push(`${init?.method ?? 'GET'} ${target}`);
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (target.includes('queue.fal.run') && init?.method === 'POST') {
        return json({ request_id: 'req-1', status_url: 'https://queue.fal.run/s', response_url: 'https://queue.fal.run/r' });
      }
      if (target.endsWith('/s')) return json({ status: statusSeq[Math.min(polls++, statusSeq.length - 1)] });
      if (target.endsWith('/r')) return json({ images: [{ url: 'https://cdn.fal/out.png' }] });
      if (target === 'https://cdn.fal/out.png') {
        const copy = new Uint8Array(imageBytes.length);
        copy.set(imageBytes);
        return new Response(copy.buffer as ArrayBuffer, { status: 200 });
      }
      return new Response('nf', { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  test('submit → poll → download → journal, y replay sin gastar', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-genimg-'));
    const outPath = join(dir, 'covers', 'bg.png');
    const lines: string[] = [];
    const fake = fakeFal(await realPng());
    const options = {
      projectDir: dir,
      prompt: 'fondo de gym',
      outPath,
      aspect: '9:16',
      spendCapUsd: 2,
      force: false,
      out: (line: string) => lines.push(line),
    };
    const deps = { ...fake, falKey: async () => 'k', sleep: async () => {} };
    const first = await runGenImage(options, deps);
    expect(first.width).toBe(768);
    expect(first.height).toBe(1344);
    expect(first.spentUsd).toBeGreaterThan(0);
    const journal = JSON.parse(await readFile(join(dir, 'qa', 'gen-image.json'), 'utf8')) as {
      status: string;
      requestId: string;
    };
    expect(journal.status).toBe('completed');
    expect(journal.requestId).toBe('req-1');
    const second = await runGenImage(options, deps);
    expect(second.spentUsd).toBe(0);
    expect(fake.calls.filter((call) => call.startsWith('POST')).length).toBe(1);
  });

  test('cap menor al estimado rechaza antes de tocar red', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-genimg-'));
    const fake = fakeFal(await realPng());
    await expect(
      runGenImage(
        {
          projectDir: dir,
          prompt: 'x',
          outPath: join(dir, 'covers', 'bg.png'),
          aspect: '9:16',
          spendCapUsd: 0.0001,
          force: false,
          out: () => {},
        },
        { ...fake, falKey: async () => 'k', sleep: async () => {} },
      ),
    ).rejects.toThrow(/supera el cap/);
    expect(fake.calls).toEqual([]);
  });

  test('el 403 expone el motivo de FAL (ej. balance agotado)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-genimg-'));
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ detail: 'User is locked. Reason: Exhausted balance.' }), {
        status: 403,
      })) as unknown as typeof fetch;
    await expect(
      runGenImage(
        {
          projectDir: dir,
          prompt: 'x',
          outPath: join(dir, 'covers', 'bg.png'),
          aspect: '9:16',
          spendCapUsd: 2,
          force: false,
          out: () => {},
        },
        { fetchImpl, falKey: async () => 'k', sleep: async () => {} },
      ),
    ).rejects.toThrow(/Exhausted balance/);
  });
});

describe('plan() purity (NFR-002)', () => {
  test('no fetch and no secret resolution for any verb', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-social-'));
    const deps = makeTestDeps();
    const specs = buildSocialSpecs(deps);
    const argsByVerb: Record<string, Record<string, string | number | boolean | string[]>> = {
      cover: { project: dir },
      'gen-image': { project: dir, prompt: 'fondo de gym', 'spend-cap': 2 },
      carousel: { project: dir, images: dir },
    };
    for (const spec of specs) {
      const steps = await spec.plan(
        makeTestContext(argsByVerb[spec.verb] ?? { project: dir }, { mode: 'plan' }),
      );
      expect(Array.isArray(steps)).toBe(true);
      expect(steps.length).toBeGreaterThan(0);
    }
    expect(deps.calls.fetch).toBe(0);
    expect(deps.calls.secrets).toEqual([]);
  });

  test('run() refuses to execute in plan mode', async () => {
    const specs = buildSocialSpecs(makeTestDeps());
    for (const spec of specs) {
      await expect(
        spec.run(makeTestContext({ project: '/tmp', 'spend-cap': 1 }, { mode: 'plan' })),
      ).rejects.toThrow(/refuses plan mode/);
    }
  });

  test('gen-image run() refuses without spend cap', async () => {
    const genImage = specByVerb(buildSocialSpecs(makeTestDeps()), 'gen-image');
    await expect(
      genImage.run(makeTestContext({ project: '/tmp', submit: true }, { mode: 'run' })),
    ).rejects.toThrow(/spend-cap/);
  });
});
