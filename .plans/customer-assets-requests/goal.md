---
id: "G-002"
title: "Solicitar videos de un proyecto: upload requests con enlace directo de invitado (R-001)"
status: "pending"
end_state: "Las tres fases R-1..R-3 pasan verification reproducida por el coordinador: un invitado con el enlace sube materiales a UN request puntual sin login respetando max-files/max-bytes y la cuota del cliente; portal-request-pull importa al proyecto Studio exacto con SHA y procedencia; close/expiry y negativas de aislamiento pasan; typecheck, build y portal:verify exit 0; sin G-cap-live resuelto no hay minteo real, invitado real ni deploy."
verification: "bun --cwd apps/customer-assets run test:worker -- tests/projects.test.ts tests/material-project.test.ts tests/request-tokens.test.ts tests/request-quota.test.ts && bun --cwd apps/customer-assets run test:ui && bun --cwd apps/customer-assets run test:e2e && bun test packages/customer-assets packages/cli/src/specs/portal.test.ts packages/cli/src/specs/studio.test.ts packages/cli/src/portal packages/cli/src/runtime.test.ts && bun run portal:verify && bun --cwd apps/customer-assets run typecheck && bun --cwd apps/customer-assets run build && bun run build; todos exit 0"
deliverables: ["Proyección PortalProject y pestaña Proyectos por cliente", "Upload requests con token de invitado, límites configurables y cuota CAS", "CLI portal-request-create/pull/close y cierre/expiración con auditoría"]
budget: "Por fijar por operador al lanzar OMP; un worker mutable zai/glm-5.3-flash:high; sin gastos de Cloudflare/email/modelos fuera de gates; 0 emails (el enlace se entrega por el canal del operador)."
---

# R-001 (G-002) · Solicitar videos de un proyecto — upload requests con enlace directo de invitado

## Description
Añadir al portal v1 (G-001, completed) el flujo «Solicitar videos de un proyecto», aprobado por el operador el 2026-10-05: el administrador registra proyectos de Studio por cliente (PortalProject, puntero canónico como PortalClient), crea pedidos de material (UploadRequest) con título/instrucciones, límites configurables (maxFiles/maxBytes) y vencimiento, y mintea un enlace directo con token de capacidad (UploadRequestToken) que el invitado abre sin login para subir solo a ese request. La CLI importa lo cumplido al proyecto exacto de Studio por el bridge existente, con verificación SHA y procedencia. El sistema de producción sigue siendo Studio; el portal sigue siendo proyección y entrega.

## End State
Un fixture demuestra: admin crea proyecto y request con límites; invitado con enlace (sin sesión) ve solo ese request y sube hasta los límites; al llenarse o vencer el request se cierra sin cron; los uploads quedan atribuidos a (portal_project_id, upload_request_id) y los uploads libres sin proyecto quedan intactos; `portal-request-pull` importa al proyecto Studio exacto con SHA/procedencia reutilizando el bridge; negativas: token de otro request, request cerrado/vencido, exceso de límites/cuota, invitado sin catálogo/deliveries, miembro sin mintear. Verifications de las tres fases pasan offline. El uso live (deploy, links reales, invitado real) queda fuera de este plan y requiere G-cap-live explícito; sin él el goal queda en pending de live, no completed por inventar alcance.

## Deliverables
Migraciones D1 aditivas (portal_project, upload_request, upload_request_token, columnas nullable en material) revisables; API v1 aditiva y SDK tipado; página móvil de invitado sin login; pestaña Proyectos en admin por cliente; specs CLI `portal-request-*` en el dispatcher existente; extensión del verifier offline con el recorrido request completo y negativas; evidencia offline sin secretos en `evidence/customer-assets-requests/`.

## Definition of Done
1. Cada fase accepted tras reproducción por el coordinador de sus verifications, no auto-accept.
2. `test:worker`, `test:ui`, `test:e2e`, tests CLI y `portal:verify` extendido exit 0 con assertions reales: capacidad del token acotada a UN request, doble reserva CAS contra cuota, auto-close por llenado/expiración lazy, import exacto a Studio; sin 0-tests ni skips usados como evidencia.
3. Build raíz y build app exit 0 conservando manifests; uploads libres, auth, access links, entregas, posts y grid de v1 sin regresión (suites existentes incluidas en verification).
4. Auditoría mínima sin secretos: nunca el token, el URL del enlace, cookies ni keys en logs/evidencia.
5. Evidencia offline en `evidence/customer-assets-requests/` con comandos/exits/counts; live solo tras G-cap-live humano y fuera del alcance aprobado de este plan.

## Constraints / Must Not Change
No modificar `.plans/customer-assets-portal/` ni rehacer fases accepted de G-001. Preservar: auth y provisioning v1, access links, materiales libres sin proyecto (uploads sin `portal_project_id`/`upload_request_id` intactos), entregas, posts/grid, revocación, aislamiento entre clientes. Studio v1 canónico: sin escribir manifests remotos ni sellar revisiones desde el portal. El invitado jamás ve catálogo, entregas, otros requests ni clientes; el token jamás crea sesión ni otorga scopes. Sin links públicos permanentes, sin email, sin cron/colas, sin conversión HEIC/transcode, sin aprobación editorial del cliente, sin IA/publicación, sin GC remoto, sin migración destructiva (solo tablas nuevas y columnas nullable). Contratos exclusivamente aditivos sobre v1; conflicto = escalar, no cambiar semántica v1 por conveniencia.

## Authorization
Gates de esta iniciativa, semántica idéntica a G-001: `G-cap-implement` (implementación acotada y tests puros) y `G-cap-local` (D1/R2 emulados temporales, migraciones 0003/0004 en fixture desechable, servidores efímeros con mail fake) están CUBIERTOS por las aprobaciones vigentes del operador del 2026-10-04 (precedente G-001, mismo app/same scripts, sin infraestructura nueva); el trabajo offline de R-1..R-3 puede ejecutarse sin esperar gate nuevo. `G-cap-live` permanece OPEN: mintear links reales, probar con invitado real, migrar el D1 de producción o desplegar requiere aprobación humana explícita con inventario y límites; ningún agente lo resuelve ni se deduce de este plan o del batch. No iniciar OMP ni consumir provider quota sin lanzamiento autorizado.
