/**
 * Project and scene contracts plus the canonical project folder layout.
 *
 * A project is a folder holding a `video.json` (the `VideoConfig`) plus the
 * canonical subfolders returned by `projectPaths`. Runtime validation uses
 * plain guards here; richer schemas live in a sibling package.
 */
import { existsSync, promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { isRecord } from './guards';

/** Canonical project subfolders, in display order. */
export const PROJECT_SUBDIRS = ['script', 'scenes', 'remotion', 'qa', 'renders', 'assets'] as const;

export type SceneStatus = 'active' | 'pending';
export type SceneSource = 'demo-app' | 'motion' | 'fal-video' | 'avatar';
/** Requested fal.ai generation duration in seconds. */
export type FalVideoDuration = 4 | 5 | 6 | 8 | 10;

/** Isolated-demo-DB reset steps run before recording a capture scene. */
export interface ResetDbConfig {
  note?: string;
  commands: Array<{ cmd: string[]; cwd?: string; env?: Record<string, string> }>;
}

export interface SceneDialogueLine {
  character: string;
  line: string;
}

/** Declarative fal.ai generated-video request for `fal-video` scenes. */
export interface SceneFalVideo {
  provider: 'fal';
  qualityTier: 'support' | 'hero';
  preset: string;
  initialImage: string;
  tailImage?: string;
  promptFile: string;
  negativePromptFile?: string;
  duration: FalVideoDuration;
  maxAttempts: number;
  budgetUsd: number;
  /** Named characters from `VideoConfig.visualSystem` resolved at submit time. */
  characterRefs?: string[];
}

/** Avatar take for `avatar` scenes (image + audio inputs). */
export interface SceneAvatar {
  image: string;
  audio: string;
  characterRefs?: string[];
  productReferences?: string[];
}

export interface SceneConfig {
  id: string;
  intent: string;
  source: SceneSource;
  /** Narration text; may be empty on acted (dialogue) scenes. */
  narration: string;
  status: SceneStatus;
  /** Expected scene length hint in seconds. */
  durationHint?: number;
  /** Per-scene lower/upper bounds (seconds). */
  minSeconds?: number;
  maxSeconds?: number;
  /** Max playback speed for a demo capture (defaults to 4). */
  maxPlaybackRate?: number;
  caption?: string;
  /** Acted dialogue lines; the narrator stays silent on these scenes. */
  dialogue?: SceneDialogueLine[];
  falVideo?: SceneFalVideo;
  avatar?: SceneAvatar;
  /** Per-scene isolated-demo-DB reset; overrides `VideoConfig.capture.resetDb`. */
  resetDb?: ResetDbConfig;
}

export interface VisualCharacter {
  id: string;
  /** Project-relative reference images (assets/, first = primary). */
  references: string[];
}

/** Global visual system (style + cast + camera), declared once per video. */
export interface VisualSystem {
  styleReference?: string;
  characters?: VisualCharacter[];
  cameraLanguage?: string;
}

export interface VoiceSettings {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  use_speaker_boost?: boolean;
  speed?: number;
}

export interface CastVoice {
  voiceId: string;
  voiceName?: string;
  modelId?: string;
  language?: string;
  voiceSettings?: VoiceSettings;
}

export interface TtsConfig {
  provider: 'elevenlabs' | 'openai';
  /**
   * Narration mode. `'scene'` (legacy): one TTS request per scene.
   * `'continuous'`: one request for the whole video. Omitted = `'scene'`.
   */
  mode?: 'scene' | 'continuous';
  voiceId: string;
  voiceName?: string;
  modelId: string;
  language?: string;
  voiceSettings?: VoiceSettings;
  /** Optional pronunciation dictionary applied to the request. */
  pronunciationDictionaryId?: string;
}

export interface VideoConfig {
  /** Slug of the video (e.g. "01-main-flow"). */
  id: string;
  /** Owning product (e.g. "gymspace"). */
  product: string;
  title: string;
  /**
   * Human/editorial review policy. Reviews are advisory by default; complex
   * productions opt into `required`.
   */
  workflow?: {
    schemaVersion: 1;
    draft: boolean;
    reviewPolicy?: 'advisory' | 'required';
  };
  resolution: { width: number; height: number };
  fps: number;
  tts: TtsConfig;
  /** Branding is a reference to a shared brand-tokens preset. */
  branding: { preset: string };
  visualSystem?: VisualSystem;
  /** Fixed voice per acting character id; the narrator uses `tts`. */
  cast?: Record<string, CastVoice>;
  capture?: {
    /** Declared app revision; remote revisions are not independently verified. */
    appRevision?: string;
    /** Project-relative fixtures/scripts whose bytes define the captured state. */
    fixtureFiles?: string[];
    resetDb?: ResetDbConfig;
  };
  scenes: SceneConfig[];
}

export interface ProjectPaths {
  scriptDir: string;
  scenesDir: string;
  remotionDir: string;
  qaDir: string;
  rendersDir: string;
  assetsDir: string;
}

export interface Project {
  /** `<product>/<id>` identifier derived from the config. */
  slug: string;
  /** Directory holding `video.json` (as given to `loadProject`). */
  dir: string;
  config: VideoConfig;
  paths: ProjectPaths;
}

/** The project config is missing or fails the runtime contract. */
export class ProjectValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProjectValidationError';
  }
}

function invalid(message: string): never {
  throw new ProjectValidationError(message);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${label} must be an object.`);
  return value;
}

function asString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string') invalid(`${label} must be a string.`);
  if (!allowEmpty && value.trim().length === 0) invalid(`${label} must not be empty.`);
  return value;
}

function asOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return asString(value, label);
}

function asFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    invalid(`${label} must be a finite number.`);
  }
  return value;
}

function asPositiveInt(value: unknown, label: string): number {
  const amount = asFiniteNumber(value, label);
  if (!Number.isInteger(amount) || amount < 1) invalid(`${label} must be a positive integer.`);
  return amount;
}

function asStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array.`);
  return value.map((entry, index) => asString(entry, `${label}[${index}]`));
}

function asOptionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  return asStringArray(value, label);
}

function validateVoiceSettings(value: unknown, label: string): VoiceSettings {
  const settings = asRecord(value, label);
  for (const key of ['stability', 'similarity_boost', 'style', 'speed'] as const) {
    if (settings[key] !== undefined) asFiniteNumber(settings[key], `${label}.${key}`);
  }
  if (settings.use_speaker_boost !== undefined && typeof settings.use_speaker_boost !== 'boolean') {
    invalid(`${label}.use_speaker_boost must be a boolean.`);
  }
  return value as VoiceSettings;
}

function validateResetDb(value: unknown, label: string): ResetDbConfig {
  const reset = asRecord(value, label);
  asOptionalString(reset.note, `${label}.note`);
  if (!Array.isArray(reset.commands)) invalid(`${label}.commands must be an array.`);
  reset.commands.forEach((entry, index) => {
    const command = asRecord(entry, `${label}.commands[${index}]`);
    asStringArray(command.cmd, `${label}.commands[${index}].cmd`);
    asOptionalString(command.cwd, `${label}.commands[${index}].cwd`);
    if (command.env !== undefined) {
      const env = asRecord(command.env, `${label}.commands[${index}].env`);
      for (const [key, entryValue] of Object.entries(env)) {
        asString(entryValue, `${label}.commands[${index}].env.${key}`, true);
      }
    }
  });
  return value as ResetDbConfig;
}

function validateFalVideo(value: unknown, label: string): SceneFalVideo {
  const falVideo = asRecord(value, label);
  if (falVideo.provider !== 'fal') invalid(`${label}.provider must be "fal".`);
  if (falVideo.qualityTier !== 'support' && falVideo.qualityTier !== 'hero') {
    invalid(`${label}.qualityTier must be "support" or "hero".`);
  }
  asString(falVideo.preset, `${label}.preset`);
  asString(falVideo.initialImage, `${label}.initialImage`);
  asOptionalString(falVideo.tailImage, `${label}.tailImage`);
  asString(falVideo.promptFile, `${label}.promptFile`);
  asOptionalString(falVideo.negativePromptFile, `${label}.negativePromptFile`);
  if (![4, 5, 6, 8, 10].includes(falVideo.duration as number)) {
    invalid(`${label}.duration must be one of 4, 5, 6, 8, 10 seconds.`);
  }
  asPositiveInt(falVideo.maxAttempts, `${label}.maxAttempts`);
  const budget = asFiniteNumber(falVideo.budgetUsd, `${label}.budgetUsd`);
  if (budget < 0) invalid(`${label}.budgetUsd must not be negative.`);
  asOptionalStringArray(falVideo.characterRefs, `${label}.characterRefs`);
  return value as SceneFalVideo;
}

function validateScene(value: unknown, index: number): SceneConfig {
  const label = `scenes[${index}]`;
  const scene = asRecord(value, label);
  asString(scene.id, `${label}.id`);
  asString(scene.intent, `${label}.intent`);
  if (
    scene.source !== 'demo-app' &&
    scene.source !== 'motion' &&
    scene.source !== 'fal-video' &&
    scene.source !== 'avatar'
  ) {
    invalid(`${label}.source must be "demo-app", "motion", "fal-video" or "avatar".`);
  }
  asString(scene.narration, `${label}.narration`, true);
  if (scene.status !== 'active' && scene.status !== 'pending') {
    invalid(`${label}.status must be "active" or "pending".`);
  }
  const durations: Record<string, number | undefined> = {
    durationHint: scene.durationHint === undefined ? undefined : asFiniteNumber(scene.durationHint, `${label}.durationHint`),
    minSeconds: scene.minSeconds === undefined ? undefined : asFiniteNumber(scene.minSeconds, `${label}.minSeconds`),
    maxSeconds: scene.maxSeconds === undefined ? undefined : asFiniteNumber(scene.maxSeconds, `${label}.maxSeconds`),
  };
  for (const [key, amount] of Object.entries(durations)) {
    if (amount !== undefined && amount <= 0) invalid(`${label}.${key} must be greater than 0.`);
  }
  if (durations.minSeconds !== undefined && durations.maxSeconds !== undefined) {
    if (durations.minSeconds > durations.maxSeconds) {
      invalid(`${label}.minSeconds must not exceed ${label}.maxSeconds.`);
    }
  }
  if (scene.maxPlaybackRate !== undefined) {
    const rate = asFiniteNumber(scene.maxPlaybackRate, `${label}.maxPlaybackRate`);
    if (rate <= 0) invalid(`${label}.maxPlaybackRate must be greater than 0.`);
  }
  asOptionalString(scene.caption, `${label}.caption`);
  if (scene.dialogue !== undefined) {
    if (!Array.isArray(scene.dialogue)) invalid(`${label}.dialogue must be an array.`);
    scene.dialogue.forEach((entry, lineIndex) => {
      const line = asRecord(entry, `${label}.dialogue[${lineIndex}]`);
      asString(line.character, `${label}.dialogue[${lineIndex}].character`);
      asString(line.line, `${label}.dialogue[${lineIndex}].line`);
    });
  }
  if (scene.falVideo !== undefined) validateFalVideo(scene.falVideo, `${label}.falVideo`);
  if (scene.avatar !== undefined) {
    const avatar = asRecord(scene.avatar, `${label}.avatar`);
    asString(avatar.image, `${label}.avatar.image`);
    asString(avatar.audio, `${label}.avatar.audio`);
    asOptionalStringArray(avatar.characterRefs, `${label}.avatar.characterRefs`);
    asOptionalStringArray(avatar.productReferences, `${label}.avatar.productReferences`);
  }
  if (scene.resetDb !== undefined) validateResetDb(scene.resetDb, `${label}.resetDb`);
  if ((scene.source === 'avatar' && scene.falVideo !== undefined) || (scene.avatar !== undefined && scene.source !== 'avatar')) {
    invalid(`${label} cannot mix avatar with another source or falVideo.`);
  }
  return value as SceneConfig;
}

function validateTts(value: unknown): TtsConfig {
  const tts = asRecord(value, 'tts');
  if (tts.provider !== 'elevenlabs' && tts.provider !== 'openai') {
    invalid('tts.provider must be "elevenlabs" or "openai".');
  }
  if (tts.mode !== undefined && tts.mode !== 'scene' && tts.mode !== 'continuous') {
    invalid('tts.mode must be "scene" or "continuous".');
  }
  asString(tts.voiceId, 'tts.voiceId');
  asOptionalString(tts.voiceName, 'tts.voiceName');
  asString(tts.modelId, 'tts.modelId');
  asOptionalString(tts.language, 'tts.language');
  if (tts.voiceSettings !== undefined) validateVoiceSettings(tts.voiceSettings, 'tts.voiceSettings');
  asOptionalString(tts.pronunciationDictionaryId, 'tts.pronunciationDictionaryId');
  return value as TtsConfig;
}

function validateVisualSystem(value: unknown): VisualSystem {
  const visualSystem = asRecord(value, 'visualSystem');
  asOptionalString(visualSystem.styleReference, 'visualSystem.styleReference');
  asOptionalString(visualSystem.cameraLanguage, 'visualSystem.cameraLanguage');
  if (visualSystem.characters !== undefined) {
    if (!Array.isArray(visualSystem.characters)) invalid('visualSystem.characters must be an array.');
    visualSystem.characters.forEach((entry, index) => {
      const character = asRecord(entry, `visualSystem.characters[${index}]`);
      asString(character.id, `visualSystem.characters[${index}].id`);
      asStringArray(character.references, `visualSystem.characters[${index}].references`);
    });
  }
  return value as VisualSystem;
}

function validateCast(value: unknown): Record<string, CastVoice> {
  const cast = asRecord(value, 'cast');
  for (const [characterId, entry] of Object.entries(cast)) {
    const voice = asRecord(entry, `cast.${characterId}`);
    asString(voice.voiceId, `cast.${characterId}.voiceId`);
    asOptionalString(voice.voiceName, `cast.${characterId}.voiceName`);
    asOptionalString(voice.modelId, `cast.${characterId}.modelId`);
    asOptionalString(voice.language, `cast.${characterId}.language`);
    if (voice.voiceSettings !== undefined) {
      validateVoiceSettings(voice.voiceSettings, `cast.${characterId}.voiceSettings`);
    }
  }
  return value as Record<string, CastVoice>;
}

function validateCapture(value: unknown): NonNullable<VideoConfig['capture']> {
  const capture = asRecord(value, 'capture');
  asOptionalString(capture.appRevision, 'capture.appRevision');
  asOptionalStringArray(capture.fixtureFiles, 'capture.fixtureFiles');
  if (capture.resetDb !== undefined) validateResetDb(capture.resetDb, 'capture.resetDb');
  return value as NonNullable<VideoConfig['capture']>;
}

/**
 * Runtime contract check for an untrusted `video.json` payload. Throws
 * `ProjectValidationError` on the first violation; returns the narrowed config.
 */
export function validateProject(value: unknown): VideoConfig {
  const config = asRecord(value, 'video.json');
  asString(config.id, 'id');
  asString(config.product, 'product');
  asString(config.title, 'title');
  if (config.workflow !== undefined) {
    const workflow = asRecord(config.workflow, 'workflow');
    if (workflow.schemaVersion !== 1) invalid('workflow.schemaVersion must be 1.');
    if (typeof workflow.draft !== 'boolean') invalid('workflow.draft must be a boolean.');
    if (workflow.reviewPolicy !== undefined && workflow.reviewPolicy !== 'advisory' && workflow.reviewPolicy !== 'required') {
      invalid('workflow.reviewPolicy must be "advisory" or "required".');
    }
  }
  const resolution = asRecord(config.resolution, 'resolution');
  asPositiveInt(resolution.width, 'resolution.width');
  asPositiveInt(resolution.height, 'resolution.height');
  const fps = asFiniteNumber(config.fps, 'fps');
  if (fps <= 0) invalid('fps must be greater than 0.');
  validateTts(config.tts);
  const branding = asRecord(config.branding, 'branding');
  asString(branding.preset, 'branding.preset');
  if (config.visualSystem !== undefined) validateVisualSystem(config.visualSystem);
  if (config.cast !== undefined) validateCast(config.cast);
  if (config.capture !== undefined) validateCapture(config.capture);
  if (!Array.isArray(config.scenes)) invalid('scenes must be an array.');
  const ids = new Set<string>();
  config.scenes.forEach((scene, index) => {
    const validated = validateScene(scene, index);
    if (ids.has(validated.id)) invalid(`scenes[${index}].id "${validated.id}" is duplicated.`);
    ids.add(validated.id);
  });
  return value as VideoConfig;
}

/** Type guard over `validateProject` for callers that prefer narrowing. */
export function isVideoConfig(value: unknown): value is VideoConfig {
  try {
    validateProject(value);
    return true;
  } catch {
    return false;
  }
}

/** Canonical absolute directories of a project folder. */
export function projectPaths(projectDir: string): ProjectPaths {
  return {
    scriptDir: join(projectDir, 'script'),
    scenesDir: join(projectDir, 'scenes'),
    remotionDir: join(projectDir, 'remotion'),
    qaDir: join(projectDir, 'qa'),
    rendersDir: join(projectDir, 'renders'),
    assetsDir: join(projectDir, 'assets'),
  };
}

/**
 * Loads and validates `<dir>/video.json` into a `Project`. Missing or corrupt
 * manifests fail with `ProjectValidationError`; nothing on disk is modified.
 */
export async function loadProject(dir: string): Promise<Project> {
  if (typeof dir !== 'string' || dir.trim().length === 0) {
    invalid('loadProject requires a project directory.');
  }
  const configPath = join(dir, 'video.json');
  if (!existsSync(configPath)) {
    invalid(`No video.json found in ${dir}.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await fsp.readFile(configPath, 'utf8'));
  } catch (cause) {
    throw new ProjectValidationError(`Invalid video.json in ${configPath}.`, { cause });
  }
  const config = validateProject(raw);
  return {
    slug: `${config.product}/${config.id}`,
    dir,
    config,
    paths: projectPaths(dir),
  };
}
