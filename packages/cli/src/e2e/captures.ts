/**
 * Demo scene-media prep: `demo-app` scenes assemble from a capture clip at
 * `scenes/<id>/capture.mp4` (the path `vm plan` declares and
 * `sceneMediaCandidates` resolves). The demo's clip is derived LOCALLY from
 * the committed placeholder art — deterministic, $0, no network — so both
 * live and offline runs carry real scene media through the exact same
 * staging/provenance path a production capture would.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { sha256File, type Project } from '@videomaker/core';

import { sceneMediaCandidates } from '../pipeline/generate';
import { firstExisting, projectAbsolute } from '../pipeline/assemble';
import type { MediaCommandDeps } from '../pipeline/deps';

/** Project-relative source art the demo capture is derived from. */
const DEMO_ART_RELATIVE = 'public/media/placeholder-art.png';

/** Intrinsic size and length of the generated capture clip. */
const CAPTURE = {
  width: 540,
  height: 540,
  seconds: 30,
  fps: 30,
};

function captureArgs(input: string | undefined, output: string): string[] {
  const motion =
    `scale=${CAPTURE.width}:${CAPTURE.height}:force_original_aspect_ratio=increase,` +
    `crop=${CAPTURE.width}:${CAPTURE.height},` +
    `zoompan=z='min(zoom+0.0009,1.22)'` +
    `:d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'` +
    `:s=${CAPTURE.width}x${CAPTURE.height}:fps=${CAPTURE.fps},format=yuv420p`;
  const source =
    input === undefined
      ? ['-f', 'lavfi', '-i', `color=c=0x14281C:s=${CAPTURE.width}x${CAPTURE.height}:r=${CAPTURE.fps}`]
      : ['-loop', '1', '-framerate', String(CAPTURE.fps), '-i', input];
  return [
    '-y',
    ...source,
    '-t',
    String(CAPTURE.seconds),
    '-vf',
    input === undefined ? 'format=yuv420p' : motion,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '24',
    '-r',
    String(CAPTURE.fps),
    '-an',
    output,
  ];
}

export interface CapturePrepResult {
  /** Project-relative clips that exist after the call (created or reused). */
  scenes: Array<{ sceneId: string; capture: string; created: boolean; sha256: string }>;
}

/**
 * Ensures every active `demo-app` scene has its capture clip. Idempotent: an
 * existing capture is reused; a missing one is synthesized from the demo art
 * through the injected ffmpeg seam (a plain color card without art).
 */
export async function ensureSceneCaptures(
  project: Project,
  deps: MediaCommandDeps,
  out: (line: string) => void,
): Promise<CapturePrepResult> {
  const projectDir = project.dir;
  const scenes: CapturePrepResult['scenes'] = [];
  for (const scene of project.config.scenes) {
    if (scene.status !== 'active' || scene.source !== 'demo-app') continue;
    const candidates = sceneMediaCandidates(project.config, scene.id);
    const existing = await firstExisting(projectDir, candidates);
    const captureRelative = existing ?? `scenes/${scene.id}/capture.mp4`;
    let created = false;
    if (existing === undefined) {
      const output = projectAbsolute(projectDir, captureRelative);
      await mkdir(dirname(output), { recursive: true });
      const artAbsolute = projectAbsolute(projectDir, DEMO_ART_RELATIVE);
      const args = captureArgs(existsSync(artAbsolute) ? artAbsolute : undefined, output);
      const result = await deps.ffmpeg.run(args);
      if (result.exitCode !== 0) {
        throw new Error(
          `capture synthesis for scene "${scene.id}" failed: ${result.stderr.slice(-300)}`,
        );
      }
      created = true;
      out(
        `gen-media: synthesized the local capture for scene "${scene.id}" → ${captureRelative} ` +
          `(${CAPTURE.seconds}s, $0, offline).`,
      );
    }
    scenes.push({
      sceneId: scene.id,
      capture: captureRelative,
      created,
      sha256: await sha256File(projectAbsolute(projectDir, captureRelative)),
    });
  }
  return { scenes };
}
