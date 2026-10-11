---
id: G-001
title: Serie "SABÍAS QUE… TABÚ" — seis videos full-motion listos para publicar
status: completed
end_state: "Los 6 videos existen como MP4 1080×1920 H.264/AAC con duración >0 en projects/serie-sabias-que/<slug>/renders/<slug>.mp4; para cada uno 'bun run vm -- qa --project projects/serie-sabias-que/<slug>' sale exit 0 y su factcheck/facts.json solo contiene afirmaciones con sourceUrl http(s); cada video tiene paquete de publicación (title, description, hashtags <=5, covers/cover.png) y 'bun projects/serie-sabias-que/scripts/verify-series.ts --stage final' sale exit 0; un servidor de revisión escucha en 0.0.0.0:7099 sirviendo los 6 MP4 y responde HTTP 200 en http://<tailscale-ipv4>:7099/."
verification: "bun projects/serie-sabias-que/scripts/verify-series.ts --stage final sale exit 0; 'ss -tlnp | grep 7099' muestra listener 0.0.0.0:7099; 'curl -sI http://$(tailscale ip -4):7099/' responde HTTP 200/206; y 'bun run vm -- qa --project projects/serie-sabias-que/<slug>' sale exit 0 para los seis slugs. Ningún enlace apunta a localhost/127.0.0.1."
deliverables:
  - "6 proyectos en projects/serie-sabias-que/<slug>/ (video.json, escenas, remotion, qa, covers, renders)"
  - "6 MP4 verticales 1080×1920 30fps H.264/AAC de 45–60 s en <slug>/renders/<slug>.mp4"
  - "research/<slug>/facts.json con hechos + fuente verificable por video"
  - "publication/<slug>.draft.json con title/description/hashtags<=5 y covers/cover.png por video"
  - "scripts/verify-series.ts (verificador único, stages research|motion|media|narration|final) y serve-review.ts"
  - "enlace de revisión Tailscale (HTTP 200/206) con los 6 MP4 y .plans/serie-sabias-que/orchestration/ con DAG, overlay, bootstrap, ancla y runbook"
budget: "8 sesiones; un worker mutable a la vez; TTS ElevenLabs y fal.ai SOLO después de G-ai-spend resuelto por el operador, con tope explícito; prohibido publicar en redes sin G-publish resuelto. Presupuesto agotado => blocked/budget-limited, nunca completed."
---

# G-001 · Serie "SABÍAS QUE… TABÚ"

## Description
Producir una serie de seis videos verticales **full-motion** (sin cara, sin footage de terceros) sobre
temas tabú y curiosidades virales, con formato "sabías que". Cada video es motion graphics dirigido
(kinetic type + data-viz) más B-roll generado solo donde aporta, narración TTS en español y una
identidad de serie única. El objetivo de la entrega es dejar los seis MP4 **listos para publicar**:
renderizados, verificados, con su portada, copy y hashtags, y accesibles por un enlace de revisión
Tailscale. La publicación social real NO es parte de este goal (queda detrás de `G-publish`).

## End State
Seis MP4 verticales reproducibles (1080×1920, 30 fps, H.264/AAC, 45–60 s) en
`projects/serie-sabias-que/<slug>/renders/<slug>.mp4`, cada uno con QA verde (`vm qa` exit 0),
`facts.json` con fuentes reales, paquete de publicación completo y un enlace Tailscale servido con
HTTP 200/206 desde `0.0.0.0:7099`.

## Deliverables
Ver frontmatter. Además el detalle creativo de los 6 videos vive en `series.md`.

## Definition of Done
1. `bun projects/serie-sabias-que/scripts/verify-series.ts --stage final` exit 0 (chequea los 6).
2. `bun run vm -- qa --project projects/serie-sabias-que/<slug>` exit 0 para los seis slugs.
3. `ss -tlnp | grep 7099` muestra bind `0.0.0.0:7099`; `curl -sI http://$(tailscale ip -4):7099/` en 200/206.
4. `facts.json` de cada video: cada afirmación con `sourceUrl` http(s) y `dateAccessed`.
5. Cero datos inventados, cero enlaces localhost al usuario, cero publicación social sin gate.

## Constraints / Must Not Change
No Docker, migraciones, contenedores ni infraestructura nueva. No tocar `presets/*` ni proyectos
existentes (`rafelito-*`, `jh-*`, `pepe-*`, `_yt`). No secreto en logs, manifests ni capturas. No
presentar media sintética como real (activo `discloseSyntheticMediaWhenPresent`). No publicar. No
importar del monorepo `elena`.

## Non-Goals
Publicación a Zernio/redes; monetización; uso de material de terceros; doblaje multi-idioma.

## Budget
8 sesiones; un worker mutable. TTS/fal solo con `G-ai-spend`. Agotado => `add-note` + `release` +
goal `blocked`/`budget-limited`, nunca `completed`.
