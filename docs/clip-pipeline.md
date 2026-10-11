# Pipeline de clips: ingesta, corte, selección y publicación

Comandos y reglas operativas del flujo **YouTube → clips verticales → publicación**,
con los números medidos en dos corridas reales (comedia 49 min y podcast 71 min).

## Resumen de comandos

| Comando | Qué hace | Coste |
|---|---|---|
| `vm clip-ingest` | Baja el video entero **o solo los tramos** (`--section a-b`), con proxy opcional | gratis |
| `vm clip-cut` | Corta 9:16 desde un source local: **snapping a silencio real**, layouts, subtítulos quemados, loudness, portada y `--jobs` | gratis |
| `vm clips-select` | Selección editorial con Typesafe: rúbrica configurable + fusión de reacción de público | ~$0.004 por corrida |
| `vm creator-*` / `creator-batch-*` | QA, aprobación por digest y publicación por red | $0 (sin generación) |

---

## 1. Ingesta (`clip-ingest`)

```bash
# Todo el video (canónico: clips/source.mp4)
bun run vm clip-ingest --project projects/<p> --url "<youtube-url>"

# Solo los tramos elegidos (rápido): un archivo por rango en clips/sections/
bun run vm clip-ingest --project projects/<p> --url "<youtube-url>" \
  --proxy http://127.0.0.1:8118 \
  --extractor-args "youtube:player_client=tv_embedded" \
  --section 1700-1730 --section 1800-1830
```

**Medido**: video completo 1.4 GB → **58 min**; los mismos 10 tramos (~650 s) → ~7 min
(2 tramos de 30 s en 82 s, 1920×1080). `--plan` no toca red ni secretos y **redacta las
credenciales del proxy** (`host:puerto`, nunca `user:pass`).

### Reglas aprendidas (todas costaron depuración)

1. **El proxy tiene que llegar al hijo ffmpeg.** `--proxy` solo cubre a yt-dlp; para
   `--download-sections` el que descarga es ffmpeg. El comando añade
   `--downloader-args "ffmpeg:-http_proxy <proxy>"`. Sin eso la descarga se **cuelga**
   (no falla: se queda en ~40 B/s produciendo un `.part` de 44 bytes).
2. **ffmpeg no habla SOCKS.** Un proxy `socks5h://` sirve para yt-dlp pero rompe el
   tramo (HTTP 403). Solución: puente HTTP→SOCKS (`privoxy` con
   `forward-socks5t / 127.0.0.1:9050 .`, escucha en `127.0.0.1:8118`).
3. **Preferir https directo sobre HLS.** El selector evita el "Premium" HLS del mismo
   alto: `bestvideo[height<=H][protocol^=http]+bestaudio[protocol^=http]/…`. El HLS
   equivalente puede pesar 3× y el tramo va mucho más lento por proxy.
4. **El exit de Tor se quema.** Tras ~1.5 GB el mismo exit empieza a devolver
   *"Sign in to confirm you're not a bot"*. Hay que **rotar**: quitar `ExitNodes`,
   reiniciar Tor, probar con `-F` y **fijar la huella** del exit que funcione
   (`ExitNodes <fp>` + `StrictNodes 1`, huella vía `onionoo.torproject.org`).
   El pin es obligatorio: la URL de googlevideo queda atada a la IP que la extrajo.
5. **Mata huérfanos.** Si abortas una corrida, los ffmpeg hijos siguen bajando y te
   roban el ancho de banda (se midió: 4 huérfanos degradando la siguiente corrida).
6. **PO token no compensa aquí**: con el puente la ingesta ya es ~7 min; montar
   `bgutil` ahorraría ~4 min a cambio de un servicio Node más. Descartado a propósito.
7. **`--reuse-existing`** conserva un `clips/source.mp4` ya bajado. Es opt-in porque el
   default del repo **refresca** el source a propósito (evitar publicar calidad vieja).

## 2. Corte (`clip-cut`)

```bash
bun run vm clip-cut --project projects/<p> --clip-plan clips/clip-plan.json \
  --layout crop --words source/words.json --peaks source/reactions.json
```

- **Snapping a silencio real**: mide `silencedetect` **por ventana** (±8 s) y mueve cada
  borde al silencio medido. El archivo completo tarda ~10 min; por ventana es <1 s.
  Regla del repo: *nunca cortar solo por timestamps de ASR*.
- **Layouts**: `blur` (frame completo sobre fondo desenfocado, seguro para dos personas)
  y `crop` (llena el 9:16 con `--crop-offset` 0-100). Para talking heads el crop se ve
  mucho mejor en móvil.
- **Subtítulos quemados** (`--words`): genera un `.ass` determinista por clip (cue por
  presupuesto de palabras/caracteres o pausa) y lo encadena con `subtitles=`.
- **Loudness en el corte**: −16 LUFS, ≤−1.5 dBTP, 48 kHz. El artefacto sale listo para
  `creator-qa` sin un paso aparte.
- **Portada** en el pico de reacción más fuerte dentro de la ventana (si no hay, 40 %).
- **`--jobs N`** reparte los clips entre N ffmpeg concurrentes (validado: 2 clips con
  subtítulos en 39 s frente a ~60 s secuenciales).

## 3. Selección (`clips-select`)

- **Caché y gasto ya existentes**: caché por candidato en
  `analysis/.clip-selection-cache/<digest>.json` con validación de evidencia pagada, y
  ledger con reservas/confirmados. Repetir una selección idéntica cuesta $0.
- **Rúbrica configurable** (`request.rubric`): reescribe instrucciones, niveles, pesos y
  umbrales (`minQuality`, `confidenceFloor`, `gateFloor`) **sin cambiar el contrato del
  resultado**. El `GUARD` de datos no confiables se reantepone siempre.
  Límite consciente: los 4 slots (`hook/value/autonomy/closure`) y los 2 gates son fijos;
  ids nuevos exigirían subir la versión del contrato.
- **Fusión de reacción** (`request.reactionPeaks` + `reactionWeight`): el pico más fuerte
  dentro de la ventana se normaliza y entra como **bonus de ranking**. No toca
  `evaluation.quality` (la evidencia se conserva); el reporte lo declara.
- `reactionWeight` es opcional **sin default** a propósito: inyectarlo cambiaría el digest
  de toda solicitud existente e invalidaría sus cachés pagadas.

## 4. Publicación

- **Varios clips × varias redes** → usar `creator-batch-*` (no un loop de `creator-publish`):
  un manifiesto, progreso durable, una reconciliación. Validado con 5 proyectos × 4 redes
  = 20 destinos (dry-run: sin red, sin escrituras).
- **`sourceAttribution`** en el borrador: línea de crédito de material de terceros. Está
  **dentro del digest**, así que cambiarla invalida la aprobación, igual que el copy.
- `pending` ≠ publicado; un envío incierto no se reintenta.

## Ya existía en el repo (verificado, no duplicado)

| Necesidad | Dónde vive | Evidencia revisada |
|---|---|---|
| Caché de llamadas pagadas | `analysis/.clip-selection-cache/<digest>.json` + validación de evidencia | `specs/clip-selection.ts::selectionJobs` exige intent `completed` con el mismo receipt |
| Coste real | ledger `qa/spend.json` → `spend.confirmedActualUsd` en el resultado V2 | corrida real: `$0.00042` para 8 llamadas |
| Dashboard de clips | `vm clip-viewer` → `clips/dashboard/index.html` (solo lectura) | renderer `renderClipsDashboard` en `pipeline/clip.ts` |
| Servir con enlace seguro | `dashboard-serve` + `dashboard-url` (IPv4 Tailscale, nunca loopback) | `specs/studio-dashboard.ts` |
| Publicación multi-clip | `creator-batch-plan/publish/status/reconcile` | 5 proyectos × 4 redes = 20 destinos, dry-run sin red |

## Descartado con evidencia

- **PO token (`bgutil`)**: ver arriba; el puente HTTP→SOCKS ya deja la ingesta en minutos.
- **Copy asistido por red con Typesafe**: **imposible con este proveedor**. El adaptador
  expone `score` y `noul` (evaluación), no generación de texto; el repo no tiene ningún
  proveedor generativo de texto. El copy se redacta a mano y se aprueba por digest.
- **Página de estado propia**: duplicaría `clip-viewer` + `dashboard-serve`; lo que se
  hizo fue generar el HTML desde el proyecto (`source/make_report.py` en las corridas),
  no añadir otro dashboard al repo.

## Números de la corrida (JH, 71 min)

| Etapa | Antes | Ahora |
|---|---|---|
| Ingesta | 58 min (video completo) | **~7 min** (solo tramos) |
| Corte | 18 min (10 clips) | igual, + silencio/subtítulos/loudness |
| Selección | 15 s · $0.0037 | igual, + rúbrica y fusión |

El cuello real del pipeline es la **ingesta**, no la IA.
