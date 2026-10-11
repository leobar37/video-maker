#!/usr/bin/env bun
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { sha256File } from '../../core/src';
import type { TutorialVideoProps } from '../examples/async-javascript/Root';
import type { AsyncScript, DemoEvidence, NarrationMeta } from '../examples/async-javascript/types';

const root = resolve(import.meta.dir, '../../..');
const project = resolve(root, 'projects/tutorials/javascript-asincrono');
const output = resolve(root, 'docs/artifacts/javascript-asincrono');
const publicDir = resolve(project, 'public');

async function command(args: string[]) {
  const process = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${args[0]} failed (${exitCode}): ${stderr}`);
  return { stdout, stderr };
}

async function finalizeAudio(file: string, durationSeconds: number) {
  const probe = await command(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=duration', '-of', 'json', file]);
  if (Math.abs(Number(JSON.parse(probe.stdout).streams[0]?.duration) - durationSeconds) > 0.05) {
    throw new Error('Refusing to mux a video with unexpected duration.');
  }
  const temporary = file.replace(/\.mp4$/, '.audio-mux.mp4');
  // Encode the continuous WAV once and retain AAC priming metadata. Remotion's
  // concatenated AAC introduced two packets (42.7ms) of delay in this production.
  await command(['ffmpeg', '-hide_banner', '-y', '-i', file, '-i', resolve(publicDir, 'narration.wav'),
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-ac', '2', '-ar', '48000', '-af', 'apad', '-t', String(durationSeconds),
    '-movflags', '+faststart', temporary]);
  await rename(temporary, file);
}

async function prepareAudio(metadata: NarrationMeta) {
  const source = resolve(project, 'script/audio/narration.wav');
  if (await sha256File(source) !== metadata.wavSha256) throw new Error('Narration hash mismatch.');
  const normalized = resolve(publicDir, 'narration.wav');
  const qaPath = resolve(project, 'qa/audio-normalization.json');
  try {
    const previous = JSON.parse(await readFile(qaPath, 'utf8'));
    if (previous.sourceSha256 === metadata.wavSha256 && previous.outputSha256 === await sha256File(normalized)) return;
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const analysis = await command(['ffmpeg', '-hide_banner', '-i', source, '-af',
    'loudnorm=I=-16:LRA=11:TP=-1.5:print_format=json', '-f', 'null', '-']);
  const metrics = JSON.parse(analysis.stderr.slice(analysis.stderr.lastIndexOf('{')));
  const filter = `loudnorm=I=-16:LRA=11:TP=-1.5:measured_I=${metrics.input_i}:measured_LRA=${metrics.input_lra}:measured_TP=${metrics.input_tp}:measured_thresh=${metrics.input_thresh}:offset=${metrics.target_offset}:linear=true:print_format=json`;
  const normalization = await command(['ffmpeg', '-hide_banner', '-y', '-i', source,
    '-af', filter, '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', normalized]);
  const probe = await command(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', normalized]);
  const duration = Number(JSON.parse(probe.stdout).format.duration);
  if (Math.abs(duration - metadata.durationSeconds) > 0.03) throw new Error('Normalization changed audio duration.');
  await writeFile(qaPath, JSON.stringify({ sourceSha256: metadata.wavSha256,
    outputSha256: await sha256File(normalized), durationSeconds: duration,
    metrics: JSON.parse(normalization.stderr.slice(normalization.stderr.lastIndexOf('{'))),
    method: 'Two-pass loudnorm; no trimming, silence removal or scene cuts.',
  }, null, 2));
}

function captions(metadata: NarrationMeta) {
  const cues: string[] = [];
  let words: NarrationMeta['words'] = [];
  for (let index = 0; index < metadata.words.length; index++) {
    const word = metadata.words[index]!;
    words.push(word);
    const next = metadata.words[index + 1];
    if (words.length >= 7 || !next || next.start - word.end > 0.5 || /[.!?]$/.test(word.word)) {
      const start = new Date(Math.round(Math.max(0, words[0]!.start) * 1000)).toISOString().slice(11, 23);
      const end = new Date(Math.round(Math.min(metadata.durationSeconds, word.end) * 1000)).toISOString().slice(11, 23);
      const text = words.map(item => item.word).join(' ').replaceAll('&', '&amp;').replaceAll('<', '&lt;');
      cues.push(`${start} --> ${end}\n${text}`);
      words = [];
    }
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  const formatIndex = args.indexOf('--format');
  const selectedFormat = formatIndex < 0 ? 'both' : args[formatIndex + 1];
  if (!['both', 'horizontal', 'vertical'].includes(selectedFormat ?? '')) throw new Error('Use --format horizontal|vertical|both.');
  const stillsOnly = args.includes('--stills-only');
  const sampleOnly = args.includes('--sample-only');
  const script = JSON.parse(await readFile(resolve(project, 'script.json'), 'utf8')) as AsyncScript;
  const narration = JSON.parse(await readFile(resolve(project, 'script/audio/narration.json'), 'utf8')) as NarrationMeta;
  const evidence = JSON.parse(await readFile(resolve(project, 'qa/demo-results.json'), 'utf8')) as DemoEvidence;
  if (script.scenes.map(scene => scene.narration.trim()).join('\n\n') !== narration.text) throw new Error('Narration is stale for this script.');
  if (script.scenes.length !== narration.scenes.length) throw new Error('Scene count mismatch.');
  for (const [index, scene] of script.scenes.entries()) {
    const proof = evidence.scenes.find(item => item.id === scene.id);
    const codeHash = createHash('sha256').update(scene.code).digest('hex');
    if (!proof?.passed || proof.codeSha256 !== codeHash) throw new Error(`Unverified or stale demo: ${scene.id}`);
    if (narration.scenes[index]?.sceneId !== scene.id) throw new Error(`Narration order mismatch: ${scene.id}`);
  }
  await mkdir(output, { recursive: true });
  await mkdir(publicDir, { recursive: true });
  await prepareAudio(narration);
  await copyFile(resolve(import.meta.dir, '../examples/async-javascript/preview.html'), resolve(output, 'index.html'));
  await copyFile(resolve(project, `script/audio/sample-${narration.voice.voiceId}.wav`), resolve(output, 'voice-sample.wav'));
  await writeFile(resolve(output, 'captions.vtt'), captions(narration));
  await writeFile(resolve(output, 'script.json'), JSON.stringify(script, null, 2));
  await writeFile(resolve(output, 'demo-results.json'), JSON.stringify(evidence, null, 2));
  const inputProps: TutorialVideoProps = { script, narration, evidence };
  await writeFile(resolve(output, 'render-props.json'), JSON.stringify(inputProps));
  const manifest = { title: script.title, voice: narration.voice, durationSeconds: narration.durationSeconds,
    fps: 30, chapters: narration.scenes.map((timing, index) => ({ ...timing, title: script.scenes[index]!.title })),
    formats: { horizontal: { width: 1920, height: 1080, video: 'javascript-asincrono-horizontal.mp4' },
      vertical: { width: 1080, height: 1920, video: 'javascript-asincrono-vertical.mp4' } },
    evidence: { runtime: evidence.runtime, nodeVersion: evidence.nodeVersion, verifiedAt: evidence.verifiedAt },
  };
  await writeFile(resolve(output, 'video.json'), JSON.stringify(manifest, null, 2));
  if (args.includes('--prepare-only')) {
    console.log(`Audio normalized; captions and preview prepared: ${output}`);
    return;
  }
  const formats = selectedFormat === 'both' ? ['horizontal', 'vertical'] as const : [selectedFormat as 'horizontal' | 'vertical'];
  if (args.includes('--audio-only')) {
    for (const format of formats) {
      await finalizeAudio(resolve(output, manifest.formats[format].video), (Math.ceil(narration.durationSeconds * 30) + 30) / 30);
      console.log(`${format}: audio mux aligned to continuous master; video stream unchanged.`);
    }
    return;
  }
  const serveUrl = await bundle({ entryPoint: resolve(import.meta.dir, '../examples/async-javascript/index.ts'), publicDir });
  for (const format of formats) {
    const composition = await selectComposition({ serveUrl, id: format === 'horizontal' ? 'AsyncJavascriptHorizontal' : 'AsyncJavascriptVertical', inputProps });
    if (composition.fps !== 30 || composition.durationInFrames < Math.ceil(narration.durationSeconds * 30)) throw new Error('Composition truncates narration.');
    for (const [index, timing] of narration.scenes.entries()) {
      const frame = Math.round((timing.startSeconds + timing.durationSeconds * 0.68) * 30);
      await renderStill({ serveUrl, composition, inputProps, frame,
        output: resolve(output, `${format}-${String(index + 1).padStart(2, '0')}.png`) });
    }
    console.log(`${format}: ${narration.scenes.length} chapter stills ready.`);
    if (stillsOnly) continue;
    let lastPercent = -1;
    await renderMedia({ serveUrl, composition, inputProps, codec: 'h264', pixelFormat: 'yuv420p',
      audioCodec: 'aac', audioBitrate: '192k', crf: 18, concurrency: 3, imageFormat: 'jpeg', jpegQuality: 92,
      ...(sampleOnly ? { frameRange: [0, 30 * 15 - 1] as [number, number] } : {}),
      outputLocation: resolve(output, sampleOnly ? `sample-${format}.mp4` : manifest.formats[format].video),
      onProgress: ({ progress }) => {
        const percent = Math.floor(progress * 10) * 10;
        if (percent !== lastPercent) { console.log(`${format}: ${percent}%`); lastPercent = percent; }
      },
    });
    await finalizeAudio(resolve(output, sampleOnly ? `sample-${format}.mp4` : manifest.formats[format].video),
      sampleOnly ? 15 : composition.durationInFrames / composition.fps);
  }
  console.log(`Output: ${output}`);
}

main().then(() => process.exit(0)).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
