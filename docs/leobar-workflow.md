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
