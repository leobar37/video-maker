#!/usr/bin/env bun
import { resolve } from 'node:path';

const directory = resolve(import.meta.dir, '../../../docs/artifacts/javascript-asincrono');
const allowed: Record<string, true> = Object.fromEntries([
  'index.html', 'video.json', 'script.json', 'demo-results.json', 'captions.vtt', 'voice-sample.wav',
  ...['horizontal', 'vertical'].flatMap(format => [
    `javascript-asincrono-${format}.mp4`, `sample-${format}.mp4`,
    ...Array.from({ length: 14 }, (_, index) => `${format}-${String(index + 1).padStart(2, '0')}.png`),
  ]),
].map(filename => [filename, true as const]));

const server = Bun.serve({
  hostname: '0.0.0.0', port: Number(process.env.PORT ?? 8142),
  async fetch(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    const pathname = new URL(request.url).pathname;
    const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!Object.hasOwn(allowed, filename)) return new Response('Not found', { status: 404 });
    const file = Bun.file(resolve(directory, filename));
    if (!(await file.exists())) return new Response('This render is not available yet.', { status: 404 });
    return new Response(file, { headers: { 'Cache-Control': 'no-cache' } });
  },
});
console.log(`Async tutorial preview listening on all interfaces, port ${server.port}`);
