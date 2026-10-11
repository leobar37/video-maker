---
id: P-001
title: Investigación factual y guiones de los seis videos
status: completed
phase_type: investigation
description: Verificar cada afirmación "sabías que" contra fuentes reales y escribir el guion beat-a-beat de los seis videos, más el verificador de serie y el manifest. Ninguna generación de pago.
end_state: "Existen projects/serie-sabias-que/series.json, projects/serie-sabias-que/scripts/verify-series.ts y research/<slug>/facts.json + script/<slug>.md para los seis slugs; 'bun projects/serie-sabias-que/scripts/verify-series.ts --stage research' sale exit 0 (>=4 hechos por video, cada uno con sourceUrl http(s) y dateAccessed)."
verification: "cd /home/leobar37/code/video-maker && bun projects/serie-sabias-que/scripts/verify-series.ts --stage research"
deliverables:
  - "projects/serie-sabias-que/series.json (manifest de los 6 slugs, formato, paleta, voz pendiente)"
  - "projects/serie-sabias-que/scripts/verify-series.ts (stages research|motion|media|narration|final)"
  - "research/<slug>/facts.json y script/<slug>.md para los 6 videos"
entry_criteria: "G-start resuelto por el operador (autoriza implementación local sin gasto)."
dependencies: ["G-start"]
requirements: ["FR-005", "FR-011", "FR-015"]
subagent: "orchestrator (mimo-v2.6-pro)"
---

# P-001 · Investigación factual y guiones

## Contexto
Los seis videos dependen de hechos verificables (contrato §2). Sin `facts.json` no hay guion. Ver
[`series.md`](../series.md) para los claims `VERIFICAR` de cada video. Esta fase es 100% local/gratis.

## Objetivo
1. Escribir `series.json` con los 6 slugs y la identidad de serie (la voz real se resuelve en P-002).
2. Implementar `scripts/verify-series.ts` con los cinco stages descritos en `contracts.md` §4 (lee
   `series.json`; usa `ffprobe` para audio/render). Es la autoridad de verificación de todas las fases.
3. Por video: `research/<slug>/facts.json` (≥4 hechos, cada uno `{id, claim, sourceUrl, sourceTitle,
   dateAccessed, jurisdiction?}`) y `script/<slug>.md` (guion beat-a-beat con hook, cuerpo y cierre,
   timings objetivo y notas de motion). Los claims sin fuente se reemplazan, no se suavizan.

## Preservar
No modificar `projects/demo/*`, `presets/*` ni ningún proyecto existente. No usar material de terceros.
No inventar IDs/cifras. Sin llamadas de red desde el verificador (solo fs + ffprobe).

## Resultado verificable por fase
El comando de `verification` sale exit 0 e imprime el resumen de los 6 slugs con sus conteos de hechos.

## Reporte final esperado
Archivos creados, número de hechos por video, fuentes usadas (dominios), huecos de verificación y
cualquier beat reemplazado por falta de fuente. Comandos + exit codes.
