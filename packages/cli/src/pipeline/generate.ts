/**
 * Paid media generation orchestration: narration synthesis (gen-audio), the
 * music bed (gen-music) and scene media (gen-media).
 *
 * Every spend goes through `submitPaidOnce` (core `submitOnce`): one provider
 * submit, a receipt journaled to `qa/spend.json` or an `uncertain` entry that
 * blocks retries until reconciled. Credentials resolve lazily through the
 * `SecretSource` seam; planning never touches this module.
 */
import { readFile } from 'node:fs/promises';

import {
  loadProject,
  paidPlanDigest,
  resolveInsideProject,
  sha256File,
  sha256Json,
  type VideoConfig,
} from '@videomaker/core';
import {
  useMusicBed,
  type MediaArtifact,
  type MediaProvider,
  type PaidReceipt,
} from '@videomaker/providers';
import type { ContinuousNarration } from '@videomaker/schemas';

import {
  buildContinuousNarrationMeta,
  joinSceneNarration,
  narrationFingerprint,
  parseCharacterAlignment,
  type JoinedNarration,
} from './narration';
import { writeJsonArtifact } from './evidence';
import {
  FileSpendLedger,
  buildPaidPlan,
  completePaidAttempt,
  spendLedgerPath,
  submitPaidOnce,
} from './spend-ledger';
import type { MediaCommandDeps } from './deps';

/** Narration master artifacts (the paths core's assets gate expects). */
export const NARRATION_WAV_RELATIVE = 'script/audio/narration.wav';
export const NARRATION_META_RELATIVE = 'script/audio/narration.json';
export const MUSIC_AUDIO_RELATIVE = 'script/audio/music.mp3';
export const MUSIC_META_RELATIVE = 'script/audio/music.json';

const MEDIA_POLL_INTERVAL_MS = 2_000;
const MEDIA_MAX_POLLS = 900;

export interface GenerateOptions {
  projectDir: string;
  deps: MediaCommandDeps;
  /** Hard cap in USD journalled against every submit of this run. */
  spendCapUsd: number;
  /** Operator cost estimate; null prices on return. */
  estimatedCostUsd: number | null;
  force: boolean;
  now: () => Date;
  out: (line: string) => void;
}

export interface GenAudioResult {
  wav: string;
  meta: string;
  narration: ContinuousNarration;
  /** True when an existing verified master was reused (no spend). */
  replayed: boolean;
}

/** Polls a media job to completion, then fetches its artifact. Never retries submits. */
async function awaitMediaArtifact(
  deps: MediaCommandDeps,
  provider: MediaProvider,
  receipt: PaidReceipt,
  label: string,
): Promise<MediaArtifact> {
  const ctx = deps.providerContext();
  for (let poll = 0; poll < MEDIA_MAX_POLLS; poll += 1) {
    const status = await provider.status(receipt, ctx);
    if (status.state === 'succeeded') return provider.result(receipt, ctx);
    if (status.state === 'failed') {
      throw new Error(`${label} failed at the provider: ${status.detail ?? 'no detail'}`);
    }
    await deps.sleep(MEDIA_POLL_INTERVAL_MS);
  }
  throw new Error(
    `${label}: timed out after ${MEDIA_MAX_POLLS} polls waiting for job ` +
      `${receipt.providerJobId}; the attempt stays journalled — reconcile it before resubmitting.`,
  );
}

async function verifiedExistingMaster(
  projectDir: string,
  fingerprint: string,
): Promise<ContinuousNarration | undefined> {
  const metaPath = await resolveInsideProject(projectDir, NARRATION_META_RELATIVE);
  const wavPath = await resolveInsideProject(projectDir, NARRATION_WAV_RELATIVE);
  let raw: string;
  try {
    raw = await readFile(metaPath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const meta = JSON.parse(raw) as ContinuousNarration;
    if (meta.fingerprint !== fingerprint) return undefined;
    if ((await sha256File(wavPath)) !== meta.wavSha256) return undefined;
    return meta;
  } catch {
    return undefined;
  }
}

/**
 * gen-audio: ONE continuous narration synthesis (kind 'tts') →
 * `script/audio/narration.wav` + `script/audio/narration.json` with gap-free
 * scene timings, the request fingerprint and the wav sha256.
 */
export async function runGenAudio(options: GenerateOptions): Promise<GenAudioResult> {
  const { projectDir, deps } = options;
  const project = await loadProject(projectDir);
  const { tts } = project.config;
  if (tts.mode !== 'continuous') {
    throw new Error(
      'gen-audio synthesizes the continuous narration master; set `tts.mode: ' +
        '"continuous"` in video.json (per-scene stems are not generated here).',
    );
  }
  const narrated = project.config.scenes.filter((scene) => scene.status === 'active');
  const joined: JoinedNarration = joinSceneNarration(
    narrated.map((scene) => ({ id: scene.id, narration: scene.narration })),
  );
  const fingerprint = narrationFingerprint(tts, joined.text);

  if (!options.force) {
    const existing = await verifiedExistingMaster(projectDir, fingerprint);
    if (existing) {
      options.out(
        `gen-audio: verified master reused (fingerprint ${fingerprint.slice(0, 12)}…); $0 spend.`,
      );
      return {
        wav: NARRATION_WAV_RELATIVE,
        meta: NARRATION_META_RELATIVE,
        narration: existing,
        replayed: true,
      };
    }
  }

  const wavPath = await resolveInsideProject(projectDir, NARRATION_WAV_RELATIVE);
  const idempotencyKey = `gen-audio:${fingerprint.slice(0, 32)}`;
  const plan = buildPaidPlan({
    command: 'gen-audio',
    subject: idempotencyKey,
    inputs: { fingerprint },
    outputs: [NARRATION_WAV_RELATIVE, NARRATION_META_RELATIVE],
    estimatedCostUsd: options.estimatedCostUsd,
    spendCapUsd: options.spendCapUsd,
    maxAttempts: 3,
  });
  const store = new FileSpendLedger(spendLedgerPath(projectDir));
  const params: Record<string, unknown> = {
    voiceId: tts.voiceId,
    modelId: tts.modelId,
    text: joined.text,
    outputPath: wavPath,
    transcode: true,
    ...(tts.language !== undefined ? { language: tts.language } : {}),
    ...(tts.voiceSettings !== undefined ? { voiceSettings: tts.voiceSettings } : {}),
    ...(tts.pronunciationDictionaryId !== undefined
      ? { pronunciationDictionaryId: tts.pronunciationDictionaryId }
      : {}),
    ...(options.estimatedCostUsd !== null
      ? { estimatedCostUsd: options.estimatedCostUsd }
      : {}),
  };

  options.out(`gen-audio: one continuous synthesis (${joined.text.length} chars) → ${NARRATION_WAV_RELATIVE}`);
  // ONE provider instance per operation: submit and result share its cache.
  const provider = deps.ttsProvider();
  const submitted = await submitPaidOnce({
    store,
    plan,
    now: options.now,
    submit: () =>
      provider.submit(
        {
          kind: 'tts',
          params,
          planDigest: paidPlanDigest(plan),
          idempotencyKey,
        },
        deps.providerContext(),
      ),
  });
  const artifact = await awaitMediaArtifact(
    deps,
    provider,
    submitted.receipt,
    `narration synthesis ${submitted.record.attemptId}`,
  );

  const probe = await deps.probeMedia(wavPath);
  const narration = buildContinuousNarrationMeta({
    tts,
    joined,
    alignment: parseCharacterAlignment(artifact.extra?.alignment),
    masterDurationSeconds: probe.durationSeconds,
    wavSha256: await sha256File(wavPath),
    wav: NARRATION_WAV_RELATIVE,
    generatedAt: options.now().toISOString(),
  });
  await writeJsonArtifact(
    await resolveInsideProject(projectDir, NARRATION_META_RELATIVE),
    narration,
  );
  await completePaidAttempt(store, submitted.record.attemptId, options.now);
  options.out(
    `gen-audio: master ${narration.durationSeconds.toFixed(2)}s across ` +
      `${narration.scenes.length} scene(s); timings in ${NARRATION_META_RELATIVE}.`,
  );
  return {
    wav: NARRATION_WAV_RELATIVE,
    meta: NARRATION_META_RELATIVE,
    narration,
    replayed: false,
  };
}

export interface GenMusicOptions extends GenerateOptions {
  /** $0 reuse: bed id or name from the music library. */
  use?: string;
  /** Explicit opt-in to a PAID generation. */
  generate: boolean;
  /** Music provider for generation (`elevenlabs` | `fal`). */
  provider?: 'elevenlabs' | 'fal';
  prompt?: string;
  lengthSeconds?: number;
}

export interface GenMusicResult {
  audio: string;
  meta: string;
  mode: 'reuse' | 'generate';
  detail: string;
}

/**
 * gen-music: $0 reuse from the music library first (`--use <bed>`); paid
 * generation only when requested explicitly (`--generate`) and journalled.
 * Writes `script/audio/music.*`.
 */
export async function runGenMusic(options: GenMusicOptions): Promise<GenMusicResult> {
  const { projectDir, deps } = options;
  await loadProject(projectDir);
  const library = deps.musicLibrary();

  if (options.use !== undefined && options.use.trim().length > 0) {
    const source = await resolveInsideProject(projectDir, MUSIC_AUDIO_RELATIVE);
    const metaTarget = await resolveInsideProject(projectDir, MUSIC_META_RELATIVE);
    const outcome = await useMusicBed(
      {
        bedRef: options.use,
        targetAudioPath: source,
        targetMetaPath: metaTarget,
        ...(options.force ? { force: true } : {}),
      },
      library,
      { clock: deps.clock },
    );
    options.out(`gen-music: ${outcome.detail} ($0 reuse; no spend journalled).`);
    return {
      audio: MUSIC_AUDIO_RELATIVE,
      meta: MUSIC_META_RELATIVE,
      mode: 'reuse',
      detail: outcome.detail,
    };
  }

  if (!options.generate) {
    throw new Error(
      'gen-music needs an explicit source: pass --use <bed> to reuse a library bed ($0) ' +
        'or --generate (with --provider/--prompt/--seconds) for a paid generation.',
    );
  }
  const providerId = options.provider;
  if (providerId === undefined) {
    throw new Error('gen-music --generate needs --provider (elevenlabs | fal).');
  }
  const prompt = options.prompt?.trim() ?? '';
  if (prompt.length === 0) {
    throw new Error('gen-music --generate needs --prompt <text> for the music bed.');
  }
  const lengthSeconds = options.lengthSeconds ?? 30;
  if (!Number.isFinite(lengthSeconds) || lengthSeconds <= 0) {
    throw new Error('gen-music --seconds must be a positive number.');
  }

  const audioPath = await resolveInsideProject(projectDir, MUSIC_AUDIO_RELATIVE);
  const idempotencyKey = `gen-music:${sha256Json({ prompt, lengthSeconds, provider: providerId }).slice(0, 32)}`;
  const plan = buildPaidPlan({
    command: 'gen-music',
    subject: idempotencyKey,
    inputs: { prompt, lengthSeconds, provider: providerId },
    outputs: [MUSIC_AUDIO_RELATIVE, MUSIC_META_RELATIVE],
    estimatedCostUsd: options.estimatedCostUsd,
    spendCapUsd: options.spendCapUsd,
    maxAttempts: 3,
  });
  const store = new FileSpendLedger(spendLedgerPath(projectDir));
  const params: Record<string, unknown> = {
    prompt,
    lengthSeconds,
    outputPath: audioPath,
    ...(options.estimatedCostUsd !== null
      ? { estimatedCostUsd: options.estimatedCostUsd }
      : {}),
  };

  options.out(`gen-music: paid generation via ${providerId} → ${MUSIC_AUDIO_RELATIVE}`);
  // ONE provider instance per operation: submit and result share its cache.
  const provider = deps.musicProvider(providerId);
  const submitted = await submitPaidOnce({
    store,
    plan,
    now: options.now,
    submit: () =>
      provider.submit(
        {
          kind: 'music',
          params,
          planDigest: paidPlanDigest(plan),
          idempotencyKey,
        },
        deps.providerContext(),
      ),
  });
  const artifact = await awaitMediaArtifact(
    deps,
    provider,
    submitted.receipt,
    `music generation ${submitted.record.attemptId}`,
  );
  const metaPath = await resolveInsideProject(projectDir, MUSIC_META_RELATIVE);
  await writeJsonArtifact(metaPath, {
    schemaVersion: 1,
    provider: providerId,
    prompt,
    lengthSeconds,
    sha256: artifact.sha256 ?? (await sha256File(audioPath)),
    generatedAt: options.now().toISOString(),
  });
  await completePaidAttempt(store, submitted.record.attemptId, options.now);
  options.out(`gen-music: bed ready at ${MUSIC_AUDIO_RELATIVE} (adopt it into the library for $0 reuse).`);
  return {
    audio: MUSIC_AUDIO_RELATIVE,
    meta: MUSIC_META_RELATIVE,
    mode: 'generate',
    detail: `generated via ${providerId}`,
  };
}

/** Scene media output paths a source can produce (first existing wins on reads). */
export function sceneMediaCandidates(config: VideoConfig, sceneId: string): string[] {
  const scene = config.scenes.find((entry) => entry.id === sceneId);
  switch (scene?.source) {
    case 'fal-video':
      return [`scenes/${sceneId}/media/video.mp4`, `scenes/${sceneId}/generated.mp4`];
    case 'avatar':
      return [`scenes/${sceneId}/media/avatar.mp4`, `scenes/${sceneId}/avatar.mp4`];
    case 'demo-app':
      return [`scenes/${sceneId}/media/capture.mp4`, `scenes/${sceneId}/capture.mp4`];
    default:
      return [];
  }
}

export interface GenMediaOptions extends GenerateOptions {
  /** Scene ids to generate; default: every active fal-video/avatar scene. */
  scenes?: string[];
}

export interface GenMediaSceneResult {
  sceneId: string;
  output: string;
  sha256: string;
  attemptId: string;
  estimatedCostUsd: number | null;
}

export interface GenMediaResult {
  scenes: GenMediaSceneResult[];
}

async function projectFileBytes(
  projectDir: string,
  relative: string,
): Promise<{ bytes: Uint8Array; filename: string }> {
  const path = await resolveInsideProject(projectDir, relative);
  return { bytes: await readFile(path), filename: relative.split('/').pop() ?? 'asset' };
}

/**
 * gen-media: scene media via the fal video/avatar adapters →
 * `scenes/<id>/media/*`, with a per-scene paid receipt journaled to
 * `qa/spend.json` through the core paid-operation engine. The explicit spend
 * cap is enforced before any submit (the spec layer refuses to run without it).
 */
export async function runGenMedia(options: GenMediaOptions): Promise<GenMediaResult> {
  const { projectDir, deps } = options;
  const project = await loadProject(projectDir);
  const { config } = project;
  const requested = options.scenes?.filter((id) => id.trim().length > 0);
  const targets = config.scenes.filter(
    (scene) =>
      scene.status === 'active' &&
      (scene.source === 'fal-video' || scene.source === 'avatar') &&
      (requested === undefined || requested.includes(scene.id)),
  );
  if (requested !== undefined) {
    for (const id of requested) {
      if (!config.scenes.some((scene) => scene.id === id && (scene.source === 'fal-video' || scene.source === 'avatar'))) {
        throw new Error(
          `gen-media: scene "${id}" is not an active fal-video/avatar scene in video.json.`,
        );
      }
    }
  }
  if (targets.length === 0) {
    throw new Error('gen-media: no fal-video/avatar scenes selected (check --scenes / scene status).');
  }

  // Run-level budget check BEFORE any submit: the cap bounds the whole run.
  const estimatedTotal = targets.reduce(
    (sum, scene) => sum + (sceneEstimate(scene, options) ?? 0),
    0,
  );
  if (options.estimatedCostUsd !== null && estimatedTotal > options.spendCapUsd) {
    throw new Error(
      `gen-media: estimated total $${estimatedTotal.toFixed(2)} exceeds --spend-cap ` +
        `$${options.spendCapUsd.toFixed(2)}; raise the cap or select fewer scenes.`,
    );
  }

  const store = new FileSpendLedger(spendLedgerPath(projectDir));
  const results: GenMediaSceneResult[] = [];
  for (const scene of targets) {
    const output = scene.source === 'fal-video'
      ? `scenes/${scene.id}/media/video.mp4`
      : `scenes/${scene.id}/media/avatar.mp4`;
    const outputPath = await resolveInsideProject(projectDir, output);
    const { params, inputs } =
      scene.source === 'fal-video'
        ? await falVideoParams(projectDir, config, scene.id, outputPath, options.estimatedCostUsd)
        : await avatarParams(projectDir, config, scene.id, outputPath, options.estimatedCostUsd);
    const inputsDigest = sha256Json(inputs);
    const idempotencyKey = `gen-media:${scene.id}:${inputsDigest.slice(0, 24)}`;
    const plan = buildPaidPlan({
      command: 'gen-media',
      subject: idempotencyKey,
      inputs,
      outputs: [output],
      estimatedCostUsd: sceneEstimate(scene, options),
      spendCapUsd: options.spendCapUsd,
      maxAttempts: 3,
    });
    options.out(`gen-media: ${scene.source} scene "${scene.id}" → ${output}`);
    // ONE provider instance per scene: submit and result share its cache.
    const provider =
      scene.source === 'fal-video' ? deps.falVideoProvider() : deps.falAvatarProvider();
    const submitted = await submitPaidOnce({
      store,
      plan,
      now: options.now,
      submit: () =>
        provider.submit(
          {
            kind: scene.source === 'fal-video' ? 'video' : 'avatar',
            params,
            planDigest: paidPlanDigest(plan),
            idempotencyKey,
          },
          deps.providerContext(),
        ),
    });
    const artifact = await awaitMediaArtifact(
      deps,
      provider,
      submitted.receipt,
      `scene media ${scene.id}`,
    );
    const sha256 = artifact.sha256 ?? (await sha256File(outputPath));
    await completePaidAttempt(store, submitted.record.attemptId, options.now);
    results.push({
      sceneId: scene.id,
      output,
      sha256,
      attemptId: submitted.record.attemptId,
      estimatedCostUsd: sceneEstimate(scene, options),
    });
    options.out(`gen-media: scene "${scene.id}" ready (${sha256.slice(0, 12)}…).`);
  }
  return { scenes: results };
}

function sceneEstimate(
  scene: VideoConfig['scenes'][number],
  options: GenMediaOptions,
): number | null {
  if (options.estimatedCostUsd !== null) return options.estimatedCostUsd;
  return scene.falVideo?.budgetUsd ?? null;
}

async function falVideoParams(
  projectDir: string,
  config: VideoConfig,
  sceneId: string,
  outputPath: string,
  estimatedCostUsd: number | null,
): Promise<{ params: Record<string, unknown>; inputs: Record<string, unknown> }> {
  const scene = config.scenes.find((entry) => entry.id === sceneId);
  const fal = scene?.falVideo;
  if (!scene || !fal) throw new Error(`gen-media: scene "${sceneId}" has no falVideo request.`);
  const prompt = await readProjectText(projectDir, fal.promptFile);
  const source = await projectFileBytes(projectDir, fal.initialImage);
  const inputs: Record<string, unknown> = {
    sceneId,
    kind: 'video',
    preset: fal.preset,
    prompt,
    durationSeconds: fal.duration,
    initialImageSha256: await sha256File(await resolveInsideProject(projectDir, fal.initialImage)),
    ...(fal.tailImage !== undefined
      ? { tailImageSha256: await sha256File(await resolveInsideProject(projectDir, fal.tailImage)) }
      : {}),
  };
  const params: Record<string, unknown> = {
    modelId: fal.preset,
    prompt,
    durationSeconds: fal.duration,
    source,
    outputPath,
    ...(fal.negativePromptFile !== undefined
      ? { negativePrompt: await readProjectText(projectDir, fal.negativePromptFile) }
      : {}),
    ...(fal.tailImage !== undefined
      ? { tailSource: await projectFileBytes(projectDir, fal.tailImage) }
      : {}),
    ...(estimatedCostUsd !== null ? { estimatedCostUsd } : {}),
  };
  return { params, inputs };
}

async function avatarParams(
  projectDir: string,
  config: VideoConfig,
  sceneId: string,
  outputPath: string,
  estimatedCostUsd: number | null,
): Promise<{ params: Record<string, unknown>; inputs: Record<string, unknown> }> {
  const scene = config.scenes.find((entry) => entry.id === sceneId);
  const avatar = scene?.avatar;
  if (!scene || !avatar) throw new Error(`gen-media: scene "${sceneId}" has no avatar take.`);
  const image = await projectFileBytes(projectDir, avatar.image);
  const audio = await projectFileBytes(projectDir, avatar.audio);
  const inputs: Record<string, unknown> = {
    sceneId,
    kind: 'avatar',
    imageSha256: await sha256File(await resolveInsideProject(projectDir, avatar.image)),
    audioSha256: await sha256File(await resolveInsideProject(projectDir, avatar.audio)),
  };
  const params: Record<string, unknown> = {
    image,
    audio,
    outputPath,
    ...(estimatedCostUsd !== null ? { estimatedCostUsd } : {}),
  };
  return { params, inputs };
}

async function readProjectText(projectDir: string, relative: string): Promise<string> {
  const path = await resolveInsideProject(projectDir, relative);
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    throw new Error(`gen-media: missing input file ${relative} (scene prompt/prompt file).`, {
      cause,
    });
  }
}
