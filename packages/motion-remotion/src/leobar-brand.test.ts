import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { brandPresets, leobarTokens, leoTokens, resolveBrandTokens } from './brand';

const preset = JSON.parse(readFileSync(new URL('../../../presets/leobar.json', import.meta.url), 'utf8'));

describe('leobar visual preset', () => {
  test('registers leobar independently without replacing conceptual leo', () => {
    expect(resolveBrandTokens('leobar')).toBe(leobarTokens);
    expect(resolveBrandTokens('leo')).toBe(leoTokens);
    expect(brandPresets.leobar).not.toBe(brandPresets.leo);
    expect(leobarTokens.publicationProfile).toBe(preset.publishing.profile.name);
  });

  test('keeps palette, fonts and captions aligned with the canonical workflow', () => {
    expect(leobarTokens.canvas.from).toBe(preset.identity.palette[0]);
    expect(leobarTokens.canvas.to).toBe(preset.identity.palette[0]);
    expect(leobarTokens.brandGradient.to).toBe(preset.identity.palette[1]);
    expect(leobarTokens.accent).toBe(preset.identity.palette[2]);
    expect(leobarTokens.ink).toBe(preset.identity.palette[3]);
    expect(leobarTokens.accent).toBe(preset.editing.captions.accentColor);
    expect(leobarTokens.ink).toBe(preset.editing.captions.textColor);
    expect(leobarTokens.fontDisplay).toBe(preset.identity.fonts.join(', '));
    expect(leobarTokens.fontBody).toBe(leobarTokens.fontDisplay);
  });
});
