/**
 * $0 music-bed wiring for the demo project: a small, deterministic soft pad
 * registered in a project-local library (`assets/music/library.json`) so the
 * `gen-music` reuse path (`useMusicBed`) works offline on any checkout. The
 * registry follows the `MusicLibrary` contract of `@videomaker/providers`, so
 * `vm gen-music --use <bed>` and the assembler's ducking stage consume it
 * exactly like a bed adopted from a real generation.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { sha256File } from '@videomaker/core';
import {
  findMusicBed,
  loadMusicLibrary,
  saveMusicLibrary,
  type MusicBed,
  type MusicLibraryPaths,
} from '@videomaker/providers';

import { synthesizeMusicBedWav } from './offline-audio';

/** Stable id of the demo bed (`vm gen-music --use demo-soft-pad`). */
export const DEMO_BED_ID = 'demo-soft-pad';

const BED_FILE_RELATIVE = join('assets', 'music', 'bed.wav');
const BED_DURATION_SECONDS = 24;

/**
 * The demo keeps its bed registry INSIDE the project (`assets/music/…`), so
 * library reuse works on any checkout without a repo-root `music/` directory.
 * Exported as the wiring contract between `runE2e`, `runGenMusic` and tests.
 */
export function demoMusicLibraryPaths(projectDir: string): MusicLibraryPaths {
  return {
    libraryPath: join(projectDir, 'assets', 'music', 'library.json'),
    repoRoot: projectDir,
  };
}

export interface MusicBedState {
  bed: MusicBed;
  /** True when the bed (or its registry entry) had to be (re)generated. */
  created: boolean;
  detail: string;
}

/**
 * Ensures the demo bed exists in the project library with a sha256 that
 * matches its audio file. Self-healing: a missing or drifted file is
 * resynthesized deterministically — never an error, never a spend.
 */
export async function ensureDemoMusicBed(
  projectDir: string,
  options: { now: () => Date; out: (line: string) => void },
): Promise<MusicBedState> {
  const paths = demoMusicLibraryPaths(projectDir);
  const bedPath = join(projectDir, BED_FILE_RELATIVE);
  const library = loadMusicLibrary(paths);
  const existing = findMusicBed(library, DEMO_BED_ID);

  if (existing !== undefined && existsSync(bedPath)) {
    const sha256 = await sha256File(bedPath);
    if (sha256 === existing.sha256) {
      options.out(
        `gen-music: library bed "${existing.name}" already registered (${existing.durationSeconds}s); $0 reuse.`,
      );
      return { bed: existing, created: false, detail: `library bed ${existing.id} verified` };
    }
  }

  await mkdir(dirname(bedPath), { recursive: true });
  await writeFile(bedPath, synthesizeMusicBedWav({ durationSeconds: BED_DURATION_SECONDS }));
  const now = options.now().toISOString();
  const bed: MusicBed = {
    id: DEMO_BED_ID,
    name: 'Demo soft pad',
    provider: 'offline-synth',
    model: 'pad-v1',
    prompt: 'Soft F-major pad bed for the demo pipeline (locally synthesized, $0).',
    bpm: 90,
    tags: ['demo', 'bed', 'instrumental'],
    durationSeconds: BED_DURATION_SECONDS,
    generatedAt: now,
    adoptedAt: now,
    source: 'demo/hello',
    file: BED_FILE_RELATIVE,
    sha256: await sha256File(bedPath),
  };
  library.beds = [...library.beds.filter((entry) => entry.id !== bed.id), bed];
  saveMusicLibrary(paths, library);
  options.out(
    `gen-music: synthesized the demo bed (${BED_DURATION_SECONDS}s) → ${BED_FILE_RELATIVE} ` +
      `and registered it as ${bed.id}; $0, offline.`,
  );
  return { bed, created: true, detail: `bed ${bed.id} synthesized and registered` };
}
