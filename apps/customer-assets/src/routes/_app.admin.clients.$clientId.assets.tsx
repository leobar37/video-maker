import { createFileRoute, useParams } from '@tanstack/react-router';
import { AssetsPage } from '../features/assets/AssetsPage';

export const Route = createFileRoute('/_app/admin/clients/$clientId/assets')({
  component: () => {
    const params = useParams({ from: '/_app/admin/clients/$clientId' });
    return <AssetsPage clientId={params.clientId} admin />;
  },
});
