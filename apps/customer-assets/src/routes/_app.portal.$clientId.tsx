import { Outlet, createFileRoute } from '@tanstack/react-router';
import { PortalClientLayout } from '../features/clients/PortalShell';

export const Route = createFileRoute('/_app/portal/$clientId')({
  component: () => (
    <PortalClientLayout>
      <Outlet />
    </PortalClientLayout>
  ),
});
