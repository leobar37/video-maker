---
id: P-003
title: "Motion kit de Remotion con render adapter"
status: done
phase_type: implementation
description: "Extraer el motor visual compartido como motion-core (frame math, timing continuo, cámara) y motion-remotion (composición Film, sequencer, subtítulos, componentes base, brand tokens), más un render adapter que encapsule bundle/selectComposition/renderMedia/renderStill y un AssetResolver que reemplace las rutas de assets hardcodeadas."
end_state: "`bun test packages/motion-core` pasa (frame math, boundaries de timing continuo, cámara) y `bun run motion:still -- --sample` produce un PNG still de la composición de ejemplo usando los mismos boundaries que el render, sin red y sin imports del monorepo origen."
verification: "bun test packages/motion-core && bun run motion:still -- --sample && test -s projects/demo/hello/qa/stills/sample.png; además un test asegura que el still y el render usan idénticos límites de escena (frame math compartido)."
deliverables: "packages/motion-core (frame math, timing continuo, planes de cámara), packages/motion-remotion (Film, SceneRenderer con registry, Subtitles, PhoneMock, DemoCamera, brand tokens), AssetResolver, render adapter (bundle/renderMedia/renderStill + loudnorm separado), composición de ejemplo en projects/demo/hello y tests de frame math/boundaries."
entry_criteria: "P-001 completado (packages/core con contratos de escena disponibles)."
dependencies: [P-001]
requirements: [FR-007, FR-008]
goal: G-001
subagent: task
---

# P-003 — Motion kit de Remotion con render adapter

## Contexto

La fuente ya tiene una división limpia: `videos/shared/` es reutilizable (sequencer `Film`,
tipos, `scene-frames`, `brand-tokens` — verificado que no importa `apps/*`) y los TSX de
escenas son bespoke por video. El kit debe empaquetar primitivas y contratos, no plantillas
de animación: cada proyecto registra sus escenas de autoría propia.

## Files / áreas involucradas

Origen (referencia de copia, worktree `control-de-caja`):
- `videos/shared/components/Film.tsx`, `types.ts`, `index.ts` — sequencer, transiciones, audio master, timing scene/continuous.
- `videos/shared/scene-frames.ts` — frame math (`filmSceneFrames`, `sceneFinalBoundary`, `filmDurationInFrames`).
- `videos/shared/brand-tokens.ts` — contrato `BrandTokens` y resolución de presets (adapter de datos).
- `videos/shared/motion/` + `timeline-adapter.ts` — interacción/cámara desde timelines.
- `videos/cli/assemble.ts`, `videos/cli/still.ts` — bundle + selectComposition + renderMedia/renderStill + loudnorm ffmpeg.
- Referencia de integración: `videos/lab/98-creator-bottle/remotion/` y `videos/links/03-pipeline-de-videos/remotion/` (composition Film, SceneView dispatch).

Destino: `packages/motion-core`, `packages/motion-remotion`, `projects/demo/hello/remotion/` (composición de ejemplo), tests.

## Qué lograr

1. `motion-core` (TS puro, sin React/I/O): tipos de escena/film, frame math, aritmética de
   timing continuo (sin padding ni gaps), planes de cámara y serialización para que CLI y
   render consuman exactamente el mismo output.
2. `motion-remotion` (React + Remotion como peer deps): `Film` (sequencer), `SceneRenderer`
   con **scene registry** (`registerScene(id, renderer)`), `Subtitles`/`Caption`, `PhoneMock`,
   `DemoCamera`, transiciones y helpers de fondo/branding. Recibe `BrandTokens`, `AssetResolver`
   y el dispatch por props; jamás importa tipos de la CLI de producción.
3. `AssetResolver`: manifiesto de assets `{id, src, width, height, duration, sha256}` que
   reemplaza `staticFile('<scene>/media/...')` y el escaneo de `getStaticFiles()`.
4. Render adapter: encapsula `bundle`/`selectComposition`/`renderMedia` (h264)/`renderStill`
   con `publicDir` y módulos webpack inyectables; la normalización loudnorm/ebur128 queda
   como etapa separada y opcional con gate configurable.
5. Composición de ejemplo `projects/demo/hello` con 2 escenas (una motion, una de media
   local) que ejercite timing continuo, subtítulos y stills.

## Qué preservar

- Distinción de audio del origen: narración continua (master reproducido una vez vía
  `FilmProps.narration`) vs. audio por escena (`scene.audioSrc`) — no duplicar audio.
- Filosofía de autoría: el kit provee primitivas y safe zones; las escenas bespoke por
  `intent` son código del proyecto, no templates del kit (regla `videos/RULES.md` de la fuente).

## Validación y resultado final verificable

- `bun test packages/motion-core` → exit 0 (incluye test still-vs-render boundaries).
- `bun run motion:still -- --sample` → genera `projects/demo/hello/qa/stills/sample.png` no vacío.
- `grep -rE "@theelena|control-de-caja|videos/cli" packages/` → sin resultados.

## Reporte final esperado

API pública de `motion-core` y `motion-remotion`, contrato del `AssetResolver`, del render
adapter y de `BrandTokens`, salida de las verificaciones y notas sobre qué componentes del
origen quedaron deliberadamente fuera (p. ej. escenas bespoke).
