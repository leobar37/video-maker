# Contexto · serie-sabias-que

## Qué es
Serie de **6 videos verticales full-motion** de formato "sabías que" sobre temas tabú y curiosidades
virales de internet. Cada video se produce con el pipeline existente de `video-maker`
(`vm new → escenas/narración → gen-audio → gen-media → still → assemble → qa`), se revisa con el
verificador propio de la serie y se entrega por un enlace Tailscale **listo para publicar**.

El detalle creativo de los seis videos (hooks, beats, escenas, prompts, hashtags, claims a verificar)
vive en [`series.md`](./series.md).

## Dónde vive
- Plan y contrato: `.plans/serie-sabias-que/`.
- Proyectos de video: `projects/serie-sabias-que/<slug>/` (seis slugs en `series.md`).
- Verificador único: `projects/serie-sabias-que/scripts/verify-series.ts` (stages research|motion|media|narration|final).
- Servidor de revisión: `projects/serie-sabias-que/serve-review.ts` (bind 0.0.0.0, sin localhost).
- Ejecución: DAG en climier (initiative `serie-sabias-que`) + overlay OMP `serie-sabias-que.yml`.

## Repo y convenciones verificadas
- CLI: `bun run vm -- <verbo> [--flags]` (`packages/cli/src/main.ts`). Verbos usados: `new`, `preflight`,
  `plan`, `still`, `gen-media`, `gen-audio`, `assemble`, `qa`, `cover`, `bundle`, `dashboard`.
- Proyecto de video: `video.json` con `id`, `product`, `title`, `workflow`, `resolution` (1080×1920),
  `fps` (30), `tts`, `branding.preset`, `scenes[{id,intent,source,narration,caption,status,durationHint,...}]`.
  Referencia real: `projects/demo/hello/` (mp4 de salida en `renders/`, evidencia en `qa/report.json` y `qa/loudness.json`).
- `vm assemble` escribe `renders/*.mp4` + `qa/report.json` + `qa/loudness.json` y no gasta (es cómputo).
- `vm gen-audio` y `vm gen-media` son **pagos** (TTS ElevenLabs / fal.ai), exigen `--spend-cap` y están
  detrás de los gates `assets`/`spend` de la CLI.
- `vm still` y `vm preflight`/`vm plan` son locales y gratis (offscreen).

## Verified
- Provider/modelo: `xiaomi-token-plan-sgp/mimo-v2.6-pro` y `xiaomi-token-plan-sgp/mimo-v2.6-flash`
  existen en `omp models` (verificado 2026-10-05; no hay fuzzy match silencioso).
- `climier` 1.0.0 y `omp` 18.6.1 instalados. `.climier.json` existe (`project_id 9552835e699ba892`).
- Overlays previos: `~/code/dotfiles/omp/profiles/knowledge-agent-*.yml`; el launcher viejo
  `scripts/omp-session.sh` apunta a un perfil inexistente (`video-maker-plan.yml`) — por eso este plan
  usa su propio `orchestration/launch.sh` y NO toca el script global.

## Inferred
- Los videos 2, 4 y 5 pueden renderizarse casi enteros en Remotion (motion graphics/UI mockups) sin
  generación fal; 1, 3 y 6 se benefician de B-roll generado. Todas las portadas usan `vm cover`.
- La narración en español requiere un `voiceId` real (ya usado en el repo o Voice Design); no se
  inventa ningún ID: se resuelve en P-002 con evidencia.

## Unknown / a resolver en ejecución
- `voiceId` exacto de español a usar (P-002).
- Coste real de TTS y de las imágenes fal (el operador fija el tope en `G-ai-spend`).
- Si `vm dashboard serve` refleja proyectos `video.json` además del catálogo studio; el fallback
  verificado es `serve-review.ts` (estático, bind 0.0.0.0).

## Decisiones del operador
Ver [`decisions.json`](./decisions.json). Resumen: 6 videos full-motion; tabú/curiosidad viral;
formato "sabías que"; modelos Mimo v2.6 Pro (orquestador) y Flash (worker); entrega = MP4 + enlace
listos para publicar, **sin** publicar.
