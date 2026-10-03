import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { checkPilotClipQa } from '../../packages/cli/src/creator/pilot-qa';
import { examples, frames, recipe } from './fixtures';

// Synthetic geometric stand-ins, not detected human faces. No fonts, plugins,
// downloads, network, model calls, paid render, or publication operations.
const directory = fileURLToPath(new URL('./generated/', import.meta.url));
await mkdir(directory, { recursive: true });
const privateDirectory = join(directory, 'private');
await mkdir(privateDirectory, { recursive: true });
const source = join(privateDirectory, 'source.mp4');
const sample = join(directory, 'sample.mp4');
const filter = "drawbox=x=0:y=0:w=320:h=180:color=black:t=fill:enable='gte(t,2)',drawbox=x=32:y=36:w=64:h=72:color=blue:t=fill,drawbox=x=208:y=36:w=64:h=72:color=orange:t=fill";
const commands = [
  ['ffmpeg', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=10:d=5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-vf', filter, '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', '-shortest', source],
  ['ffmpeg', '-nostdin', '-y', '-i', source, '-t', '4', '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', sample],
  ['ffmpeg', '-nostdin', '-y', '-i', sample, '-frames:v', '1', join(directory, 'still.png')],
];
for (const cmd of commands) {
  const process = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit' });
  const status = await process.exited;
  if (status !== 0) throw new Error(`Local ffmpeg failed (${status}); no remote fallback permitted.`);
}
await writeFile(join(directory, 'evidence.json'), JSON.stringify({ ...recipe, frames, examples }, null, 2));
await writeFile(join(directory, 'qa-results.json'), JSON.stringify(examples.map((example) => ({
  label: example.label, expectedOk: example.expectedOk, ...checkPilotClipQa(example.input),
})), null, 2));
console.log(`Synthetic local sample and evidence written to ${directory}`);
