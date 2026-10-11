#!/usr/bin/env bun
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { sha256File, sha256Json } from '../../core/src';
import type { NarrationMeta } from '../examples/async-javascript/types';
import type { CodemodeScript, CodemodeVideoProps } from '../examples/pi-codemode/types';

const root = resolve(import.meta.dir, '../../..');
const project = resolve(root, 'projects/tutorials/pi-codemode-dark');
const output = resolve(root, 'docs/artifacts/pi-codemode-dark');
const publicDir = resolve(project, 'public');
const targetWpm = 185;

async function command(args: string[]) {
  const process = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${args[0]} failed (${exitCode}): ${stderr}`);
  return { stdout, stderr };
}

async function paceNarration(sample: boolean): Promise<NarrationMeta> {
  const voice = JSON.parse(await readFile(resolve(project, 'voice.json'), 'utf8'));
  const basename = sample ? `sample-${voice.voiceId}` : 'narration';
  const raw = JSON.parse(await readFile(resolve(project, `script/audio/${basename}.json`), 'utf8')) as NarrationMeta;
  const source = resolve(project, `script/audio/${basename}.wav`);
  if (raw.wavSha256 !== await sha256File(source)) throw new Error('Source narration hash changed.');
  const destination = resolve(publicDir, sample ? 'voice-sample.wav' : 'narration.wav');
  const metadataPath = resolve(project, `script/audio/${basename}.paced.json`);
  const normalizationPath = resolve(project, `qa/${basename}.pace.json`);
  const wordCount = raw.text.trim().split(/\s+/).length;
  const tempo = Math.min(1.28, Math.max(1, raw.durationSeconds / (wordCount * 60 / targetWpm)));
  const fingerprint = sha256Json({ source: raw.wavSha256, tempo, targetWpm, lufs: -16, truePeak: -1.5 });
  try {
    const previous = JSON.parse(await readFile(metadataPath, 'utf8')) as NarrationMeta;
    if (previous.requestFingerprint === fingerprint && previous.wavSha256 === await sha256File(destination)) return previous;
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const analysis = await command(['ffmpeg', '-hide_banner', '-i', source, '-af',
    `atempo=${tempo},loudnorm=I=-16:LRA=9:TP=-1.5:print_format=json`, '-f', 'null', '-']);
  const measured = JSON.parse(analysis.stderr.slice(analysis.stderr.lastIndexOf('{')));
  const filter = `atempo=${tempo},loudnorm=I=-16:LRA=9:TP=-1.5:measured_I=${measured.input_i}:measured_LRA=${measured.input_lra}:measured_TP=${measured.input_tp}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true:print_format=json`;
  const normalized = await command(['ffmpeg', '-hide_banner', '-y', '-i', source, '-af', filter,
    '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', destination]);
  const probe = await command(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', destination]);
  const durationSeconds = Number(JSON.parse(probe.stdout).format.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || (!sample && durationSeconds + 0.8 > 120)) throw new Error('Paced narration would violate the two-minute limit.');
  const paced: NarrationMeta = { ...raw, requestFingerprint: fingerprint,
    durationSeconds, wavSha256: await sha256File(destination),
    scenes: raw.scenes.map((scene, index) => {
      const startSeconds = scene.startSeconds / tempo;
      const endSeconds = index === raw.scenes.length - 1 ? durationSeconds : scene.endSeconds / tempo;
      return { ...scene, startSeconds, endSeconds, durationSeconds: endSeconds - startSeconds };
    }),
    words: raw.words.map(word => ({ word: word.word, start: Math.min(durationSeconds, word.start / tempo),
      end: Math.min(durationSeconds, word.end / tempo) })),
  };
  await writeFile(metadataPath, JSON.stringify(paced, null, 2));
  await writeFile(normalizationPath, JSON.stringify({ sourceSha256: raw.wavSha256, outputSha256: paced.wavSha256,
    sourceDurationSeconds: raw.durationSeconds, durationSeconds, tempo, pitchPreserved: true,
    targetWpm, actualWpm: wordCount * 60 / durationSeconds, wordCount,
    metrics: JSON.parse(normalized.stderr.slice(normalized.stderr.lastIndexOf('{'))),
    method: 'Continuous atempo plus two-pass loudnorm. No voice slicing or silence deletion.',
  }, null, 2));
  console.log(`${sample ? 'Sample' : 'Full voice'}: ${durationSeconds.toFixed(2)}s, ${(wordCount * 60 / durationSeconds).toFixed(1)} wpm, tempo ${tempo.toFixed(3)}, pitch preserved.`);
  return paced;
}

function captions(meta: NarrationMeta) {
  const cues: string[] = [];
  let group: NarrationMeta['words'] = [];
  for (const [index, word] of meta.words.entries()) {
    group.push(word);
    if (group.length >= 5 || /[.!?]$/.test(word.word) || index === meta.words.length - 1) {
      const start = new Date(Math.round(group[0]!.start * 1000)).toISOString().slice(11, 23);
      const end = new Date(Math.round(word.end * 1000)).toISOString().slice(11, 23);
      const text = group.map(item => item.word).join(' ').replaceAll('&', '&amp;').replaceAll('<', '&lt;');
      cues.push(`${start} --> ${end}\n${text}`);
      group = [];
    }
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  await mkdir(publicDir, { recursive: true });
  await mkdir(output, { recursive: true });
  await mkdir(resolve(project, 'qa'), { recursive: true });
  if (args.includes('--voice-sample')) {
    await paceNarration(true);
    await copyFile(resolve(publicDir, 'voice-sample.wav'), resolve(output, 'voice-sample.wav'));
    return;
  }
  const script = JSON.parse(await readFile(resolve(project, 'script.json'), 'utf8')) as CodemodeScript;
  if (script.reviewOnly !== true || script.publishingAllowed !== false) throw new Error('This pipeline is strictly review-only.');
  const narration = await paceNarration(false);
  if (script.scenes.map(scene => scene.narration.trim()).join('\n\n') !== narration.text) throw new Error('Script differs from synthesized narration.');
  if (narration.scenes.length !== script.scenes.length) throw new Error('Narrated scene count mismatch.');
  const inputProps: CodemodeVideoProps = { script, narration };
  await writeFile(resolve(output, 'render-props.json'), JSON.stringify(inputProps));
  await writeFile(resolve(output, 'script.json'), JSON.stringify(script, null, 2));
  await writeFile(resolve(output, 'captions.vtt'), captions(narration));
  await writeFile(resolve(output, 'video.json'), JSON.stringify({ title: script.title,
    durationSeconds: (Math.ceil(narration.durationSeconds * 30) + 24) / 30,
    width: 1080, height: 1920, fps: 30, voice: narration.voice.voiceName, targetWpm,
    reviewOnly: true, publishingAllowed: false, video: 'pi-codemode-vertical.mp4',
    chapters: narration.scenes.map((timing, index) => ({ ...timing, title: script.scenes[index]!.title })),
    sources: script.sources,
  }, null, 2));
  await copyFile(resolve(import.meta.dir, '../examples/pi-codemode/preview.html'), resolve(output, 'index.html'));
  await writeFile(resolve(project, 'review.json'), JSON.stringify({ schemaVersion: 1, approved: false,
    publishingAllowed: false, reason: 'User requires review link and approval before any social publication.' }, null, 2));
  if (args.includes('--prepare-only')) return;
  const serveUrl = await bundle({ entryPoint: resolve(import.meta.dir, '../examples/pi-codemode/index.ts'), publicDir });
  const composition = await selectComposition({ serveUrl, id: 'PiCodemodeVertical', inputProps });
  if (composition.durationInFrames / composition.fps > 120 || composition.width !== 1080 || composition.height !== 1920) throw new Error('Composition violates requested format.');
  for (const [index, scene] of narration.scenes.entries()) {
    await renderStill({ serveUrl, composition, inputProps,
      frame: Math.round((scene.startSeconds + scene.durationSeconds * 0.62) * 30),
      output: resolve(output, `scene-${String(index + 1).padStart(2, '0')}.png`) });
  }
  console.log('9 scene stills ready.');
  if (args.includes('--stills-only')) return;
  const destination = resolve(output, 'pi-codemode-vertical.mp4');
  let lastPercent = -1;
  await renderMedia({ serveUrl, composition, inputProps, codec: 'h264', pixelFormat: 'yuv420p',
    audioCodec: 'aac', audioBitrate: '192k', crf: 18, concurrency: 3, imageFormat: 'jpeg', jpegQuality: 92,
    outputLocation: destination, onProgress: ({ progress }) => {
      const percent = Math.floor(progress * 10) * 10;
      if (percent !== lastPercent) { console.log(`Vertical render: ${percent}%`); lastPercent = percent; }
    },
  });
  // Use the uninterrupted master directly, avoiding the prior render's AAC packet delay.
  const muxed = resolve(output, 'pi-codemode-vertical.mux.mp4');
  await command(['ffmpeg', '-hide_banner', '-y', '-i', destination, '-i', resolve(publicDir, 'narration.wav'),
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
    '-ar', '48000', '-af', 'apad', '-t', String(composition.durationInFrames / composition.fps),
    '-movflags', '+faststart', muxed]);
  await rename(muxed, destination);
  console.log(`Review-only video ready: ${destination}`);
}

main().then(() => process.exit(0)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
