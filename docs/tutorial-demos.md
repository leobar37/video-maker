# Demostraciones de código: guía de autoría y atlas

Esta guía es el punto de entrada para personas y agentes que construyen tutoriales con el kit de motion graphics. La referencia ejecutable es la demo de OpenCode; los componentes son genéricos y no dependen de OpenCode.

## Dónde empezar

| Necesidad | Fuente canónica |
|---|---|
| Encontrar un componente, propiedades, límites y ejemplo | [Atlas JSON](../packages/motion-remotion/src/tutorial/atlas.json) |
| Componentes y tipos públicos | [Exports del kit](../packages/motion-remotion/src/index.ts) |
| Terminal, código | [panels.tsx](../packages/motion-remotion/src/tutorial/panels.tsx) |
| Layout, ventana, video, anotación y puntero | [primitives.tsx](../packages/motion-remotion/src/tutorial/primitives.tsx) |
| Timeline de terminal y scroll determinista | [terminal-model.ts](../packages/motion-remotion/src/tutorial/terminal-model.ts) |
| Ejemplo completo en horizontal y vertical | [Root.tsx](../packages/motion-remotion/examples/opencode/Root.tsx) |
| Registro Remotion | [index.ts](../packages/motion-remotion/examples/opencode/index.ts) |
| Render y generación de la vista de revisión | [tutorial-demo.ts](../packages/motion-remotion/scripts/tutorial-demo.ts) |
| Servidor de preview con soporte HTTP Range | [tutorial-preview.ts](../packages/motion-remotion/scripts/tutorial-preview.ts) |

El atlas visual se genera como `docs/artifacts/opencode-motion-kit/atlas.html`. No es otra implementación de los componentes: usa el catálogo JSON y capturas del render real. Las imágenes muestran componentes **en contexto**, no fixtures aisladas.

## Inicio rápido

Desde la raíz del repositorio, con las dependencias instaladas:

```bash
# Regenerar página, atlas, guía y catálogo sin renderizar.
bun run motion:tutorial --catalog-only

# Validación rápida de encuadres en ambos formatos: cuatro PNG por formato.
# También renderiza el pequeño MP4 local usado como fixture del video integrado.
bun run motion:tutorial --stills

# Render completo: horizontal + vertical, 32 segundos por video.
bun run motion:tutorial

# Renderizar solo un formato.
bun run motion:tutorial --format vertical
bun run motion:tutorial --format horizontal

# Servir exclusivamente los recursos de esta demo; puerto predeterminado 8140.
bun run motion:tutorial:preview
# Puerto alternativo si el anterior está ocupado (no detener servicios ajenos).
PORT=8141 bun run motion:tutorial:preview
```

Estos comandos escriben archivos locales y ejecutan Chromium/FFmpeg mediante Remotion. No llaman a APIs de pago, no publican contenido, no arrancan contenedores y no modifican bases de datos. El primer render puede descargar Chromium si Remotion aún no lo tiene instalado. `--catalog-only` no genera capturas ni MP4: si todavía no existen, hay que ejecutar un render.

### Acceso desde otros dispositivos

El servidor escucha en `0.0.0.0`, sirve solo una lista de archivos permitidos y admite byte ranges para que funcione el salto entre capítulos. No tiene autenticación: usar solo con material no sensible y en una red de confianza.

1. Obtener la dirección con `tailscale ip -4`.
2. Verificar el listener con `ss -tlnp | grep ':8140'` (ajustar si se eligió otro puerto).
3. Abrir `http://<IP-TAILSCALE>:8140/` para las demos y `/atlas.html` para el atlas.
4. Para abrir directamente el formato vertical, añadir `?format=vertical` a la página principal.

No compartir direcciones loopback: no funcionan desde el teléfono u otro ordenador. Si Tailscale no está disponible, resolverlo antes de anunciar el enlace.

## Contrato de los formatos

| Formato | Composition ID | Resolución | FPS | Duración | Archivo |
|---|---|---|---|---|---|
| Horizontal | `OpenCodeDemo` | 1920 × 1080 | 30 | 960 frames / 32 s | `opencode-demo.mp4` |
| Vertical | `OpenCodeDemoVertical` | 1080 × 1920 | 30 | 960 frames / 32 s | `opencode-demo-vertical.mp4` |

Ambos utilizan el mismo contenido y cuatro capítulos de 240 frames (8 segundos): terminal, código, video y resumen. `Sequence` reinicia el frame local en cada capítulo. Cambiar duración o añadir capítulos exige actualizar el contrato compartido de la demo, el catálogo y el navegador de capítulos; no editar solo el HTML o el nombre de un MP4.

**Vertical no significa recortar el horizontal.** `TutorialLayout` detecta la orientación con `useVideoConfig()` y coloca la anotación debajo del panel. La escena de código apila los paneles y ajusta la tipografía. El video de ejemplo usa una fuente vertical dedicada, no un crop que oculte comandos. Un contenedor adaptativo no puede reorganizar por sí solo cualquier contenido hijo: cada escena debe decidir cómo redistribuir sus paneles.

La plantilla reserva márgenes de composición, pero no certifica las zonas seguras de todas las plataformas sociales. Verificar controles, captions y overlays del destino antes de publicar.

## Flujo para crear una nueva demostración

### 1. Definir qué se demuestra

- Un objetivo concreto: por ejemplo, abrir el proyecto, pedir un cambio y revisar el diff.
- Separar **demostración real** (grabación de una sesión) de **ilustración** (comandos, código o respuestas guionados).
- Definir formato(s), duración, capítulos y voz antes de animar.
- No presentar resultados inventados como si fueran una ejecución real. La demo incluida está rotulada como ilustrativa y no tiene narración.

### 2. Reutilizar el componente adecuado

Consultar `atlas.json` por `id`, `tags` o `source`. Todos los componentes del tutorial se exportan desde `@videomaker/motion-remotion`. Dentro de este repositorio, un ejemplo ubicado en el paquete también puede importar `../../src`, como hace la demo.

- Comandos y salidas guionadas → `TerminalWindow`.
- Fragmento o diff explicado → `CodePanel`.
- Grabación real → `ScreenRecording`.
- Estructura 16:9/9:16 → `TutorialLayout`.
- Explicación breve → `Callout`.
- Foco visual manual → `TutorialPointer`.
- Marco para otro contenido → `DesktopWindow`.

No incorporar un editor completo, emulador de terminal ni otra librería de animación para estas necesidades básicas. Los componentes renderizan desde el frame de Remotion y aceptan datos serializables donde corresponde.

### 3. Escribir una escena

Este ejemplo es un componente de escena; debe renderizarse dentro de una composición Remotion. No usa temporizadores ni efectos de reproducción:

```tsx
import React from 'react';
import { Sequence } from 'remotion';
import {
  Callout,
  TerminalWindow,
  TutorialLayout,
  type TerminalEntry,
} from '@videomaker/motion-remotion';

const entries: TerminalEntry[] = [
  { text: 'cd mi-proyecto', at: 15, duration: 30, kind: 'command' },
  { text: 'opencode', at: 60, duration: 30, kind: 'command' },
  { text: '# Describe una tarea concreta', at: 120, kind: 'comment' },
];

export function IntroScene() {
  return (
    <TutorialLayout
      eyebrow="01 / INICIO"
      title="Abre tu proyecto."
      description="Una instrucción clara a la vez."
      step="01 — 03"
      series="MI SERIE"
      topic="MI HERRAMIENTA"
      footer="EJEMPLO ILUSTRATIVO"
      aside={<Callout number="01" title="Contexto" from={45}>Usa la carpeta del proyecto.</Callout>}
    >
      <TerminalWindow entries={entries} title="~/mi-proyecto" fontSize={32} />
    </TutorialLayout>
  );
}

export function Tutorial() {
  return <Sequence from={0} durationInFrames={240}><IntroScene /></Sequence>;
}
```

Registrar `Tutorial` con `Composition`, usando dimensiones/FPS explícitos, y registrar el root con `registerRoot`. La demo existente muestra ambos pasos. Mantener el nuevo ejemplo dentro de un workspace o configurar la resolución de imports del bundler: un archivo arbitrario en `projects/` no hereda necesariamente las dependencias del kit.

### 4. Preparar el contenido

**Terminal**

- `at` y `duration` están en **frames locales**, no milisegundos ni segundos.
- A 30 fps: 15 frames = 0,5 s; 60 frames = 2 s.
- `duration` omitido o cero muestra el texto inmediatamente.
- `kind` acepta `command`, `output`, `success` o `comment`.
- Los eventos se ordenan por `at`; los empates conservan el orden de entrada.
- Usar tiempos y duraciones no negativos; evitar comandos solapados si se quiere una escritura secuencial.
- `maxRows` limita líneas lógicas (incluidos saltos `\n`), no filas visuales resultantes del ajuste de palabras. Dividir salidas largas y revisar overflow al cambiar la fuente.
- `terminalRows()` es puro: permite probar comienzo, mitad, final y saltos hacia atrás sin un navegador.

**Código**

```tsx
<CodePanel
  filename="src/greet.ts"
  firstLine={10}
  highlightLines={[10]}
  lines={[{
    change: 'added',
    tokens: [
      { text: 'const ', kind: 'keyword' },
      { text: 'name = ' },
      { text: '"Elena"', kind: 'string' },
      { text: ';' },
    ],
  }]}
/>
```

Los tokens se suministran explícitamente; `CodePanel` **no tokeniza código automáticamente** ni ejecuta el fragmento. Se puede adaptar la salida de un highlighter externo antes del render. `highlightLines` usa los números visibles, incluyendo `firstLine`. Los cambios admitidos son `added` y `removed`; no se calcula un diff automáticamente. Los textos son nodos React, no HTML inyectado.

**Video**

```tsx
import { staticFile } from 'remotion';

<ScreenRecording
  src={staticFile('mi-grabacion.mp4')}
  title="Sesión grabada"
  startFrom={30}
  endAt={270}
  zoom={1.1}
  focus={{ x: 30, y: 40 }}
  muted
/>
```

- Poner el archivo en el `publicDir` de la composición; `staticFile()` resuelve desde esa raíz, no desde la carpeta del TSX.
- `startFrom`/`endAt` son frames al FPS de la composición; `endAt` es el final exclusivo. Asegurar duración suficiente para la secuencia.
- `focus.x`/`focus.y` son porcentajes 0–100. `zoom` se limita por abajo a 1; aumentarlo puede ocultar bordes.
- Se conserva la relación de aspecto (`contain`); las bandas vacías son preferibles a perder contenido importante.
- `muted` es `true` por defecto. Si se combina con `Film` y una narración maestra, no duplicar el audio dentro de la escena.
- Este componente **no graba pantalla**, no detecta cursor ni extrae metadatos. Es un reproductor dentro del render. La demo genera un MP4 sintético para verificar la decodificación; sustituirlo por una captura autorizada para un tutorial real.

### 5. Comprobar ambos encuadres

1. Renderizar stills lejos de los frames de entrada (por ejemplo, frame local 170).
2. Verificar también el inicio de escritura y el fin de cada secuencia si se cambian tiempos.
3. En vertical, apilar contenido y acortar títulos/salidas antes de reducir demasiado la fuente.
4. Mantener el padre del panel con altura definida; `DesktopWindow`/`TerminalWindow`/`CodePanel` ocupan `height: 100%`.
5. `TutorialPointer` usa porcentajes respecto al ancestro posicionado. Añadir `position: relative` al panel si se usa fuera de `ScreenRecording`.
6. No tapar líneas importantes con punteros, subtítulos o anotaciones.

### 6. Validar y entregar

```bash
bun test packages/motion-remotion/src/tutorial/tutorial.test.tsx
bun run --cwd packages/motion-remotion build
bun run motion:tutorial --stills
bun run motion:tutorial
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,r_frame_rate,nb_frames,duration \
  -of json docs/artifacts/opencode-motion-kit/opencode-demo-vertical.mp4
```

Checklist de entrega:

- [ ] Pruebas del comportamiento afectado y TypeScript pasan.
- [ ] Se revisaron las cuatro escenas de cada formato solicitado.
- [ ] El archivo final tiene resolución, FPS y duración esperados.
- [ ] El MP4 reproduce y permite saltar a los capítulos, incluso hacia atrás.
- [ ] La página funciona en escritorio y móvil sin deformar las capturas.
- [ ] Los ejemplos ilustrativos están identificados y no se presentan como sesiones reales.
- [ ] Si hay voz, se verifican cortes, sincronía y audio duplicado; esta demo no valida una narración.
- [ ] El enlace usa Tailscale y el listener no está limitado a loopback.
- [ ] Se entregan los formatos solicitados, no solo un enlace genérico al horizontal.

## Mantener el atlas

El archivo `src/tutorial/atlas.json` es el índice canónico de descubrimiento; las firmas TS son la autoridad de tipos. Al crear, mover o modificar un componente:

1. Exportarlo desde `src/index.ts` si es parte de la API pública.
2. Actualizar su entrada en el JSON: ID, descripción, tags, ruta, propiedades, ejemplo, límites y capítulo de referencia.
3. Usarlo en una escena del ejemplo para que la captura sea verificable.
4. Ejecutar las pruebas de integridad del catálogo y el typecheck.
5. Regenerar el atlas con `bun run motion:tutorial --catalog-only`; si cambió la apariencia, renderizar también las capturas/videos.
6. Mantener este documento y los comandos en el README. No crear índices competidores en archivos de instrucciones de agentes.

El atlas no descubre automáticamente componentes nuevos. Su integridad se comprueba con tests, pero el contenido explicativo debe mantenerse junto al código.

## Qué se versiona y qué se genera

- **Versionable:** componentes, ejemplos TSX/HTML, catálogo JSON, scripts, pruebas y esta guía.
- **Generado/ignorado:** MP4, PNG y copia de la página/atlas/guía en `docs/artifacts/opencode-motion-kit/`; fixtures de video en `projects/demo/opencode/public/`.
- No editar solo el HTML generado: cambiar la plantilla versionable y ejecutar `--catalog-only`.
- El servidor no lista el repo ni expone rutas arbitrarias. Para añadir otro recurso de revisión, actualizar su allowlist de forma explícita.
- No es el pipeline completo de publicación: no crea aprobaciones, no sube a redes y no sustituye la QA editorial del tutorial final.
