import { createFileRoute, useParams } from '@tanstack/react-router';
import { PostsPage } from '../features/posts/PostsPage';

export const Route = createFileRoute('/_app/admin/clients/$clientId/posts')({
  component: () => {
    const params = useParams({ from: '/_app/admin/clients/$clientId' });
    return <PostsPage clientId={params.clientId} admin />;
  },
});
