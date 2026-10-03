# Workflow de video compartido: clientes y redes

## Arquitectura y alcance

El flujo es **uno solo**, independiente de la marca y de la red social:

`ingesta → análisis → EDL → cuerpo continuo → composición → QA → aprobación → publicación → verificación`

Tres capas distintas:

| Capa | Responsabilidad | No contiene |
|---|---|---|
| Workflow `creator-*` | Inicialización, QA local, aprobación ligada a hashes, publicación y recuperación | Nombres de marcas, IDs de cuentas concretas, obligación de publicar en cuatro redes |
| Preset de cliente | Identidad, edición, audio, perfil y lista variable de destinos | Assets, timestamps, copy final, presupuestos o aprobaciones heredados |
| Reglas por destino | Límites de duración/texto/título y opciones propias de cada red | Restricciones globales que afecten a redes no seleccionadas |

[Leobar](leobar-workflow.md) es la primera configuración, **no el nombre del motor**.
[`presets/example-client.json`](../presets/example-client.json) demuestra otro cliente,
formato horizontal y un único destino Facebook; sus IDs son ficticios y deben sustituirse.

Se reutilizan los puertos y adapters existentes: credenciales lazy, R2, ZernioPublisher,
spend gate y journals. No hay otro cliente HTTP ni otro motor de publicación paralelo.
Este workflow es de **video**; no implementa un editor automático, carruseles ni una
promesa de compatibilidad con cualquier plataforma futura. Una red debe estar
soportada por el proveedor, conectada al perfil correcto y admitir la media concreta.
Las opciones especiales nuevas requieren validación explícita, no passthrough arbitrario.
El adapter de video actual valida TikTok, YouTube, LinkedIn, X (`twitter`), Facebook
e Instagram. Añadir otro cliente usa datos; añadir otra red exige habilitar/validar
su contrato en el adapter/schema y añadir pruebas, **no copiar el workflow**.

Contrato de referencia para capacidad TikTok:
[creator-info oficial de Zernio](https://docs.zernio.com/accounts/get-tiktok-creator-info.mdx).

## 1. Crear un proyecto limpio

```bash
# El preset es explícito: nunca se elige leobar por defecto.
bun run vm creator-init --preset presets/leobar.json --project projects/mi-video --id mi-video --title 'Mi video' --dry-run
bun run vm creator-init --preset presets/leobar.json --project projects/mi-video --id mi-video --title 'Mi video'

# Otro cliente; plantilla offline, todavía sin cuentas reales:
bun run vm creator-init --preset presets/example-client.json --project projects/ejemplo-cliente --id ejemplo-cliente --title 'Ejemplo de otro cliente'
```

`--dry-run` no escribe, no consulta red ni resuelve secretos. El init real rechaza un
directorio existente. Crea `creator-project.json`, una copia byte a byte
`preset.snapshot.json`, `publication/draft.json` y carpetas de producción.

Cada proyecto fija versión/hash del preset. Cambiar el archivo canónico no cambia
proyectos en curso. No hay `video.json` ficticio, TTS impuesto, publicaciones previas
ni autorización automática. No copiar `publication/` o `qa/` de otro proyecto.

## 2. Workflow editorial y técnico

### Ingesta y análisis

- Copiar los originales sin borrarlos ni recodificarlos. Registrar procedencia,
  bytes, SHA-256, duración, FPS, streams y rotación; comparar con origen si está accesible.
- Decodificar completo y transcribir todas las tomas, con timestamps/palabras.
- Revisar fotogramas de cámara y pantalla, gestos y pausas. Distinguir audio original
  de pantalla muda y orientación real de dimensiones almacenadas.
- Definir objetivo y argumento con material real, no con una promesa inventada.
- Conservar ASR original y documentar correcciones con evidencia; no inventar verbos
  o nombres dudosos para que el guion suene mejor.

### Cortes y timeline

- Guardar fuente/entrada/salida y mapeo a frames por segmento.
- Medir silencio real con `silencedetect`; **nunca cortar solo por timestamps ASR**.
- Priorizar frases completas y continuidad sobre una duración arbitraria.
- Las muletillas pueden ser conectores; eliminarlas solo con ambos bordes seguros.
- Preservar poses para efectos y remapear captions a la timeline final sin overlaps.
- Distinguir captura sincronizada de pantalla ilustrativa; no afirmar que demuestra
  un resultado que no muestra.
- Una ventana de RMS bajo es evidencia acústica, no certificación de escucha humana.

### Cuerpo FFmpeg + capas Remotion

FFmpeg produce un cuerpo continuo con las dimensiones/FPS/codecs del snapshot.
Remotion compone cámara, pantalla, PiP, títulos y efectos encima. No convertir cada
palabra o microcorte en otra instancia de `OffthreadVideo`.

- `-nostdin` y `stdin: 'ignore'`; drenar stdout/stderr en paralelo.
- Timeout finito y kill solo del hijo propio, nunca `pkill ffmpeg` global.
- Si se usa `apad`, limitar la salida con `atrim`/duración finita.
- Validar una muestra corta antes del cuerpo completo.
- Reusar el kit Remotion instalado; media real copiada a `remotion/public/`, no symlinks.
- Evitar audio duplicado: videos de apoyo muteados si `Audio` reproduce la voz aparte.
- Usar `WordSubtitles` compartido y pasar posiciones/tamaño/colores del snapshot.
  El registry visual no aplica captions por sí solo. Revisar rostro, contraste y UI
  de las redes: porcentajes configurados no garantizan una safe area universal.
- Motion y títulos responden a la narración; no interrumpir la voz con tarjetas.

### Generación opcional

No hay gasto, TTS, música ni efectos habilitados por haber elegido un preset.
Cada generación requiere nueva autorización y presupuesto, reserva durable,
precio/límites conocidos, máximo de intentos y reutilización por hash. Ante estado
incierto, reconciliar sin otro submit automático. Revisar cara/manos/pose/encuadre.
No arrastrar autorizaciones ni el presupuesto de un video anterior.

## 3. QA local y revisión editorial

Completar `video` y `cover` en `publication/draft.json` con rutas relativas seguras.
El perfil actual usa portada PNG con las dimensiones del render, no un 9:16 obligatorio.

```bash
bun run vm creator-qa --project projects/mi-video
```

Escribe `qa/creator-media.json`: hash, formato, dimensiones, FPS, pistas, duración,
decodificación y loudness. Los valores vienen del snapshot, no de leobar ni de una red.
La tolerancia de loudness es ±1 LUFS por defecto (`editing.audio.lufsTolerance` puede
configurarla). Normalizar con margen de true peak y medir de nuevo después de AAC.

La QA técnica **no autoriza publicar**. Revisar además frames del MP4 final, uniones,
voz, captions, efectos, pantalla/PiP y cierre; documentar límites de escucha. Preservar
los hashes originales. Cambios en media, portada, copy, cuentas o preset invalidan
la aprobación.

Para revisión remota: servir solo el final con HTTP Range; comprobar bind en todas
las interfaces y acceso desde otro dispositivo. Compartir IP Tailscale, nunca enlaces
loopback. No exponer originales, transcripciones, `.env` ni el repositorio.

## 4. Borrador y aprobación específica

Campos comunes del borrador:

- `video`, `cover`: archivos locales relativos al proyecto.
- `title`, `content`, `tags`: contenido nuevo, con límites por destino.
- `platformContent`: overrides de texto por plataforma; no un campo especial de X
  en el modelo común. El texto compartido sirve donde cumple los límites.
- `syntheticMedia`: boolean explícito; inicialmente `null`. Usar IA para editar no
  implica que la media sea sintética; sí declararla cuando el render la incluye.
- `approval`: inicialmente `{ "approved": false, "digest": null }`.

```bash
bun run vm creator-publish --project projects/mi-video --spend-cap 0 --dry-run
```

El plan es offline y no escribe: muestra bloqueos y digest candidato. No puede
certificar salud remota de cuentas ni aceptación por una plataforma. Tras revisar
render y copy exactos y recibir autorización del usuario, guardar el digest en
`approval.digest` y `approval.approved: true`. Nunca autoaprobar para pasar el gate.

El digest liga media, portada, contenido, targets y preset. Un proyecto nuevo no hereda
permisos del cliente anterior ni de otra publicación del mismo cliente.

## 5. Publicar y comprobar por destino

```bash
# SOLO con autorización específica ya registrada:
bun run vm creator-publish --project projects/mi-video --confirm --spend-cap 0

# Solo lectura: consultar sin volver a publicar.
bun run vm creator-status --project projects/mi-video
```

Efectos del envío: comprobar perfil/cuentas/capacidad, subir solo final y portada a
R2 existente, verificar sus bytes y publicar mediante el Publisher existente.
No crea buckets, contenedores ni bases de datos. `--spend-cap 0` no habilita generación;
no significa que almacenamiento o proveedor sean gratuitos.

- Perfil por nombre **e ID**, pertenencia exacta y salud de todas las cuentas
  seleccionadas antes del envío; nunca fallback al perfil `default` ni a otra marca.
- Targets variables: uno, varios o las redes configuradas; no hay cuatro obligatorios.
- Constraints por destino: por ejemplo, el límite conservador de X solo aplica si X
  está entre los targets. No recortar ni excluir redes automáticamente para aprobar QA.
- Para un render común, se deben cumplir todos los destinos seleccionados. Si necesitan
  versiones incompatibles, preparar variantes/proyectos con sus propios snapshots y
  aprobación: este flujo no genera variantes ni las sustituye silenciosamente.
- TikTok consulta capacidad/privacy reales solo si ese target existe; YouTube recibe
  sus metadatos propios. Otras plataformas no heredan estas opciones.
- Las caps del preset son política de proyecto, **no una tabla universal ni garantía**
  de límites del proveedor. Cuentas/formatos/planes pueden tener requisitos distintos.
- Registrar cada destino, su receipt, estado y URL. `accepted`/`pending` no son publicado.
- Marcador durable antes de POST; ante timeout/crash/uncertain, consultar y reconciliar.
  No borrar marcadores, cambiar la clave ni forzar un reintento. No reenviar éxitos.
- Cerrar solo con estados comprobados por red; verificar página pública cuando se pueda.

## 6. Agregar otro cliente o red

1. Partir de `presets/example-client.json`, no de los assets/receipts de otro cliente.
2. Asignar `id`, `version`, `name`, identidad y parámetros de edición propios.
3. Configurar el perfil y **todas** las cuentas verificadas del cliente; los IDs de
   ceros de la plantilla no son cuentas reales. No conservar IDs de leobar.
4. Declarar los targets y sus constraints; `options` solo si hay soporte validado para
   esa plataforma. Agregar una cuenta no autoriza publicar automáticamente en ella.
5. Crear proyecto con `creator-init --preset presets/<cliente>.json ...` y verificar
   plan/snapshot limpio. Mantener autorización por proyecto, no por preset.
6. Si interesa catalogar identidad en Studio, registrar cliente y nueva versión de
   preset usando comandos existentes. Studio no reemplaza el snapshot operativo:

```bash
bun run vm client-create <cliente> --name '<Nombre>' --workspace projects/<cliente>-studio
bun run vm preset-create <cliente> --client <cliente> --file presets/<cliente>.json --workspace projects/<cliente>-studio
```

Incrementar versión al cambiar política; nunca modificar snapshots activos ni versiones
Studio selladas. Un preset de datos nuevo no requiere otro workflow ni copiar scripts.

## 7. Lotes recuperables: ocho clips × tres destinos

Los cinco comandos registrados en
[`creator-batch.ts`](../packages/cli/src/specs/creator-batch.ts) usan **`--batch`**,
no `--manifest`. El contrato es
[`CreatorBatchManifestSchema`](../packages/schemas/src/creator-batch.ts),
`schemaVersion: 1`; no es un archivo de permisos ni sustituye las aprobaciones de
cada proyecto. Todos los destinos enumerados son obligatorios.

Ejemplo de estructura **ficticia**, expresado como objeto JavaScript para no repetir
ocho veces los mismos campos. Su serialización JSON tendría ocho proyectos y
24 destinos. Los hashes sintácticamente válidos e IDs de este ejemplo no son
evidencia, cuentas reales ni aprobación; sustituirlos por datos del proyecto
correspondiente, después de su revisión y autorización, sin copiar grants entre
proyectos:

```js
const manifest = {
  schemaVersion: 1,
  batchId: 'lote-ejemplo-8x3',
  queuePolicy: 'allow-provider-queue',
  projects: Array.from({ length: 8 }, (_, i) => {
    const id = `clip-${String(i + 1).padStart(2, '0')}`;
    return {
      projectPath: `clips/${id}`,
      projectId: id,
      preset: { id: 'cliente-ficticio', version: 1, sha256: 'a'.repeat(64) },
      approval: { approved: true, digest: 'b'.repeat(64) },
      media: { videoSha256: 'c'.repeat(64), coverSha256: 'd'.repeat(64) },
      targets: [
        { platform: 'youtube', accountId: 'cuenta-ficticia-yt', username: 'cliente-ficticio' },
        { platform: 'linkedin', accountId: 'cuenta-ficticia-li', username: 'cliente-ficticio' },
        { platform: 'tiktok', accountId: 'cuenta-ficticia-tt', username: 'cliente-ficticio' },
      ],
    };
  }),
};
```

Si el archivo se guarda en `projects/lote-ejemplo/batch.json`, `clips/clip-01` se
resuelve dentro de `projects/lote-ejemplo/`, no desde el cwd. No se admiten rutas
absolutas, `..`, `.`, segmentos vacíos, barras invertidas ni symlinks. Cada path e
ID de proyecto es único; una cuenta compartida entre clips conserva exactamente
su plataforma/username. Preset, digest, hashes y targets se contrastan con los
snapshots y borradores actuales: editar el manifiesto no concede aprobación.

Los siguientes ejemplos son instrucciones de operación, **no se ejecutan al leer
esta guía**. Empezar offline; las líneas mutantes solo se usan con autorización
específica existente:

```bash
# Offline, solo lectura local:
bun run vm creator-batch-plan --batch projects/lote-ejemplo/batch.json --spend-cap 0
bun run vm creator-batch-publish --batch projects/lote-ejemplo/batch.json --spend-cap 0 --dry-run

# GET remoto, sin escrituras ni nuevos envíos:
bun run vm creator-batch-status --batch projects/lote-ejemplo/batch.json

# SOLO con autorización específica: pueden subir media y hacer POST nuevos.
bun run vm creator-batch-publish --batch projects/lote-ejemplo/batch.json --confirm --spend-cap 0
bun run vm creator-batch-resume --batch projects/lote-ejemplo/batch.json --confirm --spend-cap 0

# GET remoto + auditoría local durable; jamás POST:
bun run vm creator-batch-reconcile --batch projects/lote-ejemplo/batch.json --confirm --spend-cap 0
```

Los cinco aceptan `--dry-run`: solo leen evidencia local; **cero escrituras, red,
secretos, uploads, procesos o generación**, incluso para status/reconcile. El plan
no certifica identidad, aceptación ni capacidad remota.

| Comando en run | Efectos posibles |
|---|---|
| `creator-batch-plan` | Solo lectura local. |
| `creator-batch-status` | Consultas GET de receipts/intents existentes; no persiste reconciliación, no POST ni storage. |
| `creator-batch-publish` | GET de comprobación, escrituras durables, upload de final/portada y POST solo para targets seguros `not-started`. |
| `creator-batch-resume` | Mismos efectos autorizables que publish; no es una consulta segura ni un retry de intentos ya iniciados. |
| `creator-batch-reconcile` | GET + `publication/reconciliations.jsonl`, receipts exactos y journal local cuando hay prueba; nunca POST, upload ni cierre del ledger de gasto. |

Publish, resume y reconcile exigen `--confirm` y `--spend-cap 0` explícitos. Ese cero
prohíbe generación pagada, no garantiza coste cero del proveedor/almacenamiento.
No hay POST duplicado: el intent durable precede al envío y el lote conserva la
clave original. Resume no reenvía `published`, `pending`, `failed` ni `uncertain`,
ni libera una cuenta por ausencia ambigua del post. Un fallo/estado incierto de
una cuenta pausa sus nuevos destinos; un fallo compartido de credenciales/TLS
detiene trabajo nuevo del lote, sin descartar éxitos.

### Estados, contadores y capacidad

El progreso contiene `checkedAt`, `targets`, `summary`, `complete`, `capacity` y
`dependencies`, además del manifiesto interno. Cada target requerido aparece una
vez. Sus estados son `published`, `pending`, `not-started`, `uncertain`, `failed` o
`blocked`; los contadores son `total`, `published`, `pending`, `notStarted`,
`uncertain`, `failed`, `blocked`. `complete` solo es true con los 24 destinos
comprobados como `published`: ocho clips en cola no equivalen a ocho publicados.
`published` requiere intent exacto, identidad remota y `checkedAt`; una URL puede
no existir todavía. `checkedAt` fecha la inspección/snapshot, no el momento de
publicación ni una garantía de actualidad continua.

- **`allow-provider-queue`** es la política por defecto: admite capacidad numérica
  desconocida cuando pasan identidad/capability y no hay una prohibición conocida.
  La aceptación del proveedor sigue siendo `pending`, no publicación inmediata.
- **`require-capacity`** exige evidencia `confirmed` con `remaining` o `available`
  positivo por cuenta antes de un nuevo claim. `unknown` o `estimated` no bastan;
  offline esos targets nuevos quedan bloqueados. La evidencia se vuelve a validar
  en cada preflight, no es una reserva global de los 24 destinos.
- La observación por defecto es **`unknown`**: no inventar una cuota de 15, cupos
  diarios, reset ni siguiente retry. `canPostMore` de TikTok expresa capability,
  no un número de publicaciones. `resetAt`/`nextRetryAt` solo son evidencia
  opcional, no un scheduler ni permiso para reintentar.
- El seam confirmado es `CreatorDeps.capacity?: CreatorCapacitySource`, adapter
  read-only de `(target, checkedAt)` a `CreatorBatchCapacityObservation`. No hay
  endpoint de cuota inventado ni adapter numérico habilitado por defecto.
  Se exige identidad coincidente, timestamp no futuro/de hasta 60 segundos y
  valores coherentes; inyectar una estimación no la convierte en `confirmed`.
- Un ledger abierto del **mismo proyecto** bloquea nuevos envíos. Un intento
  `clips-select` reconocido en el proyecto fuente de renders independientemente
  aprobados es informativo; se preserva, no se reembolsa ni se copia autorización.
  Dependencias abiertas desconocidas o evidencia insegura fallan cerradas.

El preflight GET reutiliza los adapters existentes y clasifica fallos como
`credential`, `tls`, `identity`, `capability`, `quota` o `network`, con alcance
compartido o de cuenta. Verifica perfil nombre+ID, pertenencia/accountId,
plataforma/username y salud exactos; TikTok valida privacy, interacciones, duración
y `canPostMore` del creator-info real. Antes de upload, rechaza configuración que
no satisface el snapshot. Resolver R2 valida configuración, no prueba permisos:
los HEAD/uploads reales siguen siendo autoritativos. No registrar secretos,
bodies de error o URLs privadas; **nunca cambiar TLS globalmente ni desactivar
la verificación de certificados** para superar un bloqueo.

## 8. Selección parcial y piloto editorial antes del loop

### Selección V1/V2 y gasto incierto

`clips-select --project <proyecto> --request <ruta-relativa>` lee una solicitud
contenida en el proyecto; `transcript` es relativo a la solicitud. No usa
`--batch` ni `--manifest`. El reader acepta resultados V1 y V2; el producer actual
escribe **V2** en `analysis/clip-selection.result.json` y su reporte en
`analysis/clip-selection.report.mdx`. V1 conserva su lectura legacy; no reinterpretar
sus rutas editoriales como estados de pago V2.

V2 distingue lifecycle `evaluated`, `not_evaluated`, `failed`, `uncertain` de route
editorial `suggested`, `review`, `rejected`, `duplicate`, `not_selected`. Sin
evaluación válida, `evaluation` y `route` son null: no inventar métricas, ranking
o rechazos. Ejemplo: **9 evaluadas, 1 incierta y 490 no evaluadas** de 500 produce
`status: "partial"`/`provenance: "automatic-partial"`, conserva las nueve respuestas
y su evidencia, y no representa 491 rechazos. No completa las restantes a escondidas.
Un resultado parcial retorna exit code 1; también se escribe para revisión.
Siempre `cutStatus: "needs_audio_video_review"` y `approvedForPublication: false`.

El reporte separa `spend.confirmedActualUsd` (cargo comprobado),
`openReservedUsd` (reservas de intentos `uncertain`/`submitted`) y
`historicalReservedUsd` (reservas originales, incluyendo las cerradas; máximo por
attemptId, sin sumar cada línea del journal). Cada entry lleva el **último registro
original** en `attempt`, o null si no hubo intento; el reporte no reconcilia ni
reescribe `qa/spend.json`. Los tokens/llamadas de la invocación no reemplazan ese
ledger. Conserva digests y caché existentes: V2 cambia el reporte, no las claves
de reutilización. Sin receipt/ledger válido no tratar una respuesta como caché
pagada comprobada. Una incertidumbre no es fallo confirmado, cargo cero,
reembolso ni permiso para retry; preservar reservas y reconciliar explícitamente.
No borrar lock/journal/cache para fabricar un intento nuevo.

`--spend-cap 0` en run permite únicamente reutilización elegible de caché; puede
escribir resultado/reporte local, **no equivale a dry-run**. Una llamada nueva exige
`--submit` (envía transcript a Typesafe) y presupuesto explícito suficiente. La
guía y el demo no autorizan esas llamadas. `--dry-run` no escribe ni llama al
proveedor. Las ventanas iniciales usan bordes de segmentos, un speaker y gaps
limitados; no certifican cortes a palabra ni deduplicación semántica de paráfrasis.
Ni scores ni probabilidades son garantía de viralidad.

### Receta de piloto sobre material real

1. Elegir `contentType` explícito (`educational` o `comedy`), audiencia/objetivo y
   presupuesto nuevo en la solicitud/operación. Empezar con **`maxCandidates: 5–10`**,
   no 500; es una política de piloto, no el máximo general del selector. Pedir plan
   offline primero. Cero USD solo permite fixtures o caché ya comprobada; evaluar
   media real mediante proveedor necesita autorización propia.
2. Revisar ejemplos **positivo y negativo**, ambos con reviewer y reviewedAt,
   según cuatro criterios: **premisa, autonomía, remate, fidelidad**. El positivo
   pasa los cuatro; el negativo falla al menos uno, con notas concretas. Educación
   requiere valor/contexto completo; comedia requiere setup, remate y reacción sin
   perder el sentido. No fabricar un gancho que el original no sostiene.
3. **Escuchar el audio real**, incluyendo ambos bordes y reacciones; contrastar
   ASR palabra por palabra y mirar frames/cambios de cámara. Registrar lo dudoso
   en `unreliableWordIndexes`; no quemar captions dudosos dentro de un clip.
   Revisar subtítulos del render y mantener contexto, voz y fidelidad originales.
4. Sellar decisiones y EDL, renderizar una muestra designada, revisar su MP4 con
   audio, encuadre single/duo, captions y transiciones antes del resto. La revisión
   editorial de la muestra **no es aprobación de publicación**.

Solicitud ilustrativa `analysis/pilot-request.json` (el transcript de selección
debe cumplir `ClipSelectionTranscriptSchema`, no asumir que cualquier ASR JSON
es intercambiable):

```json
{
  "schemaVersion": 1,
  "transcript": "selection-transcript.json",
  "audience": "Personas que aprenden el tema explicado en la fuente",
  "objective": "Conservar una explicación autónoma y fiel",
  "contentType": "educational",
  "maxClips": 3,
  "duration": { "minSec": 15, "maxSec": 45 },
  "maxCandidates": 8
}
```

Presupuesto explícito para inspección offline, sin enviar el transcript:
`bun run vm clips-select --project projects/mi-video --request analysis/pilot-request.json --spend-cap 0 --dry-run`.
Un run con caché elegible sigue usando cero; si requiere llamadas nuevas, detenerse
y obtener autorización/presupuesto propio antes de añadir `--submit`.

El gate opcional usa archivos locales
[`ClipPilotPolicySchema`/`ClipPilotEvidenceSchema`](../packages/schemas/src/creator-pilot.ts).
No existe un comando de autoaprobación. En `clips/pilot-policy.json`, por ejemplo:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "sampleIds": ["muestra-01"],
  "contentType": "educational",
  "maxCandidates": 8
}
```

`sampleIds` son IDs únicos de 1–10 rangos **ya sellados y aprobados** en
`clips/decisions.json`; no permisos de publicación. `maxCandidates` de la policy
registra el límite editorial del piloto, no trunca por sí solo el selector: fijar
el mismo límite en la solicitud. Con policy activa puede crearse primero solo la
muestra designada:

```bash
# Operación local de render; no llamada de selección ni publicación.
bun run vm clip-render --project projects/mi-video --id muestra-01
```

Antes de renderizar cualquier no-muestra, incluso con `--id` explícito o selección
mixta, se exige `clips/pilot-evidence.json` aprobado editorialmente, ligado al hash
de `renders/clips/muestra-01.mp4` y a la procedencia vigente: source MP4,
source manifest, transcript, decisiones, frames y digest de shards ordenados
con sus hashes/metadata. El ejemplo positivo debe incluir la muestra y coincidir
con un rango aprobado; el negativo coincide con uno rechazado. Cambiar fuente,
transcript, shards, decisiones o sample invalida el gate. Ausencia de policy o
`enabled: false` mantiene el comportamiento previo; activarla no concede gasto.

La evidencia EDL debe cubrir **todos los rangos aprobados**, con `startFrame` y
`endFrame` exactos al segundo fuente del corte y al contenido/frame_id actuales;
no sirve el frame «más cercano». Usa tiempo fuente, no la timeline del MP4 final.
La QA rechaza palabras partidas, ausencia de evidencia de palabras o de frames
exactos en bordes, captions con índices dudosos, reacción truncada o sin ambos
bordes exactos, cambio de cámara sin `layoutChanges` exacto y caras ausentes/fuera
de encuadre. Duo exige ambas
caras; una reacción debe conservar al oyente y no quedar tapada por un crop single.
Los booleans `transcriptReview`/`framingReview` son declaraciones del revisor,
**no prueban que un humano escuchó**, ni calibran safe areas reales por plataforma.
El revisor debe comprobar el final completo; los checks solo validan la evidencia
aportada y no descubren solos reacciones omitidas o errores semánticos.

### Demo sintético offline, no validación de una fuente real

[`demo/creator-pilot/generate.ts`](../demo/creator-pilot/generate.ts) usa FFmpeg local
lavfi: tono de 440 Hz y formas geométricas, no rostros detectados ni voz/transcript
ASR real. Produce [sample.mp4](../demo/creator-pilot/generated/sample.mp4),
[still.png](../demo/creator-pilot/generated/still.png) y JSON de fixtures/QA.
Solo como receta local opcional: `bun demo/creator-pilot/generate.ts`; no se
ejecuta automáticamente, no descarga ni hace llamadas pagadas.
El original permanece en `demo/creator-pilot/generated/private/source.mp4`:
**no exponerlo**. Este demo no genera ni prueba caché del proveedor, no certifica
escucha/ASR real, no es una aprobación hash-bound operativa y no autoriza gasto,
publicación ni viralidad. Sus booleans y timestamps son fixtures declarados.

## 9. Preview allowlist y resumen público manual

Se reutiliza `@videomaker/dashboard`, sin otra app/daemon ni cambios al review-server
privado de un proyecto. Estas APIs son opcionales, read-only y no arrancan un
servidor por importarlas o configurar un objeto:

- `options.review?: ReviewPreviewConfig`, con
  `{ rootDir: string, files: readonly ReviewPreviewFile[] }`; cada file declara
  `{ route: string, path: string, mediaType: ReviewPreviewMediaType }`.
  `route` es una ruta exacta `/review/<nombre-final-declarado>` y `path` es relativo
  seguro a `rootDir`. El helper exportado `createReviewPreviewHandler(config)`
  devuelve `(Request) => Promise<Response>`.
- `options.creatorBatchProgress?: () => Promise<CreatorBatchProgress>` habilita
  **solo la ruta exacta GET/HEAD `/api/creator-batch/summary`**. Sin inyección no
  existe esa ruta. El proveedor de snapshot debe leer progreso ya disponible,
  no ejecutar publish, status ni reconcile automáticamente.
- `buildPublicCreatorBatchStatus(progress): PublicCreatorBatchStatus` sanitiza el
  snapshot y se exporta desde el dashboard. El endpoint usa el envelope JSON
  habitual del dashboard; no entregar el `CreatorBatchProgress` interno completo.

Ejemplo de whitelist explícita para la muestra **final**, sin iniciar ningún listener:

```ts
const review = {
  rootDir: 'demo/creator-pilot/generated',
  files: [
    { route: '/review/sample.mp4', path: 'sample.mp4', mediaType: 'video/mp4' },
    { route: '/review/still.png', path: 'still.png', mediaType: 'image/png' },
  ],
} as const;
```

Solo declarar finales HTML, MP4/WebM y stills raster
PNG/JPEG/GIF/WebP/AVIF; no SVG, transcript, source, journal, evidence JSON, secretos
ni directorios enteros. La configuración es una allowlist copiada, no escaneo del
repo; no hay browsing, fallback a un path libre ni symlinks/traversal. Entradas
inseguras/no declaradas no se sirven. Declarar un HTML final tampoco autoriza
sus fuentes privadas como subrecursos.

Las lecturas recorren los directorios con descriptores fijados y `O_NOFOLLOW`,
sin seguir symlinks ni reabrir por una ruta absoluta insegura. Requieren Linux
y `/proc/self/fd`; si no están disponibles, o un componente cambia de identidad,
la petición falla cerrada (404), sin fallback inseguro.

Solo el HTML de REVIEW se transforma con el parser integrado `HTMLRewriter`
de Bun: los scripts siguen bloqueados por el sandbox; solo los enlaces `a`/`area`
del namespace HTML conservan `href` si coincide exactamente con una ruta
`/review/` declarada (sin query, fragmento ni alias relativo/codificado).
Se eliminan los destinos externos/no declarados, los enlaces de namespaces
ajenos a HTML, `xlink:href`, `xml:base`, `ping`, `target`, `formtarget`,
`attributionsrc`, `base`, `noscript` (con su contenido) y todas las directivas
`meta[http-equiv]`, incluido meta refresh; se conserva el contenido de los
enlaces eliminados.
Esta política no equivale a una prohibición universal de navegación por CSP.
La UI habitual y los bytes sellados no se transforman.

Preview acepta GET/HEAD; video admite **un solo HTTP Range** en GET, con 206 y
Content-Range cuando corresponde y 416 para rangos inválidos. HEAD devuelve
headers completos sin body y no aplica Range; `If-Range` conserva respuesta
completa 200. El tamaño se obtiene de nuevo para cada request y, para HTML de
REVIEW, corresponde al snapshot UTF-8 transformado también en HEAD; no se congela
al crear el handler. No interpretar Content-Length como hash/aprobación de una
versión anterior. Este flujo no inicia servicios ni publica contenido en vivo.

El resumen público contiene `schemaVersion: 1`, `checkedAt` copiado del snapshot,
`clipCount`, `refresh: "manual"`, `autoMonitoring: false`, contadores `summary` y
`complete`. Los targets exponen únicamente `clipOrdinal`, `targetOrdinal`,
`platform`, `state`, y opcionalmente `checkedAt`/URL pública HTTPS reconocida para
esa plataforma; los ordinales empiezan en 1. La capacidad opcional conserva
`observationOrdinal`, plataforma, status/timestamp y campos numéricos/capability/
reset si existen. No publica IDs, usernames, claves idempotentes, hashes, paths,
receipts, fuente/detalles libres ni el manifiesto interno. Una URL descartada por
la sanitización no cambia el estado comprobado del target.

Refrescar manualmente vuelve a leer **el snapshot**, no realiza GET al proveedor
por sí solo. `checkedAt` puede estar antiguo; no hay polling, POST, loops de status,
scheduler, push, monitoring ni servicio iniciado por este flujo. Para nueva
evidencia remota usar status/reconcile explícitos según sus efectos y actualizar
el snapshot local sin automatizar envíos.

La revisión externa solo se habilita explícitamente: comprobar bind en **todas
las interfaces** (`ss -tlnp`) y acceso real desde el otro dispositivo antes de
compartir el enlace. Obtener IPv4 con `tailscale ip -4` y compartir únicamente
`http://<IPv4-Tailscale>:<puerto>/review/<nombre-final>`; MagicDNS solo si la IP no
funciona en el dispositivo. Si Tailscale no está activo, declararlo y activarlo
antes de compartir; nunca sustituirlo por una URL loopback. Esta guía no inicia
servidores ni expone el proyecto.

## Skills existentes

| Skill | Especialidad | Límite |
|---|---|---|
| `videos-youtube-render-qa` | Cortes, FFmpeg/Remotion, frames y audio | Su guía legacy horizontal no sobreescribe formato del snapshot. |
| `social-publisher` | Publicación/revisión con navegador cuando se necesita | No ejecutarla en paralelo a la publicación API del mismo contenido. |
| `youtube-linkedin-launch` | Título/descripción y voz personal, comprobaciones de lanzamiento | Aplicar solo a esos destinos; no es el workflow universal. |
| `fal-generate` | Media sintética opcional autorizada | No concede presupuesto. |

No hace falta otra skill por cliente o red. El código y esta guía son la fuente de
verdad del producto; las skills aportan técnicas especializadas. No se modificaron
skills personales ni el espejo Factory para registrar un preset.
