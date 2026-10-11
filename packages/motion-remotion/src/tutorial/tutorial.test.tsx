import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodePanel } from './panels';
import { terminalRows, type TerminalEntry } from './terminal-model';
import * as kit from '../index';
import atlas from './atlas.json';
import { CHAPTER_FRAMES, DEMO_CHAPTERS, DEMO_FORMATS, DEMO_FRAMES, parseDemoArgs } from '../../examples/opencode/config';
import { writeTutorialCatalog } from '../../scripts/tutorial-catalog';

const entries: TerminalEntry[] = [
  { text: 'opencode', at: 10, duration: 8, kind: 'command' },
  { text: 'ready\nproject loaded', at: 22, kind: 'success' },
];

describe('tutorial terminal frame sampling', () => {
  test('reveals text at exact frame boundaries and stops the command caret on output', () => {
    expect(terminalRows(entries, 9)).toEqual([]);
    expect(terminalRows(entries, 10)[0]?.text).toBe('');
    expect(terminalRows(entries, 14)[0]?.text).toBe('open');
    expect(terminalRows(entries, 18)[0]?.text).toBe('opencode');
    expect(terminalRows(entries, 22).every((row) => !row.active)).toBe(true);
  });
  test('scrolls multiline output and is independent of playback order', () => {
    const before = terminalRows(entries, 14);
    expect(terminalRows(entries, 100, 2).map((row) => row.text)).toEqual(['ready', 'project loaded']);
    expect(terminalRows(entries, 14)).toEqual(before);
  });
  test('sorts events, supports instant output, and keeps unicode codepoints intact', () => {
    expect(terminalRows([
      { text: 'later', at: 20, kind: 'output' },
      { text: '好a', at: 0, duration: 2, kind: 'command' },
    ], 1)[0]?.text).toBe('好');
    expect(terminalRows(entries, 22, 1)[0]?.text).toBe('project loaded');
    expect(() => terminalRows(entries, 0, 0)).toThrow('positive integer');
  });
});

test('code panel renders escaped tokens, line offsets, highlights and diff markers', () => {
  const html = renderToStaticMarkup(<CodePanel filename="sample.ts" firstLine={10} highlightLines={[10]}
    lines={[{ change: 'added', tokens: [{ text: '<script>', kind: 'string' }] }]} />);
  expect(html).toContain('sample.ts');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).toContain('>10</span>');
  expect(html).toContain('>+</span>');
  expect(html).toContain('4px solid #D6EF96');
});

const repoRoot = resolve(import.meta.dir, '../../../..');

test('atlas entries point to public components, real source files and valid chapters', () => {
  const ids: string[] = [];
  for (const component of atlas.components) {
    expect(ids).not.toContain(component.id);
    ids.push(component.id);
    expect(typeof kit[component.id as keyof typeof kit]).toBe('function');
    expect(existsSync(resolve(repoRoot, component.source))).toBe(true);
    expect(component.chapter).toBeGreaterThanOrEqual(1);
    expect(component.chapter).toBeLessThanOrEqual(DEMO_CHAPTERS.length);
    expect(component.example).toContain(`<${component.id}`);
    expect(Object.keys(component.props).length).toBeGreaterThan(0);
  }
  for (const component of atlas.relatedComponents) {
    expect(existsSync(resolve(repoRoot, component.source))).toBe(true);
  }
});

test('guide source links resolve and both demo formats share the chapter timing', () => {
  const guide = readFileSync(resolve(repoRoot, atlas.guide), 'utf8');
  for (const match of guide.matchAll(/\]\((\.\.?\/[^)]+)\)/g)) {
    expect(existsSync(resolve(repoRoot, 'docs', match[1]))).toBe(true);
  }
  expect(DEMO_FORMATS.horizontal.width / DEMO_FORMATS.horizontal.height).toBe(16 / 9);
  expect(DEMO_FORMATS.vertical.width / DEMO_FORMATS.vertical.height).toBe(9 / 16);
  expect(DEMO_FRAMES).toBe(CHAPTER_FRAMES * DEMO_CHAPTERS.length);
  expect(DEMO_FORMATS.vertical.video).not.toBe(DEMO_FORMATS.horizontal.video);
});

test('render options default to both formats and reject invalid requests before rendering', () => {
  expect(parseDemoArgs([]).formats).toEqual(['horizontal', 'vertical']);
  expect(parseDemoArgs(['--format', 'vertical', '--stills'])).toEqual({
    formats: ['vertical'], stillsOnly: true, catalogOnly: false,
  });
  expect(parseDemoArgs(['--catalog-only']).catalogOnly).toBe(true);
  expect(() => parseDemoArgs(['--format', 'square'])).toThrow('--format');
  expect(() => parseDemoArgs(['--format'])).toThrow('--format');
  expect(() => parseDemoArgs(['--unknown'])).toThrow('Unknown');
});

test('catalog generation copies canonical sources and publishes matching format metadata', async () => {
  const output = mkdtempSync(resolve(tmpdir(), 'tutorial-catalog-'));
  try {
    await writeTutorialCatalog(repoRoot, output);
    const manifest = JSON.parse(readFileSync(resolve(output, 'demo.json'), 'utf8'));
    expect(manifest.formats).toEqual(DEMO_FORMATS);
    expect(manifest.chapters).toEqual(DEMO_CHAPTERS);
    expect(JSON.parse(readFileSync(resolve(output, 'atlas.json'), 'utf8'))).toEqual(atlas);
    expect(readFileSync(resolve(output, 'guide.md'), 'utf8')).toBe(readFileSync(resolve(repoRoot, atlas.guide), 'utf8'));
    expect(readFileSync(resolve(output, 'atlas.html'), 'utf8')).toContain("fetch('atlas.json')");
    expect(readFileSync(resolve(output, 'index.html'), 'utf8')).toContain('data-format=\"vertical\"');
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
