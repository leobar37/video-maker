import { afterAll, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  GATE_NAMES,
  PUBLISH_FINAL_STAGE,
  deriveGates,
  type GateName,
  type GateReport,
  type GatesReport,
} from './gates';

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(join(import.meta.dir, '.tmp-'));
  tempDirs.push(dir);
  return dir;
}

type Fixture = Record<string, unknown>;

async function writeFileAt(projectDir: string, relative: string, content: string): Promise<void> {
  const path = join(projectDir, relative);
  await fsp.mkdir(dirname(path), { recursive: true });
  await fsp.writeFile(path, content);
}

async function writeJsonAt(projectDir: string, relative: string, value: unknown): Promise<void> {
  await writeFileAt(projectDir, relative, JSON.stringify(value));
}

function configFixture(overrides: Fixture = {}): Fixture {
  return {
    id: '01-main',
    product: 'acme',
    title: 'Main flow',
    resolution: { width: 1920, height: 1080 },
    fps: 30,
    tts: { provider: 'elevenlabs', voiceId: 'voice-1', modelId: 'm1' },
    branding: { preset: 'acme-dark' },
    scenes: [
      { id: 's1', intent: 'Hook', source: 'demo-app', narration: 'Hello.', status: 'active' },
      { id: 's2', intent: 'Close', source: 'fal-video', narration: 'Bye.', status: 'active' },
    ],
    ...overrides,
  };
}

function journalEntry(overrides: Fixture = {}): Fixture {
  return {
    schemaVersion: 1,
    attemptId: 'att-1',
    planDigest: 'b'.repeat(64),
    command: 'gen-audio',
    subject: 'script/audio/s1.wav',
    state: 'completed',
    reservedUsd: 1,
    createdAt: '2026-09-24T12:00:00.000Z',
    receipt: { requestId: 'req-1' },
    ...overrides,
  };
}

function gateNamed(report: GatesReport, gate: GateName): GateReport {
  const found = report.gates.find((entry) => entry.gate === gate);
  if (!found) throw new Error(`missing gate ${gate}`);
  return found;
}

async function makeCompleteProject(): Promise<string> {
  const dir = await makeTempDir();
  await writeJsonAt(dir, 'video.json', configFixture());
  await writeFileAt(dir, 'scenes/s1/capture.mp4', 'capture');
  await writeFileAt(dir, 'scenes/s2/generated.mp4', 'generated');
  await writeFileAt(dir, 'script/audio/s1.wav', 'audio');
  await writeFileAt(dir, 'script/audio/s2.wav', 'audio');
  await writeJsonAt(dir, 'qa/spend.json', { schemaVersion: 1, attempts: [journalEntry()] });
  await writeFileAt(dir, 'renders/final.mp4', 'render');
  await writeJsonAt(dir, 'qa/report.json', {
    schemaVersion: 1,
    checks: [
      { code: 'av-sync', status: 'pass' },
      { code: 'branding', status: 'not-applicable' },
    ],
  });
  await writeJsonAt(dir, 'qa/reviews.json', {
    schemaVersion: 2,
    records: {
      'signoff:delivery': { kind: 'signoff', subject: 'delivery', verdict: 'approved' },
    },
  });
  await writeJsonAt(dir, 'qa/publication/pub1/journal.json', {
    schemaVersion: 1,
    stages: ['preflight', PUBLISH_FINAL_STAGE],
  });
  return dir;
}

describe('deriveGates', () => {
  test('reports every gate as pending for an empty project dir', async () => {
    const dir = await makeTempDir();
    const report = await deriveGates(dir);
    expect(report.schemaVersion).toBe(1);
    expect(report.gates.map((entry) => entry.gate)).toEqual([...GATE_NAMES]);
    for (const entry of report.gates) {
      expect(entry.status).toBe('pending');
      expect(entry.detail).toBeString();
    }
  });

  test('reports all gates satisfied for a complete project', async () => {
    const dir = await makeCompleteProject();
    const report = await deriveGates(dir);
    for (const entry of report.gates) {
      expect(entry.status).toBe('satisfied');
      expect(entry.detail).toBeUndefined();
    }
    expect(gateNamed(report, 'storyboard').evidence).toContain('video.json');
    expect(gateNamed(report, 'assets').evidence).toContain('scenes/s1/capture.mp4');
    expect(gateNamed(report, 'render').evidence).toContain('renders/final.mp4');
    expect(gateNamed(report, 'publish').evidence).toContain('qa/publication/pub1/journal.json');
  });

  test('spend stays pending until every attempt is reconciled', async () => {
    const dir = await makeCompleteProject();
    await writeJsonAt(dir, 'qa/spend.json', {
      schemaVersion: 1,
      attempts: [
        journalEntry(),
        journalEntry({ attemptId: 'att-2', state: 'uncertain', receipt: undefined }),
      ],
    });
    const spend = gateNamed(await deriveGates(dir), 'spend');
    expect(spend.status).toBe('pending');
    expect(spend.detail).toContain('att-2');
    expect(spend.evidence).toContain('qa/spend.json');
  });

  test('invalid spend ledger entries make the spend gate pending', async () => {
    const dir = await makeCompleteProject();
    await writeJsonAt(dir, 'qa/spend.json', {
      schemaVersion: 1,
      attempts: [journalEntry({ receipt: undefined })],
    });
    const spend = gateNamed(await deriveGates(dir), 'spend');
    expect(spend.status).toBe('pending');
    expect(spend.detail).toContain('invalid');
  });

  test('render is pending without rendered mp4 files', async () => {
    const dir = await makeCompleteProject();
    await fsp.rm(join(dir, 'renders', 'final.mp4'));
    await writeFileAt(dir, 'renders/cover.png', 'image');
    const render = gateNamed(await deriveGates(dir), 'render');
    expect(render.status).toBe('pending');
  });

  test('qa is pending on blocked, trivial or malformed reports', async () => {
    const dir = await makeCompleteProject();

    await writeJsonAt(dir, 'qa/report.json', {
      schemaVersion: 1,
      checks: [{ code: 'av-sync', status: 'blocked' }],
    });
    expect(gateNamed(await deriveGates(dir), 'qa').detail).toContain('av-sync');

    await writeJsonAt(dir, 'qa/report.json', {
      schemaVersion: 1,
      checks: [{ code: 'av-sync', status: 'not-applicable' }],
    });
    expect(gateNamed(await deriveGates(dir), 'qa').detail).toContain('no passing check');

    await writeJsonAt(dir, 'qa/report.json', { schemaVersion: 1, checks: [] });
    expect(gateNamed(await deriveGates(dir), 'qa').detail).toContain('no checks');
  });

  test('signoff is pending without an approved signoff record', async () => {
    const dir = await makeCompleteProject();

    await writeJsonAt(dir, 'qa/reviews.json', {
      schemaVersion: 2,
      records: { 'signoff:delivery': { kind: 'signoff', subject: 'delivery', verdict: 'rejected' } },
    });
    expect(gateNamed(await deriveGates(dir), 'signoff').status).toBe('pending');

    await writeJsonAt(dir, 'qa/reviews.json', {
      schemaVersion: 2,
      records: { 'asset:s1': { kind: 'asset', subject: 's1', verdict: 'approved' } },
    });
    expect(gateNamed(await deriveGates(dir), 'signoff').status).toBe('pending');
  });

  test('publish is pending until a journal reaches the final stage', async () => {
    const dir = await makeCompleteProject();
    await writeJsonAt(dir, 'qa/publication/pub1/journal.json', {
      schemaVersion: 1,
      stages: ['preflight', 'uploaded'],
    });
    const publish = gateNamed(await deriveGates(dir), 'publish');
    expect(publish.status).toBe('pending');
    expect(publish.detail).toContain(PUBLISH_FINAL_STAGE);

    await writeJsonAt(dir, 'qa/publication/pub2/journal.json', {
      schemaVersion: 1,
      stages: ['preflight', PUBLISH_FINAL_STAGE],
    });
    expect(gateNamed(await deriveGates(dir), 'publish').status).toBe('satisfied');
  });

  test('storyboard is pending on incomplete scene plans', async () => {
    const dir = await makeTempDir();
    await writeJsonAt(dir, 'video.json', configFixture({ scenes: [] }));
    expect(gateNamed(await deriveGates(dir), 'storyboard').detail).toContain('no scenes');

    await writeJsonAt(dir, 'video.json', {
      ...configFixture(),
      scenes: [{ id: 's1', intent: 'Hook', source: 'demo-app', narration: 'Hello.', status: 'pending' }],
    });
    expect(gateNamed(await deriveGates(dir), 'storyboard').detail).toContain('scene "s1" is pending');

    await writeJsonAt(dir, 'video.json', {
      ...configFixture(),
      scenes: [{ id: 's1', intent: 'Hook', source: 'demo-app', narration: 'TODO write it', status: 'active' }],
    });
    expect(gateNamed(await deriveGates(dir), 'storyboard').detail).toContain('TODO');

    await writeJsonAt(dir, 'video.json', {
      ...configFixture(),
      scenes: [{ id: 's1', intent: 'Hook', source: 'demo-app', narration: '', status: 'active' }],
    });
    expect(gateNamed(await deriveGates(dir), 'storyboard').detail).toContain('neither narration');
  });

  test('assets is pending while required artifacts are missing', async () => {
    const dir = await makeCompleteProject();
    await fsp.rm(join(dir, 'scenes', 's1', 'capture.mp4'));
    const assets = gateNamed(await deriveGates(dir), 'assets');
    expect(assets.status).toBe('pending');
    expect(assets.detail).toContain('scenes/s1/capture.mp4');
  });

  test('assets requires avatar inputs and continuous narration', async () => {
    const dir = await makeTempDir();
    await writeJsonAt(dir, 'video.json', {
      ...configFixture({
        tts: { provider: 'elevenlabs', voiceId: 'v', modelId: 'm1', mode: 'continuous' },
        scenes: [
          {
            id: 's1',
            intent: 'Intro',
            source: 'avatar',
            narration: 'Hello.',
            status: 'active',
            avatar: { image: 'assets/host.png', audio: 'script/audio/host.wav' },
          },
        ],
      }),
    });
    const pending = gateNamed(await deriveGates(dir), 'assets');
    expect(pending.status).toBe('pending');
    expect(pending.detail).toContain('script/audio/narration.wav');
    expect(pending.detail).toContain('assets/host.png');

    await writeFileAt(dir, 'script/audio/narration.wav', 'audio');
    await writeFileAt(dir, 'scenes/s1/avatar.mp4', 'take');
    await writeFileAt(dir, 'assets/host.png', 'image');
    await writeFileAt(dir, 'script/audio/host.wav', 'audio');
    expect(gateNamed(await deriveGates(dir), 'assets').status).toBe('satisfied');
  });

  test('unreadable artifacts make their gates pending instead of throwing', async () => {
    const dir = await makeTempDir();
    await writeFileAt(dir, 'video.json', '{ not json');
    await writeFileAt(dir, 'qa/spend.json', '{ not json');
    await writeFileAt(dir, 'qa/report.json', '{ not json');
    await writeFileAt(dir, 'qa/reviews.json', '{ not json');
    await writeJsonAt(dir, 'qa/publication/pub1/journal.json', { schemaVersion: 1, stages: {} });
    const report = await deriveGates(dir);
    for (const entry of report.gates) {
      expect(entry.status).toBe('pending');
      expect(entry.detail).toBeString();
    }
  });
});
