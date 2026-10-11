import { Navigate, createFileRoute, useParams } from '@tanstack/react-router';

/** /admin/clients/:clientId → materials tab. */
export const Route = createFileRoute('/_app/admin/clients/$clientId/')({
  component: () => {
    const params = useParams({ from: '/_app/admin/clients/$clientId' });
    return <Navigate to="/admin/clients/$clientId/materials" params={{ clientId: params.clientId }} replace />;
  },
});
