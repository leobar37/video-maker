/**
 * Media surface of `@videomaker/providers`: the media adapters (fal avatar/
 * video, ElevenLabs TTS, selectable music providers), the reusable $0
 * music-bed library, the runtime primitives (`Clock`/`ProcessRunner`) and the
 * credential seam (`SecretSource`).
 */
export * from './media/common';
export * from './media/fal-queue';
export * from './media/submit-gate';
export * from './media/fal-avatar';
export * from './media/fal-video';
export * from './media/elevenlabs-tts';
export * from './media/music';
export * from './runtime';
export * from './secrets';
export * from './music-library';
