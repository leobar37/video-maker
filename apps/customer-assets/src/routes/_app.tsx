import { Outlet, createFileRoute } from '@tanstack/react-router';
import '../styles/portal.css';
import { PortalProviders } from '../api/query-provider';
import { RequireAuth } from '../features/auth/session';

export const Route = createFileRoute('/_app')({
  component: () => (
    <PortalProviders>
      <RequireAuth>
        <Outlet />
      </RequireAuth>
    </PortalProviders>
  ),
});
