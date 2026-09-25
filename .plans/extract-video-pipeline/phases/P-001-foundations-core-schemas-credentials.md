---
id: P-001
title: "Fundaciones: workspace, contratos, schemas y credenciales Doppler"
status: done
phase_type: implementation
description: "Crear el esqueleto Bun workspaces del repo y los paquetes core, schemas y credentials, copiando y desacoplando los contratos verificados del monorepo origen e implementando la estrategia de credenciales Doppler idéntica a la fuente (env-first, elena-tech/prd, lazy, cache, redacción)."
end_state: "`bun install && bun test && bun run build` exit 0 y `bun run credentials:probe` resuelve FAL_KEY, ZERNIO_API_KEY, ELEVENLABS_API_KEY y R2Env con fallback a Doppler elena-tech/prd imprimiendo solo nombres y longitudes de valores."
verification: "bun install && bun test && bun run build && bun run credentials:probe; adicionalmente `grep -rE '@theelena|control-de-caja|videos/cli' packages/` no arroja resultados."
deliverables: "packages/core (VideoConfig/SceneConfig/Project, rutas seguras), packages/schemas (Zod versionados: propuesta/progreso/resultado, SceneResult, narración continua, catálogo), packages/credentials (CredentialResolver con estrategia Doppler), tsconfig base, runner de tests, script credentials:probe, README de contratos."
entry_criteria: "Repo /home/leobar37/code/video-maker inicializado con git y bun disponible; para probar el fallback Doppler en vivo, DOPPLER_TOKEN_ELENA_TECH (o ~/.config/elena-tech/config.json con dopplerToken) presente."
dependencies: []
requirements: [FR-001, FR-002, FR-011]
goal: G-001
subagent: task
---

# P-001 — Fundaciones: workspace, contratos, schemas y credenciales Doppler

## Contexto

Es la base sobre la que se apoyan todas las demás fases. El monorepo origen ya resolvió los
diseños difíciles: contratos de proyecto versionados, sanitización de rutas y una estrategia
de credenciales probada. El trabajo es copiar esos contratos desacoplándolos de
`ProductId`, rutas `videos/` y helpers del monorepo.

## Files / áreas involucradas

Origen (referencia de copia, worktree `control-de-caja`):
- `videos/cli/lib/credentials.ts` — estrategia Doppler completa a portar casi literal.
- `videos/cli/lib/marketing.ts` — tipos `R2Env`, `accountIdFromEndpoint`, `inspectMarketingEnv`.
- `videos/cli/lib/project.ts` — `VideoConfig`/`SceneConfig`/`Project`, resolución de rutas.
- `cli/src/videos/video-types.ts` — propuesta/progreso/resultado V1/V2 y validadores.
- `videos/cli/scene-contracts.ts`, `videos/links/03-pipeline-de-videos/scenes/*.result.json` — contrato SceneResult.
- `videos/cli/lib/continuous-narration.ts` + `script/audio/narration.json` de un proyecto real — contrato de narración continua.

Destino: `packages/core`, `packages/schemas`, `packages/credentials`, `tsconfig.base.json`,
`package.json` raíz (workspaces), `bunfig.toml`, `README.md`.

## Qué lograr

1. Bun workspaces con `packages/{core,schemas,credentials}` y tests corriendo (`bun test`).
2. `packages/core`: tipos de proyecto/escena, resolución canónica de rutas bajo una raíz de
   proyectos con validación anti-traversal, y helpers de hashing (sha256) para FR-011.
3. `packages/schemas`: schemas Zod versionados (`schemaVersion`) para propuesta de ejecución,
   progreso, resultado, `SceneResult`, narración continua y entrada de catálogo. Compatibles
   en forma con los formatos del monorepo origen.
4. `packages/credentials`: `resolveCredentials(provider, opts)` con precedencia env →
   `DOPPLER_TOKEN_ELENA_TECH`/`~/.config/elena-tech/config.json` (`dopplerToken`) →
   descarga `secrets/download?format=json&project=elena-tech&config=prd` (Basic auth),
   cache en memoria por proceso, resolución lazy (prohibido resolver en modo plan) y
   redacción total en cualquier salida. Agregar `ELEVENLABS_API_KEY` al flujo (en la fuente
   solo se lee de env; aquí debe caer al mismo fallback Doppler).
5. Script `credentials:probe` que imprime nombres y longitudes, nunca valores.

## Qué preservar

- Semántica exacta de la estrategia fuente: env gana siempre; Doppler es fallback; jamás
  loguear/persistir secretos; cache por proceso con reset solo para tests.
- Versionado de schemas (compatibilidad V1/V2) y sanitización anti-traversal del origen.

## Validación y resultado final verificable

- `bun install && bun test && bun run build` → exit 0.
- `bun run credentials:probe` → exit 0 resolviendo las 4 credenciales (env o Doppler) sin
  imprimir valores; sin token ni env, falla con error accionable y exit != 0.
- `grep -rE "@theelena|control-de-caja|videos/cli" packages/` → sin resultados.

## Reporte final esperado

Estado de cada deliverable, salida de los comandos de verificación (exit codes), decisiones
tomadas sobre compatibilidad de schemas y cualquier divergencia respecto de los contratos de origen.
