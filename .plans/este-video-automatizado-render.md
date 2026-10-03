# Este video automatizado — render autónomo con captions reutilizables

## Goal

- **ID:** G-001
- **Status:** completed
- **Description:** Entregar al usuario un enlace funcional a un MP4 de revisión que convierte sus instrucciones grabadas en montaje: motion, pantalla/cámara/PiP, playa/cielo y subtítulos centrados reutilizables.
- **End state:** MP4 1080×1920 H.264/AAC reproducible con HTTP 200/206 desde una URL accesible al usuario; captions compartidos probados, QA de frames y bordes documentado, gasto fal reservado total <= US$3 y originales sin cambios.
- **Verification:** tests focalizados de captions; typecheck del paquete modificado; ffprobe y decodificación completa del MP4; extracción/revisión de frames de hook/cámara/PiP/playa/cielo/captions; auditoría de rangos/voz; comprobación HTTP del enlace; SHA-256 contra assets-manifest.
- **Deliverables:** componente compartido WordSubtitles y helpers/tests; scripts/composición del proyecto; dos imágenes editadas fal; timeline/captions remapeados; MP4 final de revisión; qa/verification.json, spend/journal, enlace.
- **Budget:** fal.ai máximo TOTAL US$3 incluidos intentos fallidos/inciertos y regeneraciones; primera pasada dos imágenes a US$0.15 estimados cada una. No videos IA de pago ni web search. Subagentes: dos implementadores como máximo, ámbitos separados. No commit ni infra.

## Objective

Usuario: «tienes claro donde aplicaras motion, donde generaras, fal.ai y donde hacer el cambio del video la pantalla con la camara?... subtitulos ... componente reusable ... ponlos en medio ... hacer el plan y dejarlo corriendo». Ampliación: «desde este momento eres autonomo, en la creacion, trata de entregarme el link del render final, para revisarlo por favor, usa sub agentes adecuadamente, modifica la cli si necesitas algun proceso que creas tedioso».

Autorización de gasto explícita, recibida mediante pregunta: **«normal podemos gastar hasta 3 dolares»**. El límite es total de este proyecto, no por escena. El agente no puede aumentarlo.

## Scope

- In scope: este video; nuevo componente compartido de subtítulos temporizados; montaje local híbrido FFmpeg/Remotion; generación image-to-image de playa/cielo; publicación/servicio de un único MP4 final para revisión.
- Out of scope: refactor global de clips, dashboard, otros proyectos, modelos de voz, publicación social, nuevos contenedores/DB, branches/worktrees, cambios a trabajo ajeno, generación de video de pago, afirmaciones de «100% autónomo» sin evidencia.
- No modificar archivos con cambios previos: `packages/cli/src/specs/clip.ts`, `packages/cli/scripts/curate-clips.ts`, `packages/motion-remotion/scripts/bench-clip-render.ts`, contenido ajeno de `.delegations/`.

## Verified Context

- Proyecto: `projects/este-video-automatizado`. Assets originales verificados; transcripciones locales medium/small y 62 instantes únicos examinados; fuentes y hashes en assets-manifest.json.
- A = `assets/VID_20261001_230918.mp4`, 114.269 s; B = `assets/VID_20261001_231250.mp4`, 54.274 s; S = `assets/video-automatizado.mp4`, 92.317 s, 1042×720 sin audio. A/B: HEVC con rotación vertical y audio AAC.
- Propuesta anterior `analysis/editorial-proposal.json` contiene rangos NARRATIVOS, no EDL aprobada. ASR extiende palabras dentro de silencios; no cortar ciegamente por timestamps de palabras.
- `packages/motion-remotion/src/subtitle-words.ts` exporta SubtitleWord y helpers de segmentación. `ClipSubtitles` ya maneja segmentos exactos, pero posición bottom y sin palabra activa; `Subtitles` reparte narración proporcionalmente y no es correcto para estos audios.
- Paquete shared exporta por `src/index.ts`. Render tooling en `./render-adapter`; Remotion 4.0.496/React 19 ya instalados. Reutilizar dependencias y adapter; no instalar otro framework.
- CLI gen-image es Flux text-to-image; no sirve para preservar identidad desde imagen. Registry ya conoce nano-banana-pro/edit; fal queue, storage, credentials y spend ledger existen. No modificar gen-image solo para este caso: script project-local con helpers existentes es suficiente; ampliar CLI solo si aparece una necesidad verdaderamente reutilizable.
- Endpoint/schema oficiales verificados: https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/nano-banana-pro/edit . Precio https://fal.ai/models/fal-ai/nano-banana-pro/edit : $0.15 por imagen 1K/2K, doble 4K; no web-search. Usar 2K, 9:16, PNG, num_images=1, limit_generations=true, enable_web_search=false.
- No afirmar que S contiene video final: se ve actividad de terminal, espera y ENOENT. Usarlo como apoyo del proceso, no resultado ficticio. Sync exacto S/A no confirmado.

## Assumptions / decisiones editoriales

- Formato vertical 1080×1920, 30fps CFR, voz original sin TTS, target 70–85 s; se permite hasta 100 s si hace falta para preservar frases completas y cortes seguros. No acelerar voz para encajar.
- Mantener orden A→B para continuidad de gafas; B se las quita hacia 12–18 s.
- Pantalla sirve como B-roll ilustrativo de proceso; no simular sincronía de acciones no verificadas. Voz siempre de A/B, nunca duplicada.
- La pieza es una prueba de editor autónomo. El hook dice prueba, no garantía comercial; cierre honesto «vamos a ver qué tal».

## Files Involved / ownership

- `packages/motion-remotion/src/WordSubtitles.tsx`, `word-captions.ts`, `word-captions.test.ts`, export en `src/index.ts`: implementar worker Captions solamente; preservar APIs legacy.
- `projects/este-video-automatizado/remotion/`, `scripts/prepare-edit.ts`, `scripts/render.ts`, `edit/`, `renders/`, `qa/`: worker Montage, excluidos los archivos de fal y autorización owned por padre.
- `projects/este-video-automatizado/scripts/generate-effects.ts`, `assets/generated/`, `generation/`, `qa/fal-*`, `qa/spend.json`: padre/integrador.
- `projects/este-video-automatizado/run/`, plan y enlace final: padre.
- Origen `assets/*.mp4`, transcripts raw y análisis anterior: read-only; correcciones editoriales en archivos NUEVOS con provenance, jamás sobre ASR original.

## Shared interface: WordSubtitles

- Exportar `WordSubtitles` de `@videomaker/motion-remotion`.
- Props mínimas: `words: readonly SubtitleWord[]` (segundos de la timeline FINAL de composición), `yPercent?: number` (default 60), `maxWords?: number` (default 4), `maxChars?: number` (default 28), `fontSize?: number` (default 58 @1080), `fontFamily?: string`, `accentColor?: string`, `textColor?: string`.
- Semántica: palabras activas por tiempo real de Remotion, agrupación determinista, cortes de frase en gaps/saltos editoriales, no frase pegada durante silencios largos. Blanco legible con sombra/contorno, palabra activa acento cian/lima; posición horizontal centrada, `top:yPercent%`, transform translateY(-50%); ancho máximo ~84%, no pegado abajo.
- Helpers puros con tests de selección temporal, agrupación, gaps, vacíos, timestamps adyacentes, posición inválida clamped/default. No requiere hook custom para tiempo, no cliente HTTP, no credenciales.
- No rediseñar ClipSubtitles/Subtitles existentes ni cambiar defaults de otros videos. Nuevo componente reusable no contiene texto, nombres, rutas ni lógica específica de este proyecto.
- Montage importa el componente shared; no copia JSX de subtítulos localmente. Puede ajustar yPercent por layout: camera 60, pantalla/PiP 60–65 si hace falta sin tapar cara/code.

## Ordered Execution Steps

### 1. Captions compartidos — independiente

- Context: reusable en cualquier video y basado en word timestamps.
- Action: implementar contrato anterior y pruebas puras relevantes; usar SubtitleWord existente.
- End state: componente exportado, sin datos del proyecto, tests y typecheck focalizados pasan después de estabilizar código.
- Verification: `bun test packages/motion-remotion/src/word-captions.test.ts packages/motion-remotion/src/subtitle-words.test.ts`; `bun run --cwd packages/motion-remotion build`.
- Depends on: nada. Ownership: worker Captions.

### 2. Preparar audio/timeline y composición — independiente de fal final

- Context: no ejecutar rangos orientativos como cortes exactos.
- Action: crear EDL conservadora ajustada a pausas acústicas reales. Preservar palabra/frase completa y respiración; no cortar en voz baja. Documentar borde desconocido en vez de aprobarlo falsamente. Si no hay pausa limpia, ampliar el rango aunque aumente duración.
- FFmpeg: normalizar autorrotación, 1080×1920/CFR30, una sola pista de audio por toma; ensamblar cuerpo continuo sin micro-cortes dentro de Remotion. Normalizar loudness sin clipping. Source→timeline map obligatorio; captions remapeados por segmentos retenidos, no por estimación proporcional.
- Subtítulos: preservar lapsus «se me lengua la traba»; nombres normalizados solo con evidencia. Correcciones ASR guardadas con texto previo/cambio/motivo. No afirmar una escucha que no ocurrió.
- Body MP4 debe ser copia real en public, no symlink. Composición project-local usa bundle/render-adapter existente. Media siempre local/public salvo imágenes finales descargadas; no llamadas de red ni gastos durante render.
- End state: body.mp4 y edit/timeline.json/captions.json/edl.json coherentes; composición lista para sustituir referencias fal; screen/camera/PiP y motion presentes; generación no es requisito para desarrollar el cuerpo.
- Verification: ffprobe cuerpo, sumas duración/FPS, bordes/segmentos, frame maps, scene anchors. No renderizar final con placeholders ni marcar task final completo hasta fal disponible.
- Depends on: nada (import de captions una vez entregado). Ownership: worker Montage.

### 3. Dos generaciones image-to-image — padre

- Input playa: `analysis/frames/VID_20261001_231250/effects-detail/033.00s.jpg`; alternativa 027.50s.
- Input cielo: `analysis/frames/VID_20261001_231250/effects-detail/040.50s.jpg`.
- Provider: `fal-ai/nano-banana-pro/edit`. Dos submits iniciales separados, un PNG 2K 9:16 cada uno. Mantener exactamente identidad/cara, ropa negra, cadena, manos/gesto y composición de referencia. Playa soleada realista; cielo/nubes estilizado pero reconocible. Sin texto, logos, dedos extra, cambio de persona.
- Upload SOLO los dos frames de referencia. FAL_KEY solo por resolver/header; jamás en logs/manifest/prompt. No subir clips completos.
- Journal/spend: reservar coste ANTES del submit, persistir receipt request_id inmediatamente, reusar cache completed; submitted/uncertain jamás re-submit automático. Total reservado <=3.00 incl. intentos fallidos/inciertos. Máximo inicial dos, hasta dos correcciones por escena si QA justifica; no gastar sobrante por gastar.
- Guardar outputs `assets/generated/beach.png` y `sky.png`; imagen+receipt+hash/cost. Si se cae la cola, recuperar por request_id. Si falla límite/no credenciales, bloquear solo esta unidad y no publicar placeholders como final.
- End state: dos imágenes reales revisadas visualmente y registro de gasto válido.
- Verification: dimensión/decodificación PNG; identidad y manos conservadas; presupuesto en enteros microUSD; receipts completos.
- Depends on: autorización US$3 recibida. Ownership: padre.

### 4. Integrar motion, cambios de cámara, fal y captions

**Mapa por tiempo de FUENTE (convertir a timeline mediante EDL):**

| Evento | Fuente | Acción concreta |
|---|---|---|
| Hook | A 0–9 s | Título superior «ESTE VIDEO ES UNA PRUEBA», entrada suave 8–12 frames; no tapar ojos ni añadir voz |
| Dolor | A 14.6–21.2 s | Énfasis «SIN ALINEAR A MANO» / acento corto, no tarjeta fullscreen |
| Remotion opcional | A 55–66 s | 3 labels pequeños «VIDEO · AUDIO · MOTION», acentos sincronizados; omitir si larga la pieza |
| Cambio cara→pantalla | A 97.5–104.7 s | Empezar en cara; al mencionar computadora mostrar S como pantalla ilustrativa, marco elegante, respetar aspect ratio |
| PiP | A 104.7–111 s | Al pedir cuadro de la cara, pantalla principal + cámara real en ventana; captions compartidos al centro/60%, sin superponer la cara |
| Limpieza | B 1–9.3 s | Motion de «PAUSAS / RECORTES» como label discreto; cortes solo si acústicamente seguros; preservar el lapsus si sirve al humor |
| Proveedor/modelos | B 9.3–18.4 s | Texto corto «MODELOS VISUALES», sin afirmaciones técnicas inventadas |
| Frame / playa | B 23–35.15 s | Resaltar el gesto/«FRAME», entrar al PNG beach tras «playa» durante pausa 32.483–35.149 s. Match-frame/crossfade 4–6f y slow push 1.00→1.04; no nuevo audio |
| Cielo | B 36–42.2 s | PNG sky durante pausa 39.56–41.839 s. Transición suave + ligero drift; volver a toma real a tiempo de próxima voz |
| Cierre | B ~49–54 s | Cara real, cierre breve; opcional «PRUEBA COMPLETADA» solo si QA realmente satisfecho; preferir «¿QUÉ TAL QUEDÓ?» |

- No movimiento aleatorio continuo: motion acompaña semántica; no zoom que corta dedos/cara. Tipografía compartida, blancos/cian/negro, contraste consistente.
- Fal genera los entornos; Remotion genera texto, marcos, transiciones y movimiento de imagen. Dos responsabilidades distintas.
- End state: composición real sin placeholders; todos los anchors remapeados y captions alineados con audio del cuerpo.
- Verification: stills antes/durante/después de cada cambio; revisar cara/code/captions no se solapen y jamás queden en el borde inferior.
- Depends on: 1,2,3. Ownership: Montage + padre integrador (coordinar; no escribir simultáneamente mismo archivo).

### 5. Render, QA y enlace

- Render primero muestra/stills; corregir dentro del alcance y luego MP4 H.264/AAC, 1080×1920/30, +faststart si corresponde.
- QA: decode completo, duración real vs plan, voces/cortes acústicos, word alignment y texto visible; hashes originales; outputs fal presentes; máximo $3 respetado.
- Publicar SOLO MP4 final (y poster opcional) usando storage existente si es seguro/reusable, o servir carpeta mínima de review via Tailscale. Ningún link localhost al usuario. Si servidor local: bind0.0.0.0, comprobar con ss, usar tailscale ip -4 y probar HTTP200/206. No abrir puerto público/Funnel ni nueva infraestructura sin permiso.
- End state: enlace reproducible y evidencia guardada; no llamar final publicado si el recurso devuelve error o es placeholder.
- Depends on: 4. Ownership: padre.

## Risks and Edge Cases

- ASR incierto no permite subtítulos certificados ni cortes milimétricos. Validar evidencia disponible, mantener original si dudoso y documentar incertidumbre.
- Pantalla sin audio: no inferir sync exacto; B-roll transparente de proceso. No presentar error como éxito.
- Fal puede alterar cara/manos: inspección de identidad y poses, regeneración solo justificada con budget ledger.
- Primer/último frame de escenas, palabras adyacentes y breves silencios no deben duplicar/subtitular fuera de contexto.
- HEVC variable FPS y metadatos de rotación: normalizar a 30fps antes de Remotion.
- Servicio/queue timeout: recuperar receipt, no duplicar pago. Al llegar al cap: stop paid work, continuar trabajo local seguro.
- Cambios ajenos preexistentes: preservarlos íntegramente.

## Validation Strategy

Cada implementador omite build/lint/tests/formatters mientras modifica código; ejecutamos validación focal una vez estabilizados los cambios y luego integración. Repetir solo checks afectados por una corrección propia. No suite global ni arreglos fuera de alcance. El padre reproduce checks relevantes y revisa imágenes; no acepta reportes sin evidencia.

## Open Questions

No hay decisiones de producto bloqueantes: usuario autorizó creación autónoma y US$3. Solo incertidumbres técnicas/editoriales a resolver conservadoramente: bordes exactos de voz, texto ASR dudoso y si R2 final es utilizable sin ampliar infra. Si hay bloqueo real, mantener goal abierto y avanzar unidades independientes.
