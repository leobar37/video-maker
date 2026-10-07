# Contratos propuestos · customer-assets-portal

Contrato de v1 para ejecución; P-001 verifica viabilidad sin ampliarlo silenciosamente. Cambios incompatibles se registran y se escalan antes de continuar.

## 1. Topología y fuente de verdad
- App nueva en `apps/customer-assets/`, aislada de las dependencias Bun/node:fs del motor. Root `workspaces` deberá añadir `apps/*`; SDK portable nuevo `packages/customer-assets/`.
- TanStack Start sirve UI, server functions y HTTP `/api/v1`. Un backend, sin otro servidor Elysia ni Docker. Servicios/repositories separan autorización, negocio y bindings de Cloudflare.
- Studio sigue siendo fuente de verdad de cliente/identidad/proyectos/assets/revisiones. D1 guarda acceso, uploads remotos y una proyección de entrega: no sustituye manifests ni backup.
- `workspaceId` identifica el workspace explícitamente registrado por el administrador; el cliente es `(workspaceId, studioClientId)`. No asumir unicidad de un slug entre carpetas distintas ni confiar en la carpeta enviada por navegador.
- R2 de portal privado, separado del backup Studio. Solo se copian bytes permitidos de materiales/outputs; nunca importar un snapshot completo al portal. La asignación de cuenta/bucket requiere autorización, no reutilizar credenciales ajenas.
- Los clientes actuales aparecen tras una adopción explícita por CLI, no por acceso público al filesystem ni por buscar todos los buckets. D1 conserva solo nombre/IDs y display metadata allowlisted; no copiar `StudioClient.metadata` íntegramente.

## 2. Entidades mínimas
| Entidad | Campos y autoridad |
|---|---|
| Auth | tablas Better Auth de usuario/cuenta/sesión/verificación/API key, generadas según versiones fijadas |
| PortalWorkspace | id opaco, etiqueta, principal integrador autorizado; mapping local fuera del portal |
| PortalClient | id opaco, workspaceId, studioClientId, nombre/display, versión de proyección; unique por workspace+client |
| Membership / Invitation | usuario/email normalizado, portalClientId, estado/expiración; invitaciones sin token propio alternativo a Better Auth |
| AgentGrant | keyId verificado, lista de clientes/workspaces y scopes revocables; no admitir scopes enviados por la CLI |
| UploadSession | clientId, stagingKey generado por servidor, bytes/tipo declarados, estado, expiry, idempotencyKey |
| Material | clientId, objectKey privado, nombre original solo display, bytes/tipo detectados, SHA-256, uploader, fecha y estado ready |
| DeliveryRevision | workspace/project/asset/revision/rootHash exactos, título/kind, outputs seleccionados (nombre, hash, bytes, mediaType), provenance mínima |
| ClientAsset | clientId + deliveryRevisionId + selección de outputs; visibilidad `internal` o `client_visible` independiente de editorialStatus |
| Post | clientId, título/caption, outputs ordenados y cover exactos de entregas, visibility, position, version |
| AuditEvent | actor/tipo, cliente, acción, recurso, fecha/requestId; sin cookies, tokens, URLs firmadas ni paths locales |

`DeliveryRevision` y bytes comprometidos inmutables; nuevas versiones = filas/referencias nuevas. No `latest` para elegir bytes que ve el cliente. P-002 define índices, foreign keys y constraints en SQL revisable.

## 3. Identidad y permisos
Magic link de Better Auth; usuarios provisionados por admin, `disableSignUp: true`, token hasheado, corto y de un uso; solicitud de login con respuesta neutra para emails desconocidos. Sesión segura same-origin (HttpOnly/Secure y política SameSite verificada), allowlist de redirects. Proveedor email real pendiente y separado del fake offline.

Admin se provisiona de manera controlada, no por registro libre. Tener sesión no implica tener membership; membership revocada corta acceso aun si la sesión sigue viva.

| Operación | Admin humano | Miembro cliente | Agente |
|---|---|---|---|
| Listar espacios/clientes | Todos autorizados | Solo memberships activas | Solo grants |
| Ver/subir material | Sí | Solo su cliente | `materials:read` / `materials:write` |
| Importar material a Studio | Mediante CLI | No | `materials:read` + permiso local explícito |
| Entregar revisión interna | Sí | No | `deliveries:write` |
| Ver borradores internos | Sí | No | `deliveries:read` |
| Cambiar visibilidad/orden/caption | Sí | No | No en v1 |
| Invitar/revocar/emitir keys | Sí | No | No |

Plugin API key de Better Auth, validación manual servidor, sin `enableSessionForAPIKeys`. Las rutas genéricas de create/update/delete keys no permitirán a miembros o agentes autoemitirse permisos ni ampliar grants; probarlas directamente. Key por integración; no cookies humanas, no admin global por defecto. Secrets solo inyección env o perfil protegido ignorado 0600, no args de proceso ni metadata de Studio.

Additivo registrado 2026-10-05 (post-G-001, ordenado por el operador, aprobado por integration owner): `POST /api/v1/clients/:clientId/access-links` mintea un link de login single-use para un miembro de ese cliente. Autorización: admin humano O clave de agente con scope explícito `access:write` en su grant server-side (scope nuevo del set v1; grants previos nunca lo tienen); los miembros nunca mintean (403 en su propio cliente, 404 fuera). El link reutiliza la maquinaria propia de Better Auth (mismo token hasheado y de un uso en la tabla `verification`; no hay tabla paralela): la expiración configurable al mintear (`<n>m|h|d`, mínimo 30 minutos, máximo 30 días, default 7d; better-auth 1.7.7 no soporta expiresIn por llamada, se materializa por instancia de minteo en el `expiresAt` de la fila, que es lo que verifica el path normal). Un email desconocido se provisiona como usuario `role=member` (provisioning server-side FR-001) y la membership se crea idempotentemente por el flujo normal de invitación; una membership revocada no se resucita (409). El URL se captura server-side y se devuelve UNA vez en la respuesta: nunca viaja por email del portal, ni queda en auditoría, logs ni idempotencia (la mutación deliberadamente no usa Idempotency-Key).

## 4. Uploads y archivos
V1: JPEG/PNG/WebP hasta 20 MiB y MP4 hasta 50 MiB por archivo; cuota default 1 GiB/cliente configurable, presupuesto reservado de forma concurrente e idempotente. HEIC se rechaza con explicación, sin fingir conversión. Logos SVG existentes solo descarga segura; para preview se entrega raster PNG/WebP. No HTML ni SVG activos inline.

Flujo `init → authenticated PUT → complete → ready`:
1. init valida identidad/cliente/grant, tipo declarado, tamaño, cuota e idempotencia; servidor genera ID y key, nunca acepta bucket/key arbitrarios.
2. PUT al Worker autenticado: streaming limitado con contador real, no solo Content-Length; detecta firmas permitidas y calcula SHA-256 con implementación incremental compatible Workers (P-001 prueba memoria/CPU). Rechazar cuerpo extra antes de commit. No cargar 50 MiB completos en memoria.
3. Staging en R2 inaccesible desde rutas de lectura. `complete` verifica lo almacenado en servidor y crea objectKey de entrega inmutable con hash/version; staging nunca es URL final.
4. D1 registra ready solo tras confirmación de objeto final; retries verifican hash, estados y constraints, sin sobrescribir. Fallo D1 después de R2 deja huérfano inaccesible para retry, no falso ready. No GC automático en v1.

Para direct PUT presigned futuro se requiere otro contrato: esas URLs son reutilizables hasta expirar y no garantizan tamaño/contenido/inmutabilidad. No usarlas para sobrescribir bytes comprometidos en v1.

Downloads y previews por Worker autenticado, lookup por resource/output ID y cliente; no keys arbitrarias. Stream de R2 privado, Range/HEAD para MP4, MIME seguro, `nosniff`, CSP y Content-Disposition appropriate; respuestas privadas/no-store o caché solo con política privada comprobada, nunca cache CDN compartido. Revocación impide solicitudes siguientes; no puede retirar un archivo ya descargado.

## 5. Integración Studio
- Adopción cliente: SDK lee `getClient`, envía IDs y solo campos de display permitidos. No escribir un `client.json` remoto paralelo.
- Import material: `material-pull` exige workspace/proyecto/asset explícitos; proyecto existente debe relacionarse con el cliente registrado. Descarga a temporal confinado, verifica hash/bytes, registra input/procedencia en el asset abierto usando servicios y schema existentes; nunca sobreescribe input distinto ni cambia snapshots. Retry conserva la misma relación `(origin, materialId)` y bytes.
- Studio no sella hoy un asset sin outputs; material raw vive como input en asset abierto, no se inventa RevisionManifest incompleto. La pieza posterior tendrá outputs y podrá usar snapshot normal.
- Entrega: `delivery-push` exige revisión exacta y outputs explícitos. Lee manifest sellado, valida rootHash con módulo puro existente y verifica bytes SHA local; archivos deben estar presentes o se restauran EXPLÍCITAMENTE por flujo Studio existente, nunca recuperar/renderizar/gastar implícitamente.
- Enviar solo datos/bytes de outputs elegidos; fuentes, recipe, manifests completos y project/clientSnapshots no viajan al cliente. Guardar rootHash preserva procedencia, no prueba que el portal tenga el backup completo.
- Nuevo output remoto se queda interno; pertenencia a `project.clientIds`, `OutputSpec.visibility: public`, status approved o backup confirmed NO autoriza entrega automática.
- Campos de provenance guardados en archivo de sidecar dentro de inputs permitido y sellado en futuras revisiones, sin credentials. Schema actual se valida; no ampliar dominio v1 solo por comodidad.

## 6. API HTTP v1
JSON tipado por schemas puros del SDK; páginas `{items,nextCursor}`, error `{error:{code,message,requestId}}`, sin `success` flag. 401 identidad faltante/inválida; 403 scope insuficiente de recurso autorizado; 404 recurso no accesible/no existente (sin enumeración entre clientes); 409 conflicto de versión/idempotencia; 413 tamaño; 415 tipo; 429 cuota/rate limit con mensaje diferenciado; 5xx sin secretos. Idempotency-Key ligada a principal+cliente+operación y fingerprint; mismo key/payload retorna recurso existente, payload distinto 409.

- `/api/auth/*`: handler Better Auth con guardas de provisioning/key management.
- `GET /api/v1/me`, `GET /api/v1/clients`.
- `POST /api/v1/clients/adopt`: proyección cliente existente, solo integrador con grant de workspace; no acceso admin general.
- `GET /api/v1/clients/:clientId/materials`, `GET /api/v1/materials/:id`.
- `POST /api/v1/clients/:clientId/uploads`, `PUT /api/v1/uploads/:id/content`, `POST /api/v1/uploads/:id/complete`.
- `GET|HEAD /api/v1/materials/:id/content`.
- `POST /api/v1/clients/:clientId/deliveries`, carga de outputs internos con mismo protocolo de staging, `POST /api/v1/deliveries/:id/complete`; ready requiere todos los bytes verificados.
- `GET /api/v1/clients/:clientId/assets`, `GET|HEAD /api/v1/deliveries/:id/outputs/:name` (autorizar selected output, no todo el asset).
- `GET|POST /api/v1/clients/:clientId/posts`, `PATCH /api/v1/posts/:id`, `PATCH /api/v1/clients/:clientId/grid` con version/If-Match. Escritura solo admin humano. Additivo registrado 2026-10-04 (P-004, aprobado por integration owner): `GET /api/v1/clients/:clientId/grid` devuelve GridState con versión vigente para iniciar PATCH sin 409 irrecuperable; solo admin humano, mismos filtros de acceso que toda lectura.
- `PATCH /api/v1/client-assets/:id/visibility`; hide hace que posts que lo usan dejen de ser visibles (no URLs indirectas).
- Admin server functions/rutas para invites/memberships/keys; no endpoints genéricos sin política server-side. Redirect a UI no sustituye checks API.

Todas las lecturas incluyen filtro cliente/grant en repositorio, no solo en UI; output en carrusel no puede pertenecer a otra entrega/cliente no autorizado. Reorder atómico con batch D1/CAS probado, no `BEGIN/COMMIT` interactivo.

## 7. CLI propuesta (no existe todavía)
Prefijo interno flat `portal-*` para no tocar normalización de grupos existentes; spec declarativa y envelope Studio actual, exit 0 éxito, 2 input/uso y 1 operacional. `--json` sin banners ni secretos. Mutaciones requieren `--execute`; por defecto muestran plan sin red/escritura, igual que `--dry-run`; lecturas remotas normales se ejecutan salvo dry-run.

- `portal-auth-status --origin <https-origin> --json`: principal/scopes sin token.
- `portal-client-adopt <clientId> --workspace <dir> --workspace-id <id> --origin <url> --execute --json`.
- `portal-client-list --origin <url> --json`.
- `portal-material-list --client <portalClientId> --cursor <cursor>? --limit <n> --origin <url> --json`.
- `portal-material-show <materialId> --origin <url> --json`.
- `portal-material-pull <materialId> --workspace <dir> --project <id> --asset <id> --origin <url> --execute --json`.
- `portal-delivery-push --workspace <dir> --client <portalClientId> --project <id> --asset <id> --revision <id> --outputs <comma-names> --origin <url> --execute --json`.
- `portal-access-link --client <portalClientId> --email <email> --expires-in <7d|48h|30m> --origin <https-origin> --execute --json`: mintea el link single-use del miembro (§3, additivo 2026-10-05 aprobado por el operador); mutación con plan puro sin `--execute` (cero red, cero credencial); el `--json` devuelve `{url, email, expiresAt, singleUse}` y el operador entrega el URL por su canal (WhatsApp, etc.); `--expires-in` valida localmente la misma gramática/acotación que el servidor.
- `portal-asset-list --client <portalClientId> --origin <url> --json`.

Credencial `CUSTOMER_ASSETS_API_KEY` inyectada, nunca `--token`; origen HTTPS explícito, no defaults a otro cliente. El SDK valida redirects/origins antes de enviar credentials; llamadas fuera del origen admitido y redirects externos no reciben header. `--dry-run` no verifica credenciales contra red ni descarga; enumera effects con datos locales.

## 8. UI
Rutas propuestas `/login`, `/portal`, `/portal/:clientId/materials`, `/portal/:clientId/assets`, `/portal/:clientId/posts`, `/portal/:clientId/instagram`, `/admin/clients` y `/admin/clients/:clientId/*`. Frontend por features auth/clients/materials/assets/posts/instagram/admin; TanStack Query con keys por usuario+cliente y invalidación al logout/cambio. Forms con wrappers y validación; typed SDK/server functions para este backend Start, no introducir Eden/Elysia solo para cumplir un patrón de otra stack.

Cliente: sube, consulta y descarga; no edita posts/orden ni ve draft. Admin: muestra/oculta entrega y post, edita caption/orden, invita y revoca. Grid no permite contenido hidden por rutas directas; portada raster/MP4 poster explícito, carrusel conserva orden. No transcodificación: para MP4 sin poster hay placeholder, no prometer miniatura automática.
