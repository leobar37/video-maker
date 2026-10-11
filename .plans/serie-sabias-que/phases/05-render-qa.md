---
id: P-005
title: Render y QA de los seis MP4
status: completed
phase_type: validation
description: Ensamblar cada video con `vm assemble` (cómputo, sin gasto) y verificar con `vm qa` (hashes + loudness). Revisar stills de bordes/captions antes de cerrar.
end_state: "Los seis projects/serie-sabias-que/<slug>/renders/<slug>.mp4 existen a 1080×1920 h264+aac con duración 40–70 s; 'bun run vm -- qa --project <slug>' sale exit 0 por los seis; hay stills de QA revisados (hook, medio, cierre) sin captions en el borde inferior."
verification: "cd /home/leobar37/code/video-maker && bun run vm -- qa --project projects/serie-sabias-que/cuerpo-despues-de-morir && bun projects/serie-sabias-que/scripts/verify-series.ts --stage final"
deliverables:
  - "renders/<slug>.mp4 por los seis slugs"
  - "qa/report.json + qa/loudness.json por los seis"
  - "qa/stills revisados por video (bordes, captions, sello)"
entry_criteria: "P-004 aceptada."
dependencies: ["P-004"]
requirements: ["FR-010", "FR-011"]
subagent: "orchestrator (mimo-v2.6-pro)"
---

# P-005 · Render y QA

## Contexto
`vm assemble` es cómputo puro (no gasta) y produce `renders/*.mp4` + evidencia. `vm qa` verifica hashes
de artefactos y loudness/true-peak (ebur128) contra tolerancia. Esta fase es la puerta dura de calidad.

## Objetivo
1. Por slug: `bun run vm -- assemble --project projects/serie-sabias-que/<slug>`.
2. Por slug: `bun run vm -- qa --project projects/serie-sabias-que/<slug>` (exit 0).
3. Extraer stills (hook, medio, cierre) y revisarlos: captions legibles, nunca pegados al borde inferior,
   sellos/motion coherentes, sin solapamientos que tapen datos.

## Preservar
No re-renderizar lo ya verde sin causa. No cambiar guion/narración aquí (si hay que corregir texto, volver
a P-001). No tocar proyectos ajenos.

## Resultado verificable por fase
`vm qa` exit 0 en los seis y `verify-series.ts --stage final` exit 0.

## Reporte final esperado
Duración y loudness por video (LUFS/true peak), resultado de hashes, stills revisados y cualquier defecto
corregido dentro del scope. Comandos + exits.
