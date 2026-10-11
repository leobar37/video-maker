---
id: P-003
title: B-roll generado y portadas de los seis videos
status: completed
phase_type: implementation
description: Generar con fal.ai el B-roll de los slugs marcados generated:true y renderizar la portada de los seis. Operación de pago, detrás de G-ai-spend.
end_state: "Para los seis slugs existe covers/cover.png; para los slugs generated:true (cuerpo-despues-de-morir, lo-que-saben-de-ti, cuerpo-traiciona-dormido) existen scenes/<id>/media/* con recibos y qa/spend.json dentro del tope; 'bun run vm -- cover --check --project projects/serie-sabias-que/<slug>' sale exit 0 por los seis y 'bun projects/serie-sabias-que/scripts/verify-series.ts --stage media' sale exit 0."
verification: "cd /home/leobar37/code/video-maker && bun run vm -- cover --check --project projects/serie-sabias-que/cuerpo-despues-de-morir && bun projects/serie-sabias-que/scripts/verify-series.ts --stage media"
deliverables:
  - "covers/cover.png (y previews) por los seis slugs"
  - "scenes/<id>/media/* + recibos + qa/spend.json para los slugs generated:true"
entry_criteria: "P-002 aceptada; G-ai-spend resuelto por el OPERADOR con tope explícito en USD."
dependencies: ["P-002", "G-ai-spend"]
requirements: ["FR-008", "FR-012"]
subagent: "worker (mimo-v2.6-flash)"
---

# P-003 · B-roll generado y portadas

## Contexto
`vm gen-media` es pago y exige `--spend-cap`; `vm cover` es local. Solo 1, 3 y 6 usan B-roll generado
(prompts en `series.md`). El resto es motion puro. Antes de cualquier submit: `--plan` para previsualizar.

## Objetivo
1. Con `G-ai-spend` resuelto, generar el B-roll de los slugs `generated:true` con
   `bun run vm -- gen-media --project <slug> --spend-cap <USD>` (tope del operador, reservado antes del submit).
2. Ejecutar `bun run vm -- cover --project <slug>` para los seis (usa `social-cover.json` con el texto de `series.md`).

## Preservar
No re-submitir un pago incierto (usar el recibo/journal existente). No exceder el tope. No generar B-roll
para los slugs `generated:false`. No subir ni publicar nada. Sin secretos en logs.

## Resultado verificable por fase
`verify-series.ts --stage media` exit 0; `cover --check` exit 0 en los seis; `qa/spend.json` total ≤ tope.

## Reporte final esperado
Slugs generados, request_ids/recibos, coste real vs reservado, dimensiones/decodificación de las imágenes,
qué se reutilizó de caché. Comandos + exits.
