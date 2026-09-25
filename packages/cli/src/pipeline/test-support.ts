/**
 * Test seams: fake deps (zero network/secrets), a minimal valid project
 * fixture and a failing CLI context. Test-only support — never imported by
 * production code paths.
 */
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  FetchLike,
  MediaArtifact,
  MediaJobStatus,
  MediaProvider,
  MediaSubmitInput,
  PaidReceipt,
  PublishOutcome,
  Publisher,
  SecretSource,
} from '@videomaker/providers';
import type {
  FilmRenderResult,
  FilmStillResult,
  RenderFilmStillOptions,
  RenderFilmVideoOptions,
} from '@videomaker/motion-remotion/render-adapter';
import type { FfmpegResult, FfmpegRunner } from '@videomaker/motion-remotion/loudness';
import type { VideoConfig } from '@videomaker/core';

import type { CommandRunContext } from '../spec-types';
import type { MediaCommandDeps, MediaProbe } from './deps';

/** Thrown by the fake `ctx.fail` so tests can assert refusals. */
export class CliFailError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
    this.name = 'CliFailError';
  }
}

export interface TestDepsCalls {
  fetch: number;
  secrets: string[];
  submits: { providerId: string; input: MediaSubmitInput }[];
  renderVideo: RenderFilmVideoOptions[];
  renderStill: RenderFilmStillOptions[];
  ffmpeg: string[][];
  publish: number;
}

export interface TestDepsOptions {
  /** Canned ebur128 `Summary:` block returned by the ffmpeg seam. */
  ebur128Summary?: string;
  /** Probe facts returned for every media file. */
  probe?: MediaProbe;
  /** `submit` behavior of the fake media providers (defaults to success). */
  submitImpl?: (input: MediaSubmitInput) => Promise<{
    receipt: PaidReceipt;
    status: MediaJobStatus;
  }>;
  /** Publisher behavior (default: published with a remote id). */
  publishImpl?: (action: 'publish' | 'schedule') => Promise<PublishOutcome>;
}

export interface TestDeps extends MediaCommandDeps {
  readonly calls: TestDepsCalls;
}

export const EBUR128_SUMMARY_PASS = `
[Parsed_ebur128_0 @ 0x0] Summary:

  Integrated loudness:
    I:         -14.0 LUFS
    Threshold: -24.1 LUFS

  Loudness range:
    LRA:         5.0 LU

  True peak:
    Peak:       -1.5 dBFS
`;

/** ebur128 summary OUT of tolerance (loud + true-peak over the gate). */
export const EBUR128_SUMMARY_LOUD = `
[Parsed_ebur128_0 @ 0x0] Summary:

  Integrated loudness:
    I:          -8.0 LUFS
    Threshold: -20.1 LUFS

  Loudness range:
    LRA:         4.0 LU

  True peak:
    Peak:        0.5 dBFS
`;

interface FakeJob {
  outputPath?: string;
  text?: string;
}

/**
 * Fake provider adapter: records submits, writes the requested output artifact
 * and fabricates a per-character alignment for the submitted text.
 */
function fakeProvider(id: string, calls: TestDepsCalls, options: TestDepsOptions): MediaProvider {
  const jobs = new Map<string, FakeJob>();
  return {
    id,
    async submit(input, _ctx) {
      calls.submits.push({ providerId: id, input });
      if (options.submitImpl) return options.submitImpl(input);
      const params = input.params as { outputPath?: unknown; text?: unknown };
      const job: FakeJob = {
        ...(typeof params.outputPath === 'string' ? { outputPath: params.outputPath } : {}),
        ...(typeof params.text === 'string' ? { text: params.text } : {}),
      };
      jobs.set(input.idempotencyKey, job);
      if (job.outputPath !== undefined) {
        await mkdir(dirname(job.outputPath), { recursive: true });
        await writeFile(job.outputPath, `fake media bytes for ${id}`);
      }
      return {
        receipt: {
          provider: id,
          providerJobId: `${id}-job-${calls.submits.length}`,
          submittedAt: '2026-01-01T00:00:00.000Z',
          raw: { idempotencyKey: input.idempotencyKey },
        },
        status: { state: 'succeeded' },
      };
    },
    async status() {
      return { state: 'succeeded' };
    },
    async result(receipt): Promise<MediaArtifact> {
      const raw = (receipt.raw ?? {}) as { idempotencyKey?: unknown };
      const job = jobs.get(typeof raw.idempotencyKey === 'string' ? raw.idempotencyKey : '');
      const characters = Array.from(job?.text ?? '');
      return {
        url: job?.outputPath !== undefined ? `file://${job.outputPath}` : 'file://fake',
        bytes: 1,
        extra: {
          alignment: {
            characters,
            character_start_times_seconds: characters.map((_, index) => index * 0.1),
            character_end_times_seconds: characters.map((_, index) => index * 0.1 + 0.05),
          },
        },
      };
    },
  };
}

/**
 * Recording deps: every seam records its calls; fetch/secrets THROW so a
 * violation of "no network, no secrets" fails the test loudly.
 */
export function makeTestDeps(options: TestDepsOptions = {}): TestDeps {
  const calls: TestDepsCalls = {
    fetch: 0,
    secrets: [],
    submits: [],
    renderVideo: [],
    renderStill: [],
    ffmpeg: [],
    publish: 0,
  };
  // Bun's `typeof fetch` carries a non-standard `preconnect`; the fake only
  // records calls and refuses network, so that member is intentionally absent.
  const fetchImpl = (async () => {
    calls.fetch += 1;
    throw new Error('network disabled in tests');
  }) as unknown as FetchLike;
  const secrets: SecretSource = {
    async getSecret(name) {
      calls.secrets.push(name);
      throw new Error(`secrets disabled in tests (${name})`);
    },
  };
  const ffmpeg: FfmpegRunner = {
    async run(args): Promise<FfmpegResult> {
      calls.ffmpeg.push([...args]);
      const joined = args.join(' ');
      if (joined.includes('ebur128')) {
        return { exitCode: 0, stdout: '', stderr: options.ebur128Summary ?? EBUR128_SUMMARY_PASS };
      }
      if (joined.includes('loudnorm') && joined.includes('print_format=json')) {
        return {
          exitCode: 0,
          stdout: '',
          stderr:
            '\n{\n  "input_i": "-18.2",\n  "input_tp": "-2.0",\n  "input_lra": "4.0",\n' +
            '  "input_thresh": "-28.3",\n  "target_offset": "0.2"\n}\n',
        };
      }
      // Mutating invocations end in an output path: simulate the file write so
      // callers can rename/verify it like the real ffmpeg result.
      const output = args[args.length - 1];
      if (output !== undefined && output !== '-') {
        const input = args[args.indexOf('-i') + 1];
        if (input !== undefined) await copyFile(input, output);
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
  // Remotion's `VideoConfig` is a library type; tests only need the id fields.
  const composition = { id: 'Film', width: 1080, height: 1920, fps: 30, durationInFrames: 1 } as unknown as FilmRenderResult['composition'];
  const deps: TestDeps = {
    calls,
    clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
    fetchImpl,
    secrets,
    process: {
      async run(command) {
        return { code: 0, stdout: '', stderr: `process disabled in tests (${command})` };
      },
    },
    ffmpeg,
    render: {
      async renderVideo(renderOptions: RenderFilmVideoOptions): Promise<FilmRenderResult> {
        calls.renderVideo.push(renderOptions);
        await mkdir(dirname(renderOptions.outputLocation), { recursive: true });
        await writeFile(renderOptions.outputLocation, `fake mp4 for ${renderOptions.outputLocation}`);
        return {
          serveUrl: 'file://fake-serve',
          composition,
          outputLocation: renderOptions.outputLocation,
          audioNormalization: null,
        };
      },
      async renderStill(renderOptions: RenderFilmStillOptions): Promise<FilmStillResult> {
        calls.renderStill.push(renderOptions);
        await mkdir(dirname(renderOptions.output), { recursive: true });
        await writeFile(renderOptions.output, `fake png frame ${renderOptions.frame}`);
        return { serveUrl: 'file://fake-serve', composition, output: renderOptions.output };
      },
    },
    async probeMedia(): Promise<MediaProbe> {
      return options.probe ?? { width: 1080, height: 1920, durationSeconds: 6 };
    },
    providerContext: () => ({ mode: 'run', secrets, fetchImpl, clock: deps.clock }),
    ttsProvider: () => fakeProvider('fake-tts', calls, options),
    musicProvider: () => fakeProvider('fake-music', calls, options),
    falVideoProvider: () => fakeProvider('fake-fal-video', calls, options),
    falAvatarProvider: () => fakeProvider('fake-fal-avatar', calls, options),
    async publisher(): Promise<Publisher> {
      const outcomeFor = async (action: 'publish' | 'schedule'): Promise<PublishOutcome> =>
        options.publishImpl
          ? options.publishImpl(action)
          : {
              outcome: 'published',
              idempotencyKey: 'key',
              remoteId: `remote-${calls.publish + 1}`,
              url: 'https://example.test/post/1',
            };
      return {
        id: 'fake-publisher',
        async accounts() {
          return [{ id: 'acct', healthy: true }];
        },
        async validate() {
          return { ok: true, problems: [] };
        },
        async publish(post) {
          calls.publish += 1;
          return { ...(await outcomeFor('publish')), idempotencyKey: post.idempotencyKey };
        },
        async schedule(post) {
          calls.publish += 1;
          return { ...(await outcomeFor('schedule')), idempotencyKey: post.idempotencyKey };
        },
        async status() {
          return { outcome: 'uncertain', idempotencyKey: 'key' };
        },
        async reconcile() {
          return { outcome: 'uncertain', idempotencyKey: 'key' };
        },
      };
    },
    musicLibrary: () => ({
      libraryPath: join(process.cwd(), 'no-such-music-library.json'),
      repoRoot: process.cwd(),
    }),
    async sleep() {
      /* no waiting in tests */
    },
  };
  return deps;
}

/** Minimal valid `video.json` fixture (continuous narration, motion scenes). */
export async function makeTestProject(
  dir: string,
  overrides: Partial<VideoConfig> = {},
): Promise<VideoConfig> {
  const config: VideoConfig = {
    id: 'test-video',
    product: 'demo',
    title: 'Test video',
    resolution: { width: 1080, height: 1920 },
    fps: 30,
    tts: {
      provider: 'elevenlabs',
      mode: 'continuous',
      voiceId: 'voice-1',
      modelId: 'eleven_multilingual_v2',
    },
    branding: { preset: 'generic-elena' },
    scenes: [
      {
        id: 'scene-a',
        intent: 'title-motion',
        source: 'motion',
        narration: 'Primera escena con voz.',
        status: 'active',
        durationHint: 3,
      },
      {
        id: 'scene-b',
        intent: 'title-motion',
        source: 'motion',
        narration: 'Segunda escena encadenada.',
        status: 'active',
        durationHint: 3,
      },
    ],
    ...overrides,
  };
  await mkdir(dir, { recursive: true });
  for (const sub of [
    'script',
    'script/audio',
    'scenes',
    'remotion',
    'qa',
    'renders',
    'assets',
    'public',
    'public/media',
  ]) {
    await mkdir(join(dir, ...sub.split('/')), { recursive: true });
  }
  await writeFile(join(dir, 'video.json'), `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

/** CLI context whose `fail` throws `CliFailError` (assertable refusals). */
export function makeTestContext(
  args: Record<string, string | number | boolean | string[]>,
  options: { cwd?: string; mode?: 'plan' | 'run'; lines?: string[] } = {},
): CommandRunContext {
  const lines = options.lines ?? [];
  return {
    args,
    cwd: options.cwd ?? process.cwd(),
    mode: options.mode ?? 'run',
    out: (line) => {
      lines.push(line);
    },
    fail: (message, code = 1) => {
      throw new CliFailError(message, code);
    },
  };
}
