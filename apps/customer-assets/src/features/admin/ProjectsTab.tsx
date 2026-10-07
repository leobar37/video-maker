/**
 * Admin Projects tab (P-101/R-1 + P-102/R-2; contracts.md §7 additive ·
 * customer-assets-requests): per-client PortalProject cards with per-project
 * material counts and the project's upload requests (create with limits,
 * mint-once guest link, close). Creation/rename/request operations are
 * admin-human-only and call the SAME audited /api/v1 endpoints the SDK
 * exposes — no side door.
 *
 * Self-contained hooks (query key follows the clientScopeKey convention of
 * api/keys.ts) so the v1 api/hooks.ts surface stays untouched.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { PortalProjectView } from '@videomaker/customer-assets';
import { errorMessage, portal } from '../../api/client';
import { clientScopeKey } from '../../api/keys';
import { FormActions, TextField, validateWith } from '../../components/forms/fields';
import { Badge, EmptyState, ErrorBanner, Spinner } from '../../components/ui/primitives';
import { useSession } from '../auth/session';
import { ProjectRequests } from '../requests/AdminRequestSection';

function projectsKey(userId: string, clientId: string) {
  return [...clientScopeKey(userId, clientId), 'projects'] as const;
}

const createProjectSchema = z.object({
  studioProjectId: z
    .string()
    .trim()
    .min(1, 'Escribe el id del proyecto de Studio.')
    .max(128, 'Máximo 128 caracteres.')
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Usa letras, números, punto, guion, dos puntos o guion bajo.'),
  name: z.string().trim().min(1, 'Escribe el título visible.').max(200, 'Máximo 200 caracteres.'),
});

const renameSchema = z.object({
  name: z.string().trim().min(1, 'Escribe el título visible.').max(200, 'Máximo 200 caracteres.'),
});

function CreateProjectForm({ clientId }: { clientId: string }) {
  const queryClient = useQueryClient();
  const { me } = useSession();
  const [studioProjectId, setStudioProjectId] = useState('');
  const [name, setName] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (input: { studioProjectId: string; name: string }) =>
      portal.createProject(clientId, input),
    onSuccess: (project) => {
      setDone(`Proyecto «${project.name}» proyectado.`);
      setStudioProjectId('');
      setName('');
      void queryClient.invalidateQueries({ queryKey: projectsKey(me.me.userId, clientId) });
    },
    onError: (error) => setFailure(errorMessage(error)),
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setFailure(null);
    setDone(null);
    const outcome = validateWith(createProjectSchema, { studioProjectId, name });
    if ('fieldErrors' in outcome) {
      setFieldErrors(outcome.fieldErrors);
      return;
    }
    setFieldErrors({});
    create.mutate(outcome.data);
  };

  return (
    <section className="card" aria-label="Proyectar proyecto de Studio" data-testid="project-create-form">
      <h3>Proyectar proyecto de Studio</h3>
      <p className="field-hint">
        Registra un proyecto EXISTENTE de Studio para este cliente (puntero canónico; el portal nunca escribe en Studio).
      </p>
      {failure !== null && <ErrorBanner message={failure} />}
      {done !== null && <p className="badge badge-ok" role="status">{done}</p>}
      <form onSubmit={submit} noValidate>
        <TextField
          label="Id del proyecto en Studio"
          name="project-studio-id"
          value={studioProjectId}
          onChange={setStudioProjectId}
          error={fieldErrors.studioProjectId}
          hint="p. ej. proj-brand-film-1"
          required
        />
        <TextField
          label="Título visible"
          name="project-display-name"
          value={name}
          onChange={setName}
          error={fieldErrors.name}
          hint="Solo se guarda este campo de display; nada más viaja de Studio."
          required
        />
        <FormActions>
          <button type="submit" className="btn btn-primary" disabled={create.isPending}>
            {create.isPending ? 'Proyectando…' : 'Proyectar proyecto'}
          </button>
        </FormActions>
      </form>
    </section>
  );
}

function ProjectCard({ clientId, project }: { clientId: string; project: PortalProjectView }) {
  const queryClient = useQueryClient();
  const { me } = useSession();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(project.name);
  const [failure, setFailure] = useState<string | null>(null);

  const rename = useMutation({
    mutationFn: (next: string) => portal.renameProject(project.id, { name: next }),
    onSuccess: () => {
      setRenaming(false);
      void queryClient.invalidateQueries({ queryKey: projectsKey(me.me.userId, clientId) });
    },
    onError: (error) => setFailure(errorMessage(error)),
  });

  const submitRename = (event: React.FormEvent) => {
    event.preventDefault();
    setFailure(null);
    const outcome = validateWith(renameSchema, { name });
    if ('fieldErrors' in outcome) {
      setFailure(outcome.fieldErrors.name ?? 'Título inválido.');
      return;
    }
    rename.mutate(outcome.data.name);
  };

  return (
    <section className="card" aria-label={`Proyecto ${project.name}`} data-testid="project-card">
      <h3 style={{ marginBottom: '0.25rem' }}>{project.name}</h3>
      <p className="material-meta">
        Studio: <code>{project.studioProjectId}</code>
      </p>
      <p>
        <Badge tone="plain">{project.materialCount ?? 0} materiales</Badge>
      </p>
      <ProjectRequests clientId={clientId} projectId={project.id} />
      {failure !== null && <ErrorBanner message={failure} />}
      {renaming ? (
        <form onSubmit={submitRename} noValidate data-testid="project-rename-form">
          <TextField label="Nuevo título" name={`rename-${project.id}`} value={name} onChange={setName} required />
          <FormActions>
            <button type="submit" className="btn btn-primary btn-sm" disabled={rename.isPending}>
              {rename.isPending ? 'Guardando…' : 'Guardar'}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setRenaming(false);
                setName(project.name);
                setFailure(null);
              }}
            >
              Cancelar
            </button>
          </FormActions>
        </form>
      ) : (
        <FormActions>
          <button
            type="button"
            className="btn btn-sm"
            data-testid="project-rename-button"
            onClick={() => setRenaming(true)}
          >
            Renombrar
          </button>
        </FormActions>
      )}
    </section>
  );
}

export function ProjectsTab({ clientId }: { clientId: string }) {
  const { me } = useSession();
  const projects = useQuery({
    queryKey: projectsKey(me.me.userId, clientId),
    queryFn: () => portal.listProjects(clientId),
  });

  if (projects.isPending) return <Spinner label="Cargando proyectos…" />;
  if (projects.isError) {
    return <ErrorBanner message={projects.error instanceof Error ? projects.error.message : 'Error de proyectos.'} />;
  }

  const items = projects.data.items;
  return (
    <div className="portal-split" data-testid="projects-tab">
      <CreateProjectForm clientId={clientId} />
      <section aria-label="Proyectos del cliente">
        <h3>Proyectos</h3>
        {items.length === 0 ? (
          <EmptyState
            title="Sin proyectos proyectados"
            hint="Proyecta el primer proyecto de Studio de este cliente."
          />
        ) : (
          <div className="card-grid">
            {items.map((project) => <ProjectCard key={project.id} clientId={clientId} project={project} />)}
          </div>
        )}
      </section>
    </div>
  );
}
