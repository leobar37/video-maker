---
id: "P-001"
title: "Auth y credenciales demostradas en D1/Workers"
status: "accepted"
phase_type: "investigation"
description: "No existe auth ni app Start hoy. La documentación ofrece una ruta Drizzle SQLite + binding D1 pero no demuestra los plugins juntos. Esta unidad reduce ese riesgo antes de desarrollar todo el portal."
end_state: "Tests Workers/D1 de login, session y API keys y prueba streaming/hash/R2 pasan; typecheck y build exit 0; versiones y configuración de adapter documentadas."
verification: "bun --cwd apps/customer-assets run test:worker -- tests/auth-runtime.test.ts tests/upload-runtime.test.ts && bun --cwd apps/customer-assets run typecheck && bun --cwd apps/customer-assets run build; todos exit 0"
deliverables: ["App Start mínima bundleable en Workers", "Schemas auth y SQL local revisable", "Prueba real de runtime emulado y reporte de versiones/limitaciones"]
entry_criteria: ["G-cap-implement y G-cap-local aprobados"]
dependencies: []
requirements: ["FR-001", "FR-009", "NFR-001", "NFR-004", "NFR-007"]
subagent: "feature-executor"
goal: "G-001"
---

# P-001 · Auth y credenciales demostradas en D1/Workers

## Task Anchor
Objetivo del usuario: «esto complementea el standar que ya tneemos, revisemos por favor». Alcance autorizado de esta unidad al abrir gates: Auth y credenciales demostradas en D1/Workers. Éxito observable: Tests Workers/D1 de login, session y API keys y prueba streaming/hash/R2 pasan; typecheck y build exit 0; versiones y configuración de adapter documentadas.

## Context
No existe auth ni app Start hoy. La documentación ofrece una ruta Drizzle SQLite + binding D1 pero no demuestra los plugins juntos. Esta unidad reduce ese riesgo antes de desarrollar todo el portal.

Referencias normativas: `../contracts.md`, `../requirements.md`, `../context.md`, `../goal.md`. Son un portal privado, dashboard y CLI; no generación/publicación ni cliente approvals. Las decisiones de fuente de verdad, ACL y bytes inmutables no son opcionales.

## Outcome / Change
Fijar dependencias y ejecutar magic link con mail sink fake, sesión/get-session/logout, token vencido/reutilizado, disableSignUp y provisioning reservado. Probar key create/verify/revoke sin impersonación, proteger endpoints genéricos de emisión/escalación y demostrar que cliente/agent no adquiere rol admin. Usar binding D1 emulado con schema aplicado SOLO tras G-cap-local. Probar upload limitado/hash incremental y escritura condicional R2 en runtime Workers, con fixture pequeño y cuerpo simulado de límite. Registrar API/config exacta del adapter transaccional: si se exige BEGIN/COMMIT no soportado, configurar opción respaldada por versión/fuente o bloquear con repro; no inventar atomicidad. No PostgreSQL, paquetes Cloudflare extra o proveedor nuevo sin aprobación. El bundle no debe importar Studio file-based, node:fs, dashboard Bun ni secretos.

## Files / Ownership
- `apps/customer-assets/package.json, vite.config.ts, wrangler.jsonc, tsconfig.json (nuevos)`
- `apps/customer-assets/src/server/auth.ts, db.ts y db/auth-schema.ts (nuevos)`
- `apps/customer-assets/tests/auth-runtime.test.ts, tests/upload-runtime.test.ts (nuevos)`
- `packages/customer-assets/src/contracts.ts (nuevo SDK puro)`
- `package.json, bun.lock (shared; integration owner)`
- `packages/schemas/src/studio.ts y packages/studio/src/contracts.ts (solo lectura)`

Paths nuevos son ownership de esta unidad; paths existentes son read-only excepto modificaciones expresamente listadas. Coordinator es integration owner de registry, exports, manifests, lockfile y root configs; releer git diff actual y coordinar antes de shared edit. No pisar cambios previos de otras tareas.

## Entry Criteria / Dependencies
Dependencies: ninguna fase previa.
Todos los gates aplicables aprobados por humano y dependencias accepted. Antes de runtime emulado/schema: G-cap-local; antes de nube/deploy: G-cap-live. Estado pendiente NO significa permiso de ejecución.

## Deliverables
- App Start mínima bundleable en Workers
- Schemas auth y SQL local revisable
- Prueba real de runtime emulado y reporte de versiones/limitaciones

## Definition of Done
- [ ] Auth/runtime tests tienen assertions y no mocks que sustituyen el binding D1 en la prueba de compatibilidad.
- [ ] Cliente/agent no crean keys privilegiadas por endpoint genérico; replay de magic link falla.
- [ ] Mail sink solo fixture no tokens en evidencia; bundle inspeccionado sin dependencias host.
- [ ] Configuración y versiones finales anotadas en contexto/contratos; si no viable, fase blocked con repro y alternativa acotada.
- [ ] Verification ejecutada por worker y reproducida por coordinator con exits y conteos, sin falsos verdes.

## Verification
`bun --cwd apps/customer-assets run test:worker -- tests/auth-runtime.test.ts tests/upload-runtime.test.ts && bun --cwd apps/customer-assets run typecheck && bun --cwd apps/customer-assets run build; todos exit 0`

Comandos nuevos de esta fase se crean antes de usarlos; los aquí nombrados son acceptance futuro, no están ejecutados ni necesariamente existen hoy. Ejecutar suites relevantes al finalizar unidad, no build/lint/tests/formatters durante investigación delegada. Para QA browser preferir herramienta nativa; compartir preview solo Tailscale IP y listener all-interface verificados, nunca loopback. Servicios persistentes/exposición requieren permiso.

## Evidence
Pendiente. Registrar comandos/exits/counts/fixtures/hash y entorno al ejecutar; nunca token, cookie, URLs de login o credenciales. No marcar completed por presupuesto.

## Subagent Prompt
Task Anchor y Outcome arriba son el trabajo único. Leer este archivo completo y referencias normativas. Cargar feature-executor y skills de dominio aplicables. Implementar únicamente esta unidad con gates verificados. No auto-accept ni resolve de gates. Tomar task en climier → trabajar → reproducir verification → submit con evidencia. Bloqueo real: nota Q: con repro mínimo y pausar solo esta unidad; no autoriza un diseño nuevo o reparación ajena. Reanudar por task READY, no rehacer fases accepted.

## Constraints / Findings / Stop
No investigar/reparar/delegar findings ajenos, ni limpiar/revertir/stage cambios de otros. Reportar mínima ubicación/fallo/impacto y continuar si no bloquea; un bloqueo no amplía scope y coordinator no lo puede autoautorizar. Reparar únicamente regresiones propias dentro de ownership. Sin gasto/infra/DB/migrations/emails/live salvo gate humano correspondiente. Parar al cumplir deliverables y verification; no completar ni fabricar evidencia si algo falta.

## Expected Final Report
Empezar restatando Task Anchor (objetivo, unidad, condición observable); luego archivos/resultados, contratos preservados, comandos/exits/counts y evidencia, bloqueos y findings ajenos mínimos. Reporte sin anchor/evidencia no se acepta.
