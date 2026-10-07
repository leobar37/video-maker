import { createFileRoute } from '@tanstack/react-router';
import { PortalHomePage } from '../features/clients/PortalShell';
import { PortalHeader } from '../features/clients/PortalShell';
import { useDocumentTitle } from '../components/ui/head';

export const Route = createFileRoute('/_app/portal/')({
  component: () => {
    useDocumentTitle('Mis clientes — Portal de clientes');
    return (
      <div className="portal-shell">
        <PortalHeader />
        <main className="portal-main">
          <h2 className="page-title">Mis clientes</h2>
          <PortalHomePage />
        </main>
      </div>
    );
  },
});
