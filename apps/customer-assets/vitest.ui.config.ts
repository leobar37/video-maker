import { defineConfig } from 'vitest/config';

/**
 * Browser-less UI/component tests (test:ui): happy-dom + @testing-library,
 * with mocked API transports. Deliberately SEPARATE from vitest.config.ts
 * (which runs inside the emulated workerd via @cloudflare/vitest-plugin —
 * React/DOM cannot run there, and vice versa).
 */
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['tests/dashboard.test.tsx'],
    globals: false,
    setupFiles: ['tests/ui-setup.ts'],
  },
  resolve: {
    // The SDK resolves via the workspace symlink; keep conditions browser-ish.
    mainFields: ['module', 'main'],
  },
});
