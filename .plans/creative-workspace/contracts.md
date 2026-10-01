# Contrato de ejecución · creative-workspace

Este documento es normativo para las seis fases. La implementación puede elegir algoritmos internos, no cambiar estas fronteras. Enmiendas requieren nota en climier y decisión del operador; no se permite reinterpretar el objetivo durante la ejecución.

## 1. Objetivo y decisiones congeladas

La CLI administra identidad, recursos, outputs, revisiones y recuperación; el agente produce libremente. Un proyecto es un espacio independiente de sus clientes. Un asset es una carpeta abierta de trabajo con entregables declarados, no un ID que oculte sus fuentes.

- Un proyecto puede relacionar cero o varios clientes; un cliente participa en varios proyectos. Los assets pueden usar varios presets exactos, incluso de marcas distintas.
- El preset orienta: identidad, logo original, colores, fuentes, referencias, reglas y tono. No impone una plantilla, composición ni renderer.
- El agente puede escribir HTML/CSS/SVG, scripts, proyectos Remotion y otros archivos directamente; snapshot debe funcionar aunque nunca se haya ejecutado un comando render de la CLI.
- Primero se versionan outputs exactos; se conservan las fuentes e inputs que permiten continuar trabajando. Restaurar NO vuelve a generar ni ejecutar código.
- No crear un sistema cerrado de templates, `post-renderer`, catálogo de layouts obligatorios, editor visual, HTML por cliente ni base de datos nueva.
- Preservar todos los verbos y contratos existentes de video, clips, persistencia y social. Nuevos objetos no sustituyen `video.json` ni `videos.json`.

## 2. Fronteras de paquetes y propiedad

`packages/schemas/src/studio.ts`: schemas y tipos persistidos independientes; exportados desde su index actual. No importa core, providers, studio ni CLI.

Nuevo `packages/studio`: servicios file-based, snapshots, catálogo y sincronización. Depende de schemas y de las primitivas core; storage se inyecta mediante el port de este contrato. No importa CLI, dashboard ni motion. No modifica el significado del hash/bundle legacy.

`packages/providers/src/storage/`: adapter R2 para el nuevo port, aprovechando el cliente existente. No sustituye `ObjectStore` ni cambia el comando `archive` legacy, que selecciona solo medios.

`packages/cli/src/specs/studio.ts`: adaptadores declarativos de servicios. El registro existente y su runtime se mantienen como fuente de verdad. `packages/dashboard`: UNA aplicación consumidora del catálogo/URLs; no contiene lógica duplicada de snapshots, R2 o render.

Propiedad: P-001 schemas y contratos; P-002 studio local; P-003 dispatcher/CLI; P-004 transporte/R2; P-005 dashboard; P-006 integración/adopción. El coordinador es dueño de integrar cambios compartidos y del lockfile. Un worker mutable a la vez por defecto. Cualquier paralelización exige comprobar que no coinciden archivos; no usar varios workers escribiendo index, registry o lockfile.

## 3. Modelo persistido v1

Todo JSON de dominio lleva `schemaVersion: 1`. IDs de entidades: kebab-case validado, no rutas; revisionId: identificador único por asset, generado localmente sin contador remoto. `r001` puede ser una etiqueta, no la identidad global.

- Client: `id`, `name`, referencias opcionales a presets y metadatos no secretos. No posee físicamente proyectos.
- PresetVersion: `presetId`, `versionId`, `clientId`, `name`, identidad opcional (paleta, fuentes, tono, reglas), referencias de recursos por ruta/hash y referencias visuales. Snapshot inmutable; cambiar logo o colores crea otra versión. `clientId` debe existir.
- CreativeProject: `id`, `name`, `clientIds: string[]`. Un array vacío es válido.
- CreativeAsset: `id`, `projectId`, `kind: image | video | svg | other`, `title`, `presetRefs: { presetId, versionId }[]`, `sources: string[]`, `inputs: string[]`, `outputs: OutputSpec[]`, `recipe?: Recipe`. Las rutas son relativas al directorio del asset. `sources` e `inputs` pueden ser directorios; outputs son archivos individuales.
- OutputSpec: `name`, `path`, `mediaType`, `role: deliverable | preview | thumbnail`, `visibility: private | public`. Nombre único por asset; privado por defecto. No deducir publicación de una aprobación editorial.
- Recipe: `argv: string[]`, `cwd: string`, `outputs: string[]`, `toolchain?: { versions?: Record<string,string>, repoCommit?: string, lockfile?: string }`. argv no es una línea para `sh -c`; cwd y outputs se validan dentro del asset. Es opcional; ejecutar requiere acción explícita.
- SnapshotFile: `path`, `sha256`, `bytes`, `mediaType`, `role: source | input | output | metadata | preset`. Paths relativos al snapshot portable; sin symlinks, secretos, URLs firmadas ni rutas absolutas.
- RevisionManifest: `projectId`, `assetId`, `revisionId`, `parentRevisionId?`, `createdAt`, `note`, `editorialStatus: draft | approved | rejected`, `projectSnapshot`, `clientSnapshots`, `assetSnapshot`, `presetSnapshots` (versiones exactas con recursos), `recipeSnapshot?`, `files: SnapshotFile[]`, `outputs` (referencias a archivos dentro de files), `rootHash`. Metadata de proyecto/clientes y snapshot de asset.json/presets incluidos; nunca referencia mutable a latest.
- SyncReceipt: fuera del manifest, `revisionId`, `rootHash`, `manifestKey`, `manifestSha256`, estado derivado `local | syncing | confirmed | failed`, objetos confirmados y error redactado opcional. Un boolean `backup: true` en el asset no prueba nada.
- ProjectCheckpoint: mapa inmutable assetId → revisionId/rootHash. No duplica archivos. Se sincroniza con el mismo protocolo y nunca apunta a una revisión inexistente.

El hash del contenido sellado usa JSON canónico definido y probado en P-001: payload `schemaVersion, projectSnapshot, clientSnapshots, assetSnapshot, presetSnapshots, recipeSnapshot, files, outputs`; files ordenados por path, claves de objetos ordenadas recursivamente, arrays semánticos conservan orden. No incluir revisionId, createdAt, note, estado editorial, parentRevisionId ni rootHash en el cálculo. Hashes SHA-256 de los bytes, no ETags. Dos snapshots del mismo contenido producen el mismo rootHash aunque sus IDs difieran. Presets incluyen datos y recursos para restaurarse sin registry. La recuperación de múltiples revisiones conserva cada snapshot de metadata; metadata activa se selecciona por checkpoint explícito o revisión solicitada, nunca según orden de listado.

## 4. Layout abierto y selección de archivos

```text
workspace/
  clients/<clientId>/client.json
  presets/<presetId>/versions/<versionId>/preset.json
  presets/<presetId>/versions/<versionId>/resources/...
  projects/<projectId>/project.json
  projects/<projectId>/assets/<assetId>/asset.json
  projects/<projectId>/assets/<assetId>/workroom/...  # convención, no requisito
  projects/<projectId>/assets/<assetId>/outputs/...
  revisions/<projectId>/<assetId>/<revisionId>/manifest.json
  revisions/<projectId>/<assetId>/<revisionId>/files/...
  checkpoints/<projectId>/<checkpointId>.json
  .vm/receipts/...
  .vm/locks/...
  .vm/cache/...
```

`--workspace` configura esta raíz y existe en todos los grupos nuevos. Puede apuntar a una carpeta temporal; no escanear todo el repo implícitamente. Recipe cwd `.` y archivos fuera de workroom son válidos si pertenecen al asset.

Snapshot selecciona asset.json + sources + inputs + outputs declarados + presets exactos y sus recursos; fuentes compartidas se referencian y empaquetan por hash, no se copian a mano en cada iteración. No respaldar todo el repo cada vez ni solo PNG/MP4. Incluir HTML, SVG, CSS, fuentes con permiso, package.json y lockfiles propios de proyectos Remotion. La política legacy que excluye lockfiles NO se traslada al dominio nuevo.

Rechazar traversal, paths absolutos, symlinks, archivos especiales, cambios de bytes durante el sellado y targets dentro del árbol de origen. Deduplicar archivos declarados varias veces. Excluir dependencias/caches regenerables (`node_modules`, `.git`, `.vm`); rechazar explícitamente selección de secretos (`.env*`, llaves privadas, cookies/tokens/credenciales conocidas), sin omisión silenciosa. Mantener política documentada, acotada y con tests; un filename sospechoso no es una auditoría exhaustiva de contenido. No ejecutar scripts importados.

Editar un asset o un preset latest no cambia revisiones selladas. Crear revisión en staging, verificar hashes y publicar atómicamente; un lock por asset evita doble escritura. Los objetos locales sellados son append-only. Restaurar en destino vacío o demostrar que los archivos existentes coinciden; conflicto => error, nunca overwrite silencioso ni `--force` destructivo en MVP.

## 5. API de servicios

Estos nombres son contrato público del nuevo paquete; tipos detallados se derivan de schemas sin inventar otra representación:

```ts
interface StudioContext { workspaceDir: string; clock: () => Date; newId: () => string }
interface RevisionRef { projectId: string; assetId: string; revisionId: string }
interface ObjectMeta { key: string; bytes: number; sha256: string; etag?: string }
interface StudioStorage {
  head(key: string): Promise<ObjectMeta | null>;
  putImmutable(key: string, bytes: Uint8Array, mediaType: string): Promise<ObjectMeta>;
  get(key: string): Promise<Uint8Array>;
  list(prefix: string, cursor?: string): Promise<{ keys: string[]; nextCursor?: string }>;
}
```

Services con context primero y argumentos tipados: `createClient`, `listClients`, `getClient`; `createPresetVersion`, `listPresetVersions`, `getPresetVersion`; `createCreativeProject`, `listCreativeProjects`, `getCreativeProject`; `createCreativeAsset`, `inspectCreativeAsset`; `snapshotAsset`, `listAssetRevisions`, `getRevisionManifest`, `diffAssetRevisions`, `restoreAssetRevision`; `createProjectCheckpoint`; `syncProject`, `verifyProjectBackup`, `recoverProjectFromStorage`; `buildStudioCatalog`.

Firmas de las operaciones críticas (los nombres de los tipos se fijan en P-001):
```ts
snapshotAsset(ctx: StudioContext, input: { projectId: string; assetId: string; note: string }): Promise<{ revision: RevisionManifest; manifestPath: string }>;
restoreAssetRevision(ctx: StudioContext, input: RevisionRef & { outDir: string }): Promise<{ restored: SnapshotFile[]; outDir: string }>;
syncProject(ctx: StudioContext, input: { projectId: string; storage: StudioStorage }): Promise<{ receipts: SyncReceipt[] }>;
verifyProjectBackup(ctx: StudioContext, input: { projectId: string; storage: StudioStorage; deep: boolean }): Promise<{ verified: RevisionRef[]; failures: StudioError[] }>;
recoverProjectFromStorage(ctx: StudioContext, input: { projectId: string; storage: StudioStorage; outDir: string; revisionRefs?: RevisionRef[]; checkpointId?: string }): Promise<{ restored: RevisionRef[]; outDir: string }>;
buildStudioCatalog(ctx: StudioContext, filter?: { clientId?: string; projectId?: string; assetId?: string; kind?: string }): Promise<StudioCatalog>;
```
`StudioCatalog` lleva `schemaVersion: 1` y `entries` con proyecto, clientes, asset, revisionId/rootHash, presets exactos, outputs (nombre/tipo/role/ruta lógica de servicio), estados separados y errores. `StudioError` tiene code/message/details sin secretos. P-001 implementa los schemas y tipos exportados de estas entradas antes de que CLI/UI consuman datos. `verifyProjectBackup` reporta failures y su adaptador CLI retorna exit 1 si no está vacío.

- snapshot devuelve `{ revision: RevisionManifest, manifestPath: string }`, sin llamadas a red ni render.
- inspect devuelve directorio real, fuentes, inputs, preset resuelto exacto, outputs existentes/faltantes, recipe explícita, historial y estado de sync. Nunca solo ID/URL.
- restore devuelve rutas restauradas y hashes comprobados. recover recibe projectId y destino vacío; reconstruye registry mínimo de proyecto/clientes/assets/revisiones/presets desde manifests remotos, sin índice ni archivos locales anteriores. Selección activa por checkpoint/revisionRefs explícito; si no se indica, solo elegir cabeza única por asset según parentRevisionId, nunca orden/timestamp de listado. Ramas con varias cabezas => CONFLICT y solicitar selector, preservando todas las revisiones.
- diff devuelve conjuntos de archivos añadidos/eliminados/modificados, outputs/presets/recipe modificados. No necesita IA ni comparación semántica de píxeles.
- sync/verify reciben StudioStorage inyectado; list paginada hasta fin. Todos los errores públicos incluyen código estable, mensaje y detalles redactados.
- catálogo distingue revisión, editorialStatus, producción (outputs comprobados/faltantes) y respaldo (receipt verificable). Campos de URLs de servicio pueden ser efímeros; NO se escriben dentro del manifest.

Códigos públicos: `INVALID_INPUT`, `NOT_FOUND`, `PATH_UNSAFE`, `SECRET_PATH`, `OUTPUT_MISSING`, `HASH_MISMATCH`, `CONFLICT`, `STORAGE_UNAVAILABLE`, `AUTH_REQUIRED`, `RECIPE_FAILED`. CLI: 0 éxito, 2 input/uso, 1 fallo operativo. Failures no dan objetos partial con estado confirmado.

## 6. CLI pública y compatibilidad

Nuevos grupos se normalizan ANTES de resolver el registro: pareja exacta `client create` → verbo interno `client-create`, etc. Lista blanca de parejas; no concatenar cualquier segundo token. Solo modificar splitInvocation/runtime mínimo necesario, preservando verbos legacy, sus flags y mensajes. En help se muestran las parejas, no se reemplaza `CommandSpec`. Evitar que valores de flags se consuman como subcomandos.

Superficie MVP, siempre con `--workspace <dir>` y `--json` en consultas:

```text
client create <id> --name <text>          client list / show <id>
preset create <id> --client <id> --file <json>   preset list / show <id> --version <id>
project create <id> --name <text> --clients <csv>
project list / show <id>
asset create <id> --project <id> --kind <kind> [--presets <preset@version,csv>]
asset inspect <id> --project <id>
asset snapshot <id> --project <id> --note <text>
asset history <id> --project <id>
asset diff <id> --project <id> --from <revision> --to <revision>
asset restore <id> --project <id> --revision <id> --out <empty-dir>
asset render <id> --project <id> --plan     # wrapper opcional: muestra argv/cwd/outputs
asset render <id> --project <id> --execute  # opt-in inequívoco; nunca en snapshot/restore
project checkpoint <id> --revisions <asset@revision,csv>
sync push --project <id>                  sync verify --project <id> [--deep]
sync recover --project <id> --out <empty-dir> [--checkpoint <id> | --revisions <asset@revision,csv>]
dashboard serve [--host <host>] [--port <n>] [--access trusted-tailnet]
dashboard url [--client <id>] [--project <id>]
```

La forma positional se adapta al parser existente mediante specs declarativas, sin reconstruir la CLI completa. P-003 define tests exactos de aridad y aliases; `preset create` asigna nueva versión siempre, nunca edita la anterior. create permite asset sin outputs; el agente edita asset.json para declarar paths; snapshot exige al menos un output existente y valida su firma/tipo cuando sea verificable. No crear comandos import/update/migrate extra en MVP: adopción mediante archivos y servicios existentes.

`--plan` y `--dry-run` siguen siendo globales: ninguna mutación, red, secretos, bind de servidor ni proceso hijo. JSON = `{ schemaVersion: 1, ok: true, data }`; errores JSON = `{ schemaVersion: 1, ok: false, error: { code, message, details? } }`. stdout JSON sin logs; diagnóstico a stderr. R2 se resuelve lazy, exclusivamente al ejecutar sync real. Ninguna generación pagada automática ni publicación en redes.

## 7. R2: protocolo, idempotencia y recuperación

Reutilizar configuración env-first existente sin exponer valores. Bucket privado `video-maker-archive-prd`: todos los archivos y manifests. Bucket público `video-maker-media-prd`: SOLO entregables opt-in `visibility: public`; nunca fuentes, presets, recursos privados ni scripts. Editorial approved NO equivale a permiso público. El gate live debe aprobar también cualquier exposición pública; fixture live completamente privado.

```text
private: objects/<sha-prefix>/<sha>  # archivo completo, incluido HTML/JSON/SVG/fuentes
private: studio/v1/projects/<project>/assets/<asset>/revisions/<revision>/manifest.json
private: studio/v1/projects/<project>/checkpoints/<checkpoint>.json
public:  objects/<sha-prefix>/<sha>  # copia explícita de outputs autorizados
```

1. Congelar snapshot local. 2. HEAD/validar y subir objetos que faltan. 3. Confirmar tamaños y SHA-256; metadatos comprobados, deep implica GET+hash. 4. Escribir manifest privado como punto de commit, condición de creación/inmutabilidad verificada con API real, no GET seguido de PUT sin protección contra carreras. 5. Escribir receipt confirmed solo tras confirmar manifest y todos sus objetos. 6. Reconstruir índices desde manifests completos.

Misma key con bytes distintos => CONFLICT. Reintentar upload no repite generación ni cambia revisión; objetos huérfanos de un fallo previo son tolerables, nunca evidence de backup completo. No agregar delete/GC. Si el endpoint no admite la condición necesaria, escalar incompatibilidad al coordinador y operador; no simular atomicidad con ETags locales. No afirmar transacción multiobjeto de R2.

Los índices son caches reconstruibles, no autoridad. Evitar read-modify-write remoto de índice global en MVP; listar manifests por prefix y cursores, verificar integridad y validar IDs antes de recuperar. Revisión remota inválida/incompleta debe ser diagnosticada, nunca renderizada como confirmada. Presets snapshot viajan con revisión; recuperar no depende de registry previo. URLs firmadas solo en respuestas temporales, redacciones en logs, nunca persistidas ni consideradas assetId.

## 8. Dashboard consumidor, no motor creativo

Una app read-only. HTTP: `GET /api/catalog?client=&project=&asset=&kind=`; `GET /api/assets/:project/:asset`; `GET /api/revisions/:project/:asset/:revision`; `GET /api/diff/:project/:asset?from=&to=`; `GET /api/files/:project/:asset/:revision/:outputName`; `GET /health`.

Las URLs de archivos se resuelven mediante manifest validado y nombre de output; no rutas arbitrarias ni proxy de URLs suministradas por usuario. En local servir copias selladas, no latest mutable; en remoto resolver objetos privados con storage servidor o URLs firmadas cortas sin persistencia. UI muestra outputs exactos, thumbnails si existen, filtros, selección feed/story por nombres declarados, descarga, comparación de revisiones y estado editorial/backup independiente. Video usa controles nativos; otros formatos tienen fallback de descarga. HTML/JS arbitrario nunca se ejecuta/inyecta; SVG original descargable como attachment, preview raster opcional. Metadatos escapados, CSP restrictiva y control de content-type.

No hay botones mutadores en MVP. No dashboard por cliente ni interpretar fuentes Remotion para mostrar un MP4. Puede existir thumbnail ausente y UI debe explicarlo sin generar con IA.

Servidor no inicia por plan ni por snapshot. Default bind interno; exposición en todas las interfaces solo con `--access trusted-tailnet` explícito y advertencia de modelo de acceso. No es apto para Internet abierto ni reemplaza auth multiusuario. Compartir solo Tailscale IPv4, verificar listener all-interface antes; si tailscaled no funciona, avisar y no dar URL loopback. Lanzar servicios durante implementación requiere aprobación explícita.

## 9. Pruebas de cierre obligatorias

- Imagen HTML/SVG con dos revisiones y logo cambiado: r1/preset viejo/outputs originales conservan hashes; no render implícito.
- Video: asset contiene proyecto Remotion editable y MP4/cover existente; snapshot + restore exactos sin ejecutar Remotion. Test offline puede usar un MP4 fixture mínimo, no render pesado o IA.
- Un proyecto con dos clientes, asset con dos presets; proyecto sin cliente válido.
- Sync falso: caída tras subir objetos y antes de manifest => no confirmed; retry deduplica; paginación; conflictos; GET alterado => HASH_MISMATCH; índice borrado reconstruible.
- Restauración real R2 en directorio nuevo SIN registry/cache/manifest local: outputs, fuentes, inputs y presets exactos por SHA-256. G-live resuelto antes.
- Dashboard mismo catálogo para imagen, SVG y video; mobile/desktop, descargas y comparación r1/r2. Browser Flash para evidencia visual.
- Compatibilidad: tests splitInvocation/registry y comandos existentes siguen pasando; build global exit 0 (baseline comprobado al preparar este plan).

## 10. Stop conditions

Dudas de API pública, permisos, cambio de dominio, arquitectura distinta, R2 condicional no soportado, fallo ajeno o presupuesto agotado => nota de bloqueo y devolver control; no inventar contratos ni expandir investigación. Un agente nunca resuelve gates humanos, acepta su task, marca respaldo completo sin evidencia ni crea commits/merge/deploy sin permiso.
