import { createFileRoute, useParams } from '@tanstack/react-router';
import { AccessTab } from '../features/admin/AccessTab';

export const Route = createFileRoute('/_app/admin/clients/$clientId/access')({
  component: () => {
    const params = useParams({ from: '/_app/admin/clients/$clientId' });
    return <AccessTab clientId={params.clientId} />;
  },
});
