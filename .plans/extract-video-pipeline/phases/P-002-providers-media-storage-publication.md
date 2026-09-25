---
id: P-002
title: "Capa de providers: media, storage y publicación con operaciones pagadas"
status: done
phase_type: implementation
description: "Implementar el paquete providers con interfaces intercambiables para object storage, generación de medios (fal video/avatar, ElevenLabs TTS/música) y publicación social (Zernio), sobre el motor de operaciones pagadas idempotentes (plan/submit/status/download, receipts, estado uncertain, límites de gasto)."
end_state: "`bun test` del paquete providers pasa con transportes fakes (incluidos los tests de idempotencia y estado uncertain de paid-operation) y `bun run providers:smoke --plan` valida configuración de los adapters sin tocar la red."
verification: "bun test packages/providers packages/core && bun run providers:smoke --plan; los tests deben incluir: submit-once (segundo submit no duplica gasto), 409 dedupe en publicación, receipt ausente ⇒ estado uncertain y reintento bloqueado, checksum sha256 en storage y journal de publicación recuperable; la superficie Zernio completa (publish + ads) valida en --plan sin red."
deliverables: "packages/providers con interfaces ObjectStore/BucketAdmin, MediaProvider, Publisher, SecretSource, Clock y ProcessRunner; motor paid-operation en core; adapters fal, ElevenLabs, R2/S3 y Zernio completo (publish, scheduling, status, dedupe 409, social-track/distribution, journals, ads); biblioteca de música reutilizable; script providers:smoke --plan; tests con transportes fakes."
entry_criteria: "P-001 completado (packages/credentials y packages/core disponibles y testeables)."
dependencies: [P-001]
requirements: [FR-003, FR-004, FR-005, FR-006, FR-012]
goal: G-001
subagent: task
---

# P-002 — Capa de providers: media, storage y publicación con operaciones pagadas

## Contexto

En la fuente cada integración es ad-hoc (fetch directo en cada script). El valor de la
extracción está en unificarlas detrás de interfaces sin perder las garantías de gasto que ya
tienen: submit-once en fal, receipts y estado `uncertain` en `paid-operation`, dedupe 409 en
Zernio y checksums en R2.

## Files / áreas involucradas

Origen (referencia de copia, worktree `control-de-caja`):
- `videos/cli/lib/paid-operation.ts` — motor de operaciones pagadas (núcleo a portar).
- `videos/cli/lib/avatar-generation.ts` — interfaz `AvatarProvider` y adapter fal (submit-once).
- `videos/cli/gen-video.ts` — integración fal I2V por queue REST (upload/submit/status/result/download).
- `videos/cli/gen-narration.ts` + `videos/cli/lib/elevenlabs-narration.ts` — TTS `with-timestamps` + transcodificación ffmpeg.
- `videos/cli/gen-music.ts` — ElevenLabs music_v2 y fal Stable Audio (providers seleccionables, sin fallback automático).
- `videos/cli/lib/marketing.ts` — cliente S3/R2, `objectExists`/`uploadObject`/`downloadObject`/`inspectObject`, guard de host público.
- `videos/cli/zernio-publish.ts` + `videos/cli/lib/publication-journal.ts` — publicación social y journals.
- `videos/cli/music-library.ts` — reutilización de camas musicales ($0).

Destino: `packages/providers`, `packages/core` (paid-operation puede vivir en core), tests con fakes.

## Qué lograr

1. Interfaces puras: `ObjectStore`/`BucketAdmin`, `MediaProvider` (upload/submit/status/result/download),
   `Publisher` (accounts/validate/publish/schedule/status/reconcile), `SecretSource` (punto de
   entrada a `packages/credentials`), `Clock` y `ProcessRunner` (ffmpeg) inyectables.
2. Motor `paid-operation` en core: plan digestado, reserva, receipt obligatorio, estados
   `uncertain/submitted/completed/reconciled`, tope de intentos y de gasto, submit único.
3. Adapters concretos: fal (video I2V, avatar con submit-once vía fetch exactamente una vez),
   ElevenLabs (TTS con timestamps + music_v2), R2/S3 (`@aws-sdk/client-s3`) y **Zernio
   completo** (cuentas/health, perfiles, posts, scheduling, status, dedupe 409 → outcome
   `accepted`, distribution/social-track y ads vía `zernio-ads`), con `maxAttempts`/retries
   explícitos y propios.
4. Biblioteca de música reutilizable (adopt/use de camas) como operación de $0.
5. `providers:smoke --plan`: valida pares de credenciales y configuración de buckets/hosts sin red.

## Qué preservar

- Invariantes de gasto del origen: sin receipt ⇒ `uncertain` y jamás auto-reintento de submit;
  `--plan` nunca resuelve credenciales ni toca la red; claves jamás en metadata/journals.
- Guard de coherencia bucket ↔ URL pública antes de mutar manifests.

## Validación y resultado final verificable

- `bun test packages/providers packages/core` → exit 0, con cobertura de los 4 casos listados
  en `verification` del frontmatter.
- `bun run providers:smoke --plan` → exit 0 sin red.
- Ningún adapter importa código del monorepo origen (NFR-003).

## Reporte final esperado

Inventario de interfaces publicadas por `packages/providers`, tabla adapter → operaciones →
credencial, resultados de tests (incluidos los de idempotencia/uncertain) y lista de
divergencias deliberadas respecto del origen.
