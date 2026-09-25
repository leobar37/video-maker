---
id: P-005
title: "Validación end-to-end con providers reales"
status: done
phase_type: validation
description: "Ejecutar el pipeline completo contra credenciales reales (Doppler elena-tech/prd) con un video demo corto y tope de gasto explícito: narración TTS con timestamps, cama musical (biblioteca o proveedor), una escena motion, render con normalización de loudness, evidencia y publicación en dry-run. Cierra el Definition of Done del goal G-001."
end_state: "`bun run demo:e2e` (con gasto acotado por paid-operation) produce `projects/demo/hello/renders/*.mp4` con duración > 0s y audio presente (ffprobe), loudness dentro de tolerancia, journal de operaciones con receipts y `vm publish --dry-run` exit 0."
verification: "bun run demo:e2e && ffprobe -v error -show_entries format=duration -of csv=p=0 projects/demo/hello/renders/<salida>.mp4 (resultado > 0) && bun run vm -- qa projects/demo/hello (exit 0) && bun run vm -- publish projects/demo/hello --dry-run (exit 0)."
deliverables: "Script demo:e2e reproducible; MP4 demo con QA de loudness y evidencia (hashes, proveniencia); journal de operaciones con receipts; verificación de ausencia de secretos; reporte de costos por operación y métricas de render; checklist final contra el DoD de G-001."
entry_criteria: "P-004 completado; credenciales disponibles (DOPPLER_TOKEN_ELENA_TECH o config global) y presupuesto de prueba aprobado por el usuario (operaciones pagadas reales: TTS y posible música)."
dependencies: [P-004]
requirements: [FR-003, FR-004, FR-008, FR-011]
goal: G-001
subagent: task
---

# P-005 — Validación end-to-end con providers reales

## Contexto

Única fase que toca red y gasta dinero real. Su valor no es solo verificar que el pipeline
funciona, sino que las invariantes de gasto (submit-once, receipts, estado uncertain) y de
seguridad (sin secretos en logs/journals) se sostienen bajo condiciones reales.

## Files / áreas involucradas

- `projects/demo/hello/` — proyecto demo de P-003/P-004, ampliado con narración y música.
- `packages/cli` (subcomandos `gen-audio`, `gen-music`, `assemble`, `qa`, `publish`).
- `packages/providers` adapters fal/ElevenLabs/R2/Zernio y `paid-operation` en core.
- `packages/credentials` resolviendo `elena-tech/prd` en vivo.

## Qué lograr

1. Script `demo:e2e` reproducible que: resuelve credenciales, genera narración con timestamps
   (TTS real), resuelve la cama musical (biblioteca primero; proveedor solo si no hay cama
   compatible), renderiza con el motion kit, normaliza loudness, escribe QA/evidencia y
   cierra publicación en `--dry-run`.
2. Confirmación de invariantes en vivo: tope de gasto respetado, receipts persistidos,
   ningún secreto en `qa/`, journals ni bundles (grep de verificación incluido en el script).
3. Recolección de métricas mínimas: duración, tamaño, costo reportado por receipts y tiempo
   de render, para estimar costos de escalamiento.

## Qué preservar

- Todo gasto pasa por paid-operation con tope explícito antes del submit; sin receipt el
  estado queda `uncertain` documentado, jamás auto-reintentado.
- Publicación real queda fuera: solo `--dry-run` (el destino social es configuración del
  consumidor del producto, no parte del smoke).

## Validación y resultado final verificable

- Comandos del campo `verification` del frontmatter, todos con exit 0 y MP4 con duración > 0s.
- `grep -rE "(fal_key|zernio|elevenlabs|secret)[=:][^ ]" projects/demo/hello/qa projects/demo/hello/*.json`
  → sin secretos plausibles.
- Journal de operaciones del demo con receipts y estados finales (`completed` o `uncertain`
  documentado).

## Reporte final esperado

Resultado de cada verificación con salida real, tabla de costos por operación (según receipts),
métricas de render, invariantes confirmadas (gasto, secretos, idempotencia) y lista de
hallazgos que ajustaron contratos, más el checklist final contra el Definition of Done de G-001.
