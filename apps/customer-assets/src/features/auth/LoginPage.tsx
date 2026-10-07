/**
 * /login (contracts.md §8): magic-link request with a NEUTRAL response —
 * the UI never reveals whether an email is registered (contracts.md §3).
 * Delivery itself is a server concern; without a configured provider the
 * request fails into a generic retryable state, never a fake success.
 * Route wiring (validateSearch etc.) lives in src/routes/login.tsx.
 */

import { useState } from 'react';
import { z } from 'zod';
import { errorMessage, isUnauthorized, requestMagicLink } from '../../api/client';
import { useMe } from '../../api/hooks';
import { FormActions, TextField, validateWith } from '../../components/forms/fields';
import { ErrorBanner, IconPlay } from '../../components/ui/primitives';
import { useDocumentTitle } from '../../components/ui/head';
import { roleHome } from './session';

const loginSchema = z.object({
  email: z.string().trim().min(1, 'Escribe tu email.').email('Email inválido.'),
});

type LoginPhase = 'editing' | 'sending' | 'sent' | 'failed';

export function LoginPage({ redirectTarget }: { redirectTarget: string | null }) {
  useDocumentTitle('Acceder — Portal de clientes');
  const me = useMe();

  // Already signed in: go straight to the destination (or the role's home).
  // A full location change (not client Navigate) keeps the target honest for
  // any deep link string without fighting the typed-route literals.
  if (me.isPending) return null;
  if (me.data !== undefined) {
    window.location.replace(redirectTarget ?? roleHome(me.data));
    return null;
  }
  if (me.isError && !isUnauthorized(me.error)) throw me.error;

  return <LoginCard redirectTarget={redirectTarget} />;
}

function LoginCard({ redirectTarget }: { redirectTarget: string | null }) {
  const [email, setEmail] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<LoginPhase>('editing');
  const [failureMessage, setFailureMessage] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setFailureMessage(null);
    const outcome = validateWith(loginSchema, { email });
    if ('fieldErrors' in outcome) {
      setFieldErrors(outcome.fieldErrors);
      return;
    }
    setFieldErrors({});
    setPhase('sending');
    requestMagicLink(outcome.data.email, redirectTarget ?? undefined)
      .then(() => setPhase('sent'))
      .catch((error: unknown) => {
        setPhase('failed');
        setFailureMessage(errorMessage(error));
      });
  };

  return (
    <main className="login-wrap">
      <div className="card login-card" data-testid="login-card">
        <span className="login-brand" aria-hidden="true">
          <IconPlay size={22} />
        </span>
        <h1 className="login-title">Portal de clientes</h1>
        <p className="login-lede">
          Acceso solo por invitación. Escribe tu email y te enviaremos un enlace de sesión de un solo uso.
        </p>
        {phase === 'sent' ? (
          <div className="state" role="status" data-testid="login-sent">
            <h3>Revisa tu email</h3>
            <p>
              Si la dirección está registrada, recibirás un enlace para entrar. El enlace caduca en pocos
              minutos y solo puede usarse una vez.
            </p>
            <FormActions>
              <button type="button" className="btn" onClick={() => setPhase('editing')}>
                Usar otro email
              </button>
            </FormActions>
          </div>
        ) : (
          <form onSubmit={submit} noValidate data-testid="login-form">
            {failureMessage !== null && <ErrorBanner message={`No se pudo enviar el enlace. ${failureMessage}`} />}
            <TextField
              label="Email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              value={email}
              onChange={setEmail}
              placeholder="tu@email.com"
              error={fieldErrors.email}
            />
            <FormActions>
              <button type="submit" className="btn btn-primary" disabled={phase === 'sending'}>
                {phase === 'sending' ? 'Enviando…' : 'Enviar enlace de acceso'}
              </button>
            </FormActions>
          </form>
        )}
      </div>
    </main>
  );
}
