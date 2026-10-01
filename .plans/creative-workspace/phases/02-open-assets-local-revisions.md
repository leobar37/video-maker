---
id: "P-002"
goal: "G-001"
title: "Assets abiertos y revisiones locales recuperables"
status: "completed"
phase_type: "implementation"
description: "Assets abiertos y revisiones locales recuperables para cumplir el contrato agente-first."
end_state: "Snapshot/restore conserva outputs y fuentes/presets por SHA sin renderizar; suites workspace/snapshot pasan con exit 0."
verification: "bun test packages/studio/src/workspace.test.ts packages/studio/src/snapshot.test.ts && bun run build"
deliverables: ["packages/studio/src/workspace.ts", "packages/studio/src/snapshot.ts", "packages/studio/src/catalog.ts", "packages/studio/src/workspace.test.ts", "packages/studio/src/snapshot.test.ts"]
entry_criteria: "Contrato normativo leído; dependencias aceptadas en climier; G-cw-implement resuelto."
dependencies: ["P-001"]
requirements: ["FR-001", "FR-002", "FR-003", "FR-004", "NFR-001", "NFR-002", "NFR-004", "NFR-005"]
subagent: "task"
model: "zai/glm-5.3:high"
---

# P-002 · Assets abiertos y revisiones locales recuperables

Modelo obligatorio: `zai/glm-5.3:high`.

## Context y resultado
Implementar servicios locales del contrato sobre workspace file-based. Sources visibles, snapshot de archivos ya producidos: no dependencia de CLI render, IA, Remotion ni plantilla.

## Archivos / ownership
packages/studio/src/workspace.ts, snapshot.ts, catalog.ts y sus módulos internos/tests; src/index.ts exporta servicios locales. P-004 tendrá sync.ts separado. No tocar runtime/registry ni providers. Dependencias nuevas solo workspace internas; lockfile integra coordinador.

## Acceptance obligatorio
- CRUD mínimo create/list/show clients, presets versionados, proyectos y create/inspect assets. Edición creativa se hace en archivos directamente. Preset update significa crear otra versión, jamás editar sellada.
- Inspect informa rutas reales/faltantes, recursos y preset exacto, recipe e historial. Un asset recién creado puede estar vacío y sin recipe.
- Selección segura según contrato: HTML/SVG/CSS/fuentes/package.json/lockfiles incluidos, caches excluidos, secretos y symlinks rechazados. Snapshot inmutable staging+lock, detecta fuente que cambia mientras copia, al menos un output existente; no inserta recetas ni dimensiones inventadas.
- Dos revisiones después de cambiar logo: r1 permanece idéntica. Files source/input/output/metadata/preset verificables. Restore directorio vacío incluye entregables exactos y contexto editable, NO ejecuta scripts ni regenera. Test con spy de subprocess/fetch que pruebe cero invocaciones.
- Historial/diff deterministic, checkpoint de dos assets y catálogo básico con estados separados. Conflictos de destino y concurrencia local se prueban; falla no deja revisión sellada parcial.
- Fixture video incluye carpeta Remotion editable y MP4 ya existente; no necesita una renderización para validar el backup.

## Handoff
Exportar API local y fixtures de dos revisiones para CLI/R2/UI. Reportar qué recursos externos no fueron declarados; no corregir el renderer de BFC ni absorber todo el repo.

## Reglas de ejecución y reporte
Leer skill builder y feature-executor antes de implementar; mantener ownership. No ejecutar build/tests/formatters durante edición: al concluir la fase, correr verification una vez; coordinador lo reproduce antes de aceptar. Si falla por esta fase, corregir y repetir; si fallo ajeno, reportar sin reparar. No ejecutar gates/accept/commit/merge/deploy.

Reportar archivos modificados, cobertura de requisitos, comandos+exit codes, contratos preservados, bloqueos y limitaciones. Presupuesto de sesión en goal.md; presupuesto agotado => release/budget-limited, no done.
