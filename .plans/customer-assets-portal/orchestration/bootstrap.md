# Bootstrap de ejecución futura · customer-assets-portal

## Task Anchor
Usuario: «esto complementea el standar que ya tneemos, revisemos por favor», posteriormente «hay que aterrizar este plan». El segundo pedido autoriza PLANIFICAR, no implementar. Este bootstrap solo cobra autoridad cuando el operador lance una sesión y abra los gates necesarios. Outcome: G-001 y verifications de seis fases reproducidas, con evidencia privada/offline/live separada.

## Context / Contract
Repo `/home/leobar37/code/video-maker`. Leer goal, context, requirements, contracts, phase-index y decisions.json en `.plans/customer-assets-portal/`. DAG propuesto en orchestration/dag-batch.json, iniciativa customer-assets-portal. Skills: orchestrate-session, climier y feature-executor; dominios auth/backend/frontend/clientes según fase. No interpretar skill de Bun/Postgres/Elysia como permiso para cambiar stack Start/Workers/D1.

## Operación
1. Inspeccionar git status/diff actual, no pisar cambios previos. Consultar climier status/context; si iniciativa no está sembrada, pedir al operador que ejecute batch revisado, no init/reset por conveniencia.
2. Modelo/provider exacto aprobado y verificado en `omp models <provider> --json`, sin fuzzy fallback. Presupuesto se fija por operador; no inferir modelos ni cuotas de otra sesión.
3. Un worker mutable por vez. Coordinator controla registry, exports y configs compartidas. Ejecutar fases serialmente.
4. Gates G-cap-implement/local/live solo humano. P-001 requiere code y local; todos los tests con schema emulado requieren local. G-cap-live no resuelto = cero credenciales/requests nube/migraciones/email/deploy, incluso probe barato.
5. Task: take → phase completa → personalmente correr verification → submit con evidence/exits/counts. Coordinator reproduce antes de accept; no auto-accept ni self-accept. Fase/goal completed solo tras aceptación/evidencia real.
6. Bloqueos: add-note `Q: <repro/cause/decision required>`; responder decisiones existentes en nota `R:`. decisions.json es registro declarativo, NO tabla automatizada para un supervisor ni aprobación de gates. Decisión nueva se escala, no responde a ciegas.
7. Agotamiento/muerte: note y release; retomar READY sin rehacer accepted/submitted. No completed por tiempo, turnos, buffer o disponibilidad del proveedor.

## Scope / Ownership / Findings / Stop
Solo el objetivo y ownership de la fase. No investigar/reparar/delegar findings ajenos, revertir/stage cambios ajenos ni convertir fallo baseline en permiso de refactor. Reportar mínima ubicación/impacto; bloqueo pausa solo unidad afectada, no amplía scope. No generación/publicación/editor/approval cliente/GC. No infra/DB/emails/deploy salvo gate específico. STOP al verificar entregables autorizados, no gastar presupuesto sobrante en features.

## Report
Comenzar con Task Anchor (objetivo/unidad/condición); paths, outcome, contratos preservados, comandos/exits/counts/hash y evidencia, bloqueos y findings mínimos. No secretos, cookies, tokens, signed URLs o screenshots de credenciales. Cierre distingue implementación offline, live publicado y gate pendiente.
