/**
 * Session feature (contracts.md §3/§8): `useMe` feeds a RequireAuth guard
 * (401 → /login with a validated `redirect` param), RequireAdmin for the
 * admin area, and the logout flow wipes the whole query cache so nothing
 * crosses a session boundary.
 */

import { createContext, useContext } from 'react';
import { Navigate, useLocation } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { MeInfo } from '@videomaker/customer-assets';
import { isUnauthorized } from '../../api/client';
import { meKey, wipePortalCache } from '../../api/keys';
import { useMe } from '../../api/hooks';
import { signOutSession } from '../../api/client';
import { Spinner } from '../../components/ui/primitives';

interface MeContextValue {
  me: MeInfo;
}

const MeContext = createContext<MeContextValue | null>(null);

export function useSession(): MeContextValue {
  const value = useContext(MeContext);
  if (value === null) throw new Error('useSession outside RequireAuth');
  return value;
}

/** Home route per role (admin dashboard vs client portal picker). */
export function roleHome(me: MeInfo): string {
  return me.me.role === 'admin' ? '/admin/clients' : '/portal';
}

/** Only allows same-origin paths (`/...`, never `//` or schemes). */
export function safeRedirectTarget(raw: string | undefined): string | null {
  if (raw === undefined || raw.length === 0) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  return raw;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <Spinner label="Verificando sesión…" />;
  if (me.isError) {
    if (isUnauthorized(me.error)) {
      return <Navigate to="/login" search={{ redirect: location.pathname }} replace />;
    }
    throw me.error;
  }
  if (me.data === undefined) return <Spinner />;
  return <MeContext.Provider value={{ me: me.data }}>{children}</MeContext.Provider>;
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { me } = useSession();
  if (me.me.role !== 'admin') {
    return (
      <div className="state" role="alert">
        <h3>Acceso restringido</h3>
        <p>Esta sección requiere una cuenta de administración aprovisionada.</p>
      </div>
    );
  }
  return <>{children}</>;
}

export function useLogout(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await signOutSession();
    wipePortalCache(queryClient);
    queryClient.removeQueries({ queryKey: meKey });
  };
}

export function LogoutButton() {
  const logout = useLogout();
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={() => {
        void logout().then(() => {
          window.location.assign('/login');
        });
      }}
    >
      Cerrar sesión
    </button>
  );
}
