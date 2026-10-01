---
id: "P-003"
goal: "G-001"
title: "CLI declarativa y recipe explícita opcional"
status: "completed"
phase_type: "implementation"
description: "CLI declarativa y recipe explícita opcional para cumplir el contrato agente-first."
end_state: "CLI por grupos consume API local, JSON y dry-run correctos; tests de nuevas specs y runtime legacy pasan con exit 0."
verification: "bun test packages/cli/src/specs/studio.test.ts packages/cli/src/runtime.test.ts packages/cli/src/args.test.ts && bun run build"
deliverables: ["packages/cli/src/specs/studio.ts", "packages/cli/src/specs/studio.test.ts", "packages/cli/src/args.test.ts"]
entry_criteria: "Contrato normativo leído; dependencias aceptadas en climier; G-cw-implement resuelto."
dependencies: ["P-002"]
requirements: ["FR-005", "FR-003", "FR-004", "NFR-002", "NFR-003", "NFR-004"]
subagent: "task"
model: "zai/glm-5.3-flash:high"
---

# P-003 · CLI declarativa y recipe explícita opcional

Modelo obligatorio: `zai/glm-5.3-flash:high`.

## Context y resultado
Adaptador mecánico de contratos ya congelados. Mantener registry declarativo y comportamiento anterior; CLI administra trabajo del agente, no decide composición. Ante ambigüedad del dispatcher escalar a GLM/coordinador, no reconstruir parser.

## Archivos / ownership
specs/studio.ts, args.test.ts y tests studio; integración mínima en all-specs.ts, args.ts/runtime.ts/registry.ts cuando corresponda. Todos los cambios a estos archivos compartidos los integra esta fase bajo ownership del coordinador. No implementar storage ni UI. Los grupos sync/dashboard se declaran y cablean cuando sus APIs existan en P-004/P-005; no placeholders que retornen éxito.

## Acceptance obligatorio
- Implementar client/preset/project/asset del contrato local incluyendo checkpoint. Normalización exacta grupo+subcomando y positional id -> flag id de spec; lista blanca, aridad clara y no consumir valores de --flags. Verbos legacy intactos, flags globales antes/después y help global/específico cubiertos.
- Cada spec usa services P-002 y ctx; --workspace explícito o default workspace. Queries --json imprimen solo envelope estable; errores tipados/status exit coherente.
- --plan y --dry-run en todos los comandos: cero writes, red, secretos, bind o subprocess; probado mediante mocks/spies y antes/después del árbol.
- asset render solo existe con recipe opcional: plan enseña argv/cwd/outputs reales; ejecución exige --execute, spawn directo sin shell, cwd confinado, fallo exit no crea revisión. Sin recipe => error accionable; no buscar templates ni crear renderer oculto. Snapshot/restore no llaman render.
- Fixture CLI crea proyecto sin cliente y otro con dos marcas, registra output producido fuera de CLI, snapshot/history/diff/restore funciona.

## Handoff
Mapa de parejas exactas para que P-004/P-005 agreguen specs en el módulo correspondiente bajo integración del coordinador; tests golden de JSON/help. Si contratos de argumentos requieren cambios, bloquear en lugar de escoger silenciosamente otra API.

## Reglas de ejecución y reporte
Leer skill builder y feature-executor antes de implementar; mantener ownership. No ejecutar build/tests/formatters durante edición: al concluir la fase, correr verification una vez; coordinador lo reproduce antes de aceptar. Si falla por esta fase, corregir y repetir; si fallo ajeno, reportar sin reparar. No ejecutar gates/accept/commit/merge/deploy.

Reportar archivos modificados, cobertura de requisitos, comandos+exit codes, contratos preservados, bloqueos y limitaciones. Presupuesto de sesión en goal.md; presupuesto agotado => release/budget-limited, no done.
