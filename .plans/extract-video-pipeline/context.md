# Contexto — extract-video-pipeline

## Visión general

Extraer del monorepo `elena` (worktree `/home/leobar37/.herdr/worktrees/theelena/control-de-caja`)
la lógica de producción de videos como producto independiente en `/home/leobar37/code/video-maker`.
El repo destino está vacío (greenfield, aún sin git): todo se construye nuevo copiando y
desacoplando código existente, sin referenciar el monorepo origen.

Auditoría de origen (2026-09-24, 6 frentes read-only): el pipeline real vive en `videos/cli/`
(60 scripts standalone ejecutados con `bun videos/cli/<verbo>.ts`) + `videos/shared/`
(componentes Remotion) + la carpeta-proyecto `videos/<namespace>/<slug>/` con contrato
`video.json` + `script/` + `scenes/` + `remotion/` + `qa/` + `renders/`. La fachada
`cli/src/commands/video.ts` solo hace passthrough por subprocess; la ejecución larga
supervisada usa goals/agentes (fuera de alcance de este plan).

## Hechos verificados (Verified)

- Contratos de datos: `VideoConfig`/`SceneConfig` (`videos/cli/lib/project.ts`),
  propuesta/progreso/resultado V1/V2 (`cli/src/videos/video-types.ts`), `SceneResult`
  (`videos/cli/scene-contracts.ts`), narración continua `narration.json`
  (timings por escena, fingerprint, sha256), catálogo `videos/videos.json` (schemaVersion 3).
- Estrategia de credenciales (`videos/cli/lib/credentials.ts`): env → `.env` raíz → Doppler
  `elena-tech/prd` vía `DOPPLER_TOKEN_ELENA_TECH` o `~/.config/elena-tech/config.json`
  (`dopplerToken`); lazy (solo `--submit`/`--run`, nunca `--plan`), cache en memoria,
  secretos jamás logueados ni persistidos. `ELEVENLABS_API_KEY` hoy se lee solo de env.
- Operaciones pagadas (`videos/cli/lib/paid-operation.ts`): plan digestado, reserva, receipt,
  estados `uncertain/submitted/completed/reconciled`, límite de intentos, submit-once en fal
  (`videos/cli/lib/avatar-generation.ts`) para no duplicar gasto.
- Gates file-based (`videos/cli/lib/workflow-state.ts`): estado derivado inspeccionando
  filesystem (no hay `workflow.json` editable).
- Motion: composición única `Film`, sequencer centralizado en `videos/shared/components/Film.tsx`,
  `brand-tokens.ts` portable (no importa `apps/*`), render vía
  `@remotion/bundler` + `renderMedia` h264 + normalización loudnorm ffmpeg (`videos/cli/assemble.ts`).
- Storage R2: buckets `elena-tech-public` (bundles), marketing y archive; URL pública
  `media.theelena.me`; S3 via `@aws-sdk/client-s3` (`videos/cli/lib/marketing.ts`).
- Publicación social Zernio con dedupe HTTP 409 (`videos/cli/zernio-publish.ts`) y journals
  idempotentes (`videos/cli/lib/publication-journal.ts`).

## Supuestos (Inferred)

- Corte por paquetes tipo ports & adapters: lo Elena-specific (Doppler/R2/Zernio/GitHub/
  textos) queda en adapters y configuración, nunca en el core.
- El monorepo destino usa Bun workspaces desde el día 1 (mismo toolchain que la fuente).
- Escenas soportadas en v1: `motion`, `fal-video`, `avatar`. `demo-app` queda diferido pero
  el `SceneSource` lo contempla como seam.

## Desconocidos (Unknown / Open Questions)

- Nombre de scope npm de los paquetes (propuesto `@videomaker/*`, cambiable).
- Si el config global se hereda (`~/.config/elena-tech/config.json`) o se crea uno propio
  (`~/.config/video-maker/config.json`) — por ahora se hereda por ser el mismo equipo/equipo local.
- Destino de publicación de paquetes (npm público, privado, o solo workspace interno).
- Política exacta de retries del `@aws-sdk/client-s3` lockeado — debe hacerse explícita al extraer.

## Decisiones tomadas

1. Formato: plan **structured** con 5 fases goal-unit; alcance: pipeline de video (sin
   delegation SDK, sin playbooks `elena-demo`, sin conversation-qa).
2. Misma estrategia Doppler que la fuente: token global + proyecto `elena-tech` / config `prd`.
3. Copiar y desacoplar; prohibido importar desde el monorepo origen (validable por grep).
4. **CLI declarativa (decisión del operador, 2026-09-24)**: los ~60 scripts standalone de la
   fuente evolucionan a una CLI cuyos comandos se definen como **datos** (spec por comando:
   verbo, args con schema, modo plan, artefactos que escribe, gates que mueve) interpretados
   por un runtime pequeño. Agregar un comando = agregar una spec, no un script nuevo.
5. **Delegación de escenas v1 (decisión del operador, 2026-09-24)**: entra el contrato
   `SceneBrief → SceneResult` más los comandos `scene-brief`/`scene-log`/`scene-verify`
   (FR-014); la ejecución del sub-agente queda externa (humano/OMP manual). El orquestador
   de agentes (goals/Herdr/guardian) sigue fuera de alcance.
6. **Zernio completo en el producto (decisión del operador, 2026-09-24)**: toda la lógica
   Zernio queda en `video-maker` — publish, scheduling, status, dedupe 409,
   social-track/distribution, journals y ads (`zernio-ads`). Sale de los non-goals.
