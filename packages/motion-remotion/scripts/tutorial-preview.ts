#!/usr/bin/env bun
import { resolve } from 'node:path';
import { DEMO_CHAPTERS, DEMO_FORMATS } from '../examples/opencode/config';

const directory = resolve(import.meta.dir, '../../../docs/artifacts/opencode-motion-kit');
const allowed: Record<string, true> = Object.fromEntries([
  'index.html', 'atlas.html', 'atlas.json', 'demo.json', 'guide.md',
  ...Object.values(DEMO_FORMATS).flatMap((format) => [
    format.video, ...DEMO_CHAPTERS.map((_, index) => `${format.stillPrefix}${index + 1}.png`),
  ]),
].map((filename) => [filename, true as const]));
const server = Bun.serve({
  hostname: '0.0.0.0',
  port: Number(process.env.PORT ?? 8140),
  async fetch(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    const pathname = new URL(request.url).pathname;
    const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!Object.hasOwn(allowed, filename)) return new Response('Not found', { status: 404 });
    const file = Bun.file(resolve(directory, filename));
    if (!(await file.exists())) return new Response('Render the demo with bun run motion:tutorial first.', { status: 404 });
    // Bun handles byte-range requests for file responses, allowing reliable video seeking.
    return new Response(file, { headers: { 'Cache-Control': 'no-cache' } });
  },
});
console.log(`Tutorial preview listening on all interfaces, port ${server.port}`);
