import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

// Emulated Workers runtime (Miniflare under the Cloudflare Vitest plugin)
// with disposable fixture D1/R2 bindings mirroring wrangler.jsonc. The test
// harness cannot use the wrangler `main` entry (the Start server entry is
// only resolvable through the Vite build), so bindings are declared inline
// here; keep them in sync with wrangler.jsonc. No real cloud: no deploy, no
// wrangler login, no live resources.
const migrations = await readD1Migrations('./migrations');

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-09-01',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        r2Buckets: ['ASSETS'],
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  // UI component tests (happy-dom) and the playwright e2e harness must NOT
  // run inside the emulated workerd pool; they have their own runners
  // (test:ui / test:e2e). Default vitest excludes are preserved.
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'tests/dashboard.test.tsx',
      'tests/e2e/**',
    ],
  },
});
