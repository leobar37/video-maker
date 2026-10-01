---
id: G-001
title: Taller creativo agente-first versionado por CLI y recuperable desde R2
status: completed
end_state: "Tests offline y live pasan con exit 0: imagen y proyecto Remotion conservan dos revisiones exactas, recuperables en carpeta vacía, y un dashboard común muestra sus outputs."
verification: "bun run studio:verify && bun run studio:verify:r2 && bun run build; todos exit 0; evidence/creative-workspace contiene comprobación visual y reporte SHA-256 de restore remoto."
deliverables: ["Schemas studio v1", "Servicios file-based y CLI por grupos", "Sync y recover R2 completos", "Dashboard único read-only", "Verificadores offline/live y evidencia SHA/visual"]
budget: "1200 turnos totales de workers (operador autorizó 800 tras 213 turnos y 1200 tras 761); 8 horas por sesión; máximo un worker mutable simultáneo; límite no implica completed."
---

# G-001 · Taller creativo agente-first

## Description
Evolucionar video-maker para administrar clientes/presets, proyectos independientes y assets abiertos. La CLI registra versiones de outputs y conserva sus fuentes, R2 guarda snapshots completos y un dashboard único consume datos/URLs. El agente sigue libre de usar HTML/SVG, Remotion, scripts u otras herramientas sin pasar por un renderer obligatorio.

## End State
Un ejemplo de imagen y otro de video/proyecto Remotion, cada uno con dos revisiones, se inspeccionan y comparan desde CLI y dashboard. Cambiar logo/latest no altera r1. Ambas revisiones se recuperan con hashes idénticos en destino vacío desde R2, sin archivos o índice local del origen y sin volver a renderizar.

## Deliverables
Schemas v1; paquete studio file-based; CLI declarativa por grupos compatible; adapter R2 y protocolo de commit; dashboard read-only común; fixtures/adopción BFC y Remotion; verificadores offline/live y evidencia redactada.

## Definition of Done
1. `bun run studio:verify` (se crea en P-006) exit 0. Ejecuta suites de schemas, paths/snapshot/restore, CLI/dry-run/compatibilidad, storage con fallos/paginación y catálogo/HTTP seguro. Incluye fixture imagen/SVG y proyecto Remotion+MP4, dos revisiones y prueba sin invocar renderer.
2. `bun run studio:verify:r2` exit 0 SOLO con G-cw-live-r2 resuelto. Usa namespace único en bucket privado, sube fixture pequeño, elimina dependencia de registry/cache local al recuperar en directorio nuevo, verifica fuentes/inputs/presets/outputs por SHA, reintenta sin duplicar upload y prueba reconstrucción de catálogo. No generación ni publicación. Si no hay permiso, goal queda blocked; tests fake no se reportan como live.
3. `bun run build` exit 0. Tests legacy de parser/runtime/registry y persistencia relevantes sin regresión.
4. Evidencia visual de dashboard en escritorio y móvil: filtros, r1/r2, formatos declarados, imagen/video y descargas. Flash verifica imágenes; GLM no finge capacidad visual. Arrancar servicios/exponerlos solo con autorización correspondiente.
5. `evidence/creative-workspace/validation.json` y capturas con resultado, comandos y exits, revisiones/rootHashes, prueba remote-only y límites. Nunca secretos, signed URLs ni estado “confirmed” inventado.
6. Las seis tasks tienen submit con evidencia y accept tras reproducción por coordinador. Goal y fases completed solo cuando estas condiciones se satisfacen.

## Constraints / Must Not Change
`contracts.md` es contrato normativo; requirements.md define alcance. No templates obligatorios; snapshot no renderiza; proyecto no pertenece a un solo cliente. No cambiar comandos/video.json/catalog legacy, trabajos originales BFC, credenciales ni buckets existentes. No DB, Docker, infraestructura, IA pagada ni publicación.

## Gates y presupuesto
G-cw-implement autoriza comenzar implementación y pruebas locales, NO R2 live ni exposición pública. G-cw-live-r2 requiere autorización explícita del operador para requests y uploads limitados en bucket privado; fixtures <= 20 MiB, sin borrado, IA ni outputs públicos. Registrar duración/bytes del probe; gastos de API modelos corresponden a la sesión lanzada explícitamente por el operador. Cumplir presupuesto; si se agota, registrar avances y release, no aceptar trabajo incompleto.
