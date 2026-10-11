# Requisitos · customer-assets-requests

## Objetivo
El administrador pide, por proyecto de Studio, los videos/materiales que falta: define un UploadRequest con límites y vencimiento, el cliente sube por enlace directo con token sin login limitado a ese request, y la CLI importa lo recibido al proyecto exacto de Studio con SHA y procedencia.

## Funcionales
- FR-101: el administrador registra proyectos por cliente (PortalProject: portalClientId + studioProjectId + display title) como proyección Studio-canónica, única por (cliente, proyecto); sin acceso público al filesystem ni enumeración de catálogo.
- FR-102: el administrador crea UploadRequests por proyecto con título/instrucciones, límites configurables maxFiles/maxBytes, expiración configurable y estado open→fulfilled/closed con creator registrado; lista y consulta requests abiertos y cerrados de cada proyecto/cliente.
- FR-103: enlace directo por token de capacidad para un SOLO request: el invitado sube sin login, sin sesión y sin ver catálogo, entregas, otros requests ni datos de otros clientes; token hasheado, con expiración y revocación efectivas; el URL lo entrega el operador por su canal (0 emails).
- FR-104: el material subido por request o etiquetado por un miembro logueado queda atribuido con `portal_project_id`/`upload_request_id` nullable; los uploads libres sin proyecto/request de v1 quedan intactos en flujo, API y UI.
- FR-105: los límites por request se respetan con concurrencia: reserva doble contra el presupuesto del request y la cuota del cliente (CAS existente), auto-close al llenar límites o vencer (evaluación lazy, sin cron); la página móvil muestra la cuota restante y rechaza excesos con errores explícitos (413/429), sin presentar una carga pendiente como disponible.
- FR-106: CLI `portal-request-create` (mutación con `--execute`, devuelve URL+expiresAt+límites para entrega manual), `portal-request-close`, `portal-request-list` y `portal-request-pull --request` que importa los materiales cumplidos al proyecto Studio exacto del pointer vía bridge existente, verificando SHA-256 y registrando procedencia; reintentar no duplica archivos ni entidades ni modifica revisiones previas.

## No funcionales
- NFR-101: autorización en servidor para cada operación; el token de invitado concede SOLO subir a su request y jamás mintea sesiones, keys ni scopes; admin humano controla requests/links; agente solo con `requests:read`/`requests:write` explícitos server-side (grants previos sin los scopes nuevos); miembro nunca mintea.
- NFR-102: uploads de invitado por el mismo pipeline privado v1 (staging inaccesible, firma/tipo/bytes validados, streaming con contador real, SHA-256, idempotencia) sin links públicos ni HTML/SVG inline; reintentos verifican hash/estado sin sobrescribir ni duplicar.
- NFR-103: esquema exclusivamente aditivo (tablas nuevas + columnas nullable); sin migración destructiva ni backfill obligatorio; compatibilidad con CLI, schemas Studio v1 y suites v1 conservada; Studio permanece fuente de verdad y D1 solo proyección.
- NFR-104: página móvil del invitado accesible sin login, con estados vacíos/carga/error, sin fuga de cache entre requests/tokens; preview de QA solo por Tailscale IP verificada con listener all-interface, nunca loopback.
- NFR-105: sin gasto/infra/migraciones reales/emails/deploy sin gate humano específico (offline cubierto por aprobaciones vigentes 2026-10-04; live requiere G-cap-live); auditoría mínima sin secretos — nunca token, URL del enlace, cookies ni keys en logs o evidencia; evidencia offline y live diferenciadas.

## No objetivos
Enviar emails o notificaciones (el enlace viaja por el canal del operador); aprobación o comentarios del cliente; publicación/programación social; transcode/HEIC; multipart para videos grandes; cron/colas de expiración; catálogo visible al invitado; edición de entregas por el cliente; GC remoto; rehacer auth/memberships de v1; cambiar la semántica v1 de uploads libres, entregas, posts o grid.
