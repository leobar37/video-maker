/**
 * App-wide TanStack Query provider (contracts.md §8). Stable client per
 * mount; user/client cache hygiene lives in ./keys and runs on identity
 * changes (logout wipe, client-switch prune) — the provider itself never
 * resets, so a session change MUST go through those helpers.
 */

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

export function PortalProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => {
    const isServer = typeof window === 'undefined';
    return new QueryClient({
      defaultOptions: {
        queries: {
          // Queries are a CLIENT concern: the server render shows pending
          // states and never fires fetches (guards/fetches resolve after
          // hydration — SSR-safe and race-free).
          enabled: !isServer,
          retry: 1,
          refetchOnWindowFocus: false,
          staleTime: 30_000,
        },
      },
    });
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
