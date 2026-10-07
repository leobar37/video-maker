import { createFileRoute, useParams } from '@tanstack/react-router';
import { MaterialsPage } from '../features/materials/MaterialsPage';

export const Route = createFileRoute('/_app/portal/$clientId/materials')({
  component: () => {
    const params = useParams({ from: '/_app/portal/$clientId' });
    return <MaterialsPage clientId={params.clientId} />;
  },
});
