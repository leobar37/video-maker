/**
 * Vertical cover pipeline (port of the elena `social-cover` idea, scoped to
 * video-maker): `social-cover.json` → 1080×1920 HTML → Chromium PNG →
 * center-crop previews. Carousel validation (1080×1350 PNG pages) lives here
 * too because it shares the dimension probe.
 *
 * No network, no secrets: rendering is local Chromium, crops are Sharp.
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { chromium } from 'playwright-core';
import sharp from 'sharp';

import { resolveChromiumExe } from './ig';

export const COVER_WIDTH = 1080;
export const COVER_HEIGHT = 1920;

/** Instagram-safe insets on the 1080×1920 canvas (profile grid + UI chrome). */
export const COVER_SAFE_ZONE = { top: 250, left: 96, right: 96, bottom: 320 } as const;

export const COVER_PNG_REL = join('covers', 'cover.png');
export const PREVIEW_3X4_REL = join('covers', 'social', 'preview-3x4.png');
export const PREVIEW_SQUARE_REL = join('covers', 'social', 'preview-square.png');

export const CAROUSEL_WIDTH = 1080;
export const CAROUSEL_HEIGHT = 1350;

export interface SocialCoverJson {
  slug: string;
  hook: string;
  support: string;
  cta: string;
  palette: { bg: string; ink: string; accent: string };
  backgroundImage?: string;
}

export interface CoverIssue {
  path: string;
  message: string;
}

/** Reads and shape-checks `<project>/social-cover.json`. Pure I/O, no render. */
export async function loadSocialCover(projectDir: string): Promise<{ cover: SocialCoverJson; path: string }> {
  const path = join(projectDir, 'social-cover.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(`cover: falta ${path} (crealo con slug/hook/support/cta/palette).`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`cover: ${path} no es JSON válido.`);
  }
  const cover = parsed as Partial<SocialCoverJson>;
  const missing = ['slug', 'hook', 'support', 'cta', 'palette'].filter(
    (key) => (cover as Record<string, unknown>)[key] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(`cover: ${path} sin campos: ${missing.join(', ')}.`);
  }
  return { cover: cover as SocialCoverJson, path };
}

/** 1080×1920 cover HTML with everything inside the safe zone. Pure. */
export function buildCoverHtml(cover: SocialCoverJson, backgroundDataUrl?: string): string {
  const { top, left, right, bottom } = COVER_SAFE_ZONE;
  const bg = backgroundDataUrl
    ? `background-image:url('${backgroundDataUrl}');background-size:cover;background-position:center;`
    : `background:${cover.palette.bg};`;
  const esc = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"></head>
<body style="margin:0;width:${COVER_WIDTH}px;height:${COVER_HEIGHT}px;overflow:hidden;${bg}font-family:system-ui,sans-serif;color:${cover.palette.ink};">
<div style="position:relative;width:${COVER_WIDTH}px;height:${COVER_HEIGHT}px;background:linear-gradient(180deg,rgba(0,0,0,.82) 0%,rgba(0,0,0,.5) 22%,rgba(0,0,0,.12) 40%,rgba(0,0,0,.12) 58%,rgba(0,0,0,.6) 78%,rgba(0,0,0,.88) 100%);">
<header style="position:absolute;top:${top}px;left:${left}px;right:${right}px;font-weight:800;letter-spacing:4px;font-size:40px;color:${cover.palette.accent};text-shadow:0 2px 12px rgba(0,0,0,.8);">${esc(cover.slug.toUpperCase())}</header>
<main style="position:absolute;left:${left}px;right:${right}px;top:620px;background:rgba(8,8,8,.55);backdrop-filter:blur(16px) saturate(1.1);border:1px solid rgba(255,255,255,.14);border-radius:28px;padding:36px 40px;">
<h1 style="font-size:104px;line-height:1.02;margin:0;text-wrap:balance;text-shadow:0 2px 24px rgba(0,0,0,.6);">${esc(cover.hook)}</h1>
<p style="font-size:46px;line-height:1.3;margin:20px 0 0;">${esc(cover.support)}</p>
</main>
<p style="position:absolute;left:${left}px;right:${right}px;bottom:${bottom}px;font-size:52px;font-weight:700;background:${cover.palette.accent};color:#111;border-radius:24px;padding:28px 32px;text-align:center;">${esc(cover.cta)}</p>
</div></body></html>`;
}

/** PNG IHDR probe (no native deps for `--check` paths). Pure. */
export function parsePngDimensions(buffer: Uint8Array): { width: number; height: number } {
  const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  if (buffer.length < 33 || !PNG_SIG.every((byte, index) => buffer[index] === byte)) {
    throw new Error('png: no es un PNG válido (firma).');
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('png: IHDR sin dimensiones válidas.');
  }
  return { width, height };
}

/** Exact-viewport Chromium screenshot of an HTML string. */
export async function renderHtmlToPng(html: string, output: string): Promise<void> {
  const exe = resolveChromiumExe();
  if (!exe) {
    throw new Error(
      'cover: no se encontró Chromium (caché ms-playwright ni agent-browser). ' +
        'Instalá Playwright Chromium o definí PLAYWRIGHT_CHROMIUM_EXE.',
    );
  }
  await mkdir(dirname(output), { recursive: true });
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const page = await browser.newPage({
      viewport: { width: COVER_WIDTH, height: COVER_HEIGHT },
      deviceScaleFactor: 1,
    });
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: output });
  } finally {
    await browser.close();
  }
  const dims = parsePngDimensions(await readFile(output));
  if (dims.width !== COVER_WIDTH || dims.height !== COVER_HEIGHT) {
    throw new Error(`cover: render ${dims.width}x${dims.height}, esperaba ${COVER_WIDTH}x${COVER_HEIGHT}.`);
  }
}

/** Deterministic center-crop of the rendered cover (Instagram crop parity). */
export async function derivePreviews(projectDir: string): Promise<string[]> {
  const coverPath = join(projectDir, COVER_PNG_REL);
  const targets = [
    { rel: PREVIEW_3X4_REL, width: 1080, height: 1440 },
    { rel: PREVIEW_SQUARE_REL, width: 1080, height: 1080 },
  ];
  const written: string[] = [];
  for (const target of targets) {
    const out = join(projectDir, target.rel);
    await mkdir(dirname(out), { recursive: true });
    const meta = await sharp(coverPath).metadata();
    const srcW = meta.width ?? 0;
    const srcH = meta.height ?? 0;
    if (srcW < target.width || srcH < target.height) {
      throw new Error(`cover: ${coverPath} (${srcW}x${srcH}) menor que ${target.width}x${target.height}.`);
    }
    await sharp(coverPath)
      .extract({
        left: Math.round((srcW - target.width) / 2),
        top: Math.round((srcH - target.height) / 2),
        width: target.width,
        height: target.height,
      })
      .png()
      .toFile(out);
    written.push(out);
  }
  return written;
}

/** Local validation: metadata + outputs with exact dimensions. */
export async function coverCheck(projectDir: string): Promise<CoverIssue[]> {
  const issues: CoverIssue[] = [];
  try {
    await loadSocialCover(projectDir);
  } catch (error) {
    return [{ path: join(projectDir, 'social-cover.json'), message: errorMessage(error) }];
  }
  for (const [rel, width, height] of [
    [COVER_PNG_REL, COVER_WIDTH, COVER_HEIGHT],
    [PREVIEW_3X4_REL, 1080, 1440],
    [PREVIEW_SQUARE_REL, 1080, 1080],
  ] as const) {
    const path = join(projectDir, rel);
    try {
      const dims = parsePngDimensions(await readFile(path));
      if (dims.width !== width || dims.height !== height) {
        issues.push({ path, message: `dimensiones ${dims.width}x${dims.height}, esperaba ${width}x${height}.` });
      }
    } catch {
      issues.push({ path, message: 'falta o no es PNG válido.' });
    }
  }
  return issues;
}

/** Carousel page listing: ≥2 PNGs of exactly 1080×1350, lexicographic order. */
export async function carouselCheck(imagesDir: string): Promise<{ pages: string[]; issues: CoverIssue[] }> {
  const issues: CoverIssue[] = [];
  let entries: string[];
  try {
    entries = (await readdir(imagesDir)).filter((name) => name.toLowerCase().endsWith('.png')).sort();
  } catch {
    return { pages: [], issues: [{ path: imagesDir, message: 'directorio ilegible o inexistente.' }] };
  }
  if (entries.length < 2) {
    issues.push({ path: imagesDir, message: `carrusel mínimo 2 páginas, hay ${entries.length}.` });
  }
  const pages: string[] = [];
  for (const name of entries) {
    const path = join(imagesDir, name);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      const dims = parsePngDimensions(await readFile(path));
      if (dims.width !== CAROUSEL_WIDTH || dims.height !== CAROUSEL_HEIGHT) {
        issues.push({ path, message: `dimensiones ${dims.width}x${dims.height}, esperaba ${CAROUSEL_WIDTH}x${CAROUSEL_HEIGHT}.` });
        continue;
      }
      pages.push(path);
    } catch {
      issues.push({ path, message: 'no es PNG válido.' });
    }
  }
  return { pages, issues };
}

/** Renders the project cover + previews; returns written paths. */
export async function renderCover(
  projectDir: string,
  out: (line: string) => void,
): Promise<{ coverPath: string; previews: string[] }> {
  const { cover } = await loadSocialCover(projectDir);
  await mkdir(join(projectDir, 'covers'), { recursive: true });
  let backgroundDataUrl: string | undefined;
  const bgCandidates = [join('covers', 'bg.png'), 'bg.png', 'bg.jpg', join('assets', 'bg.png')];
  for (const candidate of bgCandidates) {
    try {
      const bytes = await readFile(join(projectDir, candidate));
      const ext = candidate.endsWith('.jpg') ? 'jpeg' : 'png';
      backgroundDataUrl = `data:image/${ext};base64,${Buffer.from(bytes).toString('base64')}`;
      break;
    } catch {
      continue;
    }
  }
  const html = buildCoverHtml(cover, backgroundDataUrl);
  await writeFile(join(projectDir, 'covers', 'cover.html'), html);
  const coverPath = join(projectDir, COVER_PNG_REL);
  await renderHtmlToPng(html, coverPath);
  out(`cover: portada ${COVER_WIDTH}x${COVER_HEIGHT} → ${coverPath}`);
  const previews = await derivePreviews(projectDir);
  for (const preview of previews) out(`cover: preview → ${preview}`);
  return { coverPath, previews };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
