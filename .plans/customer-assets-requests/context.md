# Contexto · customer-assets-requests

Fecha de revisión: 2026-10-05. Objetivo: registrar el plan del feature «Solicitar videos de un proyecto» (upload requests con enlace directo de invitado) sobre el portal v1 ya operativa. El operador aprobó el diseño en sesión (2026-10-05); esta planificación NO autoriza ejecución live. Las verificaciones de documentación primaria (Better Auth 1.7.7, Drizzle-D1 `transaction: false`, batch D1/CAS, presigned URLs descartadas, TanStack Start/Workers) siguen vigentes en `.plans/customer-assets-portal/context.md` y NO se duplican aquí.

## Verified · repositorio (post G-001, completed 2026-10-05)
- Ejecución en `/home/leobar37/.herdr/worktrees/video-maker/customer-assets-portal` (rama del portal); NO tocar `/home/leobar37/code/video-maker` ni `.plans/customer-assets-portal/` (solo lectura normativa).
- `apps/customer-assets`: Start/Workers con D1/R2; scripts reales `test:worker` (vitest), `test:ui`, `test:e2e` (`bun tests/e2e/run.ts`), `typecheck`, `build`; raíz `portal:verify` (`scripts/customer-assets-verify.ts`) y `portal:verify:live` (`scripts/customer-assets-verify-live.ts`).
- `migrations/0001_auth.sql`, `0002_portal.sql`: 16 tablas incl. `portal_client` (puntero Studio-canónico con versión de proyección), `upload_session`, `idempotency_record`, `client_quota`, `material`, `audit_event`. `material` hoy NO tiene columnas de proyecto/request: las nullable nuevas son aditivas.
- `src/server/uploads.ts`: pipeline real `initUploadSession → putUploadContent → completeUploadSession` sobre `ingestStream`/`stageUpload`/`finalizeUpload` con SHA-256 incremental (`createIncrementalSha256`), detección de firma (`detectMediaType`), límites por tipo (`V1_TYPE_LIMIT_BYTES`) y CAS de cuota en una sola sentencia (`reserveQuota`: `reserved_bytes += delta WHERE reserved_bytes + delta <= limit_bytes`) con release compensatorio; default 1 GiB/cliente (`DEFAULT_CLIENT_QUOTA_BYTES`).
- `src/server/access.ts`: errores tipados, `authorizeClient`, `requireAdmin`, `recordAudit`, `batchAll` (batch D1 transaccional probado en G-001), bounds de access links `ACCESS_LINK_MIN/MAX/DEFAULT_SECONDS` (30m..30d, default 7d) y maquinaria de token hasheado single-use reutilizable como modelo para el token de request.
- `src/server/materials.ts`: listado/lectura por principal y `materialBytesForClient` (uso real de cuota); `serveMaterialContent` con cabeceras seguras.
- Scopes en `packages/customer-assets/src/contracts.ts`: `materials:read/write`, `deliveries:read/write`, `access:write` (aditivo 2026-10-05, grants previos nunca lo tienen). Para requests se añaden `requests:read`/`requests:write` con la misma disciplina: server-side, nunca desde la CLI, grants viejos sin el scope nuevo.
- CLI: verbos flat `portal-*` en `packages/cli/src/specs/portal.ts` (plan/dry-run sin red, `--execute` para mutaciones, `--json` sin secretos, exit 0/1/2, credencial `CUSTOMER_ASSETS_API_KEY` inyectada, origen HTTPS explícito); bridge `packages/cli/src/portal/bridge.ts` ya importa material con SHA/procedencia (`portal-material-pull`) y push de outputs (`portal-delivery-push`).
- UI: rutas `_app.admin.clients.$clientId.*` (incl. access.tsx del additivo de links) y `_app.portal.$clientId.*`; `login.tsx` público. No existe ruta de invitado sin login: `/request/$token` será la primera y debe quedar FUERA del layout autenticado.
- Suite v1 incluida en `test:worker`: access, uploads, deliveries, posts, access-links, dashboard, auth/upload runtime. Cualquier regresión de v1 se reporta, no se debilita.

## Verified · decisión del operador (2026-10-05, sesión)
- Feature aprobado: «Solicitar videos de un proyecto» con enlace directo por token de invitado (sin login), token de capacidad acotado a UN request, sin acceso a catálogo/deliveries; límites configurables por request (maxFiles/maxBytes) hard-capped por la cuota del cliente (CAS existente).
- Entidades: PortalProject (portalClientId + studioProjectId + display title, puntero canónico como PortalClient), UploadRequest (id, portalProjectId, título/instrucciones, límites, expiry, estado open→fulfilled/closed, creator), UploadRequestToken (hash, expiry, solo-subir-a-este-request). `material` gana `upload_request_id`/`portal_project_id` nullable; uploads libres sin cambio.
- Admin: pestaña Proyectos por cliente con cards de requests abiertos y material nuevo. CLI: `portal-request-create` (→ link) y `portal-request-pull` (import al proyecto exacto por el bridge, SHA + procedencia). R-3 cierra con close/expiry + audit. Fases R-1..R-3. Móvil: página del request muestra cuota restante y auto-close por llenado/vencimiento.

## Inferred / decisiones propuestas (defaults aprobados por el operador, registrados en decisions.json)
- Token: hash SHA-256 en D1, expiración con la misma gramática/acotación que access links (30m..30d), un token activo por request; re-mint revoca el anterior; revocación efectiva en cada request; jamás crea sesión. El URL lo entrega el operador por su canal: 0 emails.
- Cuota: doble reserva en un batch D1 — CAS de `client_quota` existente + presupuesto propio del request (used_bytes/used_files) con condiciones `state='open'` y no-expirado; release compensatorio en fallo/abort igual que v1. Free uploads conservan la ruta actual sin columnas nuevas obligatorias.
- Expiry lazy: evaluado en cada uso/listado; auto-close al llenar límites; sin cron ni colas (NFR v1).
- Proyección: D1 solo guarda IDs/títulos/límites/estado; Studio sigue canónico; sin manifests remotos ni snapshot al portal.

## Unknown / decisiones abiertas acotadas
1. Inventario y límites live (deploy de la feature, links reales, invitado real, migración 0003/0004 en prod): operador en G-cap-live; bloquea uso live, no la planificación ni el offline.
2. Proyecto Studio piloto y contacto invitado real: fixtures sintéticos hasta asignación explícita; no deducir del cwd.
3. Defaults de maxFiles/maxBytes por request: el admin los pasa al crear (CLI exige ambos o aplica default documentado en contracts §4); sin inventar política de retención posterior.
4. Presupuesto de sesión OMP y tope horario: preflight de lanzamiento; este plan no consume sesiones nuevas.
5. Copys/idioma de la página móvil del invitado: propuesta en R-2, ajuste editorial del operador no bloquea acceptance funcional.

Estas incógnitas no bloquean el plan offline. Sí bloquean su fase o el live correspondiente; no autorizan scope nuevo.
