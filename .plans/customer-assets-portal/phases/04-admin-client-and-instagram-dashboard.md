---
id: "P-004"
title: "Dashboard admin/cliente y simulación de Instagram"
status: "pending"
phase_type: "implementation"
description: "La UI actual es vanilla/read-only para tailnet. Esta unidad crea la app React Start privada sin exponer el servidor Bun ni prometer integración real de Instagram."
end_state: "Tests de UI y browser en desktop/móvil pasan carga, filtros, draft oculto, posts/carrusel y grid persistida; typecheck/build exit 0."
verification: "bun --cwd apps/customer-assets run test:ui && bun --cwd apps/customer-assets run test:e2e && bun --cwd apps/customer-assets run typecheck && bun --cwd apps/customer-assets run build; todos exit 0"
deliverables: ["Portal por cliente con Materiales/Assets/Posts/Instagram", "Admin invites/access/visibility/caption/order", "Estados accesibles y upload progress", "Evidencia visual desktop/móvil con fixtures"]
entry_criteria: ["Dependencias accepted y contratos vigentes"]
dependencies: ["P-003"]
requirements: ["FR-002", "FR-003", "FR-004", "FR-005", "FR-006", "NFR-005"]
subagent: "feature-executor"
goal: "G-001"
---

# P-004 · Dashboard admin/cliente y simulación de Instagram

## Task Anchor
Objetivo del usuario: «esto complementea el standar que ya tneemos, revisemos por favor». Alcance autorizado de esta unidad al abrir gates: Dashboard admin/cliente y simulación de Instagram. Éxito observable: Tests de UI y browser en desktop/móvil pasan carga, filtros, draft oculto, posts/carrusel y grid persistida; typecheck/build exit 0.

## Context
La UI actual es vanilla/read-only para tailnet. Esta unidad crea la app React Start privada sin exponer el servidor Bun ni prometer integración real de Instagram.

Referencias normativas: `../contracts.md`, `../requirements.md`, `../context.md`, `../goal.md`. Son un portal privado, dashboard y CLI; no generación/publicación ni cliente approvals. Las decisiones de fuente de verdad, ACL y bytes inmutables no son opcionales.

## Outcome / Change
Construir rutas propuestas y features de contratos.md §8. Subida mobile con formatos/límites visibles, retry y progreso real; unsupported HEIC explicado. Mostrar assets y versiones seleccionadas, posts/carrusel/portada con caption y descargas. Grid tres columnas y modal/detail; admin ordena mediante controles accesibles persistidos con version y conflicto; cliente solo consulta. Formularios encapsulados con wrappers/Zod, TanStack Query con cache usuario+cliente y limpieza logout. No hardcoded contenido de marca ni código por cliente. No editor de video, aprobación del cliente ni publicación.

## Files / Ownership
- `apps/customer-assets/src/routes/{login,portal,admin}* (nuevos)`
- `apps/customer-assets/src/features/{auth,clients,materials,assets,posts,instagram,admin}/ (nuevos)`
- `apps/customer-assets/src/components/{forms,ui}/ (nuevos)`
- `apps/customer-assets/tests/dashboard.test.tsx y e2e/portal.spec.ts (nuevos)`
- `packages/dashboard/src/ (solo lectura: preservar viewer confiable)`

Paths nuevos son ownership de esta unidad; paths existentes son read-only excepto modificaciones expresamente listadas. Coordinator es integration owner de registry, exports, manifests, lockfile y root configs; releer git diff actual y coordinar antes de shared edit. No pisar cambios previos de otras tareas.

## Entry Criteria / Dependencies
Dependencies: P-003.
Todos los gates aplicables aprobados por humano y dependencias accepted. Antes de runtime emulado/schema: G-cap-local; antes de nube/deploy: G-cap-live. Estado pendiente NO significa permiso de ejecución.

## Deliverables
- Portal por cliente con Materiales/Assets/Posts/Instagram
- Admin invites/access/visibility/caption/order
- Estados accesibles y upload progress
- Evidencia visual desktop/móvil con fixtures

## Definition of Done
- [ ] Client A jamás ve cache/miniaturas/posts de B al cambiar sesión/cliente; navegación deep-link también protegida.
- [ ] Admin habilita entrega y post, luego oculta: cliente pierde catálogo/archivo/ruta directa.
- [ ] Grid persiste reload; carousel order y caption seguros (sin HTML activo); conflicto de reorder no pierde cambios silenciosamente.
- [ ] Pruebas upload happy path/error/unsupported/oversized y empty state; viewport 390x844 y 1440x900 sin overflow.
- [ ] Capturas revisadas personalmente sin tokens ni URLs privadas sensibles; requests reales solo runtime local autorizado.
- [ ] Verification ejecutada por worker y reproducida por coordinator con exits y conteos, sin falsos verdes.

## Verification
`bun --cwd apps/customer-assets run test:ui && bun --cwd apps/customer-assets run test:e2e && bun --cwd apps/customer-assets run typecheck && bun --cwd apps/customer-assets run build; todos exit 0`

Comandos nuevos de esta fase se crean antes de usarlos; los aquí nombrados son acceptance futuro, no están ejecutados ni necesariamente existen hoy. Ejecutar suites relevantes al finalizar unidad, no build/lint/tests/formatters durante investigación delegada. Para QA browser preferir herramienta nativa; compartir preview solo Tailscale IP y listener all-interface verificados, nunca loopback. Servicios persistentes/exposición requieren permiso.

## Evidence
Pendiente. Registrar comandos/exits/counts/fixtures/hash y entorno al ejecutar; nunca token, cookie, URLs de login o credenciales. No marcar completed por presupuesto.

## Subagent Prompt
Task Anchor y Outcome arriba son el trabajo único. Leer este archivo completo y referencias normativas. Cargar feature-executor y skills de dominio aplicables. Implementar únicamente esta unidad con gates verificados. No auto-accept ni resolve de gates. Tomar task en climier → trabajar → reproducir verification → submit con evidencia. Bloqueo real: nota Q: con repro mínimo y pausar solo esta unidad; no autoriza un diseño nuevo o reparación ajena. Reanudar por task READY, no rehacer fases accepted.

## Constraints / Findings / Stop
No investigar/reparar/delegar findings ajenos, ni limpiar/revertir/stage cambios de otros. Reportar mínima ubicación/fallo/impacto y continuar si no bloquea; un bloqueo no amplía scope y coordinator no lo puede autoautorizar. Reparar únicamente regresiones propias dentro de ownership. Sin gasto/infra/DB/migrations/emails/live salvo gate humano correspondiente. Parar al cumplir deliverables y verification; no completar ni fabricar evidencia si algo falta.

## Expected Final Report
Empezar restatando Task Anchor (objetivo, unidad, condición observable); luego archivos/resultados, contratos preservados, comandos/exits/counts y evidencia, bloqueos y findings ajenos mínimos. Reporte sin anchor/evidencia no se acepta.
