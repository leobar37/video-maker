---
id: P-002
title: Identidad de serie, escenas y motion (Remotion), sin generación
status: completed
phase_type: implementation
description: Crear los seis proyectos con `vm new`, poblar video.json con escenas/narración/caption según el guion, e implementar las escenas Remotion de kinetic type y data-viz. Todo local y gratis (gen-media/gen-audio no se ejecutan aquí).
end_state: "Los seis projects/serie-sabias-que/<slug>/ tienen video.json válido (1080×1920, 30 fps, >=4 escenas activas) y componentes Remotion; 'bun run vm -- preflight --project projects/serie-sabias-que/<slug>' sale exit 0 para los seis, 'bun run vm -- still --project <slug> --draft' produce PNG en qa/stills y 'bun projects/serie-sabias-que/scripts/verify-series.ts --stage motion' sale exit 0."
verification: "cd /home/leobar37/code/video-maker && bun projects/serie-sabias-que/scripts/verify-series.ts --stage motion && bun run vm -- still --project projects/serie-sabias-que/cuentas-no-mueren --draft"
deliverables:
  - "6 x projects/serie-sabias-que/<slug>/video.json + scenes + remotion/ (escenas motion)"
  - "identidad de serie aplicada (sello, paleta, tipografía, reglas de motion) y voiceId real resuelto"
  - "qa/stills/*.png de muestra por video (draft)"
entry_criteria: "P-001 aceptada; G-start resuelto."
dependencies: ["P-001"]
requirements: ["FR-001", "FR-002", "FR-003", "FR-004", "FR-007", "FR-015"]
subagent: "worker (mimo-v2.6-flash)"
---

# P-002 · Identidad de serie, escenas y motion

## Contexto
El pipeline ya tiene el motor Remotion (`packages/motion-remotion`, composición `Film`) y el subtítulo
compartido `WordSubtitles`. NO se re-diseña el motor: se usan sus escenas/plantillas. Los videos 2, 4 y 5
son motion/UI puros; 1, 3 y 6 reservan huecos para B-roll de P-003 (escena `source` fal).

## Objetivo
1. `bun run vm -- new --project projects/serie-sabias-que/<slug> --id <slug> --product serie-sabias-que --title "<título de series.md>"` por los seis slugs.
2. Completar `video.json` con las escenas de `series.md` (id, intent, source, narration, caption,
   status `active`, durationHint coherente con 45–60 s). Resolver el `voiceId` de español con una
   fuente real (ya usado en el repo o Voice Design); **no inventar el ID**.
3. Implementar las escenas Remotion de cada video (kinetic type, data-viz, UI mockups, sellos) con
   motion dirigido por semántica y subtítulos `WordSubtitles` (nunca pegados al borde inferior).

## Preservar
No tocar `WordSubtitles` ni las escenas existentes de otros proyectos. No ejecutar `gen-audio`/`gen-media`
(aún no hay `G-ai-spend`). No agregar dependencias nuevas si el kit ya alcanza.

## Resultado verificable por fase
`verify-series.ts --stage motion` exit 0 y un still draft real por al menos un video.

## Reporte final esperado
Slugs creados, escenas por video, voiceId elegido + su procedencia, archivos Remotion tocados, comandos + exits.
