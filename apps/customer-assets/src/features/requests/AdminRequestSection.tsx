/**
 * Admin request cards (P-102, R-2; contracts.md §7 additive ·
 * customer-assets-requests): per-project upload requests with creation form
 * (limits pickers), minted-link copy shown EXACTLY ONCE (the URL is never
 * persisted, logged or re-displayed), and close. Everything goes through the
 * SAME audited /api/v1 endpoints the SDK exposes — no side door.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { UploadRequestLinkView, UploadRequestView } from '@videomaker/customer-assets';
import { errorMessage, portal } from '../../api/client';
import { clientScopeKey } from '../../api/keys';
import { FormActions, TextField, validateWith } from '../../components/forms/fields';
import { Badge, EmptyState, ErrorBanner, Spinner, formatBytes, formatDateTime } from '../../components/ui/primitives';
import { useSession } from '../auth/session';

export function requestsKey(userId: string, projectId: string) {
  return [...clientScopeKey(userId, 'project'), projectId, 'requests'] as const;
}

const MIB = 1024 * 1024;

/** `<n>` | `<n>MiB` | `<n>GiB` (accepts MiB/GiB/MB/GB, case-insensitive). */
function parseMaxBytesInput(raw: string): number | undefined {
  const match = /^(\d+)\s*(MiB|GiB|Mib|mib|M|G)?$/i.exec(raw.trim());
  if (match === null) return undefined;
  const amount = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(amount) || amount <= 0) return undefined;
  const unit = (match[2] ?? '').toLowerCase();
  if (unit === 'gib' || unit === 'g') return amount * 1024 * MIB;
  if (unit === 'mib' || unit === 'm') return amount * MIB;
  return amount;
}

const createRequestSchema = z.object({
  title: z.string().trim().min(1, 'Escribe el título del pedido.').max(200, 'Máximo 200 caracteres.'),
  instructions: z.string().trim().max(2000, 'Máximo 2000 caracteres.'),
  maxFiles: z
    .string()
    .trim()
    .regex(/^\d+$/, 'Cantidad de archivos inválida.')
    .refine((v) => Number.parseInt(v, 10) >= 1 && Number.parseInt(v, 10) <= 500, 'Entre 1 y 500 archivos.'),
  maxBytes: z
    .string()
    .trim()
    .refine((v) => parseMaxBytesInput(v) !== undefined, 'Usá un valor como 512MiB o 2GiB.'),
  expiresIn: z
    .string()
    .trim()
    .regex(/^(\d+)(m|h|d)$/, 'Usá <n>m, <n>h o <n>d (ej. 30m, 48h, 7d).'),
});

const STATE_LABEL: Record<UploadRequestView['state'], { label: string; tone: 'ok' | 'plain' | 'hidden' }> = {
  open: { label: 'Abierto', tone: 'ok' },
  fulfilled: { label: 'Completo', tone: 'plain' },
  closed: { label: 'Cerrado', tone: 'hidden' },
  expired: { label: 'Vencido', tone: 'hidden' },
};

function CreateRequestForm({ clientId, projectId }: { clientId: string; projectId: string }) {
  const queryClient = useQueryClient();
  const { me } = useSession();
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [maxFiles, setMaxFiles] = useState('10');
  const [maxBytes, setMaxBytes] = useState('2GiB');
  const [expiresIn, setExpiresIn] = useState('7d');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (input: { title: string; instructions?: string; maxFiles: number; maxBytes: number; expiresIn: string }) =>
      portal.createRequest(projectId, input),
    onSuccess: () => {
      setTitle('');
      setInstructions('');
      setFailure(null);
      void queryClient.invalidateQueries({ queryKey: requestsKey(me.me.userId, projectId) });
    },
    onError: (error) => setFailure(errorMessage(error)),
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setFailure(null);
    const outcome = validateWith(createRequestSchema, { title, instructions, maxFiles, maxBytes, expiresIn });
    if ('fieldErrors' in outcome) {
      setFieldErrors(outcome.fieldErrors);
      return;
    }
    setFieldErrors({});
    const parsedBytes = parseMaxBytesInput(outcome.data.maxBytes)!;
    create.mutate({
      title: outcome.data.title,
      ...(outcome.data.instructions.length > 0 ? { instructions: outcome.data.instructions } : {}),
      maxFiles: Number.parseInt(outcome.data.maxFiles, 10),
      maxBytes: parsedBytes,
      expiresIn: outcome.data.expiresIn,
    });
  };

  return (
    <section className="card" aria-label="Crear pedido de material" data-testid="request-create-form">
      <h3>Crear pedido de material</h3>
      <p className="field-hint">
        Define título, límites y vencimiento. Los límites se validan contra la cuota del cliente; el enlace se genera
        después, por pedido.
      </p>
      {failure !== null && <ErrorBanner message={failure} />}
      <form onSubmit={submit} noValidate>
        <TextField label="Título" name="request-title" value={title} onChange={setTitle} error={fieldErrors.title} required />
        <TextField
          label="Instrucciones (opcional)"
          name="request-instructions"
          value={instructions}
          onChange={setInstructions}
          error={fieldErrors.instructions}
          hint="Qué necesita el estudio; lo ve el invitado."
        />
        <div className="field-row">
          <TextField
            label="Máximo de archivos"
            name="request-max-files"
            value={maxFiles}
            onChange={setMaxFiles}
            inputMode="numeric"
            error={fieldErrors.maxFiles}
            hint="Default 10."
            required
          />
          <TextField
            label="Tamaño máximo total"
            name="request-max-bytes"
            value={maxBytes}
            onChange={setMaxBytes}
            error={fieldErrors.maxBytes}
            hint="Default 2GiB; nunca más que la cuota del cliente."
            required
          />
          <TextField
            label="Vence en"
            name="request-expires-in"
            value={expiresIn}
            onChange={setExpiresIn}
            error={fieldErrors.expiresIn}
            hint="30m a 30d (ej. 48h, 7d). Default 7d."
            required
          />
        </div>
        <FormActions>
          <button type="submit" className="btn btn-primary" disabled={create.isPending}>
            {create.isPending ? 'Creando…' : 'Crear pedido'}
          </button>
        </FormActions>
      </form>
    </section>
  );
}

/** The minted URL is shown exactly once, in this session, and never stored. */
function MintedLinkOnce({ link, onDismiss }: { link: UploadRequestLinkView; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="key-once" data-testid="request-link-once">
      <strong>Enlace del invitado (se muestra una sola vez):</strong>
      <div className="material-row">
        <code style={{ wordBreak: 'break-all' }}>{link.url}</code>
      </div>
      <FormActions>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => void copy()}>
          {copied ? 'Copiado ✓' : 'Copiar enlace'}
        </button>
        <button type="button" className="btn btn-sm" onClick={onDismiss}>
          Ya lo guardé, ocultar
        </button>
      </FormActions>
      <p className="field-hint">
        Entregalo por tu canal (WhatsApp, email propio). Vence el {formatDateTime(link.expiresAt)} ·
        límite {link.limits.maxFiles} archivos / {formatBytes(link.limits.maxBytes)}. Regenerar revoca este enlace.
      </p>
    </div>
  );
}

function RequestCard({ clientId, projectId, request }: { clientId: string; projectId: string; request: UploadRequestView }) {
  const queryClient = useQueryClient();
  const { me } = useSession();
  const [link, setLink] = useState<UploadRequestLinkView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: requestsKey(me.me.userId, projectId) });
  };

  const mint = useMutation({
    mutationFn: () => portal.mintRequestLink(request.id, {}),
    onSuccess: (minted) => {
      setLink(minted);
      setFailure(null);
      invalidate();
    },
    onError: (error) => setFailure(errorMessage(error)),
  });

  const close = useMutation({
    mutationFn: () => portal.closeRequest(request.id, { reason: 'Cerrado desde el panel' }),
    onSuccess: () => {
      setFailure(null);
      invalidate();
    },
    onError: (error) => setFailure(errorMessage(error)),
  });

  const state = STATE_LABEL[request.state];

  return (
    <section className="card" aria-label={`Pedido ${request.title}`} data-testid="request-card" data-request-state={request.state}>
      <h3 style={{ marginBottom: '0.25rem' }}>{request.title}</h3>
      {request.instructions !== null && <p className="field-hint">{request.instructions}</p>}
      <p>
        <Badge tone={state.tone}>{state.label}</Badge>{' '}
        <Badge tone="plain">
          {request.usedFiles}/{request.maxFiles} archivos · {formatBytes(request.usedBytes)}/{formatBytes(request.maxBytes)}
        </Badge>{' '}
        <Badge tone="warn">vence {formatDateTime(request.expiresAt)}</Badge>
      </p>
      <p className="material-meta" data-testid="request-remaining-admin">
        Restante: {request.remainingFiles} archivos · {formatBytes(request.remainingBytes)}
      </p>
      {failure !== null && <ErrorBanner message={failure} />}
      {link !== null && <MintedLinkOnce link={link} onDismiss={() => setLink(null)} />}
      <FormActions>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          data-testid="request-mint-button"
          disabled={request.state !== 'open' || mint.isPending}
          onClick={() => mint.mutate()}
        >
          {mint.isPending ? 'Generando…' : 'Generar enlace'}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger"
          data-testid="request-close-button"
          disabled={(request.state !== 'open' && request.state !== 'fulfilled') || close.isPending}
          onClick={() => close.mutate()}
        >
          {close.isPending ? 'Cerrando…' : 'Cerrar pedido'}
        </button>
      </FormActions>
    </section>
  );
}

export function ProjectRequests({ clientId, projectId }: { clientId: string; projectId: string }) {
  const { me } = useSession();
  const requests = useQuery({
    queryKey: requestsKey(me.me.userId, projectId),
    queryFn: () => portal.listRequests(projectId),
  });

  if (requests.isPending) return <Spinner label="Cargando pedidos…" />;
  if (requests.isError) {
    return (
      <ErrorBanner
        message={requests.error instanceof Error ? requests.error.message : 'Error de pedidos.'}
      />
    );
  }

  const items = requests.data.items;
  return (
    <div data-testid="project-requests">
      <CreateRequestForm clientId={clientId} projectId={projectId} />
      <h4 style={{ margin: '0.75rem 0 0.35rem' }}>Pedidos</h4>
      {items.length === 0 ? (
        <EmptyState title="Sin pedidos" hint="Creá el primer pedido de material para este proyecto." />
      ) : (
        items.map((request) => <RequestCard key={request.id} clientId={clientId} projectId={projectId} request={request} />)
      )}
    </div>
  );
}
