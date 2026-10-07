import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

const appRouter = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof appRouter;
  }
}

export function getRouter() {
  return appRouter;
}
