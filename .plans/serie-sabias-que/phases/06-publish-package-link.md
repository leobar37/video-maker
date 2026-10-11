---
id: P-006
title: Paquete de publicación por video y enlace Tailscale de los seis MP4
status: completed
phase_type: integration
description: Escribir el paquete de publicación de cada video (title/description/hashtags/disclosure), construir la página de revisión y servirla por Tailscale con los seis MP4. Sin publicar en redes.
end_state: "Existen publication/<slug>.draft.json (title, description, hashtags <=5, discloseSyntheticMedia) por los seis, una página de revisión y serve-review.ts; el servidor escucha en 0.0.0.0:7099 ('ss -tlnp | grep 7099'), 'curl -sI http://<tailscale-ipv4>:7099/' da HTTP 200/206 y la página lista los seis MP4; 'bun projects/serie-sabias-que/scripts/verify-series.ts --stage final' sale exit 0 y ningún enlace compartido es localhost."
verification: "cd /home/leobar37/code/video-maker && bun projects/serie-sabias-que/scripts/verify-series.ts --stage final && ss -tlnp | grep 7099 && curl -sI \"http://$(tailscale ip -4):7099/\" | head -1"
deliverables:
  - "publication/<slug>.draft.json por los seis slugs"
  - "projects/serie-sabias-que/serve-review.ts + página de revisión con los 6 MP4"
  - "enlace Tailscale verificado (0.0.0.0:7099, HTTP 200/206) y evidencia en qa/ o evidence/"
entry_criteria: "P-005 aceptada; los seis MP4 y sus portadas existen."
dependencies: ["P-005"]
requirements: ["FR-013", "FR-014"]
subagent: "worker (mimo-v2.6-flash)"
---

# P-006 · Paquete de publicación y enlace

## Contexto
La entrega del goal es "listos para publicar", **no** publicado. La publicación real usa el flujo
`creator-*`/`publish` con preset y aprobación del operador (`G-publish`), fuera de este plan.

## Objetivo
1. Escribir `publication/<slug>.draft.json` con title, description, hashtags ≤5 (de `series.md`) y
   `discloseSyntheticMedia: true` cuando el slug sea `generated:true`.
2. Crear `serve-review.ts` (servidor local, bind `0.0.0.0:7099`) y la página de revisión que lista y
   reproduce los seis MP4 con su portada. Preferir `vm dashboard` si ya sirve proyectos `video.json`;
   si no, usar el servidor propio (verificado).
3. Verificar bind y HTTP; usar **`http://<tailscale-ipv4>:7099/`**, nunca localhost.

## Preservar
No publicar ni subir media a redes. No exponer puertos públicos/Funnel. No cambiar los MP4 ni sus hashes.
Si Tailscale no corre, decirlo explícitamente y dar el comando; no caer a loopback.

## Resultado verificable por fase
`verify-series.ts --stage final` exit 0 + `ss` con 0.0.0.0:7099 + `curl -sI` en 200/206.

## Reporte final esperado
El comando exacto levantado, la IPv4 Tailscale, la URL final, qué contiene la página y confirmación de que
no hay publicación social. Comandos + exits.
