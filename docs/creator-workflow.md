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

- Perfil por nombre **e ID**, pertenencia exacta y salud de todas las cuentas antes
  del envío; nunca fallback al perfil `default` ni a otra marca.
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
