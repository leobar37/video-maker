---
id: G-001
title: "Producto independiente de pipeline de video en video-maker"
status: done
end_state: "En /home/leobar37/code/video-maker: `bun install && bun test && bun run build` exit 0; `bun run credentials:probe` resuelve credenciales contra Doppler elena-tech/prd sin imprimir secretos; `bun run demo:e2e` produce un MP4 válido (ffprobe duración > 0s) con loudness normalizado; ningún paquete importa código del monorepo elena."
verification: "bun install && bun test && bun run build && bun run credentials:probe && bun run demo:e2e; ffprobe sobre el MP4 resultante reporta duración > 0s y stream de audio presente."
deliverables: "packages/core, packages/schemas, packages/credentials, packages/providers, packages/motion-core, packages/motion-remotion, packages/cli, projects/demo/hello, scripts de verificación (credentials:probe, demo:dry, demo:e2e) y documentación de contratos y credenciales."
budget: "6 sesiones de ejecución o su equivalente; todo gasto en providers pasa por paid-operation con tope explícito antes del submit."
---

# Goal

## Description

Extraer del monorepo `elena` (worktree `/home/leobar37/.herdr/worktrees/theelena/control-de-caja`)
la lógica de producción de videos como producto independiente y reutilizable en
`/home/leobar37/code/video-maker`: contratos de proyecto, operaciones pagadas idempotentes,
providers de medios/storage/publicación, motion kit de Remotion y CLI de producción con
gates derivados del filesystem. La estrategia de credenciales se conserva tal cual:
env-first y fallback al proyecto Doppler `elena-tech` config `prd` con el token global
`DOPPLER_TOKEN_ELENA_TECH`.

## End State

Observable y verificable con comandos (campo `end_state` del frontmatter): el repo construye,
testea, resuelve credenciales contra Doppler y produce un video demo corto de punta a punta.

## Deliverables

- `packages/core` — contratos de proyecto (VideoConfig/SceneConfig/Project), rutas seguras, gates file-based, motor de operaciones pagadas.
- `packages/schemas` — schemas Zod versionados: propuesta/progreso/resultado, SceneResult, narración continua, catálogo.
- `packages/credentials` — resolución de secretos con estrategia Doppler (env-first, lazy, cache, redacción).
- `packages/providers` — adapters ObjectStore (R2/S3), media (fal video/avatar, ElevenLabs TTS/música) y Publisher (Zernio) detrás de interfaces.
- `packages/motion-core` + `packages/motion-remotion` — frame math, timing continuo, composición `Film`, subtítulos, brand tokens y render adapter.
- `packages/cli` — scaffolder, audio, render, QA/loudness, bundle/hydrate/archive, catálogo.
- `projects/demo/hello` — proyecto de video de demostración usado por la validación.
- Documentación de contratos y de configuración de credenciales.

## Definition of Done

1. `bun install && bun test && bun run build` termina con exit code 0.
2. `bun run credentials:probe` resuelve `FAL_KEY`, `ZERNIO_API_KEY`, `ELEVENLABS_API_KEY` y `R2Env`
   por env-first con fallback a `elena-tech/prd`, e imprime solo nombres y longitudes.
3. `bun run demo:e2e` genera `projects/demo/hello/renders/*.mp4` con duración > 0s (ffprobe),
   audio presente y loudness dentro de tolerancia (chequeo loudnorm/ebur128).
4. `grep -r "control-de-caja\|@theelena\|videos/cli" packages/` no arroja imports del monorepo origen.
5. Todo submit de operación pagada del demo queda registrado con receipt/estado en el journal del proyecto.

## Constraints / Must Not Change

- Estrategia de credenciales Doppler: `DOPPLER_TOKEN_ELENA_TECH` (o `~/.config/elena-tech/config.json`
  campo `dopplerToken`) → `https://api.doppler.com/v3/configs/config/secrets/download?project=elena-tech&config=prd`.
  Precedencia env → Doppler. Resolución lazy (solo en submit/run), cache en memoria, jamás loguear ni persistir secretos.
- Contratos de datos versionados (schemaVersion) compatibles con los formatos existentes del monorepo origen.
- Ciclo `--plan` de cada comando operativo: sin red y sin resolución de credenciales.
- Idempotencia de operaciones pagadas: submit único con receipt; sin receipt el estado queda `uncertain`, nunca se reintenta automáticamente.

## Non-Goals

- SDK de delegación (goals, agentes Herdr, guardian, plan-state) — los agentes quedan como proceso externo.
- Motor de playbooks `elena-demo` y captura de escenas `demo-app` (se deja el seam `SceneSource`, no la implementación).
- QA conversacional (`conversation-qa`, simulador WhatsApp).
- Tooling de ingesta/footage (`yt-fetch`, `footage-*`, `ingest`, `adopt`), dashboard y workspaces multi-tenant.

## Budget

6 sesiones de ejecución (o su equivalente). Cualquier gasto real en providers pasa por
paid-operation con tope explícito configurado antes del submit.
