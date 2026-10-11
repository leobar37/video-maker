#!/usr/bin/env bun
import { resolve } from 'node:path';

const directory = resolve(import.meta.dir, '../../../docs/artifacts/pi-codemode-dark');
const allowed: Record<string, true> = Object.fromEntries([
  'index.html', 'video.json', 'script.json', 'captions.vtt', 'voice-sample.wav', 'pi-codemode-vertical.mp4',
  ...Array.from({ length: 9 }, (_, index) => `scene-${String(index + 1).padStart(2, '0')}.png`),
].map(filename => [filename, true as const]));

const server = Bun.serve({
  hostname: '0.0.0.0', port: Number(process.env.PORT ?? 8143),
  async fetch(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    const path = new URL(request.url).pathname;
    const filename = path === '/' ? 'index.html' : path.slice(1);
    if (!Object.hasOwn(allowed, filename)) return new Response('Not found', { status: 404 });
    const file = Bun.file(resolve(directory, filename));
    if (!(await file.exists())) return new Response('Review render not ready yet.', { status: 404 });
    return new Response(file, { headers: { 'Cache-Control': 'no-cache' } });
  },
});
console.log(`Codemode review listening on all interfaces, port ${server.port}; publishing disabled.`);
