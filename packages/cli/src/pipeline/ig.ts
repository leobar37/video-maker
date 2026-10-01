/**
 * Instagram ingest helpers (read-only research evidence).
 *
 * Two transports:
 * - fetch: anonymous `og:*` meta tags of single post pages (caption, likes,
 *   comments, date, preview image). The profile grid is login-walled for
 *   anonymous fetch, so grid enumeration needs the browser transport.
 * - browser: headless Chromium (Playwright) renders the public profile grid
 *   exactly like the terminal-browser sessions did: close the login dialog
 *   with Escape and read `main a[href]` links.
 *
 * Secrets are never involved; every failure is actionable (missing Chromium
 * binary, login wall without grid, rate limit).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

export type FetchImpl = typeof fetch;

export interface IgPostDetail {
  href: string;
  shortcode: string;
  kind: 'post' | 'reel';
  caption: string;
  likes: number;
  comments: number;
  date: string;
  image: string;
}

export interface IgProfileInventory {
  username: string;
  profile: string;
  title: string;
  bio: string;
  followers: number | null;
  following: number | null;
  posts: string[];
  reels: string[];
  posts_detail: IgPostDetail[];
  extraction: { at: string; method: string; note: string };
}

export const IG_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** `&#xf1;` / `&quot;` style entities found in og meta content. */
export function decodeEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function metaContent(html: string, property: string): string {
  const pattern = new RegExp(
    `<meta[^>]+property="${property}"[^>]+content="([^"]*)"`,
    'i',
  );
  return decodeEntities(pattern.exec(html)?.[1] ?? '');
}

/**
 * Grid links of a rendered profile page (`/user/p/<code>/`,
 * `/user/reel/<code>/`). Pure: operates on href strings.
 */
export function extractGridHrefs(username: string, hrefs: readonly (string | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const href of hrefs) {
    if (!href) continue;
    const match = new RegExp(`^/${username}/(p|reel)/([A-Za-z0-9_-]+)/$`).exec(href);
    if (!match) continue;
    const normalized = `/${username}/${match[1]}/${match[2]}/`;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/** Parses one fetched post page into its research detail. Pure. */
export function parsePostOg(href: string, html: string): IgPostDetail {
  const ogDesc = metaContent(html, 'og:description');
  const ogTitle = metaContent(html, 'og:title');
  const image = metaContent(html, 'og:image');
  const head = ogDesc.split(' - ')[0] ?? '';
  const likes = Number.parseInt(/([\d,]+)\s+likes/.exec(head)?.[1]?.replace(/,/g, '') ?? '0', 10);
  const comments = Number.parseInt(/([\d,]+)\s+comments/.exec(head)?.[1]?.replace(/,/g, '') ?? '0', 10);
  const date = /on\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/.exec(ogDesc)?.[1] ?? '';
  const quoted = /:\s+"([\s\S]*)"\.\s*$/.exec(ogDesc)?.[1]?.trim();
  const caption =
    quoted ?? ogTitle.replace(/^.*Instagram:\s*/, '').replace(/^"|"$/g, '').trim();
  const kindMatch = /^\/[^/]+\/(p|reel)\/([A-Za-z0-9_-]+)\/$/.exec(href);
  return {
    href,
    shortcode: kindMatch?.[2] ?? href,
    kind: kindMatch?.[1] === 'reel' ? 'reel' : 'post',
    caption,
    likes: Number.isFinite(likes) ? likes : 0,
    comments: Number.isFinite(comments) ? comments : 0,
    date,
    image,
  };
}

/** Anonymous fetch with the IG desktop user agent. */
export async function fetchIgHtml(
  url: string,
  fetchImpl: FetchImpl,
): Promise<{ status: number; html: string }> {
  const response = await fetchImpl(url, { headers: { 'User-Agent': IG_UA } });
  const html = await response.text();
  return { status: response.status, html };
}

/** Candidate Chromium executables, newest Playwright cache first. */
export function chromiumCandidates(): string[] {
  const home = homedir();
  const out: string[] = [];
  if (process.env.PLAYWRIGHT_CHROMIUM_EXE && process.env.PLAYWRIGHT_CHROMIUM_EXE.length > 0) {
    out.push(process.env.PLAYWRIGHT_CHROMIUM_EXE);
  }
  for (const build of ['chromium-1243', 'chromium-1234', 'chromium-1228']) {
    out.push(join(home, '.cache', 'ms-playwright', build, 'chrome-linux64', 'chrome'));
    out.push(join(home, '.cache', 'ms-playwright', build, 'chrome-linux', 'chrome'));
  }
  out.push(join(home, '.agent-browser', 'browsers', 'chrome-150.0.7871.24', 'chrome'));
  return out;
}

/** First existing Chromium executable, or undefined. */
export function resolveChromiumExe(): string | undefined {
  return chromiumCandidates().find((path) => {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  });
}

/**
 * Renders a URL in headless Chromium and returns title + main hrefs +
 * optional full-page screenshot.
 */
export interface RenderedProfile {
  title: string;
  hrefs: string[];
  profileText: string;
}

export async function captureScreenshots(jobs: ReadonlyArray<{ url: string; path: string }>): Promise<void> {
  const exe = resolveChromiumExe();
  if (!exe) {
    throw new Error(
      'ig-profile: no se encontró Chromium (caché ms-playwright ni agent-browser). ' +
        'Instalá Playwright Chromium o definí PLAYWRIGHT_CHROMIUM_EXE.',
    );
  }
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const page = await browser.newPage({ userAgent: IG_UA, viewport: { width: 1366, height: 900 } });
    for (const job of jobs) {
      await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(5000);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1000);
      await page.screenshot({ path: job.path, fullPage: false });
    }
  } finally {
    await browser.close();
  }
}

export async function renderWithChromium(
  url: string,
  options: { screenshotPath?: string; waitMs?: number } = {},
): Promise<RenderedProfile> {

  const exe = resolveChromiumExe();
  if (!exe) {
    throw new Error(
      'ig-profile: no se encontró Chromium (caché ms-playwright ni agent-browser). ' +
        'Instalá Playwright Chromium o definí PLAYWRIGHT_CHROMIUM_EXE.',
    );
  }
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const page = await browser.newPage({
      userAgent: IG_UA,
      viewport: { width: 1366, height: 900 },
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(options.waitMs ?? 8000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1500);
    const title = await page.title();
    const hrefs = await page.$$eval('main a', (els) =>
      els.map((a) => a.getAttribute('href')),
    );
    const profileText = await page
      .$eval('main', (el) => el.innerText.slice(0, 4000))
      .catch(() => '');
    if (options.screenshotPath) {
      await page.screenshot({ path: options.screenshotPath, fullPage: false });
    }
    return { title, hrefs: hrefs.filter((h): h is string => typeof h === 'string'), profileText };
  } finally {
    await browser.close();
  }
}

/** A parse with no signal (login-wall HTML instead of og tags). */
export function isEmptyDetail(detail: IgPostDetail): boolean {
  return (
    detail.caption === '' &&
    detail.likes === 0 &&
    detail.comments === 0 &&
    detail.date === '' &&
    detail.image === ''
  );
}

/** `314 followers` / `368 following` from the rendered profile text. */
export function parseFollowCounts(text: string): { followers: number | null; following: number | null } {
  const counts: Record<string, number | null> = { followers: null, following: null };
  for (const key of ['followers', 'following'] as const) {
    const raw = new RegExp(`([\\d,]+)\\s+${key}`).exec(text)?.[1];
    if (!raw) continue;
    const value = Number.parseInt(raw.replace(/,/g, ''), 10);
    counts[key] = Number.isFinite(value) ? value : null;
  }
  return { followers: counts.followers, following: counts.following };
}

/** First substantial content line of the rendered profile (the bio). */
export function guessBio(text: string, username: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 20 &&
        !line.includes(username) &&
        !/followers|following|Posts|Reels|Tagged/i.test(line),
    );
  return lines[0] ?? '';
}

const DIAGNOSIS_RULES: Record<string, string> = {
  'caption-vacio': 'Sin caption: solo emoji o vacío; sin keyword ni CTA.',
  'caption-corto': 'Caption menor a 40 caracteres: no posiciona ni convierte.',
  'sin-hashtags': 'Sin hashtags: alcance solo a seguidores actuales.',
  'cero-comentarios': '0 comentarios: nadie conversa; el algoritmo lo entierra.',
  'poco-alcance': 'Menos de 10 likes con 314 seguidores: <3% de alcance.',
};

/** Data-driven flags for one post (no visual judgment here). */
export function diagnosePost(detail: IgPostDetail): string[] {
  const flags: string[] = [];
  if (detail.caption.replace(/[\p{Emoji}\s]/gu, '').length === 0) flags.push('caption-vacio');
  else if (detail.caption.length < 40) flags.push('caption-corto');
  if (!/#\w/.test(detail.caption)) flags.push('sin-hashtags');
  if (detail.comments === 0) flags.push('cero-comentarios');
  if (detail.likes < 10) flags.push('poco-alcance');
  return flags;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Standalone `diagnostico/index.html` from the inventory. Pure. */
export function renderDiagnosticHtml(inventory: IgProfileInventory): string {
  const cards = inventory.posts_detail
    .map((post) => {
      const items = diagnosePost(post)
        .map((flag) => `<li><strong>${flag}</strong> — ${DIAGNOSIS_RULES[flag] ?? ''}</li>`)
        .join('');
      return `<article class="card">
<h3><a href="https://www.instagram.com${post.href}">${post.shortcode}</a> <span class="kind">${post.kind}</span></h3>
<p class="meta">${post.date} · ${post.likes} likes · ${post.comments} comentarios</p>
<blockquote>${escapeHtml(post.caption) || '<em>(sin caption)</em>'}</blockquote>
${post.image ? `<img loading="lazy" src="${post.image}" alt="portada ${post.shortcode}">` : ''}
<ul class="flags">${items || '<li class="ok">Sin observaciones de datos.</li>'}</ul>
</article>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Diagnóstico · @${escapeHtml(inventory.username)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:960px;margin:auto;padding:24px;background:#111;color:#eee}
.card{border:1px solid #444;border-radius:12px;padding:16px;margin:16px 0;background:#1a1a1a}
.kind{font-size:.8em;color:#9cf}.meta{color:#aaa}blockquote{border-left:3px solid #c33;padding-left:12px;white-space:pre-wrap}
img{max-width:100%;border-radius:8px}.flags li{margin:4px 0}.ok{color:#7d7}a{color:#9cf}</style>
</head><body>
<h1>@${escapeHtml(inventory.username)} — por qué están mal</h1>
<p>${inventory.posts_detail.length} posts · ${inventory.followers ?? '?'} seguidores ·
fuente: <a href="${escapeHtml(inventory.profile)}">perfil</a> · ${escapeHtml(inventory.extraction.at)}</p>
${cards}
</body></html>`;
}

export interface BrowserCollectOptions {
  count: number;
  screenshots: boolean;
  gridScreenshotPath: string;
  postsShotDir?: string;
  out: (line: string) => void;
}

export interface BrowserCollected {
  title: string;
  bio: string;
  followers: number | null;
  following: number | null;
  grid: string[];
  detail: IgPostDetail[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whole profile in ONE browser session: grid, reels tab, per-post og tags
 * and screenshots. Rendered pages are not subject to the anonymous-fetch
 * throttle, so detail survives when plain fetch returns login walls.
 */
export async function collectProfileViaBrowser(
  username: string,
  options: BrowserCollectOptions,
): Promise<BrowserCollected> {
  const exe = resolveChromiumExe();
  if (!exe) {
    throw new Error(
      'ig-profile: no se encontró Chromium (caché ms-playwright ni agent-browser). ' +
        'Instalá Playwright Chromium o definí PLAYWRIGHT_CHROMIUM_EXE.',
    );
  }
  const profileUrl = `https://www.instagram.com/${username}/`;
  const browser = await chromium.launch({ executablePath: exe });
  const detail: IgPostDetail[] = [];
  try {
    const page = await browser.newPage({ userAgent: IG_UA, viewport: { width: 1366, height: 900 } });
    const visit = async (
      url: string,
      waitMs: number,
    ): Promise<{ title: string; hrefs: string[]; html: string; text: string }> => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(waitMs);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(1200);
      const hrefs = await page.$$eval('main a', (els) => els.map((a) => a.getAttribute('href')));
      const html = await page.content();
      const text = await page
        .$eval('main', (el) => el.innerText.slice(0, 4000))
        .catch(() => '');
      const title = await page.title().catch(() => '');
      return {
        title,
        hrefs: hrefs.filter((href): href is string => typeof href === 'string'),
        html,
        text,
      };
    };
    const profile = await visit(profileUrl, 8000);
    if (!profile.title.includes(username)) {
      throw new Error(`el título "${profile.title}" no menciona @${username} (bloqueo o rate-limit).`);
    }
    const seen = new Set<string>();
    for (const href of extractGridHrefs(username, profile.hrefs)) seen.add(href);
    await page.screenshot({ path: options.gridScreenshotPath, fullPage: false });
    try {
      const reels = await visit(`${profileUrl}reels/`, 6000);
      for (const href of extractGridHrefs(username, reels.hrefs)) seen.add(href);
      options.out(`ig-profile: grid + reels → ${seen.size} links únicos.`);
    } catch (error) {
      options.out(`ig-profile: pestaña reels omitida (${errorText(error)}).`);
    }
    const grid = [...seen].slice(0, Math.max(1, options.count));
    if (grid.length === 0) {
      throw new Error('grid vacío (login-wall sin posts o rate-limit 429).');
    }
    const counts = parseFollowCounts(profile.text);
    for (const href of grid) {
      try {
        const post = await visit(`https://www.instagram.com${href}`, 5000);
        const parsed = parsePostOg(href, post.html);
        if (isEmptyDetail(parsed)) {
          options.out(`ig-profile: ${href} sin og tags, se omite.`);
          continue;
        }
        detail.push(parsed);
        if (options.screenshots && options.postsShotDir) {
          await page.screenshot({ path: join(options.postsShotDir, `${parsed.shortcode}.png`) });
        }
      } catch (error) {
        options.out(`ig-profile: ${href} falló (${errorText(error)}), se omite.`);
      }
    }
    return {
      title: profile.title,
      bio: guessBio(profile.text, username),
      followers: counts.followers,
      following: counts.following,
      grid,
      detail,
    };
  } finally {
    await browser.close();
  }
}
