/**
 * music-library: adopt/use a music bed as a $0 operation — local file work
 * only, never a paid submit path and never network. A global fetch spy proves
 * the library touches zero HTTP.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  MUSIC_LIBRARY_COST_USD,
  adoptMusicBed,
  findMusicBed,
  listMusicBeds,
  loadMusicLibrary,
  planMusicBedOperation,
  useMusicBed,
  type MusicLibraryPaths,
} from './music-library';
import { MediaProviderError } from './media/common';
import { fixedClock } from './media/test-support';

const originalFetch = globalThis.fetch;
let fetchCalls = 0;

beforeEach(() => {
  fetchCalls = 0;
  // Any network call fails the test scenario; the library must never fetch.
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('the $0 music library must never touch the network');
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

interface Sandbox {
  paths: MusicLibraryPaths;
  sourceAudio: string;
  sourceMeta: string;
}

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'music-lib-'));
  const paths: MusicLibraryPaths = {
    libraryPath: join(root, 'videos', 'music', 'library.json'),
    repoRoot: root,
  };
  const sourceDir = join(root, 'videos', 'acme', 'promo-a', 'script', 'audio');
  const sourceAudio = join(sourceDir, 'music.mp3');
  const sourceMeta = join(sourceDir, 'music.json');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(sourceAudio, new Uint8Array([1, 2, 3, 4, 5]));
  writeFileSync(
    sourceMeta,
    JSON.stringify({
      provider: 'elevenlabs',
      model: 'music_v2',
      prompt: 'cama cálida',
      durationSeconds: 30.04,
      generatedAt: '2026-09-20T10:00:00.000Z',
    }),
  );
  return { paths, sourceAudio, sourceMeta };
}

describe('music library adopt/use are $0 operations', () => {
  test('planned actions declare no network, no paid submit and zero cost', () => {
    for (const operation of ['adopt', 'use'] as const) {
      const planned = planMusicBedOperation(operation);
      expect(planned.paid).toBe(false);
      expect(planned.network).toBe(false);
      expect(planned.estimatedCostUsd).toBe(MUSIC_LIBRARY_COST_USD);
      expect(MUSIC_LIBRARY_COST_USD).toBe(0);
    }
  });

  test('adopt registers a bed idempotently without any paid submit or HTTP', async () => {
    const { paths, sourceAudio, sourceMeta } = sandbox();
    const clock = fixedClock('2026-09-24T12:00:00.000Z');

    const adopted = await adoptMusicBed(
      { source: 'acme/promo-a', audioPath: sourceAudio, metaPath: sourceMeta, tags: ['corporativa'] },
      paths,
      { clock },
    );
    expect(adopted.status).toBe('adopted');
    expect(adopted.bed?.id).toMatch(/^bed-[0-9a-f]{10}$/);
    expect(adopted.bed?.source).toBe('acme/promo-a');
    expect(adopted.bed?.provider).toBe('elevenlabs');

    const duplicate = await adoptMusicBed(
      { source: 'acme/promo-a', audioPath: sourceAudio, metaPath: sourceMeta },
      paths,
      { clock },
    );
    expect(duplicate.status).toBe('duplicate');
    expect(listMusicBeds(paths).length).toBe(1);
    expect(fetchCalls).toBe(0);
  });

  test('use copies the bed and writes reuse metadata — still $0', async () => {
    const { paths, sourceAudio, sourceMeta } = sandbox();
    const clock = fixedClock('2026-09-24T12:00:00.000Z');
    const adopted = await adoptMusicBed(
      { source: 'acme/promo-a', audioPath: sourceAudio, metaPath: sourceMeta },
      paths,
      { clock },
    );

    const targetDir = join(paths.repoRoot, 'videos', 'acme', 'promo-b', 'script', 'audio');
    const targetAudio = join(targetDir, 'music.mp3');
    const targetMeta = join(targetDir, 'music.json');
    const applied = await useMusicBed(
      { bedRef: adopted.bed?.id as string, targetAudioPath: targetAudio, targetMetaPath: targetMeta },
      paths,
      { clock },
    );

    expect(applied.status).toBe('applied');
    expect(existsSync(targetAudio)).toBe(true);
    const meta = JSON.parse(readFileSync(targetMeta, 'utf8')) as Record<string, unknown>;
    expect(meta.provider).toBe('library');
    expect(meta.bedId).toBe(adopted.bed?.id);
    expect(meta.reusedFrom).toBe('acme/promo-a');
    expect(fetchCalls).toBe(0);
  });

  test('dry-run reports without copying; existing beds need explicit force', async () => {
    const { paths, sourceAudio, sourceMeta } = sandbox();
    const clock = fixedClock('2026-09-24T12:00:00.000Z');
    const adopted = await adoptMusicBed(
      { source: 'acme/promo-a', audioPath: sourceAudio, metaPath: sourceMeta },
      paths,
      { clock },
    );
    const targetDir = join(paths.repoRoot, 'videos', 'acme', 'promo-b', 'script', 'audio');
    const targetAudio = join(targetDir, 'music.mp3');
    const targetMeta = join(targetDir, 'music.json');

    const planned = await useMusicBed(
      {
        bedRef: adopted.bed?.id as string,
        targetAudioPath: targetAudio,
        targetMetaPath: targetMeta,
        dryRun: true,
      },
      paths,
      { clock },
    );
    expect(planned.status).toBe('planned');
    expect(existsSync(targetAudio)).toBe(false);

    await useMusicBed(
      { bedRef: adopted.bed?.id as string, targetAudioPath: targetAudio, targetMetaPath: targetMeta },
      paths,
      { clock },
    );
    await expect(
      useMusicBed(
        {
          bedRef: adopted.bed?.id as string,
          targetAudioPath: targetAudio,
          targetMetaPath: targetMeta,
        },
        paths,
        { clock },
      ),
    ).rejects.toThrow('pass force: true');
    expect(fetchCalls).toBe(0);
  });

  test('a tampered source file refuses reuse (sha256 guard)', async () => {
    const { paths, sourceAudio, sourceMeta } = sandbox();
    const clock = fixedClock('2026-09-24T12:00:00.000Z');
    const adopted = await adoptMusicBed(
      { source: 'acme/promo-a', audioPath: sourceAudio, metaPath: sourceMeta },
      paths,
      { clock },
    );
    writeFileSync(sourceAudio, new Uint8Array([9, 9, 9, 9, 9]));

    await expect(
      useMusicBed(
        {
          bedRef: adopted.bed?.id as string,
          targetAudioPath: join(dirname(sourceMeta), 'other', 'music.mp3'),
          targetMetaPath: join(dirname(sourceMeta), 'other', 'music.json'),
        },
        paths,
        { clock },
      ),
    ).rejects.toThrow('sha256 mismatch');
    expect(fetchCalls).toBe(0);
  });

  test('invalid provenance slugs are refused', async () => {
    const { paths, sourceAudio, sourceMeta } = sandbox();
    await expect(
      adoptMusicBed(
        { source: 'Bad Slug', audioPath: sourceAudio, metaPath: sourceMeta },
        paths,
      ),
    ).rejects.toBeInstanceOf(MediaProviderError);
  });

  test('findMusicBed matches by id or name and the registry round-trips', async () => {
    const { paths, sourceAudio, sourceMeta } = sandbox();
    const adopted = await adoptMusicBed(
      {
        source: 'acme/promo-a',
        audioPath: sourceAudio,
        metaPath: sourceMeta,
        name: 'Cama Alegre',
      },
      paths,
    );
    const library = loadMusicLibrary(paths);
    expect(findMusicBed(library, adopted.bed?.id as string)?.name).toBe('Cama Alegre');
    expect(findMusicBed(library, 'cama alegre')?.id).toBe(adopted.bed?.id);
    expect(findMusicBed(library, 'missing')).toBeUndefined();
  });
});
