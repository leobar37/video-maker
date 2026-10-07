/**
 * Admin clients dashboard (FR-002): every client in the workspace list, with
 * direct entry to its admin area. Server-authorized: this page renders only
 * inside RequireAdmin, and every mutation below re-checks the admin role
 * server-side (the UI is never the authorization boundary).
 */

import { useMemo } from 'react';
import { Link } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import type { PortalClientView } from '@videomaker/customer-assets';
import { isUnauthorized } from '../../api/client';
import { useClients } from '../../api/hooks';
import { ErrorState, Spinner, formatDate } from '../../components/ui/primitives';
import { DataTable } from '../../components/ui/data-table';
import { useDocumentTitle } from '../../components/ui/head';
import { PortalHeader } from '../clients/PortalShell';
import { useSession } from '../auth/session';

function AdminClientsTable({ items }: { items: PortalClientView[] }) {
  const columns = useMemo<ColumnDef<PortalClientView, unknown>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Cliente',
        cell: (info) => <strong>{info.getValue<string>()}</strong>,
      },
      {
        accessorKey: 'studioClientId',
        header: 'studioClientId',
        cell: (info) => <code>{info.getValue<string>()}</code>,
      },
      { accessorKey: 'projectionVersion', header: 'Versión' },
      {
        accessorKey: 'createdAt',
        header: 'Alta',
        cell: (info) => formatDate(info.getValue<number>()),
      },
      {
        id: 'actions',
        header: 'Acciones',
        enableSorting: false,
        cell: ({ row }) => (
          <span style={{ display: 'inline-flex', gap: '0.35rem', flexWrap: 'wrap' }}>
            <Link className="btn btn-sm" to="/admin/clients/$clientId" params={{ clientId: row.original.id }}>
              Administrar
            </Link>
            <Link className="btn btn-sm" to="/portal/$clientId/instagram" params={{ clientId: row.original.id }}>
              Ver portal
            </Link>
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div className="card">
      <DataTable<PortalClientView>
        columns={columns}
        data={items}
        getRowId={(client) => client.id}
        tableTestId="admin-clients-table"
        rowTestId="admin-client-row"
        ariaLabel="Clientes proyectados"
        emptyTitle="Sin clientes proyectados"
        emptyHint="Los clientes aparecen tras su adopción desde el estudio (CLI del integrador)."
        filterPlaceholder="Buscar cliente…"
      />
    </div>
  );
}

export function AdminClientsPage() {
  useDocumentTitle('Admin — Clientes');
  const { me } = useSession();
  const clients = useClients(me.me.userId);

  if (clients.isPending) return <Spinner label="Cargando clientes…" />;
  if (clients.isError) {
    if (isUnauthorized(clients.error)) throw clients.error;
    return <ErrorState message="No se pudo cargar la lista de clientes." onRetry={() => clients.refetch()} />;
  }

  const items = clients.data.items;
  return (
    <div className="portal-shell">
      <PortalHeader />
      <main className="portal-main" data-testid="admin-clients">
        <h2 className="page-title">Clientes</h2>
        <AdminClientsTable items={items} />
      </main>
    </div>
  );
}
