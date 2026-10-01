---
id: "P-001"
goal: "G-001"
title: "Dominio, schemas y contrato portable"
status: "completed"
phase_type: "implementation"
description: "Dominio, schemas y contrato portable para cumplir el contrato agente-first."
end_state: "Schemas v1 y tipos públicos validan assets abiertos/multimarca y manifests portables; suite studio de schemas y build pasan con exit 0."
verification: "bun test packages/schemas/src/studio.test.ts && bun run build"
deliverables: ["packages/schemas/src/studio.ts", "packages/schemas/src/studio.test.ts", "packages/studio/src/contracts.ts", "packages/studio/package.json"]
entry_criteria: "Contrato normativo leído; dependencias aceptadas en climier; G-cw-implement resuelto."
dependencies: []
requirements: ["FR-001", "FR-002", "FR-003", "FR-004", "NFR-001", "NFR-002", "NFR-003", "NFR-004"]
subagent: "task"
model: "zai/glm-5.3:high"
---

# P-001 · Dominio, schemas y contrato portable

Modelo obligatorio: `zai/glm-5.3:high`.

## Context y resultado
Contrato antes que implementación. Leer context.md, requirements.md, goal.md y contracts.md. Nuevo dominio separado de VideoConfig y catálogo legacy: proyecto no está encerrado dentro de un cliente y asset no exige layout, template ni recipe.

## Archivos / ownership
Crear schemas studio y sus tests; exportar desde schemas/src/index.ts. Crear esqueleto mínimo packages/studio (package.json, tsconfig.json, src/contracts.ts) con tipos de contexto/storage/errores y API acordada, sin funciones fake que prometan éxito. No implementar filesystem, CLI, R2 ni dashboard. No modificar core/project ni brand.ts.

## Acceptance obligatorio
- Todos los objetos y retorno de catálogo cumplen contrato v1; referencias exactas preset@version, output visibility privado por default y proyectos sin cliente o con dos clientes.
- Manifests incluyen proyecto/clientes, asset, presets y receta opcional; outputs solo apuntan a files existentes, paths únicos, SHA/bytes válidos, IDs y enum de estados validados. Recipes no admiten rutas externas.
- Implementar y probar canonización/hashing de payload del contrato en módulo de dominio puro: mismo contenido/mismo rootHash, timestamps/notas/IDs no alteran rootHash, cambio de output/preset sí. Orden de claves estable; no mezclar hash legacy.
- Documentar firmas exportadas definitivas EN contracts.md solo si precisan tipos; un cambio semántico requiere bloqueo/operador. Congelar DTOs del catálogo para P-005.
- Crear suites nombradas en verification; schema negative tests, metadata desconocida/control de versiones y fixtures no secretos. Build global preservado.

## Handoff
Entregar schemas/tipos, ejemplo de manifest validado y decisiones de canonical JSON. El coordinador reproduce verification antes de accept; P-002 no inicia con contrato sin congelar.

## Reglas de ejecución y reporte
Leer skill builder y feature-executor antes de implementar; mantener ownership. No ejecutar build/tests/formatters durante edición: al concluir la fase, correr verification una vez; coordinador lo reproduce antes de aceptar. Si falla por esta fase, corregir y repetir; si fallo ajeno, reportar sin reparar. No ejecutar gates/accept/commit/merge/deploy.

Reportar archivos modificados, cobertura de requisitos, comandos+exit codes, contratos preservados, bloqueos y limitaciones. Presupuesto de sesión en goal.md; presupuesto agotado => release/budget-limited, no done.
