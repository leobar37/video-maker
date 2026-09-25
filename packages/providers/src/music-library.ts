/**
 * Reusable music-bed library: a git-friendly JSON registry of generated music
 * beds so a bed is REUSED across videos instead of paying a new generation on
 * every production (the assembler loops/cuts the bed to the exact video
 * duration).
 *
 * Adopting and using a bed are $0 operations: local file work only. There is
 * NO paid submit path here and no network — by design (see
 * `planMusicBedOperation`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { sha256File } from '@videomaker/core';

import type { MediaPlannedAction } from './media/common';
import { MediaProviderError } from './media/common';
import type { Clock } from './ports';
import { systemClock } from './runtime';

/** Adopt/use a bed always costs $0: reuse beats regeneration. */
export const MUSIC_LIBRARY_COST_USD = 0;

/** Provenance slug of the video that generated a bed: `<producto>/<slug>`. */
export const MUSIC_BED_SLUG_PATTERN = /^[a-z0-9-]+\/[a-z0-9-]+$/;

export interface MusicBed {
  id: string;
  name: string;
  provider: string;
  model: string;
  prompt: string;
  bpm: number | null;
  tags: string[];
  durationSeconds: number;
  generatedAt: string;
  adoptedAt: string;
  /** Video that generated the bed: its bundle backs the audio file. */
  source: string;
  /** Repo-relative path of the audio file inside the source video. */
  file: string;
  sha256: string;
}

export interface MusicLibrary {
  version: 1;
  beds: MusicBed[];
}

export interface MusicLibraryPaths {
  /** Absolute path of the registry (e.g. `<videos>/music/library.json`). */
  libraryPath: string;
  /** Root that bed `file` paths are relative to. */
  repoRoot: string;
}

export interface AdoptMusicBedInput {
  /** Provenance slug (`<producto>/<slug>`) of the video that generated the bed. */
  source: string;
  /** Absolute path of the generated audio (e.g. `script/audio/music.mp3`). */
  audioPath: string;
  /** Absolute path of the generation metadata (`script/audio/music.json`). */
  metaPath: string;
  name?: string;
  bpm?: number;
  tags?: string[];
}

export interface UseMusicBedInput {
  /** Bed id or name. */
  bedRef: string;
  /** Absolute destination path of the reused audio. */
  targetAudioPath: string;
  /** Absolute destination path of the reuse metadata. */
  targetMetaPath: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface MusicLibraryOutcome {
  status: 'adopted' | 'duplicate' | 'applied' | 'planned';
  bed?: MusicBed;
  detail: string;
}

interface GenerationMeta {
  provider?: string;
  model?: string;
  prompt?: string;
  durationSeconds?: number;
  generatedAt?: string;
}

/**
 * Planned action of a library operation: explicit proof that adopt/use are
 * $0, offline, secret-free operations (no paid submit path).
 */
export function planMusicBedOperation(operation: 'adopt' | 'use'): MediaPlannedAction {
  return {
    provider: 'music-library',
    kind: 'music',
    operation,
    network: false,
    paid: false,
    estimatedCostUsd: MUSIC_LIBRARY_COST_USD,
    requiresSecrets: [],
    request: {},
    detail: `${operation} reuses an existing music bed from the local library: $0, no network, no paid submit`,
  };
}

export function loadMusicLibrary(paths: MusicLibraryPaths): MusicLibrary {
  if (!existsSync(paths.libraryPath)) return { version: 1, beds: [] };
  const parsed = JSON.parse(readFileSync(paths.libraryPath, 'utf8')) as MusicLibrary;
  if (parsed.version !== 1 || !Array.isArray(parsed.beds)) {
    throw new MediaProviderError(
      'INVALID_LIBRARY',
      `Invalid music library registry: ${paths.libraryPath}`,
    );
  }
  return parsed;
}

export function saveMusicLibrary(paths: MusicLibraryPaths, library: MusicLibrary): void {
  mkdirSync(dirname(paths.libraryPath), { recursive: true });
  writeFileSync(paths.libraryPath, `${JSON.stringify(library, null, 2)}\n`);
}

export function listMusicBeds(paths: MusicLibraryPaths): MusicBed[] {
  return loadMusicLibrary(paths).beds;
}

/** Finds a bed by id or case-insensitive name. */
export function findMusicBed(library: MusicLibrary, ref: string): MusicBed | undefined {
  return library.beds.find((bed) => bed.id === ref || bed.name.toLowerCase() === ref.toLowerCase());
}

function readGenerationMeta(metaPath: string): GenerationMeta {
  const parsed = JSON.parse(readFileSync(metaPath, 'utf8')) as GenerationMeta;
  if (!parsed || typeof parsed !== 'object') {
    throw new MediaProviderError('INVALID_LIBRARY', `Invalid generation metadata: ${metaPath}`);
  }
  return parsed;
}

/**
 * Registers a generated bed for reuse. Idempotent: a bed with the same sha256
 * is never registered twice. $0: no network, no paid submit.
 */
export async function adoptMusicBed(
  input: AdoptMusicBedInput,
  paths: MusicLibraryPaths,
  opts: { clock?: Clock } = {},
): Promise<MusicLibraryOutcome> {
  const clock = opts.clock ?? systemClock;
  if (!MUSIC_BED_SLUG_PATTERN.test(input.source)) {
    throw new MediaProviderError(
      'INVALID_SLUG',
      `Invalid provenance slug "${input.source}" (expected <producto>/<slug>).`,
    );
  }
  if (!existsSync(input.audioPath) || !existsSync(input.metaPath)) {
    throw new MediaProviderError(
      'BED_NOT_FOUND',
      `${input.source} has no local music bed (${input.audioPath}).`,
    );
  }
  const library = loadMusicLibrary(paths);
  const info = readGenerationMeta(input.metaPath);
  const sha256 = await sha256File(input.audioPath);
  const existing = library.beds.find((bed) => bed.sha256 === sha256);
  if (existing) {
    return {
      status: 'duplicate',
      bed: existing,
      detail: `Bed from ${input.source} is already registered as ${existing.id} (same sha256).`,
    };
  }
  const name = input.name ?? `${input.source} ${info.model ?? 'bed'}`;
  const bed: MusicBed = {
    id: `bed-${sha256.slice(0, 10)}`,
    name,
    provider: info.provider ?? 'unknown',
    model: info.model ?? '',
    prompt: info.prompt ?? '',
    bpm: input.bpm ?? null,
    tags: (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
    durationSeconds: Math.round((info.durationSeconds ?? 0) * 10) / 10,
    generatedAt: info.generatedAt ?? clock.now().toISOString(),
    adoptedAt: clock.now().toISOString(),
    source: input.source,
    file: relative(paths.repoRoot, input.audioPath),
    sha256,
  };
  library.beds.push(bed);
  saveMusicLibrary(paths, library);
  return {
    status: 'adopted',
    bed,
    detail: `Registered bed ${bed.id} — "${bed.name}" (${bed.durationSeconds}s, ${bed.provider}/${bed.model}) from ${input.source}.`,
  };
}

/**
 * Points a video at a registered bed by copying the audio and writing reuse
 * metadata. $0: no network, no paid submit — the assembler loops/cuts the bed
 * to the exact video duration afterwards.
 */
export async function useMusicBed(
  input: UseMusicBedInput,
  paths: MusicLibraryPaths,
  opts: { clock?: Clock } = {},
): Promise<MusicLibraryOutcome> {
  const clock = opts.clock ?? systemClock;
  const library = loadMusicLibrary(paths);
  const bed = findMusicBed(library, input.bedRef);
  if (!bed) {
    throw new MediaProviderError(
      'BED_NOT_FOUND',
      `Bed "${input.bedRef}" not found in ${paths.libraryPath}; list the library first.`,
    );
  }
  const source = resolve(paths.repoRoot, bed.file);
  if (!existsSync(source)) {
    throw new MediaProviderError(
      'BED_NOT_FOUND',
      `Source file missing (${bed.file}); hydrate the source video ${bed.source} first.`,
    );
  }
  const current = await sha256File(source);
  if (current !== bed.sha256) {
    throw new MediaProviderError(
      'BED_CHANGED',
      `Source file changed (sha256 mismatch); re-register the bed before reusing it.`,
    );
  }
  if (existsSync(input.targetAudioPath) && input.force !== true && input.dryRun !== true) {
    throw new MediaProviderError(
      'BED_EXISTS',
      'Target already has a music bed; pass force: true to replace it.',
    );
  }
  const detail =
    `Bed "${bed.name}" (${bed.durationSeconds}s, source ${bed.source}) applied; ` +
    `the assembler loops/cuts it to the exact video duration.`;
  if (input.dryRun === true) return { status: 'planned', bed, detail: `[dry-run] ${detail}` };

  mkdirSync(dirname(input.targetAudioPath), { recursive: true });
  copyFileSync(source, input.targetAudioPath);
  mkdirSync(dirname(input.targetMetaPath), { recursive: true });
  writeFileSync(
    input.targetMetaPath,
    `${JSON.stringify(
      {
        provider: 'library',
        model: bed.model,
        bedId: bed.id,
        bedName: bed.name,
        prompt: bed.prompt,
        durationSeconds: bed.durationSeconds,
        reusedFrom: bed.source,
        reusedAt: clock.now().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return { status: 'applied', bed, detail };
}
