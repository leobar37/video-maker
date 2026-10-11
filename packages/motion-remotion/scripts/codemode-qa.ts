#!/usr/bin/env bun
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha256File } from '../../core/src';
import { FileSpendLedger, spendLedgerPath } from '../../cli/src/pipeline/spend-ledger';
import type { NarrationMeta } from '../examples/async-javascript/types';

const root = resolve(import.meta.dir, '../../..');
const project = resolve(root, 'projects/tutorials/pi-codemode-dark');
const output = resolve(root, 'docs/artifacts/pi-codemode-dark');

async function run(args: string[]) {
  const process = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const [buffer, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).arrayBuffer(), new Response(process.stderr).text(), process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${args[0]} failed: ${stderr}`);
  return { buffer, text: new TextDecoder().decode(buffer), stderr };
}

async function main() {
  const narration = JSON.parse(await readFile(resolve(project, 'script/audio/narration.paced.json'), 'utf8')) as NarrationMeta;
  const pace = JSON.parse(await readFile(resolve(project, 'qa/narration.pace.json'), 'utf8'));
  const review = JSON.parse(await readFile(resolve(project, 'review.json'), 'utf8'));
  const script = JSON.parse(await readFile(resolve(project, 'script.json'), 'utf8'));
  if (review.approved !== false || review.publishingAllowed !== false || script.publishingAllowed !== false) throw new Error('Review-only publication guard changed.');
  if (pace.actualWpm < 170 || pace.actualWpm > 200 || pace.pitchPreserved !== true) throw new Error('Voice does not meet the faster natural-pace target.');
  if (Math.abs(Number(pace.metrics.output_i) + 16) > 1 || Number(pace.metrics.output_tp) > -1.3) throw new Error('Narration loudness/true peak outside expected range.');
  const master = resolve(project, 'public/narration.wav');
  if (await sha256File(master) !== narration.wavSha256) throw new Error('Continuous audio master changed.');
  for (const [index, scene] of narration.scenes.entries()) {
    if (scene.durationSeconds <= 0 || (index === 0 ? scene.startSeconds !== 0 : Math.abs(scene.startSeconds - narration.scenes[index - 1]!.endSeconds) > 0.001)) throw new Error('Scene boundaries overlap or have a gap.');
  }
  const ledger = await new FileSpendLedger(spendLedgerPath(project)).list();
  const reserve = ledger.reduce((sum, entry) => sum + entry.reservedUsd, 0);
  if (reserve > 1 || ledger.length !== 2 || ledger.some(entry => entry.state !== 'completed')) throw new Error('Budget or completed-request guard failed.');
  const file = resolve(output, 'pi-codemode-vertical.mp4');
  const probe = JSON.parse((await run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file])).text);
  const video = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video');
  const audio = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === 'audio');
  const expectedFrames = Math.ceil(narration.durationSeconds * 30) + 24;
  if (!video || !audio || video.width !== 1080 || video.height !== 1920 || video.r_frame_rate !== '30/1' || video.codec_name !== 'h264' || audio.codec_name !== 'aac') throw new Error('Invalid video format.');
  if (Number(video.nb_frames) !== expectedFrames || Number(probe.format.duration) > 120 || Number(audio.duration) < narration.durationSeconds) throw new Error('Duration/frame count/voice completeness failure.');
  const decode = await run(['ffmpeg', '-v', 'error', '-i', file, '-f', 'null', '-']);
  if (decode.stderr.trim()) throw new Error(`Decode errors: ${decode.stderr}`);
  const masterPcm = new Int16Array((await run(['ffmpeg', '-v', 'error', '-i', master, '-ac', '1', '-ar', '12000', '-f', 's16le', 'pipe:1'])).buffer);
  const videoPcm = new Int16Array((await run(['ffmpeg', '-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '12000', '-f', 's16le', 'pipe:1'])).buffer);
  const checkpoints = [...narration.scenes.map(scene => scene.startSeconds), narration.durationSeconds - 2];
  const correlations = checkpoints.map(seconds => {
    const start = Math.max(0, Math.floor(seconds * 12000));
    const end = Math.min(masterPcm.length, videoPcm.length, start + 24000);
    let product = 0;
    let masterEnergy = 0;
    let videoEnergy = 0;
    for (let i = start; i < end; i += 12) {
      const a = masterPcm[i]!;
      const b = videoPcm[i]!;
      product += a * b;
      masterEnergy += a * a;
      videoEnergy += b * b;
    }
    return product / Math.sqrt(masterEnergy * videoEnergy);
  });
  if (correlations.some(value => !Number.isFinite(value) || value < 0.95)) throw new Error(`Audio differs from master: ${correlations.join(', ')}`);
  const darkChecks = [];
  for (let i = 1; i <= 9; i++) {
    const still = resolve(output, `scene-${String(i).padStart(2, '0')}.png`);
    const mean = new Uint8Array((await run(['ffmpeg', '-v', 'error', '-i', still,
      '-vf', 'scale=1:1:flags=area,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'])).buffer);
    const luminance = mean[0]! * 0.2126 + mean[1]! * 0.7152 + mean[2]! * 0.0722;
    if (mean.length !== 3 || luminance > 95) throw new Error(`Scene ${i} is not predominantly dark.`);
    darkChecks.push({ scene: i, meanLuminance: luminance });
  }
  const receipt = JSON.parse(await readFile(resolve(project, 'script/audio/narration.receipt.json'), 'utf8'));
  const sampleReceipt = JSON.parse(await readFile(resolve(project, `script/audio/sample-${narration.voice.voiceId}.receipt.json`), 'utf8'));
  const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), passed: true,
    video: { width: 1080, height: 1920, fps: 30, frames: expectedFrames, durationSeconds: Number(probe.format.duration),
      bytes: Number(probe.format.size), sha256: await sha256File(file), fullDecodePassed: true },
    voice: { name: narration.voice.voiceName, model: narration.voice.modelId, gender: 'male',
      wordsPerMinute: pace.actualWpm, tempo: pace.tempo, pitchPreserved: true,
      minimumAudioMasterCorrelation: Math.min(...correlations), checkedBoundaries: checkpoints.length,
      independentAsrOrHumanListening: false },
    darkChecks, reviewOnly: true, publishingAllowed: false,
    spend: { authorizedCapUsd: 1, conservativeReservationUsd: reserve,
      providerCredits: Number(receipt.characterCost) + Number(sampleReceipt.characterCost), requests: ledger.length },
  };
  await writeFile(resolve(project, 'qa/render-validation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().then(() => process.exit(0)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
