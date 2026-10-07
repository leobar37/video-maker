---
id: "P-006"
title: "Piloto HTTPS autorizado en customers-assets.theelena.me"
status: "accepted"
phase_type: "validation"
description: "La funcionalidad offline no prueba DNS, bindings, cookies HTTPS ni email entregado. Esta fase es el único lugar para aprovisionar/migrar/subir/enviar/deploy, tras gate humano con inventario y límites explícitos."
end_state: "Smoke real HTTPS en dominio aprobado pasa con email/login, R2/D1, CLI, entrega y grid; live verifier exit 0 con evidencia sin secretos."
verification: "bun run portal:verify:live; exit 0 y evidence/customer-assets-portal/live.json con login/email HTTPS, upload→CLI→entrega→grid, aislamiento y revocación verificados"
deliverables: ["Deployment autorizado y dominio HTTPS", "Smoke live sintético reproducible y evidencia", "IDs/versiones de recursos no secretos y rollback probado/documentado"]
entry_criteria: ["Dependencias accepted; G-cap-live aprobado"]
dependencies: ["P-005"]
requirements: ["FR-001", "FR-003", "FR-004", "FR-005", "FR-006", "FR-007", "FR-008", "NFR-004", "NFR-007"]
subagent: "feature-executor"
goal: "G-001"
---

# P-006 · Piloto HTTPS autorizado en customers-assets.theelena.me

## Task Anchor
Objetivo del usuario: «esto complementea el standar que ya tneemos, revisemos por favor». Alcance autorizado de esta unidad al abrir gates: Piloto HTTPS autorizado en customers-assets.theelena.me. Éxito observable: Smoke real HTTPS en dominio aprobado pasa con email/login, R2/D1, CLI, entrega y grid; live verifier exit 0 con evidencia sin secretos.

## Context
La funcionalidad offline no prueba DNS, bindings, cookies HTTPS ni email entregado. Esta fase es el único lugar para aprovisionar/migrar/subir/enviar/deploy, tras gate humano con inventario y límites explícitos.

Referencias normativas: `../contracts.md`, `../requirements.md`, `../context.md`, `../goal.md`. Son un portal privado, dashboard y CLI; no generación/publicación ni cliente approvals. Las decisiones de fuente de verdad, ACL y bytes inmutables no son opcionales.

## Outcome / Change
Antes de actuar verificar G-cap-live, cuenta/zona, resource inventory, presupuesto requests/bytes/emails, contacto fixture autorizado y migraciones. Si no hay permiso, quedar blocked sin modificar goal a offline-only. Ejecutar únicamente plan de ops revisado: crear/asignar recursos privados aislados, aplicar schema al D1 elegido, configurar secrets/sender y desplegar Worker/domain. No modificar bucket backup/marketing ni migrar otros datos. Smoke synthetic namespace único: email real a operador aprobado, sesión HTTPS, foto <=1MiB (total uploads <=20MiB, max 2 emails salvo permiso distinto), CLI/push resultado existente, visibilidad/post/grid y negativa segundo cliente/grant revocado. Ningún render/IA/publicación. No borrar remoto como cleanup implícito; reportar fixtures huérfanos y retención.

## Files / Ownership
- `apps/customer-assets/wrangler.jsonc y migrations/ (revisión/config autorizada)`
- `apps/customer-assets/ops/, scripts/customer-assets-verify-live.ts (nuevo)`
- `package.json (portal:verify:live; shared)`
- `evidence/customer-assets-portal/live.json (nuevo durante ejecución)`
- `Cloudflare cuenta/Worker/D1/R2/DNS y sender (SOLO permiso G-cap-live)`

Paths nuevos son ownership de esta unidad; paths existentes son read-only excepto modificaciones expresamente listadas. Coordinator es integration owner de registry, exports, manifests, lockfile y root configs; releer git diff actual y coordinar antes de shared edit. No pisar cambios previos de otras tareas.

## Entry Criteria / Dependencies
Dependencies: P-005.
Todos los gates aplicables aprobados por humano y dependencias accepted. Antes de runtime emulado/schema: G-cap-local; antes de nube/deploy: G-cap-live. Estado pendiente NO significa permiso de ejecución.

## Deliverables
- Deployment autorizado y dominio HTTPS
- Smoke live sintético reproducible y evidencia
- IDs/versiones de recursos no secretos y rollback probado/documentado

## Definition of Done
- [ ] Sin G-cap-live resuelto no requests/mutations remotas ni uso de credenciales por conveniencia.
- [ ] DNS/TLS/same-origin cookies/redirect y callback email comprobados en dominio real, no workers.dev como evidencia final.
- [ ] Privacidad bucket y archivos sin sesión falla; member A y key acotada no ven B ni obtienen nuevos permisos.
- [ ] Reportar requests/bytes/emails y comando/exit; redactar tokens/cookies/keys/URLs de login.
- [ ] Operador confirma piloto y coordinador reproduce evidencia; goal no completed si live falta.
- [ ] Verification ejecutada por worker y reproducida por coordinator con exits y conteos, sin falsos verdes.

## Verification
`bun run portal:verify:live; exit 0 y evidence/customer-assets-portal/live.json con login/email HTTPS, upload→CLI→entrega→grid, aislamiento y revocación verificados`

Comandos nuevos de esta fase se crean antes de usarlos; los aquí nombrados son acceptance futuro, no están ejecutados ni necesariamente existen hoy. Ejecutar suites relevantes al finalizar unidad, no build/lint/tests/formatters durante investigación delegada. Para QA browser preferir herramienta nativa; compartir preview solo Tailscale IP y listener all-interface verificados, nunca loopback. Servicios persistentes/exposición requieren permiso.

## Evidence
Pendiente. Registrar comandos/exits/counts/fixtures/hash y entorno al ejecutar; nunca token, cookie, URLs de login o credenciales. No marcar completed por presupuesto.

## Subagent Prompt
Task Anchor y Outcome arriba son el trabajo único. Leer este archivo completo y referencias normativas. Cargar feature-executor y skills de dominio aplicables. Implementar únicamente esta unidad con gates verificados. No auto-accept ni resolve de gates. Tomar task en climier → trabajar → reproducir verification → submit con evidencia. Bloqueo real: nota Q: con repro mínimo y pausar solo esta unidad; no autoriza un diseño nuevo o reparación ajena. Reanudar por task READY, no rehacer fases accepted.

## Constraints / Findings / Stop
No investigar/reparar/delegar findings ajenos, ni limpiar/revertir/stage cambios de otros. Reportar mínima ubicación/fallo/impacto y continuar si no bloquea; un bloqueo no amplía scope y coordinator no lo puede autoautorizar. Reparar únicamente regresiones propias dentro de ownership. Sin gasto/infra/DB/migrations/emails/live salvo gate humano correspondiente. Parar al cumplir deliverables y verification; no completar ni fabricar evidencia si algo falta.

## Expected Final Report
Empezar restatando Task Anchor (objetivo, unidad, condición observable); luego archivos/resultados, contratos preservados, comandos/exits/counts y evidencia, bloqueos y findings ajenos mínimos. Reporte sin anchor/evidencia no se acepta.
