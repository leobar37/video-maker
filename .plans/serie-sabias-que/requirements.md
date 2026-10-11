# Requisitos · serie-sabias-que

El *qué*, no el *cómo*. Cada fase referencia estos IDs.

## Contenido y formato
- **FR-001** — Seis videos verticales 1080×1920, 30 fps, H.264/AAC, 45–60 s, en español.
- **FR-002** — Formato "sabías que": cada video abre con un hook de ≤2 s y cierra con remate honesto.
- **FR-003** — Full-motion: cada tramo tiene movimiento dirigido (kinetic type / data-viz / B-roll),
  sin cara en cámara y sin footage de terceros.
- **FR-004** — Temas tabú/curiosidad viral, platform-safe (definición en `contracts.md` §2).

## Verdad y evidencia
- **FR-005** — Cada afirmación tiene fuente verificable en `facts.json` (sin fuente, el beat se reemplaza).
- **FR-006** — Meta sintética declarada y sin presentar generación como prueba de un hecho.

## Identidad y assets
- **FR-007** — Identidad de serie única (paleta, tipografía, sello, reglas de motion, voz).
- **FR-008** — B-roll generado solo donde aporta (slug marcado `generated:true`) y portada por video.
- **FR-009** — Narración TTS continua (una petición por video), sin cortes ni huecos.

## Producción y QA
- **FR-010** — Render por video con evidencia `qa/report.json` y `qa/loudness.json`, `vm qa` exit 0.
- **FR-011** — Verificador único `verify-series.ts` con stages research|motion|media|narration|final.
- **FR-012** — Sin gasto real sin `G-ai-spend`; sin publicación sin `G-publish`.

## Entrega
- **FR-013** — Paquete de publicación por video: title, description, hashtags ≤5, `covers/cover.png`.
- **FR-014** — Enlace de revisión Tailscale (0.0.0.0:7099, HTTP 200/206) con los seis MP4; jamás localhost.
- **FR-015** — El detalle creativo de los seis videos vive en `series.md` y es la fuente de P-002.

## No requisitos
- Publicación social, programación, monetización, multi-idioma, analítica.
