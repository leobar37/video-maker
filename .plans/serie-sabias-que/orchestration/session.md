# Ancla de sesión — serie-sabias-que

<!--
  Se LEE al arrancar, al reanudar y DESPUÉS DE CADA COMPACTACIÓN.
  Es lo que sobrevive cuando el contexto se corta: no lo deduzcas del chat.
  Mantené el "estado conocido" al día al cerrar cada fase.
-->

- **iniciativa (climier):** `serie-sabias-que`
- **plan:** `.plans/serie-sabias-que/` — serie full-motion "SABÍAS QUE… TABÚ": 6 videos verticales con
  hechos verificados + paquete de publicación + enlace Tailscale. `contracts.md` normativo, `series.md` con el detalle.
- **repo:** `/home/leobar37/code/video-maker`
- **worker (herdr):** agente `orch-serie-sabias-que` en su pane (corre el plan)
- **supervisor:** sesión que vigila vía herdr
- **gates abiertos:** `G-start` (implementación local), `G-ai-spend` (gasto TTS/fal con tope). `G-publish` fuera del DAG.
- **decisiones:** `.plans/serie-sabias-que/decisions.json` + esta carpeta `orchestration/`
- **modelos:** `xiaomi-token-plan-sgp/mimo-v2.6-pro` (orquestador/P-001/P-005) · `.../mimo-v2.6-flash` (P-002/003/004/006)
- **estado conocido:** plan y DAG preparados; NADA implementado; gates sin resolver.

## Chequeo del supervisor (en su turno)

```bash
herdr agent get  orch-serie-sabias-que
herdr agent read orch-serie-sabias-que --source recent-unwrapped --lines 40
climier status --initiative serie-sabias-que --all
```

- `blocked` (diálogo) → `herdr agent send-keys orch-serie-sabias-que Enter|Escape`
- duda por el DAG (`add-note "Q: …"`) → responder `climier add-note <task> "R: …"`
- `submitted` → reproducir el acceptance → `climier accept|reject`
- `missing` → relanzar el pane (`.plans/serie-sabias-que/orchestration/launch.sh`)
