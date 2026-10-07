import { Navigate, createFileRoute, useParams } from '@tanstack/react-router';

/** /portal/:clientId → materials (deepest default tab). */
export const Route = createFileRoute('/_app/portal/$clientId/')({
  component: () => {
    const params = useParams({ from: '/_app/portal/$clientId' });
    return <Navigate to="/portal/$clientId/materials" params={{ clientId: params.clientId }} replace />;
  },
});
