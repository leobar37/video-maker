import { createFileRoute, useParams } from '@tanstack/react-router';
import { ProjectsTab } from '../features/admin/ProjectsTab';

export const Route = createFileRoute('/_app/admin/clients/$clientId/projects')({
  component: () => {
    const params = useParams({ from: '/_app/admin/clients/$clientId' });
    return <ProjectsTab clientId={params.clientId} />;
  },
});
