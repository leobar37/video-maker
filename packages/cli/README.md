# `@videomaker/cli` — `vm`, the production CLI (declarative, FR-013)

Commands are **data**: every verb is a `CommandSpec` (args schema, `plan()`,
`run()`, declared `writes`, declared `movesGates`) living in a registry. The
runtime (`src/runtime.ts`) interprets specs; adding a command means adding a
spec — never a new script.

```
bun packages/cli/src/main.ts <verbo> [<proyecto>] [operandos] [flags]
# o: bun run vm -- <verbo> …
# ejemplos posicionales:
#   vm qa projects/demo/hello
#   vm publish projects/demo/hello --dry-run
```

## Verb registry

| verb | spec file | writes | gates moved |
| --- | --- | --- | --- |
| `new` | `src/specs/inspect.ts` | `video.json`, `script/narration.md`, `script/ scenes/ remotion/ qa/ renders/ assets/` | — |
| `preflight` | `src/specs/inspect.ts` | — | — |
| `status` | `src/specs/inspect.ts` | — | — |
| `find` | `src/specs/inspect.ts` | — | — |
| `catalog` | `src/specs/inspect.ts` | `videos.json` (índice) | — |
| `plan` | `src/specs/inspect.ts` | — | — |
| `scene-brief` | `src/specs/scene.ts` | `scenes/<sceneId>.brief.json` | — |
| `scene-log` | `src/specs/scene.ts` | `scenes/<sceneId>.delegation.json` | — |
| `scene-verify` | `src/specs/scene.ts` | — | — |
| `gen-audio` | `src/specs/media.ts` | `script/audio/narration.wav`, `script/audio/narration.json`, `qa/spend.json` | `assets`, `spend` |
| `gen-music` | `src/specs/media.ts` | `script/audio/music.*`, `qa/spend.json` | `assets`, `spend` |
| `gen-media` | `src/specs/media.ts` | `scenes/<id>/media/*`, `qa/spend.json` | `assets`, `spend` |
| `still` | `src/specs/media.ts` | `qa/stills/*.png` | — |
| `assemble` | `src/specs/media.ts` | `renders/*.mp4`, `public/media/*`, `qa/report.json`, `qa/loudness.json` | `render`, `qa` |
| `qa` | `src/specs/media.ts` | `qa/report.json`, `qa/loudness.json` | `qa` |
| `publish` | `src/specs/media.ts` | `qa/publication/<attempt>/journal.json` | `publish` |
| `bundle` | `src/specs/persist.ts` | `<out>/MANIFEST.json` + copias de archivos | — |
| `hydrate` | `src/specs/persist.ts` | archivos restaurados en `--project` | — |
| `archive` | `src/specs/persist.ts` | `qa/archive.json` (provenance) | — |
| `version` | `src/all-specs.ts` (spec inline) | — | — |

Cada comando con alcance de proyecto declara `--project <dir>` (default `.`);
las rutas de artefactos se resuelven con `resolveInsideProject`/`projectPaths`
de `@videomaker/core` (anti-traversal). Los argumentos admiten **ambas formas**:
flag (`--project projects/demo/hello`) o posicional, en cuyo caso los valores
se asignan **en orden de declaración** (convención `project`-first en todos los
specs; los booleanos son solo flag). Si un flag ya reclamó su slot, el
posicional pasa al siguiente argumento sin asignar (el flag gana su slot); los
argumentos requeridos sin default se validan después de aplicar flags,
posicionales y defaults. `vm --help` lista el registro; `vm <verbo> --help`
muestra los argumentos declarados.

## Modo plan (`--plan` / `--dry-run`)

- Son flags **globales del runtime**, no argumentos de spec.
- El runtime llama **solo** a `plan(ctx)` e imprime `PlanStep[]`
  (`acción | target | writes | gate | cost`). `run()` **nunca** se ejecuta.
- `plan()` es puro: **sin red y sin resolución de credenciales** (NFR-002).
  Los comandos que gastan (`paid: true`) deben declarar `supportsPlan: true`.
- `run()` recibe `mode: 'run'` y debe rechazar ejecutar si recibiera `'plan'`.
- Los pasos con `costUsd` son estimaciones de operaciones pagas (p. ej.
  presupuesto `falVideo.budgetUsd`); nada se cobra en modo plan.

## Códigos de salida

| code | significado |
| --- | --- |
| `0` | ok |
| `1` | fallo del comando (`ctx.fail`, evidencia inválida, artefacto faltante) |
| `2` | error de uso: verbo desconocido, flag desconocido, argumento requerido faltante |

## Contrato de delegación de escenas (FR-014)

```
scene-brief → [ejecución EXTERNA del agente] → scene-log → scene-verify
```

1. **`vm scene-brief <proyecto> <sceneId>`** (o `vm scene-brief --scene <id>
   --project <dir>`) escribe `scenes/<id>.brief.json`
   (`SceneBrief`, `@videomaker/schemas`): dossier curado (intent, narración,
   duración, branding del preset, vecinos, `outputPath`/`stillPath`
   project-relative, `contextFiles` 3-4 archivos). El registro de agentes
   (`remotion-scene-designer`, `playbook-writer`, `creator-scene-producer`,
   `scene-critic`) decide rutas y contexto según `source`. **Este CLI nunca
   ejecuta la escena**: la delegación la hace el orquestador afuera.
2. **`vm scene-log record …`** añade (append-only) la entrada
   `SceneDelegation` al journal `scenes/<id>.delegation.json`:
   `startedAt`/`endedAt`, `agentId`, `historyRef`, `outcome`
   (`running|ok|fail|waiting-human`) y `briefDigest` = sha256 de los bytes del
   brief — la entrada queda atada al brief exacto que vio el ejecutor. Sin
   entrada no hubo delegación válida. `vm scene-log list` la consulta.
3. **`vm scene-verify --scene <id>`** verifica el `SceneResult`
   (`scenes/<id>.result.json`) de forma **independiente** contra disco:
   esquema versionado consistente (`executionStatus`/`editorialVerdict`),
   `outputPath`/`stillPath` idénticos a los del brief, rutas seguras dentro del
   proyecto, archivos existentes y **sha256 reales coincidentes** (también en
   `artifacts[]`). Cualquier discrepancia sale con exit ≠ 0; el verificador
   nunca muta el resultado.

## Gates y estado (FR-009 / FR-010)

- **No existe ningún archivo de estado editable.** Los gates (`storyboard`,
  `spend`, `assets`, `render`, `qa`, `signoff`, `publish`) se **derivan** de los
  artefactos en disco con `deriveGates` (`@videomaker/core`): borrar un
  artefacto devuelve el gate a `pending` y forjar un archivo de estado no
  otorga nada. `vm status` los reporta (`--check <gate>` → exit 1 si sigue
  pendiente).
- `vm catalog --root <dir>` escanea los `video.json` bajo la raíz y escribe el
  índice `videos.json` (contrato `VideoCatalog`); `vm find` lo consulta con
  filtros combinables: texto (id+title), `--tag`, `--product`, `--status
  (draft|published)` y `--missing bundle` (entradas sin evidencia de bundle:
  `qa/archive.json` o `bundles/<name>/MANIFEST.json`).
- `vm plan` agrega offline lo que haría el pipeline: un `PlanStep` por gate
  pendiente (incluidos los artefactos faltantes por escena, con `costUsd`
  cuando la escena es de generación paga).

## Demo y tests

```
bun packages/cli/scripts/demo-dry.ts   # demo offline: new → preflight → status
                                       # → plan → assemble --dry-run → bundle +
                                       # hydrate con verificación de hashes
bun test packages/cli                 # tests del paquete (offline, temp dirs)
```
