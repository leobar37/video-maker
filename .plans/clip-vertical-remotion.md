# Clipper estilo Opus puramente CLI: análisis de frames con OMP + adaptación en Remotion

> Modo: plan simple. No se tocó `src`; lo afirmado fue verificado en los
> archivos citados. Hay dos joyas: (1) el CLI que analiza series de frames
> con OMP y reparte el trabajo por shards, con el orquestador delegando
> primero de-dónde-a-dónde va cada clip; (2) la adaptación vertical en
> Remotion — el clip no deja de ser un video de la tool principal.

## Goal

- **Description**: llevar el flujo Opus al CLI `vm`, puramente por terminal.
  El video largo se muestrea a frames (ffmpeg) y se analiza con el **SDK de
  OMP** (`omp -p --mode json` + `@frames`, rol `vision`) por **shards en
  paralelo**; el **orquestador** agrega los análisis y **delega primero los
  rangos** (de dónde a dónde va cada clip + qué layout: solo o podcast-dúo);
  después viene el **pulido** (cortes de silencios) y la **adaptación** en la
  composición `Film` de Remotion (`@videomaker/motion-remotion`). La aprobación
  la orquesta el agente (muestra por URL/dashboard); el CLI valida y ejecuta.
- **End State** (observable): `bun run vm -- clip-render <proyecto> --plan`
  imprime steps sin red ni secretos; `bun test packages/cli
  packages/motion-remotion packages/motion-core` en verde; `bun run build`
  exit 0; proyecto temporal demuestra `renders/clips/<id>.mp4` 1080×1920 +
  `qa/stills` del mismo frame (paridad still) para layout solo y podcast-dúo;
  `clip-analyze --plan` lista shards sin invocar OMP.
- **Deliverables**:
  1. `packages/cli/src/specs/clip.ts` + registro en `all-specs.ts`:
     `clip-frames`, `clip-analyze`, `clip-propose`, `clip-ranges`, `clip-polish`,
     `clip-transcribe`, `clip-approve`, `clip-render`, `clip-locate`, `clip-strip`, `clip-viewer`.
  2. `packages/cli/src/pipeline/clip.ts` (muestreo, shards, rangos, pulido,
     props+trim) y `packages/cli/src/pipeline/agent.ts` (seam `AgentRunner`,
     inyectable vía deps, fake en tests) + `pipeline/backends/omp-sdk.ts`
     (backend actual) y `pipeline/backends/jev.ts` (futuro). Flag
     `--backend omp|jev` (default `omp`), registrado en `qa/spend.json`.
  3. `packages/motion-remotion/src/ClipVertical.tsx` (intent `clip-vertical`:
     blur-bg + crop-window animada + subs) y `ClipPodcast.tsx` (intent
     `clip-podcast`: dos caras apiladas, hablante activo enfatizado).
  4. `packages/motion-remotion/src/subtitle-words.ts`: word-timestamps de
     whisper recortados a la ventana del clip.
  5. `packages/schemas/src/clip.ts`: `FrameAnalysis`, `ClipRange`,
     `ClipDecision`, `ScoringWeights` (pesos + presets) versionados.
  6. Tests offline por pieza + demo temporal (solo + dúo).
- **Definition of Done**: comandos del End State en verde; cada verbo soporta
  `--plan` puro (sin red, sin credenciales, sin invocar `omp`, NFR-002);
  `clip-approve` rechaza (exit ≠ 0) sin aprobados o con sha256 que no
  coinciden con el source; el mp4 mide 1080×1920, dura `fin-inicio` ±1 frame,
  still coincide con el frame renderizado; `clip-analyze` con transporte fake
  produce `analysis/*.json` válidos contra schema; **cada clip con subtítulos
  quemados** (still de prueba con subs visibles), safe zones respetadas y
  `qa/loudness.json` dentro de tolerancia.
- **Constraints / Must Not Change**:
  - Comandos son DATA (`CommandSpec`; nunca scripts) — `spec-types.ts`,
    `registry.ts`, `all-specs.ts`.
  - `plan()` puro; `run()` rechaza `mode === 'plan'`; lo pago (visión OMP,
    score LLM) exige `--spend-cap` (`spend-ledger.ts`). Sin estado editable:
    gates derivados (`deriveGates`).
  - `Film` final como secuenciador: el clip se adapta como **nuevos intents +
    nuevo source `clip`**, sin cambiar timing ni render-adapter.
  - Secretos jamás en logs/metadata/journals (`@videomaker/credentials`).
  - Todo el código en inglés: identificadores, schemas, claves JSON, flags, presets
    (`highlight|hook|density|emotion|novelty|closure`, `viral|podcast|educational`,
    `single|duo`, `candidate|approved|rejected`), mensajes y errores del CLI.
    La prosa del plan y el contenido social (títulos) pueden ir en el idioma del objetivo.
  - OMP se invoca solo en `run()` y solo con `--submit`-style explícito
    (precedente: `gen-image` exige `--submit`); el costo de visión se
    presupuesta por shard en `--plan` (nº frames × tarifa).
- **Non-Goals**: TUI interactivo; dashboard con acciones; publicación
  automática (se reusa `publish`); detector de caras propio desde cero;
  scoring viral perfecto en v1; orquestación climier obligatoria (el fan-out
  por subprocesos basta en v1; sesión OMP + `task` como evolución).

## Análisis

- **Verified** (leído en repo y workstation):
  - `Film` (`motion-remotion/src/Film.tsx`): sequencer con spans exactos;
    `FilmProps` serializable como `inputProps` JSON con `width/height/fps` →
    clip vertical = `FilmProps` 1080×1920 de 1 escena, mismo pipeline.
  - Cámara en dos mitades: `planCamera` pura y serializable
    (`motion-core/src/camera.ts`, con merge de targets y approach anticipado)
    + `DemoCamera.tsx` que la ejecuta. Overlays tipográficos como **siblings**.
  - `SceneRenderer.tsx`: `registerScene(intent, renderer)` +
    `supportedSources`; bespoke en project code.
  - `Subtitles.tsx` + `subtitle-segments.ts` (puros): subs estilo TikTok.
  - `render-adapter.ts`: `bundle → selectComposition → renderMedia (h264) →
    loudness` + `renderStill` por el mismo camino (paridad still gratis).
  - CLI: `spec-types.ts` (FINAL), `pipeline/deps.ts` (seams inyectables,
    secretos lazy), `pipeline/assemble.ts` (props → render → ducking →
    loudnorm → `renders/*.mp4` + `qa/report.json` con sha256), `specs/social.ts`
    (precedente vertical 1080×1920), `specs/media.ts` (precedente pago:
    `--spend-cap` + `--submit` + `supportsPlan`).
  - Toolchain: ffmpeg 8 + ffprobe + `whisper` CLI local + bun.
  - **OMP es el SDK**: binario `omp` v18.4.3 con `-p/--print` (no
    interactivo), `--mode json|rpc` (salida parseable), `MESSAGES` con
    `@archivo` (adjunta frames), flag `--config` para overlays
    (`scripts/omp-session.sh`, `prompts/omp-session-bootstrap.md`), roles de
    modelo (`--smol/--slow/--plan`) y tool `task` para subagentes. El overlay
    `video-maker-plan.yml` fija default/slow/plan en mimo-v2.6-pro, smol en
    flash, y **visión hereda la config global (`openai-codex/gpt-5.6-luna:high`)**.
    Patrón de orquestación con delegación ya probado en este repo
    (orquestador + workers + `set_model` por sesión).
- **Inferred**:
  - Muestreo a ~1fps + `select scene` de ffmpeg da una serie manejable
    (1h → ~3600 frames; en shards de ~60 frames → 60 llamadas visión).
    Cada shard devuelve JSON validado con zod; el orquestador agrega y decide
    rangos — esa es la delegación "de dónde a dónde".
  - El análisis por frame (nº hablantes, bbox de caras normalizadas 0-1000,
    hablante activo, cambio de plano, energía/tema, highlight 0-1) alimenta
    **tres** consumidores: rangos (agregación), crop-track (caras →
    `InteractionEvent` → `planCamera`) y layout (1 cara = solo, 2 caras
    estables = podcast-dúo).
  - Pulido = intersección de rangos con voz real: gaps de whisper
    (`word_timestamps`) + `silencedetect` de ffmpeg recortan cabezas/colas
    calladas y parten rangos con baches largos.
  - Cada clip aprobado = 1 film de 1 escena (un mp4 + still + report);
    podcast-dúo = mismo film con intent `clip-podcast` y dos ventanas del
    **mismo** source recortado (sin re-encode extra: dos `OffthreadVideo` con
    `startFrom` idéntico y crop-windows distintas).
- **Unknown** (a Open Questions): shard óptimo vs costo visión; umbral de
  silencio; hablante-activo por audio (diarización) en v1 o solo visión;
  `yt-dlp`; duraciones objetivo.

## Joya 1: CLI que analiza series de frames con OMP

```
transcribe → propose (transcript) → frames (ralo+keyframes) → analyze (solo keys) → ranges → polish
 whisper        heurística local, gratis    2 niveles, config.      small vision      combina score
 gratis         proposals.json              ffmpeg gratis           shards=ventanas    + confirmación
```

- **`clip-frames --src <mp4> [--frame-every 10 --key-fps 1 --key-margin 5]`**: muestreo en
  dos niveles (todo configurable): base **rala** cada `--frame-every` segundos (contexto,
  thumbs del dashboard, detección de cambios de plano — sin visión) + **keyframes densos**
  a `--key-fps` dentro de cada ventana propuesta ± `--key-margin` segundos. Escribe
  `clips/frames/f-%06d.jpg` + `clips/frames.json` (cada frame con `rol: base|key`).
  Calidad del source (gate duro): URL → `bestvideo[height<=1080]+bestaudio/best`, nunca el
  fallback 360p (formato 18); archivo local o stream <720p → fail accionable (re-muestrear
  desde 360p estira ~5× y arruina el crop vertical). Puro ffmpeg, gratis, offline.
  `--plan` lista conteo por rol.
- **Shard (definición)**: la unidad mínima de trabajo de análisis es una **ventana candidata**
  (tamaño variable, no chunks fijos): su slice de transcript + sus keyframes densos + contexto
  (`source_sha256`, `prev_summary` del transcript vecino, `promptDigest`). Un shard =
  1 ventana = 1 llamada de visión pequeña. ID `shard-007`, manifiesto `clips/shards.json`.
  Determinista: mismo source + transcript + flags ⇒ mismos shards. Si no hay ventanas
  propuestas, no hay shards y `clip-analyze` no gasta nada.
- **Direccionamiento (hablar en posición de frames)**: canónico `frame_id` =
  `f-<n 6 dígitos>` + `t` segundos desde el inicio del source.
  `clips/frames.json` es la única tabla `frame_id ↔ t ↔ archivo`. Todo JSON
  (análisis, rangos, decisiones) referencia `frame_id`; `t` es para humanos y
  para ffmpeg (`-ss`). Transcript y frames comparten el reloj `t` del mismo
  source → cruce audio↔frame gratis, sin deriva.
- **`clip-propose [--min 20 --max 90]`** (nuevo, offline, gratis): los momentos salen del
  **transcript**, no de mirar frames. Heurística local sobre palabras: hook en apertura,
  densidad sin baches, preguntas/exclamaciones, picos de energía, giros de topic → ventanas
  candidatas con pre-score en `clips/proposals.json`. Opcional: pre-gate barato con el
  backend (`decide()` Score por ventana) antes de gastar visión.
- **`clip-analyze [--submit] [--max-shards N] [--backend omp] [--objective "<texto>"]`**: **small analysis**
  solo sobre keyframes: por shard (ventana) llama al `AgentRunner` con sus keyframes + transcript slice +
  `--objective` (el objetivo en lenguaje natural viaja en el prompt de cada shard: qué buscar y qué
  preservar, ej. "momentos divertidos, preserven las caras"). Devuelve caras/bboxes,
  hablante, calidad de plano y confirmación del momento — no redescubre nada, confirma y
  localiza. Salida `clips/analysis/shard-<n>.json` validado (zod); basura → retry 1× →
  `uncertain` (precedente paid-operation). Paralelismo `--jobs`; `spendCap` prorrateado.
- **Contrato JSON por frame** (`FrameAnalysis`, en `schemas/clip.ts`):
  `t, speakers: [{id, bbox:[x,y,w,h] 0-1000, speaking: bool}], sceneCut: bool,
  energy 0-1, topic: string, highlight 0-1, note`. Versión `schemaVersion: 1`
  para tolerar prompts mejorados sin romper lectores.
- **Tool de ubicación exacta (`clip-locate --at <t|frame_id>`) — sí, hace
  falta**: extrae el frame exacto a resolución completa + tira de vecinos
  (±2s) + slice de transcript ±10s + análisis existente de esa ventana, e
  imprime rutas + `frame_id` + `t` exactos. El agente responsable fija cortes
  con precisión de frame y el CLI resuelve a los puntos de trim.
  `clip-strip --from <t> --to <t>` genera además la cuadrícula etiquetada con
  `frame_id` para ver una ventana de un vistazo. En sesión OMP agéntica se
  invocan igual por subproceso (mismo contrato, futura tool MCP).
- **`clip-ranges [--weights <file> --preset viral|podcast|educational --min-score 0.6 --explain <id> --objective "<texto>"]`**: combina
  pre-score de transcript (`proposals.json`) + confirmación visual (`analysis/*.json`) con la función
  de scoring (ver abajo, 100% offline y ajustable) y propone `clips/candidates.json`:
  `{id, start, end, score, breakdown, layout: single|duo, faces: [...], social: {title, description, hashtags[]}}`.
  **Esta es la delegación**: de dónde a dónde va cada clip y con qué layout — el resto solo ejecuta.
  `--init-weights` escribe `clips/scoring.json` con defaults y sale; `--explain <id>` imprime el
  desglose señal-por-señal de un candidato (de dónde salió cada punto, auditable).
  `--objective` (mismo texto que en `analyze`) fija el tono del `social` y el header del dashboard.
- **Rúbrica del `social` (calidad de copy, verificable)**: título con hook específico del
  momento (nada de "el parto más dramático" genérico); descripción de 1-2 líneas anclada al
  transcript real (prohibido inventar hechos: nombres, lugares y remates salen del análisis,
  el crítico los valida); `hashtags[]` como lista (el dashboard los une con espacios —
  jamás `#a#b#c` pegados); 3-6 tags, mezcla de alcance (#comedia) + específicos (#IndiaYuridia);
  emoji máximo 1-2 y solo si suma. `clip-approve` rechaza social vacío o con tags malformados.
- **Auto-revisión del agente (2 pasadas + verificador determinista)**:
  `--review` corre al mismo backend como **crítico** (rúbrica: rangos dentro de la duración,
  layout↔caras consistente, hook real en el transcript, social completo, sin solapes) →
  el generador revisa (máx 2 rondas, journaled en `revisions[]` de cada candidato).
  Además `clip-approve` verifica **determinísticamente** cada claim contra evidencia
  (estilo `scene-verify`: schema, sha256 del source, start<end dentro de duración,
  layout↔faces, hook afirmado vs transcript real) y rechaza lo que no cuadra —
  el verificador nunca muta, solo acepta o rechaza (precedente: `scene-critic`).
- **Scoring de relevancia (ajustable, nunca caja negra)**. Cada ventana candidata suma señales
  normalizadas 0-1 × peso (defaults en `clips/scoring.json`, presets que solo cambian pesos):
  1. `highlight` visión OMP (promedio del `highlight` por frame — lo más caro, lo que más pesa);
  2. `hook`: pregunta/gancho en los primeros 3s (¿…?/cómo/números/listas, sobre el transcript);
  3. `density`: palabras/segundo sin baches (whisper; penaliza silencios >1s);
  4. `emotion`: hablante activo + energía (visión `speaking` + picos de audio);
  5. `novelty`: cambio de plano o giro de topic vs ventana previa (anti-repetición);
  6. `closure`: la ventana termina en frase completa, no a media palabra (pulido la garantiza).
  `score = Σ peso_i × señal_i / Σ pesos`, 0-1. `--min-score` filtra; `--preset` elige pesos:
  `viral` (highlight+hook altos), `podcast` (density+emotion, ventanas más largas),
  `educational` (novelty+closure, penaliza cortes bruscos). Función pura en `pipeline/clip.ts`
  (`scoreWindow(frames, words, weights)`), testeada con fixtures; `--plan` la corre en seco.
- **`clip-polish`**: recorta silencios (whisper local `word_timestamps` +
  `silencedetect`): ajusta `start/end` al primer/último fonema con margen
  200ms, parte rangos con gaps > 2s. Escribe `clips/decisions-ready.json`.
- **`clip-approve`**: valida decisiones del agente contra schema + sha256 del
  source → `clips/decisions.json` sellado. Sin esto no hay render.
- **`clip-viewer`** (patrón `ig-viewer`: función pura `renderClipsDashboard(candidates, decisions)` →
  `clips/dashboard/index.html`, local, sin red): tarjetas por clip con still, título, descripción
  y hashtags para redes, score + layout + estado (candidate/approved/rejected) y `frame_id`s del
  rango. Solo lectura: sin acciones, todo lo controla el agente por CLI. El `social` lo genera el
  backend agente en `clip-ranges` (con fallback a plantilla `topic + t` si lo omite); el agente lo
  edita en `candidates.json` y el viewer re-renderiza. A futuro `publish` toma título/descripción
  de `decisions.json` (precedente: `social-post.json` de bfc/).

## Joya 2: adaptación en Remotion (solo + podcast-dúo)

- **Solo** (`ClipVertical.tsx`, intent `clip-vertical`): blur-bg cover +
  frente nítido con crop-window animada (`ClipCamera` sobre la capa de video;
  `x(t)` del `CameraPlan` derivado de caras, clamp sin exponer bordes; plan
  estático = center-crop) + `Subtitles` siblings + safe zones. Corte exacto
  previo con ffmpeg → `duration = fin - inicio`. **Zoom prohibido**: la ventana
  se recorta a resolución nativa (scale = 1.0, sin upscale) y se **posiciona**
  en el canvas (centrada o en tercios); el blur-bg rellena el resto. La zona
  nítida conserva calidad 1:1 del source — nunca se estira un píxel.
- **Podcast-dúo** (`ClipPodcast.tsx`, intent `clip-podcast`): el canvas
  1080×1920 se parte en dos mitades (arriba/abajo): cada mitad un crop de
  cara a resolución nativa (bbox del análisis, tracking suavizado por el mismo
  `planCamera`), posicionado 1:1 sin upscale; hablante activo a color/full-brillo
  + keyline de marca, el otro levemente atenuado; subtítulo único abajo. Si el
  análisis trae 1 sola cara estable → el orquestador elige `single` (el dúo nunca
  se fuerza). Misma regla: recortar y posicionar, jamás zoom.
- Audio: el del recorte; `Film` sin master; gate de loudness existente mide
  igual. Fuente vertical de entrada → passthrough (blur atenuado).

## Workflow end-to-end

```
VIDEO LARGO (archivo local o URL -- yt-dlp)
        │
        ▼
┌─ clip-transcribe ───────────────────┐  CLI · whisper local · gratis
│ word_timestamps del largo entero    │  clips/transcript.json
└────────────────┬────────────────────┘  (mismo reloj t → cruce audio↔frame)
                 ▼
┌─ clip-propose ──────────────────────┐  CLI · heurística local · gratis
│ momentos desde el TRANSCRIPT (no    │  clips/proposals.json (ventanas +
│ de mirar frames): hook, densidad,   │  pre-score). Sin ventanas → fin,
│ preguntas, topic → ventanas         │  gasto 0 en visión
└────────────────┬────────────────────┘
                 ▼
┌─ clip-frames ───────────────────────┐  CLI · ffmpeg · gratis/offline
│ 2 niveles: base rala configurable   │  clips/frames/f-000001.jpg…
│ (--frame-every) + keyframes densos  │  clips/frames.json (rol base|key)
│ en ventanas ± margen                │  clips/shards.json (1 shard=1 ventana)
└────────────────┬────────────────────┘
                 ▼
┌─ clip-analyze ──────────────────────┐  CLI × OMP SDK · pago (spend-cap)
│ SMALL analysis solo en keyframes:   │  omp -p --mode json "@f-*.jpg"
│ confirma el momento, localiza caras │  JSON validado (zod FrameAnalysis)
│ clips/analysis/shard-N.json         │  retry 1× → uncertain, nunca inventa
└────────────────┬────────────────────┘  --plan: solo estima, no invoca
                 ▼
┌─ clip-ranges ───────────────────────┐  ★ ORQUESTADOR (agente) · offline
│ ★ DELEGACIÓN: pre-score +           │  clips/candidates.json
│ confirmación visual → rangos finales │  {start, end, score, layout, social}
│ layout: single (1 cara) | duo       │  (podcast = 2 caras estables)
└────────────────┬────────────────────┘
                 ▼
┌─ clip-polish ───────────────────────┐  CLI · gratis
│ cruza con voz real: recorta         │  clips/decisions-ready.json
│ silencios, parte gaps > 2s          │
└────────────────┬────────────────────┘
                 ▼
┌─ clip-approve ──────────────────────┐  AGENTE edita · CLI sella
│ valida schema + sha256 del source   │  clips/decisions.json
│ ⛔ sin esto no hay render            │
└────────────────┬────────────────────┘
                 ▼
┌─ clip-viewer ───────────────────────┐  CLI · local, sin red (patrón ig-viewer)
│ clips/dashboard/index.html:         │  tarjetas con still + título +
│ título, descripción y hashtags      │  descripción + hashtags + score +
│ por clip (solo lectura, el agente   │  estado. El agente lo muestra por URL;
│ muestra por URL, controla por CLI)  │  publish reusará el social a futuro
└────────────────┬────────────────────┘
                 ▼
┌─ clip-render ───────────────────────┐  CLI · Remotion Film 1080×1920
│ trim exacto → 1 film de 1 escena    │
│ por clip aprobado:                  │
│  single → ClipVertical              │
│   (blur-bg + crop animado + subs)   │
│  duo    → ClipPodcast               │
│   (caras apiladas, activo enfatizado│
│ renders/clips/<id>.mp4 + still +    │
│ qa/clips/<id>.report.json           │
└────────────────┬────────────────────┘
                 ▼
   publish / bundle / archive (reuso tal cual)
```

Transversal (fijar puntos exactos): `clip-locate --at <t|frame_id>` y
`clip-strip --from <t> --to <t>` — disponibles en ranges/approve para que el
agente responsable ancle cortes a `frame_id` exactos.

## Comandos CLI (secuencia completa)

```bash
# 0. Todo verbo en seco primero (sin red, sin secretos, sin gasto)
bun run vm -- clip-frames <proyecto> --plan

# 1. Import + muestreo base rala (acepta archivo local o URL de YouTube)
bun run vm -- clip-frames <proyecto> --src "https://youtube.com/watch?v=..." [--frame-every 10]

# 2. Transcript local con reloj t (gratis)
bun run vm -- clip-transcribe <proyecto>

# 3. Ventanas candidatas desde el transcript (gratis; sin ventanas, fin: gasto 0)
bun run vm -- clip-propose <proyecto> [--min 20 --max 90]

# 4. Keyframes densos solo en ventanas propuestas (gratis)
bun run vm -- clip-frames <proyecto> --keys [--key-fps 1 --key-margin 5]

# 5. Small vision en keyframes (LO ÚNICO PAGO — exige --submit + --spend-cap)
bun run vm -- clip-analyze <proyecto> --submit --spend-cap 5 --max-shards 30 \
  --objective "momentos más divertidos, preserven las caras"

# 6. Rangos + layout + social (offline; el objetivo fija tono y header)
bun run vm -- clip-ranges <proyecto> --preset viral [--review] \
  --objective "momentos más divertidos, preserven las caras"
bun run vm -- clip-ranges <proyecto> --explain <clip-id>   # de dónde salió cada punto

# 7. Pulido de silencios (gratis)
bun run vm -- clip-polish <proyecto>

# 8. Dashboard local (el agente lo muestra por URL; solo lectura)
bun run vm -- clip-viewer <proyecto>   # → clips/dashboard/index.html

# 9. Ubicación exacta para fijar cortes (el agente ancla a frame_id)
bun run vm -- clip-locate <proyecto> --at 83.4
bun run vm -- clip-strip <proyecto> --from 80 --to 95

# 10. Aprobación = sellado (⛔ sin esto no hay render)
bun run vm -- clip-approve <proyecto> --id clip-03 --id clip-07

# 11. Render vertical en Remotion (1080×1920, single o dúo)
bun run vm -- clip-render <proyecto> [--id clip-03]
# → renders/clips/<id>.mp4 + qa/stills + qa/clips/<id>.report.json
```

`<proyecto>` es el directorio del proyecto (flag `--project` o primer posicional,
convención del registry). Reglas que aplican a todos: `--plan`/`--dry-run` nunca
toca red ni secretos ni invoca al backend; `run()` rechaza plan-mode; sin
`--spend-cap` no hay submit pago.


## Pipeline completo

| Verbo | Hace | Escribe | Gate / costo |
|---|---|---|---|
| `clip-frames` | Muestreo 2 niveles (ralo + keyframes) + manifests | `clips/frames/`, `clips/frames.json`, `clips/shards.json` | — gratis |
| `clip-propose` | Ventanas desde transcript (heurística local) | `clips/proposals.json` | — gratis |
| `clip-analyze` | Small vision solo en keyframes, JSON validado | `clips/analysis/shard-*.json` (+ `qa/spend.json`) | `spend` (paid, `--submit` + `--spend-cap`) |
| `clip-ranges` | Combina pre-score + confirmación visual → rangos + layout (delegación) | `clips/candidates.json` (+ `clips/scoring.json` con `--init-weights`) | — offline |
| `clip-polish` | Recorta silencios, parte gaps | `clips/decisions-ready.json` | — gratis (whisper local) |
| `clip-transcribe` | whisper json del largo entero (subs + reloj t) | `clips/transcript.json` | — gratis |
| `clip-locate` | Frame exacto + vecinos + transcript ±10s | stdout (rutas + `frame_id` + `t`) | — gratis |
| `clip-strip` | Cuadrícula etiquetada de una ventana | `clips/strips/<from>-<to>.jpg` | — gratis |
| `clip-approve` | Valida+sella decisiones del agente | `clips/decisions.json` | — |
| `clip-viewer` | Dashboard local: tarjetas con still + título/descripción/hashtags | `clips/dashboard/index.html` | — gratis |
| `clip-render` | Trim exacto → Film 1080×1920 → render+qa | `renders/clips/<id>.mp4`, `qa/stills/clips/<id>.png`, `qa/clips/<id>.report.json` | `render`, `qa` |

El transcript del largo entero es estructural: `propose` y el hook lo consumen antes de gastar visión.

`publish`/`bundle`/`archive` se reusan sin cambios sobre `renders/clips/`.

## Archivos y áreas

- Nuevo `packages/cli/src/pipeline/agent.ts`: `AgentRunner` (`analyzeShard(frames, ctx)`,
  `decide(state, questions?)`) — contrato agnóstico al backend, fakes para tests. El extractor
  de clips relevantes **es un agente detrás de la frontera CLI**: los verbos y JSON son estables,
  el ejecutor se cambia sin tocar el pipeline.
- Nuevo `packages/cli/src/pipeline/backends/omp-sdk.ts`: backend actual (SDK embebido;
  fallback a subproceso `--mode json`, timeout, redacción de paths). Nada de secretos en el
  seam: OMP resuelve su propia auth por perfil.
- Futuro `packages/cli/src/pipeline/backends/jev.ts`: Jev es API de decisiones sobre `state`
  textual (Choice/Score/Noul, `POST /api/v1/decide`, key `JEV_API_KEY` vía `@videomaker/credentials`;
  verificado en docs TypeSafe: sin imágenes, input pago ~$0.042/MTok, output gratis). Mapeo:
  Score→relevancia por ventana, Choice→`single|duo` y keep/discard, Noul→gates (hook, closure).
  Como no ve frames, el flujo futuro es: descripción visual (OMP/local) → `state` texto → Jev
  decide; o Jev barato como pre-gate sobre transcript y visión OMP solo en top-K (menos gasto).
- Nuevo `packages/cli/src/pipeline/clip.ts`: frames (ffmpeg), sharding,
  agregación de rangos, pulido (whisper+silencedetect), props Film por layout,
  trim exacto. Deps inyectables (`AgentRunner`, `ProcessRunner`, `Clock`) como
  en `deps.ts`.
- Nuevo `packages/cli/src/specs/clip.ts` (`buildClipSpecs` + `clipSpecs`);
  **1 línea** en `all-specs.ts`. Estimación de costo visión en `plan()` por
  shard (nº frames), sin invocar nada.
- Nuevo `packages/motion-remotion/src/ClipVertical.tsx` (renderer + `ClipCamera`)
  y `ClipPodcast.tsx`; registro de intents en project code.
- `packages/motion-remotion/src/types.ts`: **aditivo** `FilmSceneSource += 'clip'`;
  `FilmScene` puede llevar `layout: 'single'|'duo'` + `faces` (aditivo, opcional).
- Nuevo `packages/motion-remotion/src/subtitle-words.ts` (+ test).
- Nuevo `packages/schemas/src/clip.ts`: `FrameAnalysis`, `ClipRange`, `ClipDecision`,
  `ScoringWeights` (pesos + presets, zod, `schemaVersion`).
- Nuevo `packages/motion-core/src/face-track.ts` (**puro**): bboxes de
  `FrameAnalysis` → `InteractionEvent[]` → `planCamera`; incluye split
  speaker A/B para el dúo.
- Tests: `agent.test.ts` (fake runner, timeout, JSON inválido → retry/uncertain),
  `clip.test.ts` (sharding, agregación, pulido, pureza de `plan`),
  `clip-viewer.test.ts` (`renderClipsDashboard` pura: tarjetas, escaping de
  título/descripción como en `ingest.test.ts`, sin red),
  `subtitle-words.test.ts`, `face-track.test.ts`, paridad still/render de
  ambos intents (patrón `render-parity.test.ts`).

## Validación

1. `bun test packages/cli packages/motion-remotion packages/motion-core packages/schemas` — verde.
2. `bun run build` — exit 0.
3. `bun run vm -- clip-analyze <tmp> --plan` — shards y estimado sin invocar
   `omp`; `clip-analyze --submit` sin `--spend-cap` falla accionable; con fake
   runner produce `analysis/*.json` válidos.
4. Demo temporal (clip horizontal de 2 hablantes): 1 clip `single` + 1 `duo` →
   ambos mp4 1080×1920, duración `fin-inicio` ±1 frame, still = frame del
   render, `qa/report.json` con sha256 válidos.

## Riesgos y edges

- Costo/latencia de visión escala con frames: shard 60 @1fps ≈ 1 min video por
  llamada; `--max-shards` + muestreo previo por `scene` (solo frames de cambio
  + 1 cada N) como freno. Estimado siempre visible en `--plan`.
- El modelo puede devolver JSON inválido: schema estricto + 1 retry con
  reprimenda + `uncertain` (nunca inventar rangos).
- Hablante-activo solo por visión es ruidoso: v1 lo cruza con energía de audio
  por ventana (whisper); diarización real queda fuera de v1.
- Dúo con >2 caras o caras inestables → fallback a `single` (decisión en
  `clip-ranges`, no en render).
- `yt-dlp` ausente o roto → `clip-frames` exige archivo local con error
  accionable. Fuente vertical → passthrough.
- Canonical del clip: `fps 30, 1080×1920`; el track se muestrea a ese fps.

## Open Questions

1. **Shard y muestreo**: ¿1fps fijo o adaptativo (denso en cambios de plano,
   ralo en estáticos)? Propuesta: `select=scene` + tope 1fps, `--shard-size 60`.
2. **Estimación de costo visión**: ¿tarifa fija por frame en `plan()` o
   consulta al proveedor? Propuesta: constante documentada, sin red en plan.
3. **Hablante activo v1**: ¿visión + energía whisper basta, o diarización
   desde el día 1? Propuesta: basta para v1; el dúo solo se elige con caras
   estables en ≥80% del rango.
4. **LLM de score/hook**: ¿mismo backend agente en `clip-ranges`, u otro prompt del mismo?
   Propuesta: mismo seam `AgentRunner`, otro prompt — un solo gasto.
5. **Orquestación**: ¿subprocesos con `--jobs` (v1) o sesión OMP con `task`
   fan-out + climier (evolución)? Propuesta: v1 subprocesos; el contrato
   `AgentRunner` ya deja la puerta abierta.
6. **Gates**: reusar `render`/`qa` (cero cambios en core). Sin objeción →
   queda así.
7. **Backend OMP SDK**: la página del SDK (`omp.sh/docs/sdk`) es embebido Bun
   (sesiones/eventos/tools) pero no expone firma pública legible sin JS —
   verificar nombre del paquete y API mínima en implementación; fallback
   garantizado: subproceso `omp -p --mode json` (ya verificado en `--help`).
8. **Backend Jev (futuro)**: key `JEV_API_KEY` vía `@videomaker/credentials`
   (env-first, como el resto); `decide` con reintento + fail-closed ante schema
   mismatch (práctica oficial Jev: no coercionar, log + fallback seguro).
