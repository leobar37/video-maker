import { afterAll, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import {
  PROJECT_SUBDIRS,
  ProjectValidationError,
  isVideoConfig,
  loadProject,
  projectPaths,
  validateProject,
} from './project';

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(join(import.meta.dir, '.tmp-'));
  tempDirs.push(dir);
  return dir;
}

type Fixture = Record<string, unknown>;

function minimalScene(overrides: Fixture = {}): Fixture {
  return {
    id: 's1',
    intent: 'Hook the viewer',
    source: 'demo-app',
    narration: 'Welcome.',
    status: 'active',
    durationHint: 5,
    minSeconds: 3,
    maxSeconds: 8,
    ...overrides,
  };
}

function minimalConfig(overrides: Fixture = {}): Fixture {
  return {
    id: '01-main',
    product: 'acme',
    title: 'Main flow',
    resolution: { width: 1920, height: 1080 },
    fps: 30,
    tts: { provider: 'elevenlabs', voiceId: 'voice-1', modelId: 'eleven_multilingual_v2' },
    branding: { preset: 'acme-dark' },
    scenes: [minimalScene()],
    ...overrides,
  };
}

function ttsWith(overrides: Fixture): Fixture {
  return {
    provider: 'elevenlabs',
    voiceId: 'voice-1',
    modelId: 'eleven_multilingual_v2',
    ...overrides,
  };
}

function falVideo(overrides: Fixture = {}): Fixture {
  return {
    provider: 'fal',
    qualityTier: 'hero',
    preset: 'veo3',
    initialImage: 'assets/opening.png',
    promptFile: 'prompts/s1.txt',
    duration: 8,
    maxAttempts: 3,
    budgetUsd: 2.5,
    ...overrides,
  };
}

function expectInvalid(config: unknown, messagePart: string): void {
  let caught: unknown;
  try {
    validateProject(config);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProjectValidationError);
  if (!(caught instanceof ProjectValidationError)) return;
  expect(caught.message).toContain(messagePart);
}

describe('validateProject', () => {
  test('accepts a minimal config', () => {
    expect(validateProject(minimalConfig()).id).toBe('01-main');
  });

  test('accepts a fully-populated config', () => {
    const config = minimalConfig({
      workflow: { schemaVersion: 1, draft: false, reviewPolicy: 'required' },
      visualSystem: {
        styleReference: 'assets/style.png',
        characters: [{ id: 'juan', references: ['assets/juan.png'] }],
        cameraLanguage: 'slow push-in',
      },
      cast: {
        juan: { voiceId: 'voice-2', voiceSettings: { stability: 0.5, use_speaker_boost: true } },
      },
      capture: {
        appRevision: 'abc123',
        fixtureFiles: ['fixtures/seed.sql'],
        resetDb: { note: 'clean', commands: [{ cmd: ['bun', 'run', 'reset'], env: { A: '1' } }] },
      },
      scenes: [
        minimalScene({
          id: 's1',
          source: 'fal-video',
          narration: '',
          dialogue: [{ character: 'juan', line: 'Hola' }],
          falVideo: falVideo(),
        }),
        minimalScene({
          id: 's2',
          intent: 'Close',
          source: 'avatar',
          avatar: { image: 'assets/host.png', audio: 'script/audio/host.wav' },
          resetDb: { commands: [{ cmd: ['make', 'reset'] }] },
        }),
      ],
    });
    expect(validateProject(config).scenes).toHaveLength(2);
  });

  test('rejects non-object payloads', () => {
    for (const value of [null, 'x', 42, []]) {
      expectInvalid(value, 'video.json must be an object');
    }
  });

  test('rejects missing or blank identity fields', () => {
    expectInvalid(minimalConfig({ id: undefined }), 'id must be a string');
    expectInvalid(minimalConfig({ product: '   ' }), 'product must not be empty');
    expectInvalid(minimalConfig({ title: '' }), 'title must not be empty');
  });

  test('rejects invalid workflow policy', () => {
    expectInvalid(
      minimalConfig({ workflow: { schemaVersion: 2, draft: true } }),
      'workflow.schemaVersion must be 1',
    );
    expectInvalid(
      minimalConfig({ workflow: { schemaVersion: 1, draft: 'yes' } }),
      'workflow.draft must be a boolean',
    );
    expectInvalid(
      minimalConfig({ workflow: { schemaVersion: 1, draft: true, reviewPolicy: 'always' } }),
      'workflow.reviewPolicy',
    );
  });

  test('rejects invalid resolution and fps', () => {
    expectInvalid(
      minimalConfig({ resolution: { width: 0, height: 1080 } }),
      'resolution.width',
    );
    expectInvalid(minimalConfig({ fps: 0 }), 'fps must be greater than 0');
    expectInvalid(minimalConfig({ fps: Number.NaN }), 'fps must be a finite number');
  });

  test('rejects invalid tts config', () => {
    expectInvalid(minimalConfig({ tts: ttsWith({ provider: 'piper' }) }), 'tts.provider');
    expectInvalid(minimalConfig({ tts: ttsWith({ mode: 'continous' }) }), 'tts.mode');
    expectInvalid(minimalConfig({ tts: ttsWith({ modelId: '' }) }), 'tts.modelId must not be empty');
  });

  test('rejects invalid scenes', () => {
    expectInvalid(minimalConfig({ scenes: {} }), 'scenes must be an array');
    expectInvalid(
      minimalConfig({ scenes: [minimalScene({ source: 'karaoke' })] }),
      'source must be',
    );
    expectInvalid(minimalConfig({ scenes: [minimalScene({ status: 'done' })] }), 'status must be');
    expectInvalid(minimalConfig({ scenes: [minimalScene({ intent: '' })] }), 'intent must not be empty');
    expectInvalid(
      minimalConfig({ scenes: [minimalScene({ narration: 7 })] }),
      'narration must be a string',
    );
  });

  test('rejects duplicated scene ids', () => {
    expectInvalid(
      minimalConfig({ scenes: [minimalScene(), minimalScene()] }),
      'is duplicated',
    );
  });

  test('rejects invalid duration fields', () => {
    expectInvalid(
      minimalConfig({ scenes: [minimalScene({ durationHint: 0 })] }),
      'durationHint must be greater than 0',
    );
    expectInvalid(
      minimalConfig({ scenes: [minimalScene({ minSeconds: 9, maxSeconds: 4 })] }),
      'minSeconds must not exceed',
    );
    expectInvalid(
      minimalConfig({ scenes: [minimalScene({ durationHint: Number.NaN })] }),
      'durationHint must be a finite number',
    );
    expectInvalid(
      minimalConfig({ scenes: [minimalScene({ maxPlaybackRate: -1 })] }),
      'maxPlaybackRate must be greater than 0',
    );
  });

  test('rejects invalid dialogue and falVideo payloads', () => {
    expectInvalid(
      minimalConfig({ scenes: [minimalScene({ dialogue: [{ character: 'juan', line: '' }] })] }),
      'dialogue[0].line must not be empty',
    );
    expectInvalid(
      minimalConfig({ scenes: [minimalScene({ falVideo: falVideo({ duration: 7 }) })] }),
      'duration must be one of',
    );
    expectInvalid(
      minimalConfig({ scenes: [minimalScene({ falVideo: falVideo({ budgetUsd: -1 }) })] }),
      'budgetUsd must not be negative',
    );
    expectInvalid(
      minimalConfig({
        scenes: [minimalScene({ falVideo: falVideo({ qualityTier: 'epic' }) })],
      }),
      'qualityTier',
    );
  });

  test('rejects mixing avatar with other sources', () => {
    expectInvalid(
      minimalConfig({
        scenes: [minimalScene({ source: 'avatar', falVideo: falVideo() })],
      }),
      'cannot mix avatar',
    );
    expectInvalid(
      minimalConfig({
        scenes: [
          minimalScene({ avatar: { image: 'assets/host.png', audio: 'script/audio/host.wav' } }),
        ],
      }),
      'cannot mix avatar',
    );
  });
});

describe('isVideoConfig', () => {
  test('narrows valid configs and rejects the rest', () => {
    expect(isVideoConfig(minimalConfig())).toBe(true);
    expect(isVideoConfig({})).toBe(false);
    expect(isVideoConfig(null)).toBe(false);
  });
});

describe('projectPaths', () => {
  test('returns the canonical project directories', () => {
    const paths = projectPaths('/tmp/proj');
    expect(Object.keys(paths)).toHaveLength(PROJECT_SUBDIRS.length);
    expect(paths.scriptDir).toBe(join('/tmp/proj', 'script'));
    expect(paths.scenesDir).toBe(join('/tmp/proj', 'scenes'));
    expect(paths.remotionDir).toBe(join('/tmp/proj', 'remotion'));
    expect(paths.qaDir).toBe(join('/tmp/proj', 'qa'));
    expect(paths.rendersDir).toBe(join('/tmp/proj', 'renders'));
    expect(paths.assetsDir).toBe(join('/tmp/proj', 'assets'));
  });
});

describe('loadProject', () => {
  async function makeProjectDir(): Promise<string> {
    const dir = await makeTempDir();
    await fsp.writeFile(join(dir, 'video.json'), JSON.stringify(minimalConfig()));
    return dir;
  }

  test('loads and validates a project from disk', async () => {
    const dir = await makeProjectDir();
    const project = await loadProject(dir);
    expect(project.slug).toBe('acme/01-main');
    expect(project.dir).toBe(dir);
    expect(project.config.scenes[0]?.id).toBe('s1');
    expect(project.paths.qaDir).toBe(join(dir, 'qa'));
    expect(project.paths.assetsDir).toBe(join(dir, 'assets'));
  });

  test('fails when video.json is missing', async () => {
    const dir = await makeTempDir();
    await expect(loadProject(dir)).rejects.toThrow(ProjectValidationError);
  });

  test('fails when video.json is corrupt', async () => {
    const dir = await makeTempDir();
    await fsp.writeFile(join(dir, 'video.json'), '{ not json');
    await expect(loadProject(dir)).rejects.toThrow(ProjectValidationError);
  });

  test('fails when video.json violates the contract', async () => {
    const dir = await makeTempDir();
    await fsp.writeFile(join(dir, 'video.json'), JSON.stringify({ id: 'x' }));
    await expect(loadProject(dir)).rejects.toThrow(ProjectValidationError);
  });

  test('fails without a directory argument', async () => {
    await expect(loadProject('')).rejects.toThrow(ProjectValidationError);
  });
});
