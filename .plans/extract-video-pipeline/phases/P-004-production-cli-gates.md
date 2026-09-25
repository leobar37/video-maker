---
id: P-004
title: "CLI de producción con gates derivados del filesystem"
status: done
phase_type: integration
description: "Integrar core, providers y motion kit en una CLI de producción declarativa (registry de specs de comando ejecutado por un runtime, FR-013): scaffolder de proyectos, comandos de generación de audio/medios con ciclo plan/submit/status/download, ensamblado y stills, QA de loudness, gates de estado derivados del filesystem, y persistencia portable (bundle content-addressed + hydrate/archive + catálogo)."
end_state: "Sobre un proyecto nuevo creado con `bun run vm -- new`: `bun run vm -- preflight`, `-- status` y `-- plan` terminan con exit 0, `bun run vm -- assemble --dry-run` arma el plan de render sin red, los gates se derivan del filesystem y el round-trip `bundle` → `hydrate` restaura el proyecto verificando hashes."
verification: "Script `bun run demo:dry` que crea un proyecto de prueba, ejecuta preflight/status/plan, assemble --dry-run y bundle+hydrate en un temp dir, y termina exit 0 sin red; más `bun test` de gates (transiciones derivadas) y de bundle/hydrate (hash round-trip)."
deliverables: "packages/cli con subcomandos new/preflight/status/find/catalog/plan/gen-audio/gen-music/gen-media/still/assemble/qa/bundle/hydrate/archive; gates file-based v1 (storyboard, spend, assets, render, qa, signoff, publish); scaffolder de proyectos; bundle content-addressed con MANIFEST + hydrate/archive; script demo:dry; README operativo."
entry_criteria: "P-002 y P-003 completados (providers y motion kit testeables e importables)."
dependencies: [P-002, P-003]
requirements: [FR-008, FR-009, FR-010, FR-012]
goal: G-001
subagent: task
---

# P-004 — CLI de producción con gates derivados del filesystem

## Contexto

Es la fase que hace usable el producto. La fuente lo resuelve con 60 scripts standalone
(`bun videos/cli/<verbo>.ts`); aquí se unifican como subcomandos de una sola CLI, conservando
el ciclo `--plan` primero que nada y el estado derivado de artefactos (no hay archivo de
estado editable).

## Files / áreas involucradas

Origen (referencia de copia, worktree `control-de-caja`):
- `videos/cli/new-video.ts` — scaffolder (estructura idempotente de carpeta-proyecto).
- `videos/cli/lib/workflow-state.ts` — gates derivados del filesystem (núcleo a portar/adaptar).
- `videos/cli/{preflight,status,find,catalog,inspect}.ts` — superficie de estado e inspección.
- `videos/cli/{assemble,still,qa,loudness}.ts` — render, stills y QA técnico.
- `videos/cli/{bundle,hydrate,save,archive,backup-artifacts}.ts` — persistencia portable.
- `videos/cli/lib/{publication,archive-paths,asset-provenance}.ts` — evidencia y proveniencia.
- `cli/src/commands/video.ts` — referencia de la fachada (passthrough) y del contrato progreso/resultado.

Destino: `packages/cli`, `projects/demo/hello`, `scripts/demo-dry.ts`, README operativo.

## Qué lograr

1. CLI única `vm` **declarativa**: cada subcomando (`new`, `preflight`, `status`, `find`,
   `catalog`, `plan`, `gen-audio`, `gen-music`, `gen-media` (fal-video/avatar vía providers),
   `still`, `assemble`, `qa`, `bundle`, `hydrate`, `archive`) es una spec en un registry
   declarativo (verbo, args con schema, modo plan, artefactos que escribe, gates que mueve)
   ejecutada por un runtime pequeño (FR-013). Agregar un comando = agregar una spec.
   Cada comando que gasta soporta `--plan`/`--dry-run` sin red ni credenciales (NFR-002).
2. Gates file-based adaptados a v1: `storyboard`, `spend`, `assets`, `render`, `qa`,
   `signoff`, `publish` (sin `capture`, cuyo seam queda diferido junto a `demo-app`),
   derivados de `video.json` + artefactos + journals de operaciones.
3. Scaffolder `new` que crea la carpeta-proyecto completa (config, script/, scenes/,
   remotion/, qa/, renders/) dejando escenas pendientes.
4. Persistencia portable: bundle content-addressed con MANIFEST y sha256 (excluye regenerables
   tipo `.cache`), `hydrate` con verificación de hash y `archive` separando binarios hacia el
   `ObjectStore` de providers.
5. Ensamblado: narración continua → props de film → render adapter → ducking → loudnorm,
   con QA de loudness/true peak y escritura de evidencia (hashes, proveniencia).

## Qué preservar

- El estado se deriva de artefactos; prohibido introducir un `workflow.json` editable.
- Contract de resultado del proyecto (mp4 + sha256 + qa passed + git commit) tal como lo
  validan los parsers fuente, para que la evidencia siga siendo verificable por terceros.

## Validación y resultado final verificable

- `bun run demo:dry` → exit 0 sin red (crea proyecto, preflight/status/plan, assemble
  --dry-run, bundle+hydrate round-trip en temp dir con hashes verificados).
- `bun test` (gates y bundle/hydrate) → exit 0.
- `bun run build` → exit 0.

## Reporte final esperado

Mapa de subcomandos → implementación, tabla de gates con su fuente de verdad (qué artefacto
lo satisface), contrato del bundle/MANIFEST y salidas de `demo:dry` y `bun test`.
