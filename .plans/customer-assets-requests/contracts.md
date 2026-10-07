# Contratos aditivos · customer-assets-requests

Contratos EXCLUSIVAMENTE ADITIVOS sobre `Contratos propuestos · customer-assets-portal` (v1, accepted 2026-10-05): nada de aquí modifica semántica, endpoints, scopes ni errores de v1. Cualquier necesidad de cambiar v1 (aunque sea «mejorarla») se registra y escala al integration owner antes de continuar. Las decisiones marcadas «default del operador» están aprobadas (2026-10-05) y registradas en `decisions.json`.

## 1. Alcance aditivo
- Misma app `apps/customer-assets/` (Start/Workers, D1, R2 privado), mismo SDK `packages/customer-assets/`, misma CLI. Sin app nueva, sin stack nueva, sin otro backend.
- Migraciones nuevas `0003_portal_projects.sql` (R-1) y `0004_upload_requests.sql` (R-2); `material` gana `portal_project_id` y `upload_request_id` NULLABLE. Cero backfill obligatorio: fila con NULL = upload libre de v1, ruta y permisos intactos.
- D1 sigue siendo proyección: PortalProject es puntero canónico al proyecto Studio (como PortalClient al cliente). Studio no se toca: sin manifests remotos, sin revisiones selladas desde el portal, sin snapshot al portal.

## 2. Entidades nuevas
| Entidad | Campos y autoridad |
|---|---|
| PortalProject | id opaco, portalClientId, studioProjectId, display title (sanitize como v1), projection_version, created_ms; UNIQUE (portalClientId, studioProjectId); alta solo admin humano (adopta proyecto Studio existente; el ID se valida con `requireStudioId`) |
| UploadRequest | id opaco, portalProjectId, portalClientId (denormalizado para autorización y cuota), título + instrucciones (display), maxFiles, maxBytes, usedFiles, usedBytes, state `open→fulfilled/closed`, expiresMs, createdBy (principal id), createdMs, closedMs/closeReason; límites y expiry los fija el creator al crear |
| UploadRequestToken | id opaco, requestId, tokenHash SHA-256 (el token claro solo viaja en el URL minteado, jamás se guarda ni loguea), expiresMs (30m..30d, misma gramática que access-links §3 v1), revokedMs, createdBy, createdMs; UN token activo por request (default del operador): re-mint revoca el anterior |
| Material (aditivo) | + `portal_project_id` NULLABLE, + `upload_request_id` NULLABLE; NULL = upload libre v1; juntos o `upload_request_id` solo desde el flujo de request (un material de request siempre lleva ambos: proyecto del request) |

Estados de request: `open` (acepta uploads), `fulfilled` (auto al llenar límites), `closed` (admin/creator o expiry lazy). `fulfilled`/`closed` no borran nada; solo cierran el presupuesto. Sin `latest` ni bytes mutables: material sigue siendo inmutable post-complete (§4 v1).

## 3. Identidad y permisos aditivos
Nuevo principal `guest(requestToken)`: NO es sesión de Better Auth, no toca tablas auth, no crea cookie; se resuelve por token hasheado en cada request HTTP y concede únicamente las operaciones de su request. Scopes nuevos `requests:read` y `requests:write`: server-side, definidos en el grant (nunca enviados por la CLI), grants previos jamás los tienen (patrón `access:write` §3 additivo v1). Members nunca mintean proyectos, requests ni links (403 en su cliente, 404 fuera).

| Operación | Admin humano | Miembro cliente | Agente | Invitado con token |
|---|---|---|---|---|
| Alta/lista/renombre PortalProject | Sí | Lista de su cliente | No | No |
| Crear/cerrar request | Sí | No | `requests:write` | No |
| Mintear/revoar link del request | Sí | No | `requests:write` | No |
| Listar/ver request y sus materiales (metadata) | Sí | Su cliente | `requests:read` | Solo su request (view mínima) |
| Subir a request | Sí | Sí (logueado, su cliente) | No en v1 | Solo su request, `open` y vigente |
| Descargar bytes de material de request | Sí | Su cliente | `requests:read` + `materials:read` | No |
| Importar a Studio (`portal-request-pull`) | Sí | No | `requests:read` + `materials:read` + permiso local | No |

La vista de invitado (`GET /api/v1/r/:token`) devuelve solo: título, instrucciones, límites y restante (files/bytes), expiry y estado. Nunca IDs de otros recursos, catálogo, deliveries, clientes ni membresías. Revocación/expiración/cierre efectivos en cada request HTTP; un archivo ya descargado no es retirable (igual que v1).

## 4. Límites, cuota y cierre
- Default del operador: `maxFiles` y `maxBytes` explícitos al crear (CLI `--max-files --max-bytes`); si el admin omite en UI, defaults documentados maxFiles=10, maxBytes=2 GiB, SIEMPRE validados contra la cuota del cliente al crear (un request nunca promete más que la cuota disponible).
- Reserva doble en UN batch D1 (`batchAll` v1): (a) CAS `client_quota` existente `reserved_bytes += delta WHERE reserved + delta <= limit`; (b) CAS del request `used_bytes/used_files` solo si `state='open'`, no expirado y `used + delta <= max`. Fallo de cualquiera → release compensatorio (patrón v1) y 413/429 diferenciados: 413 excede maxBytes por archivo, 429 excede presupuesto del request o cuota del cliente.
- Auto-close al llenar (usedFiles=maxFiles o usedBytes=maxBytes → `fulfilled`) y expiry LAZY evaluado en cada uso/listado (sin cron): token vencido o request cerrado → uploads y vista rechazan con estado claro. `closed` por admin → closeReason auditado.
- Los bytes del material consumen la misma cuota del cliente (NFR v1): liberar/renombrar no devuelve presupuesto fantasma; free uploads y requests compiten por el mismo CAS.

## 5. API HTTP v1 aditiva
Envolvente v1 (§6): páginas `{items,nextCursor}`, error `{error:{code,message,requestId}}`, 401/403/404/409/413/415/429/5xx con los mismos significados; Idempotency-Key ligada a principal+cliente+operación.

- `GET|POST /api/v1/clients/:clientId/projects` — lista (admin + miembros del cliente) / alta (solo admin); valida studioProjectId y unicidad; 409 duplicado.
- `PATCH /api/v1/projects/:projectId` — renombre display title; solo admin.
- `GET|POST /api/v1/projects/:projectId/requests` — lista (admin/agente `requests:read`) / alta (admin o agente `requests:write`).
- `POST /api/v1/requests/:id/link` — mintea/rota el token (admin o `requests:write`): `{url, requestId, expiresAt, limits}`; re-mint revoca el anterior (default del operador). Sin email: el operador entrega el URL.
- `GET /api/v1/requests/:id`, `GET /api/v1/requests/:id/materials` — admin/agente con scope; metadata y estado, nunca bytes sin `materials:read`.
- `POST /api/v1/requests/:id/close` — admin o `requests:write`; 409 si ya cerrado.
- Invitado (token en path, sin cookie; audit redacta el token): `GET /api/v1/r/:token` (vista mínima §3), `POST /api/v1/r/:token/uploads` (init con reserva doble), `PUT /api/v1/r/:token/uploads/:sessionId/content` (mismo streaming v1), `POST /api/v1/r/:token/uploads/:sessionId/complete` (verificación v1; crea material con ambas columnas; auto-close si llena).
- El pipeline de upload es el MISMO (init/put/complete, staging, SHA-256, firmas): el contexto request/guest solo añade validaciones y atribución; cero bifurcación de storage ni de cabeceras seguras.

## 6. CLI aditiva (prefijo flat `portal-request-*`, convención v1: plan sin `--execute`, `--json` sin secretos, exit 0/1/2, `CUSTOMER_ASSETS_API_KEY`)
- `portal-request-create --client <portalClientId> --project <portalProjectId> --title <t> [--instructions <s>] --max-files <n> --max-bytes <nMiB|nGiB> [--expires-in <30m..30d>] --origin <https-origin> --execute --json` → `{requestId, url, expiresAt, limits}`; sin `--execute` plan puro (cero red/credencial) y valida gramática de límites/expiry localmente como `portal-access-link`. Alineado 2026-10-05 (coordinator, R-3): `--project` toma el `portalProjectId` de la proyección — §3 veta que los agentes resuelvan/listen `studioProjectId`, así que la relación Studio queda en el pointer creado por admin y el cross-check es post-creación.
- `portal-request-list --client <portalClientId> [--project <portalProjectId>] [--state open|fulfilled|closed] --origin <url> --json` (sin `--project` = usage error con mensaje claro).
- `portal-request-close <requestId> --origin <url> --execute --json`.
- `portal-request-pull <requestId> --workspace <dir> --origin <url> --execute --json`: resuelve el PortalProject → proyecto Studio EXACTO del pointer (debe existir en el workspace local; si no, error sin inventar destino), reutiliza el bridge `portal-material-pull` (temporal confinado, SHA-256 verificado, input + procedencia `(origin, materialId, requestId)` en el asset abierto), idempotente por `(origin, materialId)`. Exige `requests:read` + `materials:read`; bytes descargados cuentan como materiales ya existentes, nunca re-subidos.

## 7. UI aditiva
- Admin: `routes/_app.admin.clients.$clientId.projects.tsx` — pestaña Proyectos por cliente: cards por proyecto con requests abiertos (título, restante, expiry) y material nuevo etiquetado; crear proyecto/request/link y cerrar request. Materiales con proyecto visible en la vista de materiales existente (badge), sin cambiar su flujo.
- Miembro (logueado): al subir material opcionalmente elige proyecto de su cliente (`portal_project_id`); sin proyecto = upload libre v1 intacto.
- Invitado: `routes/request.$token.tsx` FUERA del layout `_app` (pública, sin auth): página móvil-first del request — título/instrucciones, restante de cuota, subir con progreso, estados cerrado/vencido/llenado claros, sin links a nada más; `no-store`, sin fuga de cache entre tokens.
- QA browser solo con preview Tailscale IP + listener all-interface verificados (NFR v1); nunca loopback como link.

## 8. Auditoría aditiva
Eventos nuevos con `recordAudit` v1: `project.created`, `request.created/closed/fulfilled/expired`, `request_token.minted/revoked`, `request.upload.completed`. Actor = principal id (guest = hash del token, NUNCA el token ni el URL). Sin cookies, keys ni paths locales (§2 v1). `expired` se registra solo al materializar el cierre lazy, una vez (guard de idempotencia).

## 9. Asset upload links (operator order 2026-10-06)

El operador (admin humano O clave de agente con el scope NUEVO `assets:write` — los grants previos jamás lo tienen, patrón `access:write` §3) fabrica por CLI un link de subida atado a UN asset exacto de Studio; el invitado lo abre desde el celular SIN login y la toma sube atribuida a ese asset; el pull la importa al asset abierto exacto. 0 emails: el URL existe solo en la respuesta del mint y el operador lo entrega por su canal.

- **Entidad** `asset_upload_link` (migración `0005_asset_upload_links.sql`, aditiva: UNA tabla nueva + columna nullable `material.asset_target` con índice; ninguna fila existente se altera o rellena). Solo se guarda el SHA-256 del token (UNIQUE); el token crudo viaja únicamente en el URL minteado `/asset-upload/<token>`, se muestra una vez y jamás se loguea/audita (patrón `upload_request_token` §2). `material.asset_target` guarda el id LOCAL del asset studio y NUNCA viene de input del cliente.
- **Estado lazy**: `open → used | closed | expired`, materializado al primer toque (un UPDATE guardado + un audit, sin cron). `used` es terminal: la capacidad cubre UNA subida (una toma; el operador mintea un link nuevo por toma). Re-mint para el mismo (cliente, asset) cierra el link `open` previo (rotación, un link activo por asset, audit `asset_link.revoked`). Un link `closed` es capacidad revocada: la familia invitada responde el mismo 404 neutro; `used`/`expired` aún resuelven para MOSTRAR el estado terminal (toda subida se niega con 409). Cierre admin temprano con razón display-only; 409 si ya terminó; nada se borra jamás.
- **Resolución mint**: el servidor resuelve el puntero PortalProject por `studio_project_id` (o `portalProjectId` explícito cross-chequeado); 0 filas = 404, ambigüedad = 409 exigiendo `portalClientId`; `--client` es cross-check. Members nunca mintean (403 en su cliente, 404 fuera). Vencimiento con la misma gramática 30m..30d, default 7d (§4/§3 v1).
- **API v1 aditiva (§5/§6)**: `POST /api/v1/asset-upload-links` (mint, NO idempotente por diseño — persistir replay persistiría un URL minteado, igual que access/requests links); `GET /api/v1/asset-upload-links[?client=&asset=]`, `GET|POST /api/v1/asset-upload-links/:id[/close]` (admin humano; jamás contienen el token); `GET /api/v1/asset-upload-links/materials?asset=<studioAssetId>` (admin o agente con `materials:read`; el conjunto de importación exacto, cada ítem con `assetTarget` y `linkId` resuelto del `uploaded_by` hasheado vía `token_hash` UNIQUE — sin columnas nuevas); familia invitada `/api/v1/a/:token[|/uploads|/:sid/content|/:sid/complete]` resuelta ANTES del principal v1, `no-store`, solo-subida (catálogo/deliveries/posts/me responden 401 con el token como clave: NO es sesión ni API key).
- **Cuota (§4)**: el link NO tiene presupuesto propio (cuota de request N/A por orden del operador) — cada subida compite por el MISMO CAS `client_quota` (init reserva, fallos liberan, complete confirma; 413 por tipo v1 sin cambios). Dedupe por contenido (§4 v1): bytes idénticos convergen en la fila existente y conservan su contexto original (la atribución de una fila jamás se reescribe; puede quedar fuera del conjunto por asset — documentado).
- **CLI aditiva (§6, convención v1: plan sin `--execute`, `--json` sin secretos, exit 0/1/2)**:
  - `portal-asset-upload-link --workspace <dir> --project <studioProjectId> --asset <studioAssetId> [--client <portalClientId>] [--expires-in 24h|7d] --origin <url> --execute --json`: inspección local ANTES de red (proyecto/asset inexistente = error claro sin llamadas); el `--json` devuelve `{url, linkId, studioAssetId, studioProjectId, portalClientId, expiresAt}` y el URL se imprime UNA vez para entrega manual.
  - `portal-asset-pull --workspace --project --asset --origin --execute --json`: importa TODOS los materiales ready con `asset_target == asset` en el asset abierto EXACTO vía `pullMaterial` existente (temporal confinado, SHA verificado, provenance `(origin, materialId, linkId)`, asset.json con lock; idempotente por `(origin, materialId)`, jamás sobrescribe input distinto ni inventa destino).
- **UI aditiva (§7)**: ruta pública `/asset-upload/$token` fuera del layout auth (sin prompt de login en ningún punto, `no-store`), muestra asset+proyecto, cuota restante, vencimiento y estado; misma columna vertebral de subida que la página de request (componente Dropzone compartido). Reutiliza estilos v1.
- **Auditoría (§8)**: `asset_link.minted|revoked|closed|expired|used` y `asset_link.upload.completed` — jamás contienen el URL ni el token crudo.

## 10. Ingest tailnet (operator order 2026-10-06 — videos pesados ~500MB)

Canal de subida de tomas grandes por la tailnet de Tailscale, SIN login de la app y SIN que los bytes toquen Cloudflare jamás (nada de cap de 50MiB ni egreso del Worker). El portal sigue siendo la ÚNICA fuente de validez del token: el ingest resuelve cada request con la vista mínima de invitado `GET {portalOrigin}/api/v1/a/:token` (200 + `state: 'open'` + no-vencido; cache del binding ~60s) y NUNCA acepta un binding fabricado por el uploader. Confianza en capas: red cerrada (identidad WireGuard del dispositivo) + token de capacidad por asset.

- **Server** (`portal-ingest-serve`, proceso en primer plano de la workstation): bindea SOLO la IPv4 de tailscale (`tailscale ip -4`; jamás `0.0.0.0`/`::` — cero exposición LAN; el loopback existe solo para tests). Puerto default 8787, check-free-or-fail (EADDRINUSE = error fuerte, nunca comparte puerto). Todos los responses `no-store`; errores con la envolvente del portal.
- **Protocolo** (`/subir/:token`): `GET` = binding + caps + offset staged (reanudación); `PUT` = un chunk con `Content-Range: bytes s-e/total` o `?offset=` (default: append al final), respuesta `{received}`; offset adelantado = 409 con el `received` real; re-envío de cola (offset ≤ tamaño) trunca y agrega; drift de `total` entre chunks = 409; `POST /subir/:token/complete {bytes, sha256?}` = verifica tamaño (409 si difiere), SHA-256 streamado, exige MP4 (`ftyp`, 415 si no) y aterriza ATÓMICAMENTE (rename) `.tmp/portal-ingest/<tokenHash>/take-<sha8>.mp4` + `.manifest.json`. Complete idempotente: el take es content-addressed; replay con el mismo `sha256` devuelve el manifest existente (`idempotent: true`) y limpia staging.
- **Caps**: 32MiB por chunk (413; también en `maxRequestBodySize` del listener) y 5GiB por toma (413). Una toma = un archivo; tomas distintas = completes sucesivos.
- **Manifest landed** (`TailnetIngestManifest` §tipos SDK): `{schemaVersion, source: 'tailnet-ingest', takeId, tokenHash, linkId?, binding ← SIEMPRE la snapshot de la vista del portal, sha256, bytes, mediaType: 'video/mp4', receivedAt, ingestOrigin}`. `linkId` queda presente SOLO si una vista futura lo expone: la vista v1 es mínima (§3, sin ids), así que la clave de join de provenance es `tokenHash` (UNIQUE en el portal; el token crudo jamás). El landing está gitignored (`.tmp/`) y sus archivos NO son materiales del portal: entran a Studio únicamente vía pull.
- **CLI aditiva**: `portal-asset-upload-link --tailnet [--ingest-port 8787]` añade `tailnetUrl http://<ip>:<puerto>/subir/<token>` (mismo token; IP resuelta al mintear; puerto no-escuchando = advertencia, jamás falla el mint; el URL https queda intacto). `portal-asset-ingest-pull --workspace --project --asset [--ingest-dir .tmp/portal-ingest] [--token <prefijo tokenHash>] --execute --json`: importación LOCAL (sin red ni credencial) al asset abierto EXACTO vía el MISMO camino verificado de `pullMaterial` (`importMaterialBytes`: re-verificación sha256/bytes/firma, input + sidecar determinista con `tailnet: true` + `tokenHash`, asset.json con lock), borrando la toma del landing recién tras la importación verificada; re-pull con landing vacío = éxito sin duplicados.
- **SDK aditivo**: tipos `TailnetIngest*` y métodos del cliente para el protocolo (`getTailnetIngestView`, `putTailnetIngestChunk`, `completeTailnetIngest`) contra un `ingestBaseUrl` EXPLÍCITO — jamás adjuntan credenciales (origen distinto del portal; `redirect: 'error'`).
