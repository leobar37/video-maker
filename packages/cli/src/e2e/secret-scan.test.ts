/**
 * NFR-001 secret self-check: the detector catches plausible secret
 * assignments (including the `*_API_KEY=` names the bare phase pattern
 * misses), passes on clean artifacts, and NEVER emits the matched value.
 */
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatSecretFindings,
  isScannableTextPath,
  scanProjectSecrets,
  scanTextForSecrets,
} from './secret-scan';

const CLEAN_ARTIFACT = JSON.stringify(
  {
    provider: 'elevenlabs',
    voiceName: 'Rachel',
    text: 'La narración continua suena una sola vez.',
    detail: 'no secrets found in scanned artifacts',
  },
  null,
  2,
);

describe('scanTextForSecrets', () => {
  test('passes on clean output', () => {
    expect(scanTextForSecrets(CLEAN_ARTIFACT)).toEqual([]);
  });

  test('catches an injected fake secret without retaining its value', () => {
    const findings = scanTextForSecrets('ok line\nFAL_KEY=deadbeefcafe1234\nend');
    expect(findings.length).toBe(1);
    expect(findings[0]?.line).toBe(2);
    expect(findings[0]?.key).toBe('FAL_KEY');
    expect(findings[0]?.redacted).toBe('FAL_KEY=<redacted>');
    // The value must never leave the matcher.
    expect(JSON.stringify(findings)).not.toContain('deadbeefcafe1234');
  });

  test('catches the API-key names and mixed case/spacing', () => {
    const findings = scanTextForSecrets(
      ['ELEVENLABS_API_KEY=sk-live-1', 'ZERNIO_API_KEY: tok-2', 'api_secret = value-3', 'Secret:shh'].join(
        '\n',
      ),
    );
    expect(findings.map((finding) => finding.key)).toEqual([
      'ELEVENLABS_API_KEY',
      'ZERNIO_API_KEY',
      'API_SECRET',
      'SECRET',
    ]);
  });
});

describe('isScannableTextPath', () => {
  test('scans text artifacts and skips binary media', () => {
    expect(isScannableTextPath('qa/spend.json')).toBe(true);
    expect(isScannableTextPath('script/audio/narration.json')).toBe(true);
    expect(isScannableTextPath('README')).toBe(true);
    expect(isScannableTextPath('qa/stills/sample.png')).toBe(false);
    expect(isScannableTextPath('renders/hello.mp4')).toBe(false);
  });
});

describe('scanProjectSecrets', () => {
  test('flags a planted secret in qa/ and stays clean after removal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-e2e-scan-'));
    await mkdir(join(dir, 'qa', 'stills'), { recursive: true });
    await writeFile(join(dir, 'video.json'), CLEAN_ARTIFACT);
    await writeFile(join(dir, 'qa', 'report.json'), CLEAN_ARTIFACT);
    await writeFile(join(dir, 'qa', 'stills', 'sample.png'), 'FAL_KEY=inside-a-binary.png');

    const clean = await scanProjectSecrets(dir);
    expect(clean.ok).toBe(true);
    expect(clean.files.sort()).toEqual(['qa/report.json', 'video.json']);

    await writeFile(join(dir, 'qa', 'report.json'), `${CLEAN_ARTIFACT}\nzernio=leaked-token\n`);
    const dirty = await scanProjectSecrets(dir);
    expect(dirty.ok).toBe(false);
    expect(dirty.findings.map((finding) => finding.file)).toEqual(['qa/report.json']);
    expect(formatSecretFindings(dirty.findings).join('\n')).not.toContain('leaked-token');
    expect(formatSecretFindings(dirty.findings).join('\n')).toContain('ZERNIO=<redacted>');
  });
});
