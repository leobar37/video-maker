# Requirements — extract-video-pipeline

Qué (no cómo). Los detalles de implementación viven en las fases. IDs estables: `FR-00X`.

## Funcionales

- **FR-001 — Contrato de proyecto de video.** Un proyecto es una carpeta autónoma con
  configuración declarativa (proyecto y escenas: id, intent, fuente, narración, estado,
  duración), resolución segura de rutas (sin traversal) y validación de integridad.
- **FR-002 — Resolución de credenciales.** Precedencia env → Doppler (`elena-tech`/`prd`)
  con token global; resolución lazy solo en operaciones que gastan, cache por proceso y
  redacción total de secretos en logs/metadata. Debe cubrir al menos claves de medios,
  publicación social y credenciales de object storage.
- **FR-003 — Operaciones pagadas idempotentes.** Ciclo plan → submit → status → download
  con plan digestado, receipt obligatorio, estados `uncertain/submitted/completed/reconciled`
  y tope explícito de intentos y gasto. Nunca reintentar un submit sin reconciliación.
- **FR-004 — Proveedores de medios.** Síntesis de voz con timestamps, música (proveedor
  seleccionable o biblioteca reutilizable), video image-to-video, avatar e imagen/keyframe,
  todos detrás de interfaces intercambiables.
- **FR-005 — Object storage.** Operaciones de objeto (head/put/get/inspect con checksum) y
  administración básica de buckets, con verificación de coherencia entre bucket y URL pública.
- **FR-006 — Publicación social vía Zernio (completa).** Toda la lógica Zernio del origen entra
  al producto: cuentas/health, perfiles, publicación y programación de posts con clave de
  idempotencia y deduplicación 409, status, distribution/social-track, journals recuperables
  por intento y la superficie de ads (`zernio-ads`), con outcomes
  `accepted/published/failed/uncertain`.
- **FR-007 — Motion kit.** Composición única de film con sequencer, timing continuo de
  narración (sin padding ni gaps), subtítulos, transiciones, tokens de marca configurables
  y stills calculados con exactamente los mismos boundaries que el render final.
- **FR-008 — Pipeline de render.** Bundle de composición → selección → render de video →
  mezcla con ducking → normalización de loudness/true peak, como etapas observables y
  reproducibles.
- **FR-009 — Gates de estado derivados del filesystem.** El estado del proyecto (gates tipo
  storyboard/gasto/assets/render/qa/signoff/publish) se deduce inspeccionando artefactos;
  no existe un archivo de estado editable.
- **FR-010 — Scaffolding y catálogo.** Creación idempotente de proyectos desde plantilla e
  índice de proyectos con filtros (texto/tag/estado/bundle faltante).
- **FR-011 — Evidencia y proveniencia.** Hashes (sha256) de artefactos clave, procedencia de
  insumos y resultados de QA verificables por terceros sin contexto del ejecutor.
- **FR-012 — Persistencia portable.** Empaquetado content-addressed del proyecto (sin
  artefactos regenerables), restauración verificada por hash y separación clara entre
  binarios versionables y objetos en storage.
- **FR-013 — CLI declarativa.** Los comandos son datos: cada uno se declara como spec
  (verbo, argumentos con schema, modo plan, artefactos que escribe, gates que mueve) en un
  registry declarativo que un runtime pequeño interpreta. Incorporar un comando nuevo no
  requiere crear un script nuevo.
- **FR-014 — Delegación de escenas por contrato.** El producto expone `scene-brief`,
  `scene-log` y `scene-verify` sobre el contrato `SceneBrief → SceneResult` (hashes sha256,
  executionStatus, editorialVerdict, outputPath) con rastro obligatorio y verificación
  independiente. La ejecución del sub-agente (p. ej. `remotion-scene-designer`) es externa y
  opcional: el producto garantiza el contrato, no orquesta agentes.

## No funcionales

- **NFR-001 — Seguridad de secretos.** Ningún secreto en logs, metadata, journals ni bundles;
  solo viaja en headers hacia el proveedor.
- **NFR-002 — Modo plan.** Todo comando que puede gastar soporta `--plan`/`--dry-run` sin red
  y sin resolver credenciales.
- **NFR-003 — Sin dependencia del monorepo origen.** Los paquetes no importan código del
  monorepo `elena`; lo específico del cliente es configuración/adapter.
- **NFR-004 — Testabilidad sin red.** Toda la lógica de providers/gates/paid-operation tiene
  tests con transportes fakes; los smoke reales son opt-in y separados.

## Fuera de alcance (Non-Goals)

Delegación multiagente (goals/agentes/guardian), playbooks `elena-demo` y captura `demo-app`,
QA conversacional, tooling de footage/ingesta, dashboard y workspaces multi-tenant.
