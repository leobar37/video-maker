import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';

/**
 * E2E-only Vite config (tests/e2e harness, G-cap-local): identical app to
 * vite.config.ts plus Worker vars that ONLY this harness sets — the guarded
 * /api/fixture/* endpoint, a fixture Better Auth secret and the loopback
 * origin. Nothing else (build, deploy, normal dev) ever sees these values,
 * and the server binds 127.0.0.1 exclusively.
 */

const PORT = Number(process.env.E2E_PORT ?? 4519);

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      persistState: { path: 'tests/e2e/.state' },
      config: (workerConfig) => {
        const { PORTAL_LIVE_SMOKE: _smoke, PORTAL_MAIL_FROM: _mail, ...inheritedVars } = workerConfig.vars ?? {};
        workerConfig.vars = {
          ...inheritedVars,
          E2E_FIXTURE: '1',
          BETTER_AUTH_SECRET: 'e2e-fixture-secret-local-only-0123456789abcdef',
          PORTAL_ORIGIN: `http://127.0.0.1:${PORT}`,
        };
      },
    }),
    tanstackStart(),
    react(),
  ],
});
