#!/usr/bin/env bun
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha256File } from '../../core/src';
import { FileSpendLedger, spendLedgerPath } from '../../cli/src/pipeline/spend-ledger';
import type { DemoEvidence, NarrationMeta } from '../examples/async-javascript/types';

const root = resolve(import.meta.dir, '../../..');
const project = resolve(root, 'projects/tutorials/javascript-asincrono');
const output = resolve(root, 'docs/artifacts/javascript-asincrono');

async function run(args: string[]) {
  const process = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${args[0]} exited ${exitCode}: ${stderr}`);
  return { stdout, stderr };
}

async function decodeMono(file: string) {
  const process = Bun.spawn(['ffmpeg', '-v', 'error', '-i', file, '-map', '0:a:0',
    '-ac', '1', '-ar', '12000', '-f', 's16le', 'pipe:1'], { stdout: 'pipe', stderr: 'pipe' });
  const [buffer, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).arrayBuffer(), new Response(process.stderr).text(), process.exited,
  ]);
  if (exitCode !== 0 || stderr.trim()) throw new Error(`Audio decoding failed: ${stderr}`);
  return new Int16Array(buffer);
}

async function main() {
  const narration = JSON.parse(await readFile(resolve(project, 'script/audio/narration.json'), 'utf8')) as NarrationMeta;
  const evidence = JSON.parse(await readFile(resolve(project, 'qa/demo-results.json'), 'utf8')) as DemoEvidence;
  const normalization = JSON.parse(await readFile(resolve(project, 'qa/audio-normalization.json'), 'utf8'));
  const ledger = await new FileSpendLedger(spendLedgerPath(project)).list();
  const reservedUsd = ledger.reduce((sum, record) => sum + record.reservedUsd, 0);
  if (ledger.length !== 2 || ledger.some(record => record.state !== 'completed') || reservedUsd > 3) {
    throw new Error('Paid-operation ledger is unresolved or outside the approved two-request budget.');
  }
  if (narration.voice.modelId !== 'eleven_v4' || narration.scenes.length !== 14) throw new Error('Production model/scene contract changed.');
  if (evidence.scenes.length !== 14 || evidence.scenes.some(scene => !scene.passed)) throw new Error('Demo verification failed.');
  if (await sha256File(resolve(project, 'public/narration.wav')) !== normalization.outputSha256) throw new Error('Normalized master hash changed.');
  const masterPcm = await decodeMono(resolve(project, 'public/narration.wav'));
  const videoChecks = [];
  for (const format of ['horizontal', 'vertical'] as const) {
    const file = resolve(output, `javascript-asincrono-${format}.mp4`);
    const { stdout } = await run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
    const probe = JSON.parse(stdout);
    const video = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === 'video');
    const audio = probe.streams.find((stream: { codec_type: string }) => stream.codec_type === 'audio');
    const width = format === 'horizontal' ? 1920 : 1080;
    const height = format === 'horizontal' ? 1080 : 1920;
    const expectedFrames = Math.ceil(narration.durationSeconds * 30) + 30;
    if (!video || !audio || video.codec_name !== 'h264' || audio.codec_name !== 'aac') throw new Error(`${format}: missing H.264/AAC streams.`);
    // FFprobe labels full-range 4:2:0 H.264 as yuvj420p; both are browser-compatible 8-bit 4:2:0.
    if (video.width !== width || video.height !== height || !['yuv420p', 'yuvj420p'].includes(video.pix_fmt)) throw new Error(`${format}: invalid pixel format/resolution.`);
    if (video.r_frame_rate !== '30/1' || Number(video.nb_frames) !== expectedFrames) throw new Error(`${format}: frame count/fps mismatch.`);
    if (Math.abs(Number(video.duration) - expectedFrames / 30) > 1 / 30) throw new Error(`${format}: video duration mismatch.`);
    // AAC muxing may retain up to three encoder packets beyond the last video frame.
    const muxTolerance = Math.max(0.05, 3 * 1024 / Number(audio.sample_rate));
    if (!Number.isFinite(muxTolerance) || Math.abs(Number(probe.format.duration) - expectedFrames / 30) > muxTolerance) throw new Error(`${format}: container duration mismatch.`);
    if (Number(audio.duration) < narration.durationSeconds - 0.03) throw new Error(`${format}: audio stream is truncated.`);
    const decoded = await run(['ffmpeg', '-v', 'error', '-i', file, '-f', 'null', '-']);
    if (decoded.stderr.trim()) throw new Error(`${format}: decode errors: ${decoded.stderr}`);
    const renderedPcm = await decodeMono(file);
    const checkpoints = [...narration.scenes.map(scene => scene.startSeconds), narration.durationSeconds - 2];
    const correlations = checkpoints.map(seconds => {
      const start = Math.max(0, Math.floor(seconds * 12000));
      const end = Math.min(masterPcm.length, renderedPcm.length, start + 24000);
      let product = 0;
      let masterEnergy = 0;
      let renderedEnergy = 0;
      for (let sample = start; sample < end; sample += 12) {
        const master = masterPcm[sample]!;
        const rendered = renderedPcm[sample]!;
        product += master * rendered;
        masterEnergy += master * master;
        renderedEnergy += rendered * rendered;
      }
      return product / Math.sqrt(masterEnergy * renderedEnergy);
    });
    if (correlations.some(value => !Number.isFinite(value) || value < 0.9)) {
      throw new Error(`${format}: narration diverges from the continuous master at a scene boundary: ${correlations.join(', ')}`);
    }
    videoChecks.push({ format, width, height, fps: 30, frames: expectedFrames,
      durationSeconds: Number(probe.format.duration), audioDurationSeconds: Number(audio.duration),
      videoCodec: video.codec_name, audioCodec: audio.codec_name, bytes: Number(probe.format.size),
      pixelFormat: video.pix_fmt, colorRange: video.color_range,
      sha256: await sha256File(file), fullDecodePassed: true,
      audioMasterCorrelationMinimum: Math.min(...correlations), audioCheckpoints: checkpoints.length,
    });
    console.log(`${format}: H.264/AAC, ${width}x${height}, ${expectedFrames} frames, full decode passed.`);
  }
  const sampleReceipt = JSON.parse(await readFile(resolve(project, `script/audio/sample-${narration.voice.voiceId}.receipt.json`), 'utf8'));
  const fullReceipt = JSON.parse(await readFile(resolve(project, 'script/audio/narration.receipt.json'), 'utf8'));
  const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), passed: true,
    model: narration.voice.modelId, voice: narration.voice.voiceName, videos: videoChecks,
    audio: { normalization: normalization.metrics, sourceDurationSeconds: narration.durationSeconds,
      noSceneCuts: true, independentTranscriptionOrHumanListening: false },
    demos: { executed: evidence.scenes.filter(scene => scene.kind === 'executed').length,
      conceptual: evidence.scenes.filter(scene => scene.kind === 'conceptual').length, allPassed: true },
    spend: { authorizedCapUsd: 3, conservativeReservedUsd: reservedUsd,
      providerCredits: Number(sampleReceipt.characterCost) + Number(fullReceipt.characterCost),
      requests: ledger.length, allCompleted: true, dollarAmountIsReservationNotInvoice: true },
  };
  await writeFile(resolve(project, 'qa/render-validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`QA complete; ${report.spend.providerCredits} credits, reserve $${reservedUsd.toFixed(4)}.`);
}

main().then(() => process.exit(0)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
