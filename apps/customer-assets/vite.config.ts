import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';

// Minimal TanStack Start app bundleable for Cloudflare Workers
// (developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start).
// P-001 is emulation-only: no deploy, no wrangler login.
export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: 'ssr' } }),
    tanstackStart(),
    react(),
  ],
});
