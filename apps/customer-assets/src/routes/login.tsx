import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { PortalProviders } from '../api/query-provider';
import { LoginPage } from '../features/auth/LoginPage';
import { safeRedirectTarget } from '../features/auth/session';
import '../styles/portal.css';

export const Route = createFileRoute('/login')({
  // Standard-schema validator (zod): { redirect?: string }
  validateSearch: z.object({ redirect: z.string().optional() }),
  component: LoginRoute,
});

function LoginRoute() {
  const search = Route.useSearch();
  const redirectTarget = safeRedirectTarget(search.redirect);
  return (
    <PortalProviders>
      <LoginPage redirectTarget={redirectTarget} />
    </PortalProviders>
  );
}
