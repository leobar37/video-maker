/**
 * Playwright-core launcher against the CACHED chromium build (~/.cache/
 * ms-playwright). Picks the highest installed version; the local server is
 * loopback-only, so no browser flags beyond headless are needed.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';

const CACHE_ROOT = join(process.env.HOME ?? '', '.cache', 'ms-playwright');

export async function launchBrowser(): Promise<{ browser: Browser; close(): Promise<void> }> {
  let executablePath: string | undefined;
  try {
    const versions = readdirSync(CACHE_ROOT)
      .filter((entry) => entry.startsWith('chromium-'))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const version of versions) {
      const base = join(CACHE_ROOT, version);
      for (const sub of ['chrome-linux64', 'chrome-linux']) {
        const candidate = join(base, sub, 'chrome');
        try {
          statSync(candidate);
          executablePath = candidate;
          break;
        } catch {
          /* try next layout */
        }
      }
      if (executablePath !== undefined) break;
    }
  } catch {
    /* fall through to error */
  }
  if (executablePath === undefined) {
    throw new Error(`no cached chromium found under ${CACHE_ROOT}`);
  }
  const browser = await chromium.launch({ executablePath, headless: true });
  return { browser, close: () => browser.close() };
}
