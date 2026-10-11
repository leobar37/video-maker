import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CHAPTER_FRAMES, DEMO_CHAPTERS, DEMO_FORMATS, DEMO_FPS, DEMO_FRAMES } from '../examples/opencode/config';

export async function writeTutorialCatalog(root: string, output: string): Promise<void> {
  await mkdir(output, { recursive: true });
  const example = resolve(root, 'packages/motion-remotion/examples/opencode');
  await Promise.all([
    copyFile(resolve(example, 'preview.html'), resolve(output, 'index.html')),
    copyFile(resolve(example, 'atlas.html'), resolve(output, 'atlas.html')),
    copyFile(resolve(root, 'packages/motion-remotion/src/tutorial/atlas.json'), resolve(output, 'atlas.json')),
    copyFile(resolve(root, 'docs/tutorial-demos.md'), resolve(output, 'guide.md')),
    writeFile(resolve(output, 'demo.json'), JSON.stringify({
      schemaVersion: 1,
      fps: DEMO_FPS,
      durationInFrames: DEMO_FRAMES,
      chapterFrames: CHAPTER_FRAMES,
      chapters: DEMO_CHAPTERS,
      formats: DEMO_FORMATS,
    }, null, 2) + '\n'),
  ]);
}
