/**
 * Offline mode: the locally synthesized narration master carries gap-free
 * scene timings under the SAME `narration.json` contract as live TTS, and the
 * journal documents the operation as a receipt-proven $0 `offline:` attempt —
 * idempotent on reruns.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256File } from '@videomaker/core';
import { ContinuousNarrationSchema, type ContinuousNarration } from '@videomaker/schemas';

import { makeTestProject } from '../pipeline/test-support';
import { planNarrationTimeline, timelineAlignment } from './offline-audio';
import {
  OFFLINE_PROVIDER_ID,
  findNarrationMaster,
  isOfflineNarrationMeta,
  writeOfflineNarrationMaster,
} from './offline-narration';
import { journalOfflineOperation, readJournalSummary } from './journal';

const SCENES = [
  { id: 'scene-a', narration: 'Primera escena con voz.' },
  { id: 'scene-b', narration: 'Segunda escena encadenada.' },
];

describe('planNarrationTimeline', () => {
  test('assigns monotonic per-character spans and a positive master duration', () => {
    const timeline = planNarrationTimeline('hola\n\nmundo');
    expect(timeline.chars).toEqual(['h', 'o', 'l', 'a', '\n', '\n', 'm', 'u', 'n', 'd', 'o']);
    for (let index = 1; index < timeline.chars.length; index += 1) {
      expect(timeline.startSeconds[index]).toBeCloseTo(timeline.endSeconds[index - 1] as number, 9);
    }
    expect(timeline.masterDurationSeconds).toBeGreaterThan(
      timeline.endSeconds[timeline.endSeconds.length - 1] as number,
    );
    const alignment = timelineAlignment(timeline);
    expect(alignment.characters.length).toBe(alignment.character_start_times_seconds.length);
    expect(alignment.character_end_times_seconds.length).toBe(alignment.characters.length);
  });
});

describe('writeOfflineNarrationMaster', () => {
  test('writes a schema-valid, gap-free master with pinned wav sha256 and replays on rerun', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-e2e-offline-'));
    const { tts } = await makeTestProject(dir);
    const options = {
      projectDir: dir,
      tts,
      scenes: SCENES,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      out: () => {},
    };

    const first = await writeOfflineNarrationMaster(options);
    expect(first.replayed).toBe(false);
    expect(first.narration.provider).toBe(OFFLINE_PROVIDER_ID);
    expect(isOfflineNarrationMeta(first.narration)).toBe(true);

    const meta = ContinuousNarrationSchema.parse(
      JSON.parse(await readFile(join(dir, 'script', 'audio', 'narration.json'), 'utf8')),
    );
    expect(meta.scenes.map((scene) => scene.sceneId)).toEqual(['scene-a', 'scene-b']);
    expect(meta.scenes[0]?.startSeconds).toBe(0);
    expect(meta.scenes[0]?.endSeconds).toBeCloseTo(meta.scenes[1]?.startSeconds as number, 9);
    expect(meta.scenes[1]?.endSeconds).toBeCloseTo(meta.durationSeconds, 9);
    expect(meta.wavSha256).toBe(await sha256File(join(dir, 'script', 'audio', 'narration.wav')));

    const replayed = await writeOfflineNarrationMaster(options);
    expect(replayed.replayed).toBe(true);
    expect(replayed.narration).toEqual(first.narration);
    const located = await findNarrationMaster(dir, meta.fingerprint);
    expect(located?.wavSha256).toBe(meta.wavSha256);
  });

  test('force resynthesizes an existing master', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-e2e-offline-'));
    const { tts } = await makeTestProject(dir);
    const options = {
      projectDir: dir,
      tts,
      scenes: SCENES,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      out: () => {},
    };
    await writeOfflineNarrationMaster(options);
    const forced = await writeOfflineNarrationMaster({ ...options, force: true });
    expect(forced.replayed).toBe(false);
  });
});

describe('journalOfflineOperation', () => {
  test('documents $0 offline receipts and stays idempotent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-e2e-journal-'));
    const now = () => new Date('2026-01-01T00:00:00.000Z');
    const input = {
      command: 'gen-audio',
      subject: 'gen-audio:0123456789abcdef',
      inputs: { fingerprint: '0123456789abcdef' },
      outputs: ['script/audio/narration.wav', 'script/audio/narration.json'],
      now,
    };

    const first = await journalOfflineOperation(dir, input);
    expect(first.state).toBe('completed');
    expect(first.reservedUsd).toBe(0);
    expect(first.attemptId.startsWith('offline:')).toBe(true);

    const summary = await readJournalSummary(dir);
    expect(summary.counts.completed).toBe(1);
    expect(summary.totalReservedUsd).toBe(0);
    expect(summary.entries[0]?.receiptRequestId?.startsWith('offline:')).toBe(true);

    const replay = await journalOfflineOperation(dir, input);
    expect(replay.replayed).toBe(true);
    expect((await readJournalSummary(dir)).entries.length).toBe(1);
  });
});
