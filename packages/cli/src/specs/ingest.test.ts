/**
 * ingestSpecs contract: ig-profile / ig-post / ig-viewer as data, pure
 * parsers against fixtures, plan() with zero network/secrets, and run()
 * refusing plan mode.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandSpec } from '../spec-types';
import { makeTestContext, makeTestDeps } from '../pipeline/test-support';
import {
  decodeEntities,
  diagnosePost,
  extractGridHrefs,
  isEmptyDetail,
  parseFollowCounts,
  parsePostOg,
  renderDiagnosticHtml,
  type IgProfileInventory,
} from '../pipeline/ig';
import { buildIngestSpecs, ingestSpecs } from './ingest';

function specByVerb(specs: CommandSpec[], verb: string): CommandSpec {
  const spec = specs.find((entry) => entry.verb === verb);
  if (!spec) throw new Error(`missing spec ${verb}`);
  return spec;
}

const POST_HTML = `<html><head>
<meta property="og:title" content="Body Fitness Gym Cutervo on Instagram: &quot;Ven y entrena 💪&quot;">
<meta property="og:description" content="9 likes, 0 comments - bfc_cutervo on July 1, 2024: &quot;Ven y entrena 💪&quot;. ">
<meta property="og:image" content="https://cdn.example/cover.jpg">
</head><body></body></html>`;

describe('ingestSpecs registry surface', () => {
  test('exports the three ingest verbs with plan support', () => {
    expect(ingestSpecs.map((spec) => spec.verb)).toEqual(['ig-profile', 'ig-post', 'ig-viewer']);
    for (const spec of ingestSpecs) {
      expect(spec.supportsPlan).toBe(true);
      expect(spec.movesGates).toEqual([]);
    }
    expect(specByVerb(ingestSpecs, 'ig-profile').paid).toBeUndefined();
  });
});

describe('ig parsers (pure)', () => {
  test('extractGridHrefs keeps /user/(p|reel)/ links, dedupes', () => {
    expect(
      extractGridHrefs('bfc_cutervo', [
        '/bfc_cutervo/p/ABC123/',
        '/bfc_cutervo/reel/XYZ_9/',
        '/bfc_cutervo/p/ABC123/',
        '/bfc_cutervo/',
        '/other/p/ABC123/',
        null,
        '#',
      ]),
    ).toEqual(['/bfc_cutervo/p/ABC123/', '/bfc_cutervo/reel/XYZ_9/']);
  });

  test('parsePostOg reads caption, likes, comments, date', () => {
    const detail = parsePostOg('/bfc_cutervo/p/ABC123/', POST_HTML);
    expect(detail.shortcode).toBe('ABC123');
    expect(detail.kind).toBe('post');
    expect(detail.caption).toBe('Ven y entrena 💪');
    expect(detail.likes).toBe(9);
    expect(detail.comments).toBe(0);
    expect(detail.date).toBe('July 1, 2024');
    expect(detail.image).toBe('https://cdn.example/cover.jpg');
  });

  test('decodeEntities handles hex, decimal and named entities', () => {
    expect(decodeEntities('a&#xf1;o &#128170; &quot;x&quot; &amp;')).toBe('año 💪 "x" &');
  });

  test('parseFollowCounts reads both counters', () => {
    expect(parseFollowCounts('314 followers 368 following')).toEqual({ followers: 314, following: 368 });
    expect(parseFollowCounts('sin números')).toEqual({ followers: null, following: null });
  });

  test('diagnosePost flags data problems only', () => {
    expect(
      diagnosePost({ href: '', shortcode: '', kind: 'post', caption: '💪', likes: 4, comments: 0, date: '', image: '' }),
    ).toEqual(['caption-vacio', 'sin-hashtags', 'cero-comentarios', 'poco-alcance']);
    expect(
      diagnosePost({
        href: '',
        shortcode: '',
        kind: 'post',
        caption: 'Keyword real con más de cuarenta caracteres y #hashtag y CTA: ven hoy',
        likes: 22,
        comments: 2,
        date: '',
        image: '',
      }),
    ).toEqual([]);
  });

  test('renderDiagnosticHtml escapes captions and lists flags', () => {
    const inventory: IgProfileInventory = {
      username: 'bfc_cutervo',
      profile: 'https://www.instagram.com/bfc_cutervo/',
      title: 't',
      bio: '',
      followers: 314,
      following: 368,
      posts: [],
      reels: [],
      posts_detail: [
        { href: '/x/', shortcode: 'x', kind: 'post', caption: '<b>hola</b>', likes: 1, comments: 0, date: '', image: '' },
      ],
      extraction: { at: 'now', method: 'm', note: 'n' },
    };
    const html = renderDiagnosticHtml(inventory);
    expect(html).toContain('&lt;b&gt;hola&lt;/b&gt;');
    expect(html).toContain('caption-corto');
    expect(html).not.toContain('<b>hola</b>');
  });

  test('isEmptyDetail detecta HTML sin og tags', () => {
    const empty = parsePostOg('/bfc_cutervo/p/X/', '<html><head><title>Instagram</title></head></html>');
    expect(isEmptyDetail(empty)).toBe(true);
    expect(isEmptyDetail({ ...empty, likes: 4 })).toBe(false);
  });
});

describe('plan() purity (NFR-002)', () => {
  test('no fetch and no secret resolution for any verb', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-ingest-'));
    const deps = makeTestDeps();
    const specs = buildIngestSpecs(deps);
    const argsByVerb: Record<string, Record<string, string | number | boolean | string[]>> = {
      'ig-profile': { profile: 'bfc_cutervo' },
      'ig-post': { profile: 'bfc_cutervo', shortcode: 'ABC123' },
      'ig-viewer': { artifact: dir },
    };
    for (const spec of specs) {
      const steps = await spec.plan(
        makeTestContext(argsByVerb[spec.verb] ?? { artifact: dir }, { mode: 'plan' }),
      );
      expect(Array.isArray(steps)).toBe(true);
      expect(steps.length).toBeGreaterThan(0);
    }
    expect(deps.calls.fetch).toBe(0);
    expect(deps.calls.secrets).toEqual([]);
  });

  test('run() refuses to execute in plan mode', async () => {
    const specs = buildIngestSpecs(makeTestDeps());
    for (const spec of specs) {
      const base: Record<string, string | number | boolean | string[]> =
        spec.verb === 'ig-viewer'
          ? { artifact: '/tmp' }
          : { profile: 'bfc_cutervo', shortcode: 'ABC123' };
      await expect(spec.run(makeTestContext(base, { mode: 'plan' }))).rejects.toThrow(
        /refuses plan mode/,
      );
    }
  });
});

describe('ig-viewer run()', () => {
  test('writes diagnostico/index.html from the inventory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-viewer-'));
    await writeFile(
      join(dir, 'profile-inventory.json'),
      JSON.stringify({
        username: 'bfc_cutervo',
        profile: 'https://www.instagram.com/bfc_cutervo/',
        title: 't',
        bio: '',
        followers: 1,
        following: 1,
        posts: [],
        reels: [],
        posts_detail: [],
        extraction: { at: 'now', method: 'm', note: 'n' },
      }),
    );
    const viewer = specByVerb(buildIngestSpecs(makeTestDeps()), 'ig-viewer');
    const lines: string[] = [];
    const result = await viewer.run(
      makeTestContext({ artifact: dir }, { mode: 'run', lines }),
    );
    expect(result.exitCode).toBe(0);
    const html = await Bun.file(join(dir, 'diagnostico', 'index.html')).text();
    expect(html).toContain('@bfc_cutervo');
  });

  test('fails without inventory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-viewer-'));
    const viewer = specByVerb(buildIngestSpecs(makeTestDeps()), 'ig-viewer');
    await expect(
      viewer.run(makeTestContext({ artifact: dir }, { mode: 'run' })),
    ).rejects.toThrow(/no hay profile-inventory/);
  });
});
