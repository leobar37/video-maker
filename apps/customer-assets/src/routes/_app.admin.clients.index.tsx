import { createFileRoute } from '@tanstack/react-router';
import { AdminClientsPage } from '../features/admin/AdminClientsPage';
import { RequireAdmin } from '../features/auth/session';

export const Route = createFileRoute('/_app/admin/clients/')({
  component: () => (
    <RequireAdmin>
      <AdminClientsPage />
    </RequireAdmin>
  ),
});
