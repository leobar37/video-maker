import { createFileRoute, useParams } from '@tanstack/react-router';
import { MaterialsPage } from '../features/materials/MaterialsPage';

export const Route = createFileRoute('/_app/admin/clients/$clientId/materials')({
  component: () => {
    const params = useParams({ from: '/_app/admin/clients/$clientId' });
    return <MaterialsPage clientId={params.clientId} admin />;
  },
});
