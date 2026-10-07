/**
 * Portal shell (contracts.md §8): authenticated chrome shared by every
 * /portal/* page — session header, client context, per-client tab bar and
 * the cache-prune effect that fires whenever the open client changes
 * (NFR-005: no cross-client cache or miniature leakage).
 */

import { useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate, useParams } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { PortalClientView } from '@videomaker/customer-assets';
import { clientsKey, prunePortalCacheForClient } from '../../api/keys';
import { useAcceptInvitations, useClients } from '../../api/hooks';
import { Badge, EmptyState, ErrorState, IconChevronLeft, Spinner } from '../../components/ui/primitives';
import { SegmentedTabs } from '../../components/ui/tabs';
import { useDocumentTitle } from '../../components/ui/head';
import { LogoutButton, useSession } from '../auth/session';

const TABS = [
  { segment: 'materials', to: '/portal/$clientId/materials', label: 'Materiales' },
  { segment: 'assets', to: '/portal/$clientId/assets', label: 'Assets' },
  { segment: 'posts', to: '/portal/$clientId/posts', label: 'Posts' },
  { segment: 'instagram', to: '/portal/$clientId/instagram', label: 'Instagram' },
] as const;

export function PortalHeader({ clientName }: { clientName?: string }) {
  const { me } = useSession();
  const location = useLocation();
  const isAdmin = me.me.role === 'admin';
  // Member switcher needs the membership list only inside a client context;
  // the same query key the client layout already warmed is reused.
  const memberships = useClients(me.me.userId, !isAdmin && clientName !== undefined);
  const otherClients = memberships.data?.items ?? [];
  return (
    <header className="portal-header">
      <p className="portal-title">Portal de clientes{clientName !== undefined ? ` · ${clientName}` : ''}</p>
      {!isAdmin && clientName !== undefined && otherClients.length > 1 && (
        <details className="client-switcher">
          <summary aria-label="Cambiar de cliente">{clientName}</summary>
          <div className="switcher-menu">
            <Link to="/portal">Mis clientes</Link>
            {otherClients.map((entry) => (
              <Link key={entry.id} to="/portal/$clientId/materials" params={{ clientId: entry.id }}>
                {entry.name}
              </Link>
            ))}
          </div>
        </details>
      )}
      {isAdmin && location.pathname !== '/admin/clients' && (
        <div className="crumb-bar">
          <Link className="crumb-back" to="/admin/clients">
            <IconChevronLeft />
            Todos los clientes
          </Link>
        </div>
      )}
      <nav className="portal-user" aria-label="Sesión">
        <span>{me.me.email}</span>
        <Badge tone={me.me.role === 'admin' ? 'warn' : 'plain'}>{me.me.role === 'admin' ? 'Admin' : 'Cliente'}</Badge>
        <LogoutButton />
      </nav>
    </header>
  );
}

export function ClientTabs({ clientId }: { clientId: string }) {
  return <SegmentedTabs tabs={TABS} clientId={clientId} aria-label={`Secciones de ${clientId}`} />;
}

/**
 * Effects that must run when the OPEN CLIENT changes: prune every cached
 * entry scoped to another client for this user (lists, thumbs, posts) so a
 * stale miniature of client A can never be rendered under client B.
 */
export function useClientSwitchHygiene(userId: string, clientId: string): void {
  const queryClient = useQueryClient();
  const previousClientId = useRef<string | null>(null);
  useEffect(() => {
    if (previousClientId.current !== null && previousClientId.current !== clientId) {
      prunePortalCacheForClient(queryClient, userId, previousClientId.current);
    }
    previousClientId.current = clientId;
  }, [queryClient, userId, clientId]);
}

/**
 * Resolves the open client from the URL against the session's authorized
 * list. A client without membership (or an unknown id) renders 404-ish empty
 * state — matching the server's no-enumeration contract.
 */
export function useAuthorizedClient(clientId: string): {
  client: PortalClientView | null;
  ready: boolean;
  error: unknown;
} {
  const { me } = useSession();
  const clients = useClients(me.me.userId);
  if (clients.isPending) return { client: null, ready: false, error: null };
  if (clients.isError) return { client: null, ready: true, error: clients.error };
  const found = clients.data.items.find((entry) => entry.id === clientId) ?? null;
  return { client: found, ready: true, error: null };
}

export function PortalClientLayout({ children }: { children: ReactNode }) {
  const params = useParams({ strict: false });
  const clientId = typeof params.clientId === 'string' ? params.clientId : '';
  const { me } = useSession();
  const { client, ready, error } = useAuthorizedClient(clientId);
  useClientSwitchHygiene(me.me.userId, clientId);

  if (!ready) return <Spinner />;
  if (error !== null) {
    return <ErrorState message="No se pudo cargar la lista de clientes." />;
  }
  if (client === null) {
    return (
      <>
        <PortalHeader />
        <main className="portal-main">
          <EmptyState
            title="Cliente no disponible"
            hint="No tienes acceso a este cliente o no existe. Si crees que es un error, contacta al estudio."
          />
          <p style={{ textAlign: 'center' }}>
            <Link to="/portal">Volver a mis clientes</Link>
          </p>
        </main>
      </>
    );
  }
  return (
    <PortalClientSurface clientId={clientId} client={client}>
      {children}
    </PortalClientSurface>
  );
}

/**
 * Authenticated client surface: header + segmented tabs + the active page.
 * Owns the per-route document title («Materiales — <cliente>») because only
 * here the client name and the open tab are known together.
 */
function PortalClientSurface({ clientId, client, children }: { clientId: string; client: PortalClientView; children: ReactNode }) {
  const location = useLocation();
  const afterId = location.pathname.slice(location.pathname.indexOf(clientId) + clientId.length);
  const openTab = TABS.find((tab) => tab.segment === (afterId.split('/')[1] ?? ''));
  useDocumentTitle(openTab !== undefined ? `${openTab.label} — ${client.name}` : `Portal — ${client.name}`);
  return (
    <div className="portal-shell">
      <PortalHeader clientName={client.name} />
      <main className="portal-main">
        <ClientTabs clientId={clientId} />
        {children}
      </main>
    </div>
  );
}

/** /portal — picker over the caller's authorized clients (FR-002). */
export function PortalHomePage() {
  const { me } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const clients = useClients(me.me.userId);
  const acceptedOnce = useRef(false);

  const acceptInvitations = useAcceptInvitations((clientIds) => {
    // New membership → the clients list must show the new client now.
    if (clientIds.length > 0) {
      void queryClient.invalidateQueries({ queryKey: clientsKey(me.me.userId) });
    }
  });

  useEffect(() => {
    // FR-001: an invited person accepts by simply signing in — acceptance is
    // server-side, once per portal entry, and never blocks first paint.
    if (me.me.role === 'member' && !acceptedOnce.current) {
      acceptedOnce.current = true;
      void acceptInvitations.mutateAsync().catch(() => undefined);
    }
  }, [me.me.role, acceptInvitations]);

  useEffect(() => {
    // A member with exactly one client goes straight in (deep-linkable).
    if (clients.data !== undefined && me.me.role !== 'admin' && clients.data.items.length === 1) {
      const only = clients.data.items[0];
      if (only !== undefined) {
        void navigate({ to: '/portal/$clientId/materials', params: { clientId: only.id }, replace: true });
      }
    }
  }, [clients.data, me.me.role, navigate]);

  if (clients.isPending) return <Spinner />;
  if (clients.isError) return <ErrorState message="No se pudo cargar la lista de clientes." />;

  const items = clients.data.items;
  if (items.length === 0) {
    return (
      <EmptyState
        title="Aún no tienes clientes asignados"
        hint="Cuando el estudio te invite, tu cliente aparecerá aquí automáticamente."
      />
    );
  }
  return (
    <ul className="client-picker" data-testid="client-picker">
      {items.map((client) => (
        <li key={client.id} className="card client-row">
          <div>
            <h3>{client.name}</h3>
            <span className="material-meta">
              espacio {client.workspaceId.slice(0, 8)}… · versión {client.projectionVersion}
            </span>
          </div>
          <div className="client-actions">
            <Link className="btn btn-sm" to="/portal/$clientId/materials" params={{ clientId: client.id }}>
              Abrir portal
            </Link>
            {me.me.role === 'admin' && (
              <Link className="btn btn-sm" to="/admin/clients/$clientId" params={{ clientId: client.id }}>
                Administrar
              </Link>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

