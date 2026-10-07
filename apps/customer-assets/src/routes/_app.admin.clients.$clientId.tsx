import { Link, Outlet, createFileRoute, useParams, useLocation } from '@tanstack/react-router';
import { RequireAdmin } from '../features/auth/session';
import { PortalHeader } from '../features/clients/PortalShell';
import { useAuthorizedClient } from '../features/clients/PortalShell';
import { EmptyState, Spinner } from '../components/ui/primitives';
import { SegmentedTabs } from '../components/ui/tabs';
import { useDocumentTitle } from '../components/ui/head';

export const Route = createFileRoute('/_app/admin/clients/$clientId')({
  component: () => (
    <RequireAdmin>
      <AdminClientArea />
    </RequireAdmin>
  ),
});

const TABS = [
  { segment: 'materials', to: '/admin/clients/$clientId/materials', label: 'Materiales' },
  { segment: 'projects', to: '/admin/clients/$clientId/projects', label: 'Proyectos' },
  { segment: 'assets', to: '/admin/clients/$clientId/assets', label: 'Assets' },
  { segment: 'posts', to: '/admin/clients/$clientId/posts', label: 'Posts' },
  { segment: 'access', to: '/admin/clients/$clientId/access', label: 'Accesos y keys' },
] as const;

function AdminClientArea() {
  const params = useParams({ from: '/_app/admin/clients/$clientId' });
  const { client, ready, error } = useAuthorizedClient(params.clientId);

  if (!ready) return <Spinner label="Cargando cliente…" />;
  if (error !== null || client === null) {
    return (
      <div className="portal-shell">
        <PortalHeader />
        <main className="portal-main">
          <EmptyState title="Cliente no encontrado" hint="El identificador no corresponde a un cliente proyectado." />
          <p style={{ textAlign: 'center' }}>
            <Link to="/admin/clients">Volver a clientes</Link>
          </p>
        </main>
      </div>
    );
  }

  return <AdminClientSurface clientId={params.clientId} clientName={client.name} />;
}

function AdminClientSurface({ clientId, clientName }: { clientId: string; clientName: string }) {
  const pathname = useLocation().pathname;
  const afterId = pathname.slice(pathname.indexOf(clientId) + clientId.length);
  const openTab = TABS.find((tab) => tab.segment === (afterId.split('/')[1] ?? ''));
  useDocumentTitle(openTab !== undefined ? `Admin — ${openTab.label} · ${clientName}` : `Admin — ${clientName}`);
  return (
    <div className="portal-shell">
      <PortalHeader clientName={clientName} />
      <main className="portal-main">
        <h2 className="page-title">Administración · <span className="title-accent">{clientName}</span></h2>
        <SegmentedTabs tabs={TABS} clientId={clientId} aria-label={`Secciones de administración de ${clientName}`} />
        <Outlet />
      </main>
    </div>
  );
}
