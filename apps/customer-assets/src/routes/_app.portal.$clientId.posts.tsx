import { createFileRoute, useParams } from '@tanstack/react-router';
import { PostsPage } from '../features/posts/PostsPage';

export const Route = createFileRoute('/_app/portal/$clientId/posts')({
  component: () => {
    const params = useParams({ from: '/_app/portal/$clientId' });
    return <PostsPage clientId={params.clientId} />;
  },
});
