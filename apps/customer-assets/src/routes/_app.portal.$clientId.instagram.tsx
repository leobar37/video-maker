import { createFileRoute, useParams } from '@tanstack/react-router';
import { InstagramGridPage } from '../features/instagram/InstagramGridPage';

export const Route = createFileRoute('/_app/portal/$clientId/instagram')({
  component: () => {
    const params = useParams({ from: '/_app/portal/$clientId' });
    return <InstagramGridPage clientId={params.clientId} />;
  },
});
