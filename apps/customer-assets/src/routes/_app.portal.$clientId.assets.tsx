import { createFileRoute, useParams } from '@tanstack/react-router';
import { AssetsPage } from '../features/assets/AssetsPage';

export const Route = createFileRoute('/_app/portal/$clientId/assets')({
  component: () => {
    const params = useParams({ from: '/_app/portal/$clientId' });
    return <AssetsPage clientId={params.clientId} />;
  },
});
