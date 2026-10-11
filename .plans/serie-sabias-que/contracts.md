# Contrato normativo · serie-sabias-que

Prevalece sobre cualquier idea previa. Si algo exige otro schema/API/integración, **bloquear y pedir
enmienda**; no ampliar alcance.

## 1. Alcance congelado (incluir verbatim en cada prompt de worker)
Producir **seis videos verticales full-motion** (1080×1920, 30 fps, H.264/AAC, 45–60 s) con formato
"sabías que" sobre temas tabú/curiosidad viral, sin cara en cámara y sin footage de terceros. Cada
video usa el pipeline existente (`vm new` → escenas + narración → `gen-audio` → `gen-media` →
`still` → `assemble` → `qa`). Se entregan **listos para publicar**: MP4 verificado, `facts.json` con
fuentes reales, paquete de publicación (title/description/hashtags/cover) y enlace Tailscale. **No**
se publica en redes, **no** se monetiza, **no** se usa material de terceros.

## 2. Verdad factual (regla dura)
- Toda frase "sabías que" debe existir en `research/<slug>/facts.json` como
  `{ id, claim, sourceUrl (http/https), sourceTitle, dateAccessed, jurisdiction? }`.
- Sin fuente verificable, el beat **se reemplaza**, no se "suaviza" ni se "aproxima".
- No se afirma sincronía, resultado o cifra que no esté respaldada. Las cifras se citan con fecha.
- Contenido tabú permitido = incómodo pero **platform-safe**: muerte, privacidad, dinero, mentira,
  conocimiento prohibido, sueño/cuerpo. Prohibido: gore gráfico, contenido sexual explícito,
  promoción de drogas, consejo médico, acusaciones a personas/marcas reales sin prueba.

## 3. Identidad de serie
Paleta, tipografía, sello "SABÍAS QUE?" y reglas de motion son únicas y compartidas por los seis.
El motion **acompaña la semántica** (nada de movimiento aleatorio continuo). Subtítulos vía el
componente compartido `WordSubtitles` (nunca pegados al borde inferior).

## 4. Contrato del verificador único
`projects/serie-sabias-que/scripts/verify-series.ts --stage <research|motion|media|narration|final>`
es la autoridad de verificación. Lee `projects/serie-sabias-que/series.json` (manifest de los 6 slugs)
y valida, por stage:
- `research`: `research/<slug>/facts.json` válido, ≥4 hechos, cada uno con `sourceUrl` http(s) y `dateAccessed`.
- `motion`: `video.json` válido, resolución 1080×1920, fps 30, ≥4 escenas activas, `publication`/`script` dirs.
- `media`: `covers/cover.png` por slug + (para los slugs marcados `generated:true`) receipts de media.
- `narration`: `script/audio/narration.wav` por slug con duración >0 (ffprobe).
- `final`: lo anterior + `renders/<slug>.mp4` 1080×1920 h264+aac duración en [40,70]s + `publication/<slug>.draft.json` + `qa/report.json`.
Exit 0 solo si todo pasa; imprime un resumen por slug. Prohibido "fake verde".

## 5. Entrega y red
- El enlace de revisión se sirve desde `0.0.0.0:7099` (verificado con `ss -tlnp`).
- NUNCA se comparte `localhost`/`127.0.0.1`: se usa `http://<tailscale-ipv4>:7099/`.
- Si Tailscale no corre, se dice explícitamente y se dan las instrucciones; no hay fallback a loopback.
- La publicación real a Zernio queda fuera del goal (detrás de `G-publish`).

## 6. Límites operativos
No Docker, migraciones, contenedores, DB ni infraestructura nueva. No secretos en logs/manifests/
capturas. No tocar `presets/*` ni proyectos existentes. No commits/merge/deploy no autorizados.

## 7. Gates (solo el operador resuelve)
- `G-start`: autoriza implementación local (gratis: research, escenas, Remotion, stills, renders sin TTS).
- `G-ai-spend`: autoriza gasto real (TTS ElevenLabs + fal) con tope explícito en USD.
- `G-publish` (fuera del DAG): si algún día se quiere publicar de verdad. No se resuelve desde agentes.
