---
id: P-004
title: Narración TTS continua de los seis videos
status: completed
phase_type: implementation
description: Sintetizar la narración continua en español (una petición TTS por video) con el voiceId resuelto en P-002. Operación de pago, dentro del tope de G-ai-spend.
end_state: "Los seis slugs tienen script/audio/narration.wav (duración >0, ffprobe) y script/audio/narration.json con timings sin huecos; 'bun projects/serie-sabias-que/scripts/verify-series.ts --stage narration' sale exit 0 y qa/spend.json queda dentro del tope."
verification: "cd /home/leobar37/code/video-maker && bun projects/serie-sabias-que/scripts/verify-series.ts --stage narration"
deliverables:
  - "script/audio/narration.wav + narration.json por los seis slugs"
  - "qa/spend.json actualizado (TTS) dentro del tope de G-ai-spend"
entry_criteria: "P-003 aceptada; G-ai-spend resuelto; voiceId real existente."
dependencies: ["P-003"]
requirements: ["FR-009", "FR-012"]
subagent: "worker (mimo-v2.6-flash)"
---

# P-004 · Narración TTS continua

## Contexto
`vm gen-audio` sintetiza el master continuo de narración con `tts.mode: continuous` (una sola petición)
y queda detrás de los gates `assets`/`spend`. Requiere `--spend-cap`.

## Objetivo
Por cada slug: `bun run vm -- gen-audio --project projects/serie-sabias-que/<slug> --spend-cap <USD>`
(mismos topes de `G-ai-spend`), con el `voiceId` de P-002. No acelerar la voz para encajar duración.

## Preservar
No re-submitir una síntesis incierta; reusar el artefacto verificado si existe. No exceder el tope. Sin
secretos en logs. No alterar la narración ya aprobada por guion sin volver a P-001.

## Resultado verificable por fase
`verify-series.ts --stage narration` exit 0 (seis `narration.wav` con duración >0).

## Reporte final esperado
Duración por video, voiceId/modelId usados, coste real de TTS vs reservado, huecos si hubo. Comandos + exits.
