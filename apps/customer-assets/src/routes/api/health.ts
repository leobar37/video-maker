import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';

/**
 * /api/health — infrastructure probe for the local/emulated deployment only.
 * Verifies both bindings answer; performs no writes and no cloud calls.
 */
export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async () => {
        const row = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
        const bucket = await env.ASSETS.head('__health__');
        return Response.json({
          d1: row?.ok === 1,
          r2: bucket === null,
        });
      },
    },
  },
});
