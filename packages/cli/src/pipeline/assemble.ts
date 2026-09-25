/**
 * Assemble + still orchestration.
 *
 * `assemble`: continuous narration timings → film props → render adapter
 * (`renderMedia`, h264) → music ducking → loudnorm/ebur128 normalization (a
 * SEPARATE stage behind the `--loudness` gate) → `renders/*.mp4`, plus the
 * FR-011 evidence (`qa/report.json` with every produced artifact's sha256 and
 * the provenance of every input; `qa/loudness.json` with the measured
 * loudness/true-peak vs tolerance).
 *
 * `still`: renders a PNG frame through the SAME composition pipeline with the
 * SAME `filmTimingPlan` frame math as the video render — a still provably
 * samples the frame the full render would produce.
 */
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  loadProject,
  resolveInsideProject,
  sha256File,
  type Project,
  type SceneConfig,
} from '@videomaker/core';
import { filmTimingPlan, stillTimingInput, type TimingPlan } from '@videomaker/motion-core';
import {
  resolveBrandTokens,
  type AssetManifestEntry,
  type FilmProps,
  type FilmScene,
} from '@videomaker/motion-remotion';
import {
  buildEbur128MeasureArgs,
  normalizeAudioLoudness,
  parseEbur128Summary,
} from '@videomaker/motion-remotion/loudness';
import { ContinuousNarrationSchema, type ContinuousNarration, type SceneTiming } from '@videomaker/schemas';

import {
  collectArtifactEvidence,
  loudnessCheck,
  qaPassed,
  verifyArtifactHashes,
  writeEvidenceReport,
  writeLoudnessReport,
  type ArtifactEvidence,
  type InputProvenance,
  type QaEvidenceReport,
} from './evidence';
import {
  NARRATION_META_RELATIVE,
  NARRATION_WAV_RELATIVE,
  sceneMediaCandidates,
} from './generate';
import type { MediaCommandDeps } from './deps';

export const DEFAULT_RENDER_OUT_DIR = 'renders';
export const DEFAULT_STILL_OUT_DIR = 'qa/stills';

/** Music beds the ducking stage looks for, in priority order. */
export const MUSIC_BED_CANDIDATES = ['script/audio/music.mp3', 'script/audio/music.wav'];

const NARRATION_PUBLIC_SRC = 'media/narration.wav';

/** One staged copy inside the composition public dir. */
export interface StagedFile {
  /** Project-relative source artifact. */
  source: string;
  /** publicDir-relative staged path (staticFile target). */
  publicSrc: string;
  role: string;
  sha256: string;
  bytes: number;
}

/** Scene media staged into the composition + its asset-manifest facts. */
export interface SceneMediaBinding {
  publicSrc: string;
  width: number;
  height: number;
  durationSeconds: number;
  sha256: string;
}

export interface BuildFilmPropsInput {
  project: Project;
  /** Continuous mode: per-scene on-screen timings from `narration.json`. */
  timingsByScene?: ReadonlyMap<string, SceneTiming>;
  /** Continuous master binding (staged public src). */
  narration?: { src: string; durationSeconds: number };
  /** Scene mode: per-scene narration audio bindings. */
  audioByScene?: ReadonlyMap<string, { src: string; durationSeconds: number }>;
  mediaByScene?: ReadonlyMap<string, SceneMediaBinding>;
}

/**
 * Composes the film props from narration timings (or `durationHint`s in
 * draft/scene mode). Pure: every fact arrives as data, so the dry flow
 * exercises exactly what the render consumes.
 */
export function buildFilmProps(input: BuildFilmPropsInput): FilmProps {
  const { config } = input.project;
  const active = config.scenes.filter((scene) => scene.status === 'active');
  if (active.length === 0) {
    throw new Error('assemble: video.json has no active scenes to render.');
  }
  const assets: AssetManifestEntry[] = [];
  const scenes: FilmScene[] = active.map((scene) => {
    let durationInSeconds: number;
    if (input.timingsByScene) {
      const timing = input.timingsByScene.get(scene.id);
      if (!timing) {
        throw new Error(
          `assemble: scene "${scene.id}" has no timing in ${NARRATION_META_RELATIVE}; ` +
            're-run "vm gen-audio" so the master covers every active scene.',
        );
      }
      durationInSeconds = timing.durationSeconds;
    } else {
      if (scene.durationHint === undefined) {
        throw new Error(
          `assemble: scene "${scene.id}" has no durationHint and no narration timing; ` +
            'add one in video.json.',
        );
      }
      durationInSeconds = scene.durationHint;
    }
    const film: FilmScene = {
      id: scene.id,
      intent: scene.intent,
      source: scene.source,
      durationInSeconds,
    };
    if (scene.caption !== undefined) film.caption = scene.caption;
    if (scene.narration.trim().length > 0) film.narration = scene.narration;
    const media = input.mediaByScene?.get(scene.id);
    if (media) {
      film.assetId = scene.id;
      assets.push({
        id: scene.id,
        src: media.publicSrc,
        width: media.width,
        height: media.height,
        duration: media.durationSeconds,
        sha256: media.sha256,
      });
    }
    const audio = input.audioByScene?.get(scene.id);
    if (audio) {
      film.audioSrc = audio.src;
      film.audioDurationSeconds = audio.durationSeconds;
    }
    return film;
  });
  return {
    width: config.resolution.width,
    height: config.resolution.height,
    fps: config.fps,
    branding: resolveBrandTokens(config.branding.preset),
    scenes,
    timingMode: input.timingsByScene ? 'continuous' : 'scene',
    ...(input.narration ? { narration: input.narration } : {}),
    ...(assets.length > 0 ? { assets } : {}),
  };
}

/**
 * ffmpeg mix: narration kept, music bed ducked under it via sidechain. The
 * explicit `-f mp4` matters: temp outputs carry neutral suffixes and ffmpeg
 * cannot infer a container from them ("Error initializing the muxer").
 */
export function buildDuckMusicArgs(file: string, music: string, output: string): string[] {
  return [
    '-y',
    '-i',
    file,
    '-i',
    music,
    '-filter_complex',
    '[0:a]aformat=channel_layouts=stereo,aresample=48000[narr];' +
      '[1:a]aformat=channel_layouts=stereo,aresample=48000,volume=0.9[bed];' +
      '[bed][narr]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck];' +
      '[narr][duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]',
    '-map',
    '0:v',
    '-map',
    '[mix]',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-f',
    'mp4',
    output,
  ];
}

/**
 * ffmpeg stderr excerpt for error messages: head AND tail, so neither the
 * first diagnostic line nor the final actionable one is lost.
 */
export function ffmpegStderrDetail(stderr: string): string {
  const text = stderr.trim();
  return text.length <= 600 ? text : `${text.slice(0, 300)} … ${text.slice(-300)}`;
}

/** First existing candidate among project-relative paths. */
export async function firstExisting(
  projectDir: string,
  candidates: readonly string[],
): Promise<string | undefined> {
  for (const relative of candidates) {
    try {
      if ((await stat(join(projectDir, ...relative.split('/')))).isFile()) return relative;
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Project-relative path → absolute (slash-separated artifacts). */
export function projectAbsolute(projectDir: string, relative: string): string {
  return join(projectDir, ...relative.split('/'));
}

interface PreparedAssembly {
  project: Project;
  props: FilmProps;
  timingPlan: TimingPlan;
  staged: StagedFile[];
  inputs: InputProvenance[];
  narration: ContinuousNarration | undefined;
  /** Prerequisites that were absent (fatal unless preparing a draft). */
  missing: string[];
}

interface PrepareOptions {
  deps: MediaCommandDeps;
  /** Continuous timings are required (assemble + real stills). */
  requireNarration: boolean;
  /** Scene media are required (assemble + real stills). */
  requireMedia: boolean;
}

/**
 * Stages project artifacts into the composition `public/media/`, probes them
 * and composes the film props + the shared timing plan. The narration
 * master's sha256 is verified against `narration.json` (provenance pinned at
 * generation time).
 */
async function prepareAssembly(
  project: Project,
  options: PrepareOptions,
): Promise<PreparedAssembly> {
  const projectDir = project.dir;
  const { deps } = options;
  const missing: string[] = [];
  const staged: StagedFile[] = [];
  const inputs: InputProvenance[] = [];
  const mediaByScene = new Map<string, SceneMediaBinding>();
  const audioByScene = new Map<string, { src: string; durationSeconds: number }>();
  const publicDir = join(projectDir, 'public');
  await mkdir(join(publicDir, 'media'), { recursive: true });

  // Continuous narration master: timings + wav provenance.
  let narration: ContinuousNarration | undefined;
  let timingsByScene: Map<string, SceneTiming> | undefined;
  const continuous = project.config.tts.mode === 'continuous';
  if (continuous) {
    const metaPath = projectAbsolute(projectDir, NARRATION_META_RELATIVE);
    let raw: string | undefined;
    try {
      raw = await readFile(metaPath, 'utf8');
    } catch {
      missing.push(NARRATION_META_RELATIVE);
    }
    if (raw !== undefined) {
      try {
        narration = ContinuousNarrationSchema.parse(JSON.parse(raw));
      } catch (cause) {
        throw new Error(
          `${NARRATION_META_RELATIVE} is corrupt or outdated; re-run "vm gen-audio".`,
          { cause },
        );
      }
      timingsByScene = new Map(narration.scenes.map((timing) => [timing.sceneId, timing]));
      const wavPath = await resolveInsideProject(projectDir, NARRATION_WAV_RELATIVE);
      let wavSha256: string | undefined;
      try {
        wavSha256 = await sha256File(wavPath);
      } catch {
        missing.push(NARRATION_WAV_RELATIVE);
      }
      if (wavSha256 !== undefined && wavSha256 !== narration.wavSha256) {
        throw new Error(
          `${NARRATION_WAV_RELATIVE} hash ${wavSha256} ≠ ${NARRATION_META_RELATIVE}#wavSha256 ` +
            `${narration.wavSha256}; the master changed after generation — re-run "vm gen-audio".`,
        );
      }
      if (wavSha256 !== undefined) {
        staged.push(
          await stageFile(projectDir, NARRATION_WAV_RELATIVE, NARRATION_PUBLIC_SRC, 'narration-master', publicDir),
        );
        inputs.push(
          {
            path: NARRATION_WAV_RELATIVE,
            role: 'narration-master',
            sha256: wavSha256,
            source: `${NARRATION_META_RELATIVE}#wavSha256`,
          },
          {
            path: NARRATION_META_RELATIVE,
            role: 'narration-timings',
            sha256: await sha256File(metaPath),
            source: `gen-audio (fingerprint ${narration.fingerprint.slice(0, 12)}…)`,
          },
        );
      }
    }
    if (options.requireNarration && narration === undefined) {
      throw new Error(
        `assemble: missing prerequisite ${NARRATION_META_RELATIVE} (and its ${NARRATION_WAV_RELATIVE}); ` +
          'run "vm gen-audio" first.',
      );
    }
  }

  // Scene media + (legacy scene mode) per-scene audio.
  for (const scene of project.config.scenes) {
    if (scene.status !== 'active') continue;
    const candidates = sceneMediaCandidates(project.config, scene.id);
    const found = candidates.length > 0 ? await firstExisting(projectDir, candidates) : undefined;
    if (found === undefined) {
      if (candidates.length > 0) {
        missing.push(candidates[0] as string);
        if (options.requireMedia) {
          throw new Error(
            `assemble: missing prerequisite ${candidates.join(' or ')} for scene "${scene.id}"; ` +
              `run "vm gen-media --scenes ${scene.id}" first.`,
          );
        }
      }
    } else {
      const prepared = await prepareSceneMedia(deps, projectDir, scene, found, publicDir);
      mediaByScene.set(scene.id, prepared.binding);
      staged.push(prepared.staged);
      inputs.push(prepared.input);
    }
    if (!continuous) {
      const audioRelative = `script/audio/${scene.id}.wav`;
      const audioFound = await firstExisting(projectDir, [audioRelative]);
      if (audioFound !== undefined) {
        const publicSrc = `media/${scene.id}.wav`;
        staged.push(
          await stageFile(projectDir, audioFound, publicSrc, 'scene-audio', publicDir),
        );
        const probe = await deps.probeMedia(projectAbsolute(projectDir, audioFound));
        audioByScene.set(scene.id, { src: publicSrc, durationSeconds: probe.durationSeconds });
        inputs.push({
          path: audioFound,
          role: 'scene-audio',
          sha256: await sha256File(projectAbsolute(projectDir, audioFound)),
          source: `gen-audio (scene ${scene.id})`,
        });
      }
    }
  }

  const props = buildFilmProps({
    project,
    ...(timingsByScene ? { timingsByScene } : {}),
    ...(narration
      ? { narration: { src: NARRATION_PUBLIC_SRC, durationSeconds: narration.durationSeconds } }
      : {}),
    ...(audioByScene.size > 0 ? { audioByScene } : {}),
    ...(mediaByScene.size > 0 ? { mediaByScene } : {}),
  });
  const timingPlan = filmTimingPlan({
    fps: props.fps,
    scenes: props.scenes,
    timingMode: props.timingMode,
    narration: props.narration ?? null,
  });
  return { project, props, timingPlan, staged, inputs, narration, missing };
}

async function stageFile(
  projectDir: string,
  sourceRelative: string,
  publicSrc: string,
  role: string,
  publicDir: string,
): Promise<StagedFile> {
  const source = projectAbsolute(projectDir, sourceRelative);
  const target = projectAbsolute(publicDir, publicSrc);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  return {
    source: sourceRelative,
    publicSrc,
    role,
    sha256: await sha256File(source),
    bytes: (await stat(source)).size,
  };
}

interface PreparedSceneMedia {
  binding: SceneMediaBinding;
  staged: StagedFile;
  input: InputProvenance;
}

async function prepareSceneMedia(
  deps: MediaCommandDeps,
  projectDir: string,
  scene: SceneConfig,
  sourceRelative: string,
  publicDir: string,
): Promise<PreparedSceneMedia> {
  const ext = sourceRelative.split('/').pop()?.includes('.')
    ? `.${sourceRelative.split('.').pop()}`
    : '.mp4';
  const publicSrc = `media/${scene.id}${ext}`;
  const staged = await stageFile(
    projectDir,
    sourceRelative,
    publicSrc,
    `scene-media:${scene.source}`,
    publicDir,
  );
  const probe = await deps.probeMedia(projectAbsolute(projectDir, sourceRelative));
  const source =
    scene.source === 'fal-video'
      ? `gen-media (scene ${scene.id})`
      : scene.source === 'avatar'
        ? `gen-media (scene ${scene.id})`
        : `capture (scene ${scene.id})`;
  return {
    binding: {
      publicSrc,
      width: probe.width,
      height: probe.height,
      durationSeconds: probe.durationSeconds,
      sha256: staged.sha256,
    },
    staged,
    input: { path: sourceRelative, role: `scene-media:${scene.source}`, sha256: staged.sha256, source },
  };
}

export interface AssembleOptions {
  projectDir: string;
  deps: MediaCommandDeps;
  /** Project-relative renders directory (`--out`, default `renders`). */
  outDir: string;
  /** Gate for the loudnorm/ebur128 normalization stage (`--loudness`). */
  loudness: boolean;
  now: () => Date;
  out: (line: string) => void;
}

export interface AssembleResult {
  /** Project-relative render (the result contract's mp4). */
  mp4: string;
  sha256: string;
  qaPassed: boolean;
  durationSeconds: number;
  reportPath: string;
  loudnessPath: string;
  props: FilmProps;
  totalFrames: number;
}

/** Assemble: timings → props → renderMedia → ducking → loudnorm → evidence. */
export async function runAssemble(options: AssembleOptions): Promise<AssembleResult> {
  const { projectDir, deps } = options;
  const project = await loadProject(projectDir);
  const prepared = await prepareAssembly(project, {
    deps,
    requireNarration: true,
    requireMedia: true,
  });
  const inputs = [...prepared.inputs];

  const outDir = options.outDir.replace(/\/+$/, '') || DEFAULT_RENDER_OUT_DIR;
  const mp4Relative = `${outDir}/${project.config.id}.mp4`;
  const mp4Absolute = projectAbsolute(projectDir, mp4Relative);
  await mkdir(dirname(mp4Absolute), { recursive: true });

  options.out(
    `assemble: render ${prepared.timingPlan.totalFrames} frames of "${project.config.id}" → ${mp4Relative}`,
  );
  await deps.render.renderVideo({
    entryPoint: projectAbsolute(projectDir, 'remotion/index.ts'),
    publicDir: join(projectDir, 'public'),
    inputProps: prepared.props,
    expectedDurationInFrames: prepared.timingPlan.totalFrames,
    outputLocation: mp4Absolute,
    concurrency: null,
  });

  // Audio ducking: a music bed (if any) ducks under the narration master.
  // Atomic swap: write a temp with a REAL .mp4 suffix, rename over the target
  // only on success; a failure removes the temp and leaves the render intact.
  const bed = await firstExisting(projectDir, MUSIC_BED_CANDIDATES);
  if (bed !== undefined) {
    const bedAbsolute = projectAbsolute(projectDir, bed);
    const tmp = `${mp4Absolute}.duck.tmp.mp4`;
    const mixed = await deps.ffmpeg.run(buildDuckMusicArgs(mp4Absolute, bedAbsolute, tmp));
    if (mixed.exitCode !== 0) {
      await rm(tmp, { force: true });
      throw new Error(`ffmpeg music ducking failed (exit ${mixed.exitCode}): ${ffmpegStderrDetail(mixed.stderr)}`);
    }
    await rename(tmp, mp4Absolute);
    inputs.push({
      path: bed,
      role: 'music-bed',
      sha256: await sha256File(bedAbsolute),
      source: 'gen-music',
    });
    options.out(`assemble: music bed ${bed} ducked under the narration.`);
  }

  // Loudnorm/ebur128 — separate, gate-configurable stage (never part of render).
  const normalization = await normalizeAudioLoudness(mp4Absolute, {
    enabled: options.loudness,
    runner: deps.ffmpeg,
    ...(deps.log ? { log: deps.log } : {}),
  });

  // Independent measurement: evidence always records loudness vs tolerance.
  const measurement = await deps.ffmpeg.run(buildEbur128MeasureArgs(mp4Absolute));
  if (measurement.exitCode !== 0) {
    throw new Error(
      `ffmpeg ebur128 measurement failed (exit ${measurement.exitCode}): ` +
        ffmpegStderrDetail(measurement.stderr),
    );
  }
  const stats = parseEbur128Summary(measurement.stderr);
  const loudnessVerdict = loudnessCheck(stats, {}, mp4Relative);
  const loudnessPath = await writeLoudnessReport(projectDir, {
    schemaVersion: 1,
    createdAt: options.now().toISOString(),
    file: mp4Relative,
    measured: {
      integratedLufs: stats.integratedLufs,
      loudnessRangeLu: stats.loudnessRangeLu,
      truePeakDbtp: stats.truePeakDbtp,
    },
    tolerance: { targetLufs: -14, lufsTolerance: 1, targetTruePeakDbtp: -1 },
    passed: loudnessVerdict.status === 'pass',
  });

  // Evidence: every produced artifact hashed; every input provenance-pinned.
  const artifacts: ArtifactEvidence[] = [
    await collectArtifactEvidence(projectDir, mp4Relative, 'render'),
  ];
  for (const file of prepared.staged) {
    artifacts.push({
      path: `public/${file.publicSrc}`,
      role: file.role,
      sha256: file.sha256,
      bytes: file.bytes,
    });
  }
  artifacts.push(await collectArtifactEvidence(projectDir, loudnessPath, 'loudness-report'));

  const checks = [
    await verifyArtifactHashes(projectDir, artifacts),
    loudnessVerdict,
  ];
  const probe = await deps.probeMedia(mp4Absolute);
  const report: QaEvidenceReport = {
    schemaVersion: 1,
    createdAt: options.now().toISOString(),
    command: 'assemble',
    result: {
      mp4: mp4Relative,
      sha256: artifacts[0]?.sha256 ?? (await sha256File(mp4Absolute)),
      qaPassed: qaPassed(checks),
      durationSeconds: probe.durationSeconds,
    },
    artifacts,
    inputs,
    checks,
  };
  const reportPath = await writeEvidenceReport(projectDir, report);
  options.out(
    `assemble: evidence written (${reportPath}, ${loudnessPath}); ` +
      `loudness I=${stats.integratedLufs.toFixed(2)} LUFS / TP=${stats.truePeakDbtp.toFixed(2)} dBTP` +
      `${normalization.applied ? ' (normalized)' : ' (normalization skipped)'}.`,
  );
  return {
    mp4: mp4Relative,
    sha256: report.result.sha256,
    qaPassed: report.result.qaPassed,
    durationSeconds: probe.durationSeconds,
    reportPath,
    loudnessPath,
    props: prepared.props,
    totalFrames: prepared.timingPlan.totalFrames,
  };
}

export interface StillOptions {
  projectDir: string;
  deps: MediaCommandDeps;
  /** Scene ids to sample; default: every active scene. */
  scenes?: string[];
  /** Position within each scene's span (0..1, default 0.5). */
  frac: number;
  /** Draft: preview before narration/media exist (durationHint timings). */
  draft: boolean;
  /** Project-relative output directory (default `qa/stills`). */
  outDir: string;
  now: () => Date;
  out: (line: string) => void;
}

export interface StillResult {
  totalFrames: number;
  stills: { sceneId: string; png: string; frame: number }[];
}

/** Still: same composition + same `filmTimingPlan` frame math as the render. */
export async function runStill(options: StillOptions): Promise<StillResult> {
  const { projectDir, deps } = options;
  if (!Number.isFinite(options.frac) || options.frac < 0 || options.frac > 1) {
    throw new Error('still: --frac must be between 0 and 1.');
  }
  const project = await loadProject(projectDir);
  const prepared = await prepareAssembly(project, {
    deps,
    requireNarration: !options.draft,
    requireMedia: !options.draft,
  });

  // The still path computes the SAME scene boundaries: the no-audio timing
  // input (stillTimingInput) over the identical scenes/fps/mode.
  const plan = filmTimingPlan(
    stillTimingInput({
      fps: prepared.props.fps,
      scenes: prepared.props.scenes,
      timingMode: prepared.props.timingMode,
      narration: prepared.props.narration ?? null,
    }),
  );
  if (plan.totalFrames !== prepared.timingPlan.totalFrames) {
    throw new Error(
      `still: frame math drift (${plan.totalFrames} ≠ ${prepared.timingPlan.totalFrames}); ` +
        'the still and render paths must share filmTimingPlan.',
    );
  }

  const selected = options.scenes ?? prepared.props.scenes.map((scene) => scene.id);
  for (const id of selected) {
    if (!prepared.props.scenes.some((scene) => scene.id === id)) {
      throw new Error(`still: scene "${id}" is not an active scene in video.json.`);
    }
  }

  const outDir = options.outDir.replace(/\/+$/, '') || DEFAULT_STILL_OUT_DIR;
  await mkdir(projectAbsolute(projectDir, outDir), { recursive: true });
  const stills: StillResult['stills'] = [];
  for (const sceneId of selected) {
    const index = prepared.props.scenes.findIndex((scene) => scene.id === sceneId);
    const span = plan.spans[index];
    if (!span) throw new Error(`still: no frame span for scene "${sceneId}".`);
    const frame =
      span.startFrame +
      Math.min(
        span.durationInFrames - 1,
        Math.max(0, Math.round((span.durationInFrames - 1) * options.frac)),
      );
    const pngRelative = `${outDir}/${sceneId}.png`;
    await deps.render.renderStill({
      entryPoint: projectAbsolute(projectDir, 'remotion/index.ts'),
      publicDir: join(projectDir, 'public'),
      inputProps: prepared.props,
      output: projectAbsolute(projectDir, pngRelative),
      frame,
      expectedDurationInFrames: plan.totalFrames,
    });
    options.out(`still: scene "${sceneId}" frame ${frame}/${plan.totalFrames} → ${pngRelative}`);
    stills.push({ sceneId, png: pngRelative, frame });
  }
  return { totalFrames: plan.totalFrames, stills };
}
