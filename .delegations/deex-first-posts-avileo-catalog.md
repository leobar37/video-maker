# Task Anchor

Objetivo original del usuario: «que inicialize el cliente deex, y que primeor haga las dos primeros posts, tiene permiso para usar fal.ai, y que agregur soporte para las skills de avileo, conectado a prod, como tiene las credenciales, puedes abrir el link que te da y aprobarlo, esto va a nuestro pipline tambien, soporte para que los agentes consulten el catalogo de avileo».

Corrección posterior del usuario: «pero si tenemos una skill, Por que esta implementando otra cosa, o es oslo usar el sdk?». Esta corrección prevalece: USAR la skill/CLI oficial existente, sin crear otro adaptador, SDK, wrapper o integración Avileo.

Unidad autorizada: usar la conexión de solo lectura DEEX ya aprobada en Avileo producción y registrar DEEX en Studio para producir SOLO sus primeros DOS posts. Éxito: catálogo consultado mediante la skill/CLI existente; dos PNG feed 1080×1350 con fuentes, claims trazables, revisiones Studio y preview existente funcionando. No implementar una nueva frontera de catálogo. No publicar ni producir los otros cuatro posts o el video.

## Required Agent / Context

Eres el agente OMP existente en w55:pC, cwd `/home/leobar37/code/video-maker`; ejecuta esta unidad con social-post-design, fal-generate y avileo-catalog/key-routing existentes. Las skills personales canónicas están en `/home/leobar37/.agents/skills/`; no crees copias ni alternativas. La conexión DEEX read ya fue aprobada y verificada: no repetir auth.

Checkout Elena Tech confirmado: `/home/leobar37/code/theelena`; trabajo del futuro video en `/home/leobar37/.herdr/worktrees/theelena/shop-fixes`. Esos checkouts son de solo lectura para ti. Web real DEEX: `https://deex.theelena.me/`. Avileo Tienda producción: `https://tienda.theelena.me/`; verificar target con contrato/config reales, no asumir que la URL default del SDK es la deployment Tienda correcta. No usar localhost como enlace al humano.

El usuario autorizó al coordinador a abrir el enlace de device authorization y aprobar acceso a DEEX. Esa autorización es para lectura del catálogo; NO autoriza mutations de productos/inventario/precios/pedidos ni claves mutate/System Admin. No necesitas conocer la contraseña del usuario: el coordinador opera el navegador si hace falta.

## Primera acción: conexión productiva y handoff de aprobación

1. Revisa estado local sin imprimir secretos. Reutiliza command/profile host existente si funciona; conserva fuente de paquete y API target para toda la sesión. La skill publicada puede contener ejemplos 0.3.1 antiguos: no fuerces un downgrade (0.3.8 se publicó en esta sesión). El source local confirmado es opción válida; usa resolución documentada y build mínimo solo si sus exports dist realmente faltan.
2. Usa únicamente `avileo_sk_` desde env/credential store protegido para Agent Catalog; no `avileo_pk_`, no `sak_`, no SQL ni scraping autenticado de admin. `business show --json` determina tenant, capacidades efectivas, mode y actions. Exige DEEX/Deex Store y acceso read. Si la credencial existente corresponde a otro negocio, NO la reutilices, cambies de tenant ni la sobrescribas: inicia un vínculo separado siguiendo los perfiles/config admitidos.
3. Si necesitas device auth, inicia `auth login` con la CLI oficial y target productivo correcto. Cuando devuelva URL de verificación, responde pronto `WAITING_AUTH` con la URL LITERAL devuelta por el servidor, destino API, expiración/código de usuario si existen y permisos solicitados. No reconstruyas links, no compartas device secrets/access tokens. Mantén el flujo vivo si el CLI espera al navegador. PAUSA antes de producir con datos no verificados; el coordinador leerá tu respuesta y abrirá el link.
4. Tras el aviso de aprobación, termina el flujo y verifica `auth status` + `business show`, luego una lectura acotada de catálogo. Nunca trates una aprobación en navegador como prueba de que el CLI ya quedó conectado. Si ya existe una conexión válida DEEX read, verifica y continúa sin emitir otro link.

## Entregable A: cliente DEEX y dos posts

Usa `@videomaker/studio`: consulta/reutiliza `deex`, crea identidad/preset versionado si falta, proyecto propuesto `deex-presencia-digital`, assets image `post-01` y `post-02`. Antes de crear, verifica si ya existen y conserva trabajo válido. El SDK administra metadata y snapshots; el render debe producir PNG reales, no solo documentos.

### Post 01 — marca

- Concepto/titular: «Dale play a tu día.»
- Marca: DEEX, logo REAL de la web/recursos existentes; conserva proporciones. Apoyo propuesto: «Audio, tecnología y favoritos para tu hogar.»
- Objetivo: que el comprador entienda qué vende DEEX.
- Arte: composición editorial con 2–3 productos reales, tipografía protagonista; no logo flotando solo ni una tarjeta web.
- CTA: «Conoce nuestro catálogo» y `deex.theelena.me` (sin inventar @Instagram, QR/destino ni WhatsApp).

### Post 02 — producto

- Concepto/titular: «Tu música, contigo.»
- Producto: Soundcore A25i. En inspección anterior había foto real y precio PEN 65.00; RECONSULTA catálogo productivo antes de diseñar precio/stock. ID observado en la web: `d52edef0-6160-4a22-b6c9-ae6ad6122f95`; confirma que coincide con el negocio autorizado.
- Arte: producto grande, modelo identificable, precio como segundo foco; composición distinta al post 01.
- CTA: «Míralo en nuestra web».
- No inventes batería, ANC, impermeabilidad, garantía, promociones, certificación de originalidad o entrega gratis. Si faltan atributos, simplemente no los anuncies.

Identidad compartida: base crema/negro y naranja como acento, apoyada en assets/tokens reales de DEEX. Diseñar posts, no UI: sin botones falsos grandes, cajas genéricas o sombras gratuitas. Cada pieza debe funcionar sola y en el preview de perfil; no hacer puzzle recortado. No hablar de Elena Tech/pack emprendedor en estos posts: son para los compradores de DEEX.

## Permiso fal.ai y gastos

El usuario autoriza fal.ai para estas dos piezas. Límite operativo conservador: máximo USD 2 acumulados y máximo 2 intentos por operación; si cuesta más o no puedes estimarlo, pausa con el plan de costo. No extiende permiso a video, avatar, TTS, música, otros cuatro posts ni publicación.

Reutiliza producto/logo reales; fal puede aportar escenario/fondo o edición controlada, nunca inventar la apariencia del SKU, marcas, copy o UI. Componer texto/logo/precio determinísticamente. No enviar a fal PII, credenciales o datos privados del negocio. Usa el SDK/CLI/proveedor existente del repo, no scripts que evadan sus gates. Registra modelo, prompt, inputs, requestId, costo e intentos; descarga outputs. Si una request queda incierta, reconcilia antes de reintentar. Si el pipeline exige aprobación de un plan exacto, repórtala al coordinador; no escribas una firma humana por tu cuenta.

## Entregable B: consumir Avileo mediante la skill existente

Usa directamente `avileo-catalog` y `avileo-key-routing` y sus comandos oficiales. La CLI ya envuelve el SDK Avileo; no hace falta programar otra capa para estos posts.

- Conservar perfil protegido y API productiva ya verificados; consultar solo catálogo/negocio/imágenes necesarios.
- `@videomaker/studio` se usa para cliente/proyecto/piezas/revisiones, no para reimplementar Avileo.
- Solo si hace falta descubrir la skill desde el repo, reutilizar su mecanismo de referencia/configuración existente. No nueva skill duplicada, adapter TS, wrapper CLI, auth o sistema de tenants.
- Conservar por pieza procedencia mínima no secreta: producto/variante, fecha de consulta, moneda/precio e imágenes utilizadas. No copiar PII, claves ni inventario completo al bundle.
- Retirar únicamente archivos nuevos del adaptador y tests/docs ligados exclusivamente a él que sean de esta ejecución, verificando antes ownership. Si hay cambios ajenos o dudas, conservar y reportar; nunca reset/restore o limpieza amplia.

## Verified starting points / Likely Files

Investigación ya hecha; no repetir discovery amplio:
- `packages/studio/src/index.ts`: createStudioContext, createClient, createPresetVersion, createCreativeProject, createCreativeAsset, snapshotAsset, createProjectCheckpoint.
- `packages/studio/src/contracts.ts`, `workspace.ts`; `packages/schemas/src/studio.ts`: schemas y referencias.
- `scripts/studio-instagram-demo.ts`: precedente BFC; NO lo ejecutes ni cambies BFC para crear DEEX.
- `packages/dashboard/src/ui/app.js`: view=instagram y grid de propuesta existente; no Instagram conectado ni métricas reales. Outputs sellados alimentan el preview.
- `packages/cli/src/specs/social.ts`: gen-image/cover/carousel. `cover` no implica feed 4:5: produce 1080×1920/crops; usa el render existente apropiado o adaptación focalizada, sin afirmar 1080×1350 si no lo es.
- `/home/leobar37/.agents/skills/avileo-catalog/SKILL.md` + references/local-development.md y api-keys.md; skill avileo-key-routing.

## Ownership / Non-Goals

Puedes editar el workspace creativo DEEX y los archivos de producción de sus dos piezas; configuración mínima de descubrimiento de la skill existente solo si es necesaria. No implementar integración/SDK/wrapper/CLI Avileo. Preserva modificaciones ajenas y BFC/otros clientes. No editar apps/avileo, deex-store, shop-fixes, infraestructura, DB, despliegues ni pipelines de video del monorepo. Continúa en este pane.

No git checkout/switch/reset/rebase/merge/push. No commit salvo nueva autorización. No publicar en Instagram, no R2 live implícito ni pedidos/productos de prueba. Ningún secreto en logs, CLI argv, prompts, código, metadata, snapshots o reportes. No uses credenciales personales del usuario como integración persistente.

## Validation / Stop Criteria

Produce primero con las herramientas existentes. Validación final proporcional: lectura read-only real de DEEX, dos PNG 1080×1350, revisión visual completa/miniatura y coherencia de los datos publicados. No crear tests de una integración que ya no se debe implementar, ni correr suites globales. Si hay una modificación funcional indispensable dentro del alcance, comprobarla de forma focalizada.

Registra fuentes+outputs, snapshot por asset y checkpoint exacto de las DOS revisiones. Comprueba preview/download existentes. Si sirves dashboard, usa comandos existentes, bind all-interface y verifica listener/Tailscale antes de devolver URL; no compartas localhost. No instales/inicies contenedores/DB/migraciones. Un servicio local de preview sin infraestructura extra puede iniciarse para el entregable, siempre sin exponer secretos y siguiendo el contrato trusted-tailnet del repo.

Un PNG válido no demuestra buen diseño ni precio correcto; revisar ambos. STOP al entregar los dos posts usando herramientas existentes con procedencia verificada; no hacer los cuatro restantes ni otra integración.

## Scope boundary and findings protocol

Trabaja SOLO en el objetivo autorizado, entregables y ownership indicados. Repara regresiones causadas por tus cambios y verifícalas. Hallazgos preexistentes o ajenos: reporta evidencia mínima y causa incierta, no repares, investigues más ni subdelegues. Si son no bloqueantes, sigue tu unidad. Si bloquean, pausa solo esa parte y consulta al coordinador/owner; nadie puede autoautorizar expansión. No limpies, reviertas ni stages cambios de otros. Cerrar al cumplir entregables y verificación.

## Expected Final Report

Comienza restatando Task Anchor (objetivo actualizado, unidad, condición de éxito). Luego: conexión/lecturas verificadas sin secretos; confirmación de reutilización de skill/CLI; archivos descartados del adaptador propio; cliente/proyecto/assets/revisiones/checkpoint; links Tailscale y PNGs; procedencia de claims; QA visual; gasto fal real; qué NO se hizo; blockers o hallazgos fuera de scope.
