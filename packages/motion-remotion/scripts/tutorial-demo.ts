#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { CHAPTER_FRAMES, DEMO_CHAPTERS, DEMO_FORMATS, DEMO_FPS, DEMO_FRAMES, parseDemoArgs } from '../examples/opencode/config';
import { writeTutorialCatalog } from './tutorial-catalog';

const root = resolve(import.meta.dir, '../../..');
const output = resolve(root, 'docs/artifacts/opencode-motion-kit');
const publicDir = resolve(root, 'projects/demo/opencode/public');
const entryPoint = resolve(import.meta.dir, '../examples/opencode/index.ts');

async function main() {
  const options = parseDemoArgs(process.argv.slice(2));
  await writeTutorialCatalog(root, output);
  if (options.catalogOnly) {
    console.log(`Atlas and review pages updated: ${output}`);
    return;
  }
  await mkdir(publicDir, { recursive: true });
  // Generate real local MP4 fixtures. No capture session, credentials or paid APIs.
  let serveUrl = await bundle({ entryPoint, publicDir });
  for (const key of options.formats) {
    const format = DEMO_FORMATS[key];
    const sample = await selectComposition({ serveUrl, id: format.sampleId });
    console.log(`Rendering ${key} illustrative video fixture…`);
    await renderMedia({ serveUrl, composition: sample, codec: 'h264', pixelFormat: 'yuv420p',
      outputLocation: resolve(publicDir, format.sampleVideo), concurrency: 2 });
  }

  // Rebundle to include the newly generated fixtures in static assets.
  serveUrl = await bundle({ entryPoint, publicDir });
  for (const key of options.formats) {
    const format = DEMO_FORMATS[key];
    const composition = await selectComposition({ serveUrl, id: format.compositionId });
    if (composition.durationInFrames !== DEMO_FRAMES || composition.width !== format.width ||
      composition.height !== format.height || composition.fps !== DEMO_FPS) {
      throw new Error(`Tutorial ${key} metadata does not match the demo contract`);
    }
    for (let index = 0; index < DEMO_CHAPTERS.length; index++) {
      await renderStill({ serveUrl, composition, frame: index * CHAPTER_FRAMES + 170,
        output: resolve(output, `${format.stillPrefix}${index + 1}.png`) });
    }
    console.log(`${key}: ${DEMO_CHAPTERS.length} chapter stills rendered.`);
    if (!options.stillsOnly) {
      let lastPercent = -1;
      await renderMedia({ serveUrl, composition, codec: 'h264', pixelFormat: 'yuv420p',
        outputLocation: resolve(output, format.video), concurrency: 2,
        imageFormat: 'jpeg', jpegQuality: 92,
        onProgress: ({ progress }) => {
          const percent = Math.floor(progress * 10) * 10;
          if (percent !== lastPercent) { console.log(`${key} render: ${percent}%`); lastPercent = percent; }
        },
      });
    }
  }
  console.log(`Demo output: ${output}`);
}

main().then(() => process.exit(0)).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
