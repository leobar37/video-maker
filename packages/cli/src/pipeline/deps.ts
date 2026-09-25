/**
 * Injectable runtime seams for the media/pipeline commands.
 *
 * Production wiring (`defaultMediaDeps`) builds the real providers lazily —
 * credentials resolve ONLY in run mode, through the `SecretSource` seam (the
 * only door to `@videomaker/credentials`). Tests swap any seam for a fake and
 * stay network-free. Plan mode never touches this module's providers at all.
 */
import {
  FilePublicationJournal,
  ZernioClient,
  ZernioPublisher,
  bunProcessRunner,
  createElevenLabsTtsProvider,
  createFalAvatarProvider,
  createFalVideoProvider,
  createSecretSource,
  selectMusicProvider,
  systemClock,
  type Clock,
  type FetchLike,
  type MediaProvider,
  type MusicLibraryPaths,
  type MusicProviderId,
  type ProcessRunner,
  type ProviderContext,
  type Publisher,
  type SecretSource,
} from '@videomaker/providers';
import {
  processFfmpegRunner,
  type FfmpegRunner,
} from '@videomaker/motion-remotion/loudness';
import {
  renderFilmStill,
  renderFilmVideo,
  type FilmRenderResult,
  type FilmStillResult,
  type RenderFilmStillOptions,
  type RenderFilmVideoOptions,
} from '@videomaker/motion-remotion/render-adapter';

/** Intrinsic media facts the asset manifest needs. */
export interface MediaProbe {
  width: number;
  height: number;
  durationSeconds: number;
}

/** The render adapter seam (video + still paths share one composition). */
export interface RenderSeam {
  renderVideo(options: RenderFilmVideoOptions): Promise<FilmRenderResult>;
  renderStill(options: RenderFilmStillOptions): Promise<FilmStillResult>;
}

/** Everything the media/pipeline commands need from the outside world. */
export interface MediaCommandDeps {
  clock: Clock;
  fetchImpl: FetchLike;
  secrets: SecretSource;
  process: ProcessRunner;
  ffmpeg: FfmpegRunner;
  render: RenderSeam;
  /** ffprobe-backed intrinsic facts of a media file (fakeable). */
  probeMedia(path: string): Promise<MediaProbe>;
  /** Run-mode provider context; secrets resolve lazily behind it. */
  providerContext(): ProviderContext;
  /** ElevenLabs TTS adapter (kind 'tts'). */
  ttsProvider(): MediaProvider;
  /** Selectable music adapters (`elevenlabs` | `fal`). */
  musicProvider(id: MusicProviderId): MediaProvider;
  /** fal image-to-video adapter (kind 'video'). */
  falVideoProvider(): MediaProvider;
  /** fal avatar adapter (kind 'avatar'). */
  falAvatarProvider(): MediaProvider;
  /** Zernio `Publisher` port; `journalPath` keeps idempotent replay on disk. */
  publisher(journalPath: string): Promise<Publisher>;
  /** $0 music-bed library registry. */
  musicLibrary(): MusicLibraryPaths;
  sleep(ms: number): Promise<void>;
  log?: (message: string) => void;
}

async function probeMediaWithFfmpeg(runner: ProcessRunner, path: string): Promise<MediaProbe> {
  const result = await runner.run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    path,
  ]);
  if (result.code !== 0) {
    throw new Error(`ffprobe failed for ${path}: ${result.stderr.slice(-300)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch (cause) {
    throw new Error(`ffprobe returned invalid JSON for ${path}.`, { cause });
  }
  const record = (raw ?? {}) as Record<string, unknown>;
  const streams = Array.isArray(record.streams) ? record.streams : [];
  const video = (streams[0] ?? {}) as Record<string, unknown>;
  const format = (record.format ?? {}) as Record<string, unknown>;
  const durationSeconds = Number(format.duration);
  return {
    width: typeof video.width === 'number' ? video.width : 0,
    height: typeof video.height === 'number' ? video.height : 0,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
  };
}

/**
 * Production wiring. Nothing here touches the network or resolves a secret at
 * construction time: providers and the publisher are built on demand and the
 * secret source is lazy by design.
 */
export function defaultMediaDeps(overrides: Partial<MediaCommandDeps> = {}): MediaCommandDeps {
  const clock = overrides.clock ?? systemClock;
  const fetchImpl = overrides.fetchImpl ?? globalThis.fetch;
  const processRunner = overrides.process ?? bunProcessRunner;
  const secrets = overrides.secrets ?? createSecretSource({ fetchImpl });
  const deps: MediaCommandDeps = {
    clock,
    fetchImpl,
    secrets,
    process: processRunner,
    ffmpeg: overrides.ffmpeg ?? processFfmpegRunner,
    render: overrides.render ?? { renderVideo: renderFilmVideo, renderStill: renderFilmStill },
    probeMedia: overrides.probeMedia ?? ((path) => probeMediaWithFfmpeg(processRunner, path)),
    providerContext: () => ({
      mode: 'run',
      secrets,
      fetchImpl,
      clock,
      process: processRunner,
      ...(deps.log ? { logger: deps.log } : {}),
    }),
    ttsProvider: () => createElevenLabsTtsProvider({ clock }),
    musicProvider: (id) => selectMusicProvider(id, { clock }),
    falVideoProvider: () => createFalVideoProvider({ clock }),
    falAvatarProvider: () => createFalAvatarProvider({ clock }),
    publisher: async (journalPath) => {
      // Lazy credential resolution: run mode only (NFR-002).
      const apiKey = await secrets.getSecret('ZERNIO_API_KEY', 'run');
      return new ZernioPublisher(new ZernioClient({ apiKey, fetchImpl }), {
        journal: new FilePublicationJournal(journalPath),
      });
    },
    musicLibrary: () => ({
      libraryPath: `${process.cwd()}/music/library.json`,
      repoRoot: process.cwd(),
    }),
    sleep: (ms) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    },
  };
  return { ...deps, ...overrides };
}
