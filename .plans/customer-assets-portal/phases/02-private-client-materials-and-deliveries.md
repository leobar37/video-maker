---
id: "P-002"
title: "Backend privado de clientes, materiales y entregas"
status: "accepted"
phase_type: "implementation"
description: "Studio no es multi-tenant por usuario. Worker no puede montar el workspace local. Esta unidad guarda acceso y proyecciones de entrega, conservando referencias de Studio y aislando los archivos privados."
end_state: "Endpoints y archivos privados pasan tests de tenant/scope, uploads/idempotencia, entrega interna y posts; typecheck/build exit 0."
verification: "bun --cwd apps/customer-assets run test:worker -- tests/access.test.ts tests/uploads.test.ts tests/deliveries.test.ts tests/posts.test.ts && bun --cwd apps/customer-assets run typecheck && bun --cwd apps/customer-assets run build; todos exit 0"
deliverables: ["SQL auth/membership/grants/materials/projections/posts revisable", "API v1/SDK tipados", "Servicios ACL, staging privado y descargas Range/HEAD", "Tests de concurrencia y matriz de roles"]
entry_criteria: ["Dependencias accepted y contratos vigentes"]
dependencies: ["P-001"]
requirements: ["FR-002", "FR-003", "FR-004", "FR-008", "FR-009", "NFR-001", "NFR-002", "NFR-006"]
subagent: "feature-executor"
goal: "G-001"
---

# P-002 · Backend privado de clientes, materiales y entregas

## Task Anchor
Objetivo del usuario: «esto complementea el standar que ya tneemos, revisemos por favor». Alcance autorizado de esta unidad al abrir gates: Backend privado de clientes, materiales y entregas. Éxito observable: Endpoints y archivos privados pasan tests de tenant/scope, uploads/idempotencia, entrega interna y posts; typecheck/build exit 0.

## Context
Studio no es multi-tenant por usuario. Worker no puede montar el workspace local. Esta unidad guarda acceso y proyecciones de entrega, conservando referencias de Studio y aislando los archivos privados.

Referencias normativas: `../contracts.md`, `../requirements.md`, `../context.md`, `../goal.md`. Son un portal privado, dashboard y CLI; no generación/publicación ni cliente approvals. Las decisiones de fuente de verdad, ACL y bytes inmutables no son opcionales.

## Outcome / Change
Implementar contratos.md §§1–6: clients adopt para integrador acotado, membresías/admin, materiales y staging, delivery outputs, catálogo privado, posts/carrusel/portada y versioned grid. Guardar pending antes de IO; reservar cuotas concurrentes; verificar bytes/magic signatures y hashes en servidor; finalizar inmutable, sin exponerse ante fallo D1/R2. Scoped AgentGrant siempre validado además de la API key. En cada list/show/content/head/range filtrar membership/grant vigente. Cliente ve solo entregas/posts client_visible y no campos internos. Ocultar un asset corta todas las vías de posts/output. No create/delete de buckets ni migrations remotas.

## Files / Ownership
- `apps/customer-assets/src/server/{access,clients,uploads,materials,deliveries,posts,storage}.ts (nuevos)`
- `apps/customer-assets/src/db/, migrations/, src/routes/api/ (nuevos)`
- `apps/customer-assets/tests/{access,uploads,deliveries,posts}.test.ts (nuevos)`
- `packages/customer-assets/src/{contracts,client}.ts (nuevos)`
- `packages/schemas/src/studio.ts (solo lectura)`

Paths nuevos son ownership de esta unidad; paths existentes son read-only excepto modificaciones expresamente listadas. Coordinator es integration owner de registry, exports, manifests, lockfile y root configs; releer git diff actual y coordinar antes de shared edit. No pisar cambios previos de otras tareas.

## Entry Criteria / Dependencies
Dependencies: P-001.
Todos los gates aplicables aprobados por humano y dependencias accepted. Antes de runtime emulado/schema: G-cap-local; antes de nube/deploy: G-cap-live. Estado pendiente NO significa permiso de ejecución.

## Deliverables
- SQL auth/membership/grants/materials/projections/posts revisable
- API v1/SDK tipados
- Servicios ACL, staging privado y descargas Range/HEAD
- Tests de concurrencia y matriz de roles

## Definition of Done
- [ ] Fixture de dos clientes y proyecto multi-cliente: acceso cruzado list/show/download/HEAD/Range/upload/init/complete/delivery/post/reorder = denied.
- [ ] Cliente no ve borrador ni fuente/manifest/metadata ajena; outputName y rutas manipuladas no acceden a keys arbitrarias.
- [ ] Retry concurrente misma idempotency key/bytes no duplica; payload distinto 409; sobrecuota concurrente se rechaza.
- [ ] Un cuerpo oversized/tipo falso/pending/corrupto jamás alcanza ready; fallo R2/D1 deja retry consistente.
- [ ] Revocación inmediata en siguiente request; private/no-store, MIME y CSP; admin actions no disponibles vía key.
- [ ] Verification ejecutada por worker y reproducida por coordinator con exits y conteos, sin falsos verdes.

## Verification
`bun --cwd apps/customer-assets run test:worker -- tests/access.test.ts tests/uploads.test.ts tests/deliveries.test.ts tests/posts.test.ts && bun --cwd apps/customer-assets run typecheck && bun --cwd apps/customer-assets run build; todos exit 0`

Comandos nuevos de esta fase se crean antes de usarlos; los aquí nombrados son acceptance futuro, no están ejecutados ni necesariamente existen hoy. Ejecutar suites relevantes al finalizar unidad, no build/lint/tests/formatters durante investigación delegada. Para QA browser preferir herramienta nativa; compartir preview solo Tailscale IP y listener all-interface verificados, nunca loopback. Servicios persistentes/exposición requieren permiso.

## Evidence
Pendiente. Registrar comandos/exits/counts/fixtures/hash y entorno al ejecutar; nunca token, cookie, URLs de login o credenciales. No marcar completed por presupuesto.

## Subagent Prompt
Task Anchor y Outcome arriba son el trabajo único. Leer este archivo completo y referencias normativas. Cargar feature-executor y skills de dominio aplicables. Implementar únicamente esta unidad con gates verificados. No auto-accept ni resolve de gates. Tomar task en climier → trabajar → reproducir verification → submit con evidencia. Bloqueo real: nota Q: con repro mínimo y pausar solo esta unidad; no autoriza un diseño nuevo o reparación ajena. Reanudar por task READY, no rehacer fases accepted.

## Constraints / Findings / Stop
No investigar/reparar/delegar findings ajenos, ni limpiar/revertir/stage cambios de otros. Reportar mínima ubicación/fallo/impacto y continuar si no bloquea; un bloqueo no amplía scope y coordinator no lo puede autoautorizar. Reparar únicamente regresiones propias dentro de ownership. Sin gasto/infra/DB/migrations/emails/live salvo gate humano correspondiente. Parar al cumplir deliverables y verification; no completar ni fabricar evidencia si algo falta.

## Expected Final Report
Empezar restatando Task Anchor (objetivo, unidad, condición observable); luego archivos/resultados, contratos preservados, comandos/exits/counts y evidencia, bloqueos y findings ajenos mínimos. Reporte sin anchor/evidencia no se acepta.
