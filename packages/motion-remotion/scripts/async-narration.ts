#!/usr/bin/env bun
import { mkdir, open, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha256File, sha256Json, paidPlanDigest } from '../../core/src';
import { defaultMediaDeps } from '../../cli/src/pipeline/deps';
import { deriveSceneTimings, joinSceneNarration, parseCharacterAlignment } from '../../cli/src/pipeline/narration';
import { FileSpendLedger, buildPaidPlan, completePaidAttempt, spendLedgerPath, submitPaidOnce } from '../../cli/src/pipeline/spend-ledger';
import { deriveWordTimestamps } from '../../providers/src/media/elevenlabs-tts';
import type { NarrationMeta, VoiceChoice } from '../examples/async-javascript/types';

const root = resolve(import.meta.dir, '../../..');

async function main() {
  const args = process.argv.slice(2);
  const projectIndex = args.indexOf('--project');
  if (projectIndex >= 0 && !args[projectIndex + 1]) throw new Error('--project requires a directory.');
  const project = resolve(root, projectIndex >= 0 ? args[projectIndex + 1]! : 'projects/tutorials/javascript-asincrono');
  const mode = args.includes('--full') ? 'full' : 'sample';
  const submit = args.includes('--submit');
  const capIndex = args.indexOf('--spend-cap');
  const spendCapUsd = capIndex >= 0 ? Number(args[capIndex + 1]) : 0;
  if (submit && (!Number.isFinite(spendCapUsd) || spendCapUsd <= 0)) throw new Error('An explicit --spend-cap is required for synthesis.');
  const script = JSON.parse(await readFile(resolve(project, 'script.json'), 'utf8')) as { scenes: Array<{ id: string; narration: string }> };
  const voice = JSON.parse(await readFile(resolve(project, 'voice.json'), 'utf8')) as VoiceChoice;
  if (voice.modelId !== 'eleven_v4') throw new Error('This production explicitly requires eleven_v4; no model substitution.');
  const selected = mode === 'full' ? script.scenes : script.scenes.slice(0, 1);
  const joined = joinSceneNarration(selected);
  const estimatedCostUsd = Math.ceil(Array.from(joined.text).length * 0.3 / 1000 * 10000) / 10000;
  const fingerprint = sha256Json({ voice, text: joined.text, outputFormat: 'mp3_44100_128' });
  const name = mode === 'full' ? 'narration' : `sample-${voice.voiceId}`;
  const audioDir = resolve(project, 'script/audio');
  const wav = resolve(audioDir, `${name}.wav`);
  const metadataPath = resolve(audioDir, `${name}.json`);
  try {
    const existing = JSON.parse(await readFile(metadataPath, 'utf8')) as NarrationMeta;
    if (existing.requestFingerprint === fingerprint && existing.wavSha256 === await sha256File(wav)) {
      console.log(`Reusing verified ${mode}; no TTS request. ${wav}`);
      return;
    }
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  console.log(JSON.stringify({ mode, model: voice.modelId, voice: voice.voiceName, characters: joined.text.length,
    estimatedReservationUsd: estimatedCostUsd, spendCapUsd, submit }, null, 2));
  if (!submit) return;
  await mkdir(audioDir, { recursive: true });
  await mkdir(resolve(project, 'qa'), { recursive: true });
  const lockPath = resolve(project, 'qa/voice-generation.lock');
  const lock = await open(lockPath, 'wx');
  try {
    const store = new FileSpendLedger(spendLedgerPath(project));
    const attempts = await store.list();
    if (attempts.some(attempt => attempt.state === 'uncertain' || attempt.state === 'submitted')) {
      throw new Error('An unresolved paid attempt exists. Reconcile with provider evidence before continuing.');
    }
    const reserved = attempts.reduce((sum, attempt) => sum + attempt.reservedUsd, 0);
    if (reserved + estimatedCostUsd > spendCapUsd) throw new Error(`Total reserve ${reserved + estimatedCostUsd} exceeds authorized cap ${spendCapUsd}.`);
    const responsePath = resolve(audioDir, `${name}.response.json`);
    const deps = defaultMediaDeps({
      fetchImpl: Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const response = await fetch(input, { ...init, signal: AbortSignal.timeout(180_000) });
        if (init?.method === 'POST' && String(input).includes('api.elevenlabs.io/v1/text-to-speech/')) {
          // Persist paid output BEFORE parsing/alignment/transcode so a recoverable local failure never needs another POST.
          await writeFile(responsePath, await response.clone().text());
          await writeFile(resolve(audioDir, `${name}.receipt.json`), JSON.stringify({
            status: response.status, requestId: response.headers.get('request-id'),
            characterCost: response.headers.get('character-cost'), receivedAt: new Date().toISOString(),
          }, null, 2));
        }
        return response;
      }, { preconnect: fetch.preconnect }),
    });
    const params = { ...voice, text: joined.text, outputPath: wav, transcode: true, estimatedCostUsd };
    const plan = buildPaidPlan({ command: 'async-tutorial-voice', subject: fingerprint,
      inputs: { fingerprint }, outputs: [wav, metadataPath], estimatedCostUsd, spendCapUsd, maxAttempts: 1 });
    const provider = deps.ttsProvider();
    const submitted = await submitPaidOnce({ store, plan, attemptId: `async-voice-${fingerprint.slice(0, 24)}`,
      submit: () => provider.submit({ kind: 'tts', params, planDigest: paidPlanDigest(plan),
        idempotencyKey: `async-voice:${fingerprint}` }, deps.providerContext()),
    });
    const artifact = await provider.result(submitted.receipt, deps.providerContext());
    const alignment = parseCharacterAlignment(artifact.extra?.alignment);
    const probe = await deps.probeMedia(wav);
    const metadata: NarrationMeta = {
      schemaVersion: 1, requestFingerprint: fingerprint, voice, text: joined.text,
      durationSeconds: probe.durationSeconds, wavSha256: await sha256File(wav),
      scenes: deriveSceneTimings(joined.ranges, alignment, probe.durationSeconds),
      words: deriveWordTimestamps(alignment).map(word => ({ word: word.word, start: word.startSeconds, end: word.endSeconds })),
    };
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n');
    await completePaidAttempt(store, submitted.record.attemptId);
    console.log(`Generated ${mode}: ${probe.durationSeconds.toFixed(2)} seconds; cumulative reserve $${(reserved + estimatedCostUsd).toFixed(4)}.`);
    console.log(wav);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

main().then(() => process.exit(0)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
