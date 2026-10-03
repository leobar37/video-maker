---
id: "P-003"
title: "CLI conecta materiales y outputs con Studio sin duplicación"
status: "pending"
phase_type: "integration"
description: "Agentes trabajan en un workspace Studio local y el portal es remoto. El único puente permitido es la CLI/SDK, con workspace, cliente y revisión explícitos y un principal integrador autorizado."
end_state: "CLI JSON y bridge pasan pruebas de dry-run sin red, importación verificable, entrega exacta/idempotente y compatibilidad; build exit 0."
verification: "bun test packages/customer-assets packages/cli/src/specs/portal.test.ts packages/cli/src/portal packages/cli/src/runtime.test.ts packages/cli/src/specs/studio.test.ts && bun run build; todos exit 0"
deliverables: ["Specs portal-* en dispatcher actual", "SDK HTTP portable sin credentials D1/R2", "Import material y push output con provenance segura", "Tests de envelopes/exit codes y escape de paths"]
entry_criteria: ["Dependencias accepted y contratos vigentes"]
dependencies: ["P-002"]
requirements: ["FR-007", "FR-008", "NFR-003", "NFR-006"]
subagent: "feature-executor"
goal: "G-001"
---

# P-003 · CLI conecta materiales y outputs con Studio sin duplicación

## Task Anchor
Objetivo del usuario: «esto complementea el standar que ya tneemos, revisemos por favor». Alcance autorizado de esta unidad al abrir gates: CLI conecta materiales y outputs con Studio sin duplicación. Éxito observable: CLI JSON y bridge pasan pruebas de dry-run sin red, importación verificable, entrega exacta/idempotente y compatibilidad; build exit 0.

## Context
Agentes trabajan en un workspace Studio local y el portal es remoto. El único puente permitido es la CLI/SDK, con workspace, cliente y revisión explícitos y un principal integrador autorizado.

Referencias normativas: `../contracts.md`, `../requirements.md`, `../context.md`, `../goal.md`. Son un portal privado, dashboard y CLI; no generación/publicación ni cliente approvals. Las decisiones de fuente de verdad, ACL y bytes inmutables no son opcionales.

## Outcome / Change
Implementar commands de contratos.md §7, sin renombrar aliases legacy ni extender normalización por comodidad. El material se importa a inputs de asset abierto, con sidecar provenance y update asset.json validado y atómico; no inventar snapshot sin outputs. En caso de importar a nuevo asset, creación solo por SDK existente y flags explícitos, nunca proyecto por default. Push lee manifest sellado y bytes de revisión, verifica rootHash/hash y transmite únicamente outputs elegidos con staging/idempotencia; no latest mutable ni render/recover implícito. Mantener 0/1/2 y envelope Studio, mensajes redactados, HTTPS/origin allowlist sin redirect credential leakage. Dry-run y plan no cargan secrets ni hacen fetch/filesystem writes.

## Files / Ownership
- `packages/cli/src/specs/portal.ts, portal.test.ts (nuevos)`
- `packages/cli/src/portal/{bridge,auth}.ts y tests (nuevos)`
- `packages/customer-assets/src/{client,contracts}.ts (SDK)`
- `packages/cli/src/all-specs.ts (shared; relectura y owner)`
- `packages/cli/src/runtime.ts, spec-types.ts, specs/studio-pairs.ts (lectura; no segundo dispatcher)`
- `packages/studio/src/{contracts,paths,workspace,snapshot}.ts (lectura)`

Paths nuevos son ownership de esta unidad; paths existentes son read-only excepto modificaciones expresamente listadas. Coordinator es integration owner de registry, exports, manifests, lockfile y root configs; releer git diff actual y coordinar antes de shared edit. No pisar cambios previos de otras tareas.

## Entry Criteria / Dependencies
Dependencies: P-002.
Todos los gates aplicables aprobados por humano y dependencias accepted. Antes de runtime emulado/schema: G-cap-local; antes de nube/deploy: G-cap-live. Estado pendiente NO significa permiso de ejecución.

## Deliverables
- Specs portal-* en dispatcher actual
- SDK HTTP portable sin credentials D1/R2
- Import material y push output con provenance segura
- Tests de envelopes/exit codes y escape de paths

## Definition of Done
- [ ] Adopt mismo studioClientId en dos workspaceIds no mezcla clientes.
- [ ] Import dos veces da mismos bytes/path/relación; hash corrupto y traversal/symlinks fallan sin alterar asset previo.
- [ ] Push r1, luego trabajar r2: portal r1 conserva hash/bytes; push solo output declarado, sin sources/recipe/.env.
- [ ] Mutation sin --execute muestra plan, no red; dry-run con creds disponibles también cero IO/cred lookup.
- [ ] Remote pagination y auth expired/revoked/scope denied dan JSON y exit correcto; legacy specs/runtime siguen verdes.
- [ ] Verification ejecutada por worker y reproducida por coordinator con exits y conteos, sin falsos verdes.

## Verification
`bun test packages/customer-assets packages/cli/src/specs/portal.test.ts packages/cli/src/portal packages/cli/src/runtime.test.ts packages/cli/src/specs/studio.test.ts && bun run build; todos exit 0`

Comandos nuevos de esta fase se crean antes de usarlos; los aquí nombrados son acceptance futuro, no están ejecutados ni necesariamente existen hoy. Ejecutar suites relevantes al finalizar unidad, no build/lint/tests/formatters durante investigación delegada. Para QA browser preferir herramienta nativa; compartir preview solo Tailscale IP y listener all-interface verificados, nunca loopback. Servicios persistentes/exposición requieren permiso.

## Evidence
Pendiente. Registrar comandos/exits/counts/fixtures/hash y entorno al ejecutar; nunca token, cookie, URLs de login o credenciales. No marcar completed por presupuesto.

## Subagent Prompt
Task Anchor y Outcome arriba son el trabajo único. Leer este archivo completo y referencias normativas. Cargar feature-executor y skills de dominio aplicables. Implementar únicamente esta unidad con gates verificados. No auto-accept ni resolve de gates. Tomar task en climier → trabajar → reproducir verification → submit con evidencia. Bloqueo real: nota Q: con repro mínimo y pausar solo esta unidad; no autoriza un diseño nuevo o reparación ajena. Reanudar por task READY, no rehacer fases accepted.

## Constraints / Findings / Stop
No investigar/reparar/delegar findings ajenos, ni limpiar/revertir/stage cambios de otros. Reportar mínima ubicación/fallo/impacto y continuar si no bloquea; un bloqueo no amplía scope y coordinator no lo puede autoautorizar. Reparar únicamente regresiones propias dentro de ownership. Sin gasto/infra/DB/migrations/emails/live salvo gate humano correspondiente. Parar al cumplir deliverables y verification; no completar ni fabricar evidencia si algo falta.

## Expected Final Report
Empezar restatando Task Anchor (objetivo, unidad, condición observable); luego archivos/resultados, contratos preservados, comandos/exits/counts y evidencia, bloqueos y findings ajenos mínimos. Reporte sin anchor/evidencia no se acepta.
