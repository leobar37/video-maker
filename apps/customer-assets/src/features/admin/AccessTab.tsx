/**
 * Admin access tab (FR-002/FR-009): memberships, invitations and agent keys
 * per client. All operations are server functions that re-check the admin
 * session; agent keys are shown EXACTLY ONCE at issuance (the raw key is
 * never listed again).
 */

import { useState } from 'react';
import { z } from 'zod';
import type { AccessSnapshot } from './server';
import {
  useAccess,
  useInviteMember,
  useIssueAgentKey,
  useMintAccessLink,
  useRevokeGrant,
  useRevokeInvitation,
  useRevokeMembership,
} from '../../api/hooks';
import { FormActions, TextField, validateWith } from '../../components/forms/fields';
import { Badge, EmptyState, ErrorBanner, Spinner, formatDate, formatDateTime } from '../../components/ui/primitives';
import { useSession } from '../auth/session';

const AGENT_SCOPE_OPTIONS = [
  'clients:read',
  'clients:write',
  'materials:read',
  'materials:write',
  'deliveries:read',
  'deliveries:write',
  'access:write',
] as const;

const ACCESS_LINK_TTL_OPTIONS = ['30m', '1h', '48h', '7d', '30d'] as const;

const inviteSchema = z.object({ email: z.string().trim().min(1, 'Escribe el email.').email('Email inválido.') });

function InviteForm({ clientId }: { clientId: string }) {
  const { me } = useSession();
  const invite = useInviteMember(me.me.userId, clientId);
  const [email, setEmail] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setFailure(null);
    setDone(null);
    const outcome = validateWith(inviteSchema, { email });
    if ('fieldErrors' in outcome) {
      setFieldErrors(outcome.fieldErrors);
      return;
    }
    setFieldErrors({});
    invite.mutate(
      { email: outcome.data.email },
      {
        onSuccess: (data) => {
          setDone(`Invitación creada para ${data.email}.`);
          setEmail('');
        },
        onError: (error) => setFailure(error instanceof Error ? error.message : 'No se pudo invitar.'),
      },
    );
  };

  return (
    <section className="card" aria-label="Invitar miembro" data-testid="invite-form">
      <h3>Invitar miembro</h3>
      <p className="field-hint">
        La persona recibe acceso al iniciar sesión con su email (enlace mágico). La invitación caduca en 7 días.
      </p>
      {failure !== null && <ErrorBanner message={failure} />}
      {done !== null && <p className="badge badge-ok" role="status">{done}</p>}
      <form onSubmit={submit} noValidate>
        <TextField
          label="Email de la persona"
          name="invite-email"
          type="email"
          inputMode="email"
          value={email}
          onChange={setEmail}
          error={fieldErrors.email}
          required
        />
        <FormActions>
          <button type="submit" className="btn btn-primary" disabled={invite.isPending}>
            {invite.isPending ? 'Invitando…' : 'Invitar'}
          </button>
        </FormActions>
      </form>
    </section>
  );
}

function KeyIssuer({ clientId }: { clientId: string }) {
  const { me } = useSession();
  const issue = useIssueAgentKey(me.me.userId, clientId);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [workspaceWide, setWorkspaceWide] = useState(false);
  const [scopes, setScopes] = useState<string[]>(['materials:read']);
  const [failure, setFailure] = useState<string | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const toggleScope = (scope: string) => {
    setScopes((current) => (current.includes(scope) ? current.filter((entry) => entry !== scope) : [...current, scope]));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setFailure(null);
    setIssued(null);
    if (scopes.length === 0) {
      setFailure('Elige al menos un scope.');
      return;
    }
    issue.mutate(
      { email, name, scopes, workspaceWide },
      {
        onSuccess: (data) => {
          setIssued(data.key);
          setCopied(false);
        },
        onError: (error) => setFailure(error instanceof Error ? error.message : 'No se pudo emitir la key.'),
      },
    );
  };

  return (
    <section className="card" aria-label="Emitir key de agente" data-testid="agent-key-form">
      <h3>Keys de agente (CLI)</h3>
      <p className="field-hint">
        La key se muestra UNA sola vez; los scopes viven server-side y se pueden revocar en cualquier momento.
      </p>
      {failure !== null && <ErrorBanner message={failure} />}
      {issued !== null && (
        <div role="status" data-testid="issued-key">
          <p style={{ fontWeight: 600 }}>Copia ahora — no volverá a mostrarse:</p>
          <pre className="key-once">{issued}</pre>
          <FormActions>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                void navigator.clipboard?.writeText(issued).then(() => setCopied(true));
              }}
            >
              {copied ? 'Copiada ✓' : 'Copiar key'}
            </button>
          </FormActions>
        </div>
      )}
      <form onSubmit={submit} noValidate>
        <TextField label="Email del agente (usuario existente o nuevo)" name="agent-email" type="email" inputMode="email" value={email} onChange={setEmail} required />
        <TextField label="Nombre de la key" name="agent-key-name" value={name} onChange={setName} hint="p. ej. integrador-estudio" required />
        <fieldset style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius)' }}>
          <legend className="field-label">Scopes (server-side)</legend>
          {AGENT_SCOPE_OPTIONS.map((scope) => (
            <label key={scope} style={{ display: 'block' }}>
              <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} aria-label={`Scope ${scope}`} />{' '}
              {scope}
            </label>
          ))}
        </fieldset>
        <label style={{ display: 'block', margin: '0.6rem 0' }}>
          <input type="checkbox" checked={workspaceWide} onChange={(event) => setWorkspaceWide(event.target.checked)} aria-label="Grant de todo el workspace" />{' '}
          Todo el workspace (integrador; sin esto queda limitado a este cliente)
        </label>
        <FormActions>
          <button type="submit" className="btn btn-primary" disabled={issue.isPending}>
            {issue.isPending ? 'Emitiendo…' : 'Emitir key'}
          </button>
        </FormActions>
      </form>
    </section>
  );
}

function AccessLinkIssuer({ clientId }: { clientId: string }) {
  const { me } = useSession();
  const mint = useMintAccessLink(me.me.userId, clientId);
  const [email, setEmail] = useState('');
  const [expiresIn, setExpiresIn] = useState<string>('7d');
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [minted, setMinted] = useState<{ url: string; expiresAt: number } | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setFailure(null);
    setMinted(null);
    setCopied(false);
    const outcome = validateWith(inviteSchema, { email });
    if ('fieldErrors' in outcome) {
      setFailure(outcome.fieldErrors.email ?? 'Email inválido.');
      return;
    }
    mint.mutate(
      { email: outcome.data.email, expiresIn },
      {
        onSuccess: (data) => {
          setMinted({ url: data.url, expiresAt: data.expiresAt });
          setEmail('');
        },
        onError: (error) => setFailure(error instanceof Error ? error.message : 'No se pudo mintear el link.'),
      },
    );
  };

  return (
    <section className="card" aria-label="Link de acceso" data-testid="access-link-form">
      <h3>Link de acceso (single-use)</h3>
      <p className="field-hint">
        Genera un enlace de login de UN solo uso con vencimiento para entregar por tu canal (WhatsApp, etc.). El
        portal no lo manda por email ni lo vuelve a mostrar.
      </p>
      {failure !== null && <ErrorBanner message={failure} />}
      {minted !== null && (
        <div role="status" data-testid="minted-access-link">
          <p style={{ fontWeight: 600 }}>
            Copia ahora — no volverá a mostrarse (vence: {formatDateTime(minted.expiresAt)}):
          </p>
          <pre className="key-once">{minted.url}</pre>
          <FormActions>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                void navigator.clipboard?.writeText(minted.url).then(() => setCopied(true));
              }}
            >
              {copied ? 'Copiado ✓' : 'Copiar enlace'}
            </button>
          </FormActions>
        </div>
      )}
      <form onSubmit={submit} noValidate>
        <TextField label="Email del miembro" name="access-link-email" type="email" inputMode="email" value={email} onChange={setEmail} required />
        <label style={{ display: 'block', margin: '0.6rem 0' }}>
          <span className="field-label">Vencimiento</span>{' '}
          <select className="field-select" value={expiresIn} onChange={(event) => setExpiresIn(event.target.value)} aria-label="Vencimiento del link">
            {ACCESS_LINK_TTL_OPTIONS.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
        <FormActions>
          <button type="submit" className="btn btn-primary" disabled={mint.isPending}>
            {mint.isPending ? 'Minteando…' : 'Generar link'}
          </button>
        </FormActions>
      </form>
    </section>
  );
}

export function AccessTab({ clientId }: { clientId: string }) {
  const { me } = useSession();
  const access = useAccess(me.me.userId, clientId);
  const revokeMembership = useRevokeMembership(me.me.userId, clientId);
  const revokeInvitation = useRevokeInvitation(me.me.userId, clientId);
  const revokeGrant = useRevokeGrant(me.me.userId, clientId);

  if (access.isPending) return <Spinner label="Cargando accesos…" />;
  if (access.isError) return <ErrorBanner message={access.error instanceof Error ? access.error.message : 'Error de accesos.'} />;

  const data: AccessSnapshot = access.data;
  return (
    <div data-testid="access-tab">
      <InviteForm clientId={clientId} />
      <AccessLinkIssuer clientId={clientId} />
      <section className="card" aria-label="Membresías">
        <h3>Membresías</h3>
        {data.memberships.length === 0 ? (
          <EmptyState title="Sin miembros activos" hint="Invita a la primera persona de este cliente." />
        ) : (
          <div className="table-scroll">
            <table className="data" data-testid="membership-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Estado</th>
                  <th>Desde</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.memberships.map((membership) => (
                  <tr key={membership.id}>
                    <td>{membership.email}</td>
                    <td>{membership.status === 'active' ? <Badge tone="ok">activa</Badge> : <Badge tone="hidden">revocada</Badge>}</td>
                    <td>{formatDate(membership.createdMs)}</td>
                    <td>
                      {membership.status === 'active' && (
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={revokeMembership.isPending}
                          onClick={() => revokeMembership.mutate(membership.id)}
                          aria-label={`Revocar acceso de ${membership.email}`}
                        >
                          Revocar
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card" aria-label="Invitaciones">
        <h3>Invitaciones</h3>
        {data.invitations.length === 0 ? (
          <EmptyState title="Sin invitaciones" />
        ) : (
          <div className="table-scroll">
            <table className="data" data-testid="invitation-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Estado</th>
                  <th>Expira</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.invitations.map((invitation) => (
                  <tr key={invitation.id}>
                    <td>{invitation.email}</td>
                    <td>
                      <Badge tone={invitation.status === 'pending' ? 'warn' : 'plain'}>{invitation.status}</Badge>
                    </td>
                    <td>{formatDateTime(invitation.expiresMs)}</td>
                    <td>
                      {invitation.status === 'pending' && (
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={revokeInvitation.isPending}
                          onClick={() => revokeInvitation.mutate(invitation.id)}
                          aria-label={`Revocar invitación de ${invitation.email}`}
                        >
                          Revocar
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <KeyIssuer clientId={clientId} />
      <section className="card" aria-label="Grants de agente">
        <h3>Grants de agente</h3>
        {data.grants.length === 0 ? (
          <EmptyState title="Sin keys de agente" />
        ) : (
          <div className="table-scroll">
            <table className="data" data-testid="grant-table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Alcance</th>
                  <th>Scopes</th>
                  <th>Estado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.grants.map((grant) => (
                  <tr key={grant.id}>
                    <td>
                      {grant.keyName}
                      {grant.keyStart !== null && <span className="material-meta"> ({grant.keyStart}…)</span>}
                    </td>
                    <td>{grant.clientIds === null ? 'todo el workspace' : `${grant.clientIds.length} cliente(s)`}</td>
                    <td>{grant.scopes.join(', ')}</td>
                    <td>
                      {grant.revokedMs !== null ? (
                        <Badge tone="hidden">revocado</Badge>
                      ) : grant.keyEnabled ? (
                        <Badge tone="ok">activa</Badge>
                      ) : (
                        <Badge tone="warn">key deshabilitada</Badge>
                      )}
                    </td>
                    <td>
                      {grant.revokedMs === null && (
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={revokeGrant.isPending}
                          onClick={() => revokeGrant.mutate(grant.id)}
                          aria-label={`Revocar grant de ${grant.keyName}`}
                        >
                          Revocar
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="field-hint">Revocar corta el acceso del agente en el siguiente request.</p>
      </section>
    </div>
  );
}
