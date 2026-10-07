import { createFileRoute } from '@tanstack/react-router';
import { GuestRequestPage } from '../features/requests/RequestPage';
import '../styles/portal.css';

/**
 * Guest-direct request page (P-102, R-2; contracts.md §7): public route
 * OUTSIDE the `_app` auth layout — no RequireAuth, no session provider, no
 * redirect. The capability token in the path is the ONLY credential, so this
 * route must never trigger or render a login prompt. no-store via head meta:
 * no request state may leak between tokens (NFR-104).
 */
export const Route = createFileRoute('/request/$token')({
  // no-store: no request state may leak between tokens (NFR-104).
  headers: () => ({ 'cache-control': 'no-store' }),
  component: RequestTokenRoute,
});

function RequestTokenRoute() {
  const { token } = Route.useParams();
  return <GuestRequestPage token={token} />;
}
