# Leobar: configuración del workflow compartido

El flujo de producción/publicación no es exclusivo de leobar ni de una red:
leer primero [Workflow compartido para clientes y redes](creator-workflow.md).
Esta página documenta únicamente los valores y decisiones de este cliente.

## Registro

- Preset canónico: [`presets/leobar.json`](../presets/leobar.json), versión 1.
- Registro visual: `resolveBrandTokens('leobar')`, independiente del antiguo `leo`
  (línea conceptual técnica que no se modifica).
- Studio: workspace `projects/leobar-studio`, cliente/preset `leobar`, versión de
  identidad `g-45c12c9a18`. Solo identidad, no el contrato operativo completo.
- Cada proyecto fija un snapshot exacto; actualizar el preset no migra proyectos
  en curso ni cambia publicaciones existentes.

## Identidad y edición

| Parámetro | Leobar |
|---|---|
| Formato inicial | 1080×1920, 30 FPS |
| Canvas / superficie | `#081118` / `#163A43` |
| Acento / texto | `#6AE6DF` / `#FFFFFF` |
| Fuente | Arial, Helvetica, sans-serif |
| Captions cámara / pantalla-PiP | 67 % / 60 % de altura |
| Frase de captions | Hasta 4 palabras / 28 caracteres; tamaño 58 a 1080 px |
| Audio | Voz original, una pista; sin música ni TTS por defecto |
| Loudness / true peak | −16 LUFS ±1; ≤−1,5 dBTP; normalizar apuntando a −2 dBTP |

Tono en español, primera persona, práctico, curioso y honesto. Contar qué se probó,
qué cambió y qué se aprendió. Sin hype, lenguaje corporativo ni promesas de autonomía
que el video no demuestra. Pocos hashtags relevantes, máximo 5.

Conservar frases completas, gestos para efectos y continuidad de voz antes que forzar
duración. La pantalla puede ser ilustrativa, pero no debe presentarse como prueba
sincrónica de un resultado. Subtítulos sobre el pecho en cámara, sin tapar cara ni
pegarse al borde; comprobarlo en el render, no asumirlo por el porcentaje.

Playa/cielo fueron efectos del primer video: **no son escenas predeterminadas**.
Tampoco se heredan su autorización, presupuesto, EDL, copy ni journals.

## Demos rápidas de pantalla con voz/cámara

Acuerdo del 2026-10-02, aplicado a Climier y Avileo Storefront. Este caso no
hereda la edición elaborada del primer video ni necesita nuevas skills por producto.

### Alcance por defecto

- Copiar el original sin borrarlo y comprobar integridad.
- Transcribir para entender el contenido y redactar título/descripción fieles.
- Recortar solo exceso de silencios medidos, conservando frases completas y pausas
  naturales. No cortar voz basándose únicamente en timestamps de Whisper.
- Conservar el encuadre de la captura y la cámara. No forzar vertical.
- No añadir máscaras, subtítulos, música, efectos ni reestructurar el argumento
  por iniciativa propia. Si aparece una credencial o un dato sensible inequívoco,
  señalar el hallazgo concreto antes de publicar y acordar la acción; no iniciar
  una auditoría general ni tapar nombres de proyectos por suposición.
- Preparar título, descripción y portada sencilla del material existente. No
  generar assets de pago ni hacer investigación de marketing salvo solicitud.

### Render y validación proporcional

- El estándar acordado sigue siendo cuerpo continuo FFmpeg + final Remotion.
  Python auxiliar está permitido. Reutilizar la configuración validada; no inventar
  otro pipeline por video ni añadir overlays solo para justificar Remotion.
- Si basta con cortes y normalización, proponer una salida directa con FFmpeg
  como alternativa rápida, pero no sustituir silenciosamente el final Remotion.
  Esa alternativa aún no está acordada como estándar.
- Probar una muestra corta, renderizar una sola vez y ejecutar el QA del final:
  decodificación, formato, audio, encuadre y bordes de los cortes. Repetir solo
  lo afectado por un fallo concreto. No convertir un muestreo en una afirmación
  de revisión exhaustiva ni prometer un tiempo sin evidencia.
- Distinguir tiempo de edición de tiempo de render/subida. Remotion fue el
  principal coste de tiempo en Avileo Storefront; no atribuirlo a la selección.

### Destinos, autorización y conservación

- Confirmar los destinos solicitados en el contexto actual. Una cuenta configurada
  no es autorización perpetua para publicar todos los videos futuros.
- Reutilizar el mismo final completo donde sea compatible; preparar una versión
  breve para X solo cuando haga falta, sin acortar por ello las demás redes.
- Los 180 s de YouTube en el preset canónico son para la pieza corta vertical,
  no el límite de YouTube normal. Definir formato y límites del nuevo preset antes
  del init, sin alterar snapshots de proyectos ya aprobados/publicados.
- Si se añade TikTok después, reutilizar media/portada por hash y crear un destino
  independiente; no renderizar de nuevo ni reenviar a redes ya publicadas.
- Usar `creator-*` y sus journals, verificar cuenta/capacidades, ligar la autorización
  actual al digest y comprobar el estado remoto. `pending` no significa publicado;
  un enlace ausente no se inventa y un envío incierto no se repite.
- Conservar originales, transcripción, cortes, scripts, finales y recibos.

Skills de apoyo: `videos-youtube-render-qa` para cortes/audio;
`youtube-linkedin-launch` para título/descripción; `social-publisher` para
particularidades de redes y navegador si hace falta. El contrato operativo local
es [creator-workflow.md](creator-workflow.md): las recetas legacy de las skills
no sustituyen las cuentas, el formato ni la autorización de este proyecto.

## Destinos configurados

| Red | Cuenta | Cap de duración de este preset |
|---|---|---|
| TikTok | `@theleonbar37` | 600 s, además del límite real del creator |
| YouTube | `@leobar3787` | 180 s, intención de pieza corta vertical |
| LinkedIn | Elmer León Barboza | 900 s |
| X | `@elmer_joselito` | 140 s |

Son límites conservadores configurados **por destino**, no límites globales del
workflow ni garantía de las políticas de cada plataforma. Con los cuatro destinos,
el render común debe respetar el menor. Si X no está seleccionado en otro preset,
su límite no se impone a las demás redes. No recortar/excluir automáticamente.

TikTok: público, comentarios habilitados, duet/stitch deshabilitados. YouTube:
público, no dirigido a niños, categoría tecnología. Disclosure de media sintética
cuando corresponda. Son decisiones de este cliente, no defaults de todos los clientes.
Instagram/Facebook no están conectados en esta configuración de leobar; no se añaden
por descubrir una cuenta de otra marca ni por tener soporte genérico en el proveedor.

## Comandos

```bash
bun run vm creator-init --preset presets/leobar.json --project projects/mi-video --id mi-video --title 'Mi video' --dry-run
bun run vm creator-init --preset presets/leobar.json --project projects/mi-video --id mi-video --title 'Mi video'

# Después de editar/renderizar y completar el borrador nuevo:
bun run vm creator-qa --project projects/mi-video
bun run vm creator-publish --project projects/mi-video --spend-cap 0 --dry-run
```

La publicación real exige revisión y autorización del render/copy actuales, digest
aprobado y `--confirm`; seguir la [sección de publicación](creator-workflow.md#5-publicar-y-comprobar-por-destino).
No publicar ni generar al crear un proyecto o escoger un preset.

```bash
# Consultar identidad registrada sin crear otra versión:
bun run vm preset-list --workspace projects/leobar-studio --json
```

Para otro cliente, usar la [plantilla sin cuentas reales](../presets/example-client.json)
y el **mismo** workflow `creator-*`; no copiar scripts leobar ni la carpeta de producción.
