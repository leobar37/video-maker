---
id: "P-005"
title: "Flujo completo offline y preparación de operación"
status: "accepted"
phase_type: "validation"
description: "Antes de autorizar nube, reproducir los mismos caminos de usuario y CLI con D1/R2 emulados y mail fake, y demostrar que el estándar Studio permanece compatible."
end_state: "Recorrido cliente→CLI→Studio→entrega→grid y negativas de aislamiento pasan offline sin IA/publicación; compatibilidad/build exit 0 y checklist live contiene recursos/rollback."
verification: "bun run portal:verify && bun run studio:verify && bun run build && bun --cwd apps/customer-assets run build; todos exit 0"
deliverables: ["Verifier offline no-vacuous y fixtures sintéticos", "Evidencia de hashes/roles/retries y browser", "Checklist recursos/migraciones/secrets/email/domain/rollback sin aplicar"]
entry_criteria: ["Dependencias accepted y contratos vigentes"]
dependencies: ["P-004"]
requirements: ["FR-001", "FR-003", "FR-004", "FR-005", "FR-006", "FR-007", "FR-008", "FR-009", "NFR-001", "NFR-002", "NFR-003", "NFR-006", "NFR-007"]
subagent: "feature-executor"
goal: "G-001"
---

# P-005 · Flujo completo offline y preparación de operación

## Task Anchor
Objetivo del usuario: «esto complementea el standar que ya tneemos, revisemos por favor». Alcance autorizado de esta unidad al abrir gates: Flujo completo offline y preparación de operación. Éxito observable: Recorrido cliente→CLI→Studio→entrega→grid y negativas de aislamiento pasan offline sin IA/publicación; compatibilidad/build exit 0 y checklist live contiene recursos/rollback.

## Context
Antes de autorizar nube, reproducir los mismos caminos de usuario y CLI con D1/R2 emulados y mail fake, y demostrar que el estándar Studio permanece compatible.

Referencias normativas: `../contracts.md`, `../requirements.md`, `../context.md`, `../goal.md`. Son un portal privado, dashboard y CLI; no generación/publicación ni cliente approvals. Las decisiones de fuente de verdad, ACL y bytes inmutables no son opcionales.

## Outcome / Change
Crear portal:verify que exige tests/assertions y etapas visibles, con fixture de dos clientes: admin provisioning/invite → login cliente → upload foto → CLI list/pull → fixture output ya producido → Studio snapshot → CLI delivery push → admin visible/post/grid → cliente consulta/descarga. Sin generación pagada ni publicación. Añadir logout/revocación, acceso cruzado, manipulación de MIME/path, reintentos y r1/r2 inmutable. Coordinar fallo causado por cambio; baseline ajeno solo reportar. Producir inventario específico de infraestructura por entorno y migraciones SQL/backup/rollback; no ejecutar provision/deploy/emails ni studio:verify:r2. Mail live no se prueba con sink. Offline success no equivale a dominio publicado.

## Files / Ownership
- `scripts/customer-assets-verify.ts (nuevo)`
- `package.json (portal:verify; shared)`
- `apps/customer-assets/tests/, e2e/ (integración)`
- `apps/customer-assets/ops/ (nuevo: deployment checklist/rollback/resource inventory)`
- `evidence/customer-assets-portal/offline.json (nuevo durante ejecución)`

Paths nuevos son ownership de esta unidad; paths existentes son read-only excepto modificaciones expresamente listadas. Coordinator es integration owner de registry, exports, manifests, lockfile y root configs; releer git diff actual y coordinar antes de shared edit. No pisar cambios previos de otras tareas.

## Entry Criteria / Dependencies
Dependencies: P-004.
Todos los gates aplicables aprobados por humano y dependencias accepted. Antes de runtime emulado/schema: G-cap-local; antes de nube/deploy: G-cap-live. Estado pendiente NO significa permiso de ejecución.

## Deliverables
- Verifier offline no-vacuous y fixtures sintéticos
- Evidencia de hashes/roles/retries y browser
- Checklist recursos/migraciones/secrets/email/domain/rollback sin aplicar

## Definition of Done
- [ ] portal:verify devuelve 1 si una etapa o test falta/skip/0 assertions; no false-green.
- [ ] SHA de material importado y output entregado coincide; snapshot/restore existentes no cambian.
- [ ] No secretos en DB pública, DTOs, browser bundle, evidence o sidecars; scopes negados en rutas Better Auth y v1.
- [ ] Registrar counts, command exits, entorno emulado y snapshots browser; no presentar fixture como cliente real.
- [ ] Checklist live presenta D1/bucket nuevos, sender, dominio, migrations revisadas, presupuesto operativo y rollback de aplicación sin destruir datos.
- [ ] Verification ejecutada por worker y reproducida por coordinator con exits y conteos, sin falsos verdes.

## Verification
`bun run portal:verify && bun run studio:verify && bun run build && bun --cwd apps/customer-assets run build; todos exit 0`

Comandos nuevos de esta fase se crean antes de usarlos; los aquí nombrados son acceptance futuro, no están ejecutados ni necesariamente existen hoy. Ejecutar suites relevantes al finalizar unidad, no build/lint/tests/formatters durante investigación delegada. Para QA browser preferir herramienta nativa; compartir preview solo Tailscale IP y listener all-interface verificados, nunca loopback. Servicios persistentes/exposición requieren permiso.

## Evidence
Pendiente. Registrar comandos/exits/counts/fixtures/hash y entorno al ejecutar; nunca token, cookie, URLs de login o credenciales. No marcar completed por presupuesto.

## Subagent Prompt
Task Anchor y Outcome arriba son el trabajo único. Leer este archivo completo y referencias normativas. Cargar feature-executor y skills de dominio aplicables. Implementar únicamente esta unidad con gates verificados. No auto-accept ni resolve de gates. Tomar task en climier → trabajar → reproducir verification → submit con evidencia. Bloqueo real: nota Q: con repro mínimo y pausar solo esta unidad; no autoriza un diseño nuevo o reparación ajena. Reanudar por task READY, no rehacer fases accepted.

## Constraints / Findings / Stop
No investigar/reparar/delegar findings ajenos, ni limpiar/revertir/stage cambios de otros. Reportar mínima ubicación/fallo/impacto y continuar si no bloquea; un bloqueo no amplía scope y coordinator no lo puede autoautorizar. Reparar únicamente regresiones propias dentro de ownership. Sin gasto/infra/DB/migrations/emails/live salvo gate humano correspondiente. Parar al cumplir deliverables y verification; no completar ni fabricar evidencia si algo falta.

## Expected Final Report
Empezar restatando Task Anchor (objetivo, unidad, condición observable); luego archivos/resultados, contratos preservados, comandos/exits/counts y evidencia, bloqueos y findings ajenos mínimos. Reporte sin anchor/evidencia no se acepta.
