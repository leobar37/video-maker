---
id: G-001
title: Workflow de clips con publicación y recuperación verificables
status: completed
end_state: Un lote simulado de ocho clips y tres redes conserva sus aprobaciones, registra 22 publicados y dos en cola, y puede recuperar o consultar su progreso sin duplicar POST ni confundir candidatos no evaluados con fallos.
verification:
  - Tests offline de publisher, creator, batch y selección en verde.
  - Fixture de ocho clips por tres redes con HTTP 207, crash y reanudación; contador de POST por clave nunca mayor que uno.
  - Dry-run sin red, secretos, uploads ni mutaciones.
  - "Suite completa final: 1782 tests, 99 archivos, 14876 assertions y cero fallos; compilación y diff-check en verde."
budget: Solo fixtures y mocks; nuevas evaluaciones pagadas o validaciones con publicaciones reales necesitan autorización específica.
---

# Propuesta: workflow de clips y publicación resiliente

**Modalidad:** implementación completada mediante orquestación, conforme a la solicitud del usuario. No autoriza evaluaciones pagadas, nuevas publicaciones, seguimiento persistente ni modificaciones de infraestructura.

## Goal

Convertir la recuperación que hicimos manualmente en un flujo soportado por la CLI, con estados confiables por clip/red y trazabilidad de selección y gasto. El escenario de aceptación reproduce ocho clips, tres redes, 22 publicaciones confirmadas y dos TikTok en cola; reanudarlo no genera POST adicionales para publicados, pendientes, inciertos ni fallos definitivos ya intentados.

- **Verification:** suite offline focalizada, nuevo fixture de batch y comprobación de cero efectos en dry-run. Consultas de estado demuestran transiciones `pending → published` sin POST.
- **Deliverables:** parsing de receipts corregido; contratos y comandos de batch; preflight de capacidad con incertidumbre explícita; reporte versionado de selección; piloto y evidencias de QA; documentación del flujo y tests de regresión.
- **Must not change:** aprobación exacta vinculada a hashes, snapshots de identidad/cuentas, spend gates existentes, submit-once, journals append-only y prohibición de reintentos inciertos.

## Objective

Reducir las paradas falsas, los reenvíos peligrosos y la intervención manual. El operador debe ver qué está publicado, en cola, no iniciado, bloqueado o incierto y cuál es el siguiente paso permitido. Una cola del proveedor no se contará como publicación completada. La IA seguirá siendo una herramienta de evaluación, nunca una autorización de publicación.

## Scope

- **In scope:** receipts HTTP 207/otros 2xx, clasificación por target, consulta y reconciliación segura, batches sobre proyectos creator existentes, observación de cuotas, selección parcial y contabilidad comprensible, piloto editorial y QA por tramos.
- **Out of scope:** plataforma nueva, nuevo dashboard React, refactor global de providers, Docker/DB/migraciones, cambiar cuentas o formatos aprobados, borrar posts, cambiar claves para reenviar, solucionar el cobro incierto de Typesafe sin evidencia, automatizar una aprobación humana o garantizar viralidad.
- **Límite de autorización:** la orquestación cubrió los seis bloques de código y sus fixtures offline. Toda operación sobre proveedores o material real conserva sus autorizaciones, presupuesto y aprobaciones específicas.

## Verified Context inicial (baseline previo a la implementación)

- `packages/providers/src/zernio/publish.ts:270-313` reconoce receipts de creación únicamente con HTTP 200/201; un 207 cae en la rama de fallo y pierde el remoteId.
- Los receipts reconciliados del lote confirman dos TikTok `pending`, con IDs remotos y mensaje del proveedor: límite de 15 videos diarios mediante su Business API y publicación automática después de una fecha UTC. No es un límite universal de todas las vías de publicación de TikTok.
- `packages/cli/src/creator/workflow.ts` ya tiene preflight de perfil/cuentas/capacidad TikTok, intents durables y consulta GET-only. `planPublication` verifica aprobación, QA y ledger del proyecto correspondiente.
- Las consultas por `idempotencyKey` no se comportaron como el mock: la respuesta real incluyó posts de otras claves. No es seguro escoger el primero de una lista.
- El lote se recuperó con scripts privados en `projects/clip-poper-fiesta-15/qa/`; no existe aún una interfaz de batch equivalente a esa ejecución.
- En selección hubo diez llamadas nuevas, nueve evaluaciones válidas y un intento incierto. Los restantes candidatos se detuvieron; el schema v1 permite únicamente `evaluation_failed` para entradas sin métricas.
- `spend.reservedUsd` en el reporte suma reservas realizadas durante la ejecución. No equivale necesariamente a la reserva que permanece abierta en el ledger.
- El transcript inicial requirió mejora local de ASR. Dos clips cambiaban de plano completo a comediante+público y necesitaron encuadre por tramos.
- El servidor privado de review ya se corrigió para crear un `Bun.file` fresco por request. El cache de tamaño anterior truncaba HTML actualizado. La comprobación de tamaño cambiante, HTTP 206 y denegación de archivos privados pasó.
- Una consulta posterior de credenciales falló por verificación de certificado; se completó usando la CA confiable del sistema en el proceso hijo, sin desactivar TLS. No se ha demostrado que esa configuración resuelva toda posible causa de fallo de certificados.
- **Baseline ejecutado:** 52 tests, 366 assertions, cero fallos en publisher, creator y selección. La ausencia de fallo no cubre el 207 observado en producción.

## Assumptions

- Mantener el enfoque CLI y archivos versionados. No hace falta una nueva base de datos o cola propia para estas mejoras.
- Una cola ya aceptada por el proveedor seguirá siendo responsabilidad de ese proveedor; la CLI observa su avance, no crea otro envío.
- Los proyectos creator mantienen su separación legítima por clip y sus controles. Un batch no permitirá crear/copiar proyectos para eludir un ledger abierto.
- El cupo disponible puede ser desconocido. Historial y mensajes no sustituyen un contador autoritativo, y otras ejecuciones pueden consumir capacidad entre preflight y POST.

## Files Involved

### Existentes: modificar o revisar dentro de cada etapa aprobada

- `packages/providers/src/zernio/publish.ts`, `post-response.ts`, `status.ts`, `journal.ts` y `publish.test.ts`: receipts, estados y reconciliación.
- `packages/cli/src/creator/workflow.ts`, `qa.ts`, `model.ts` y `workflow.test.ts`: orquestación, gates y separación entre lectura y escritura.
- `packages/cli/src/specs/creator.ts`, `packages/cli/src/all-specs.ts`: comandos declarativos y registro.
- `packages/schemas/src/creator.ts`, `index.ts`: contratos públicos y validación en la frontera.
- `packages/schemas/src/clip-selection.ts`, `clip-selection.test.ts`: resultado versionado y clasificación de entradas sin métricas.
- `packages/cli/src/specs/clip-selection.ts`, `clip-selection.test.ts`: parada parcial, piloto, cache y ledger.
- `packages/cli/src/pipeline/clip-selection.ts`, `clip-selection.test.ts`: ranking y reporte.
- `packages/cli/src/pipeline/spend-ledger.ts` y `packages/cli/src/specs/clip.ts`: lectura histórica sin mutaciones y guard opcional del piloto antes del loop de render.
- `docs/creator-workflow.md`: guía operativa, estados y criterios de cierre.
- `projects/clip-poper-fiesta-15/qa/review-server.ts` y evidencias de QA/reconciliación: referencias del incidente, no contrato general ni destino de cambios de producto.

### Nuevos implementados

- `packages/schemas/src/creator-batch.ts` y su test: manifiesto del batch y progreso por target.
- `packages/cli/src/creator/batch.ts` y su test: controlador de batch que reutiliza el workflow existente.
- `packages/cli/src/specs/creator-batch.ts` y su test: plan/publish/status/resume/reconcile.
- `packages/cli/src/creator/preflight.ts` y su test: observaciones de capacidad y validación de acceso antes de uploads/POST.
- `packages/schemas/src/creator-preflight.ts`, `creator-pilot.ts` y sus tests: DTOs remotos y evidencia editorial versionada.
- `packages/cli/src/creator/pilot.ts`, `pilot-qa.ts` y sus tests; `packages/cli/src/specs/clip-pilot.test.ts`: aprobación de muestra y checks de cortes/layout.
- `packages/dashboard/src/batch-status.ts`, `review-preview.ts` y sus tests: proyección pública y whitelist/Range seguros en el dashboard existente.
- `demo/creator-pilot/`: fixtures positivos/negativos, generador local y muestra sintética inspeccionable.

## Ordered Execution Steps

### 1. Receipts correctos y reconciliación sin duplicados — prioridad crítica

- **Context:** un 207 puede contener un post aceptado/en cola, parcialmente publicado o realmente fallido.
- **Files:** parsing/publish/status/journal del proveedor, contratos creator y tests correspondientes.
- **Action:**
  - Inspeccionar el receipt de las respuestas 2xx reconocidas, incluidos 202/207; conservar el remoteId aunque el target esté pendiente o fallido.
  - Resolver estado y URL del target solicitado, no tomar una URL o estado de otra plataforma.
  - `published` exige evidencia de publicación del target. `pending/queued/scheduled` se normalizan como aceptado/en cola. Estado desconocido o 2xx sin receipt queda incierto y bloquea reenvío.
  - Mantener 409 dedupe y los gates existentes. No declarar todos los 207 exitosos ni garantizar rechazo solo por un código desconocido.
  - Mantener `status` como consulta sin mutaciones. Incorporar una reconciliación explícita y auditada para registrar evidencia, sin sobrescribir el historial.
  - Si un lookup por clave retorna una lista no filtrada, exigir membresía exacta. Fallback por payload solo con coincidencia única y comprobada de cuenta/perfil, texto, video, cover y ventana del intento; recorrer páginas o mantener incertidumbre. Nunca elegir el primer post.
- **End State:** fixture 207 con TikTok pendiente devuelve receipt aceptado y remoteId; GET posterior cambia a publicado sin POST adicional. Receipts ambiguos no desbloquean envíos.
- **Verification:** tests para 200/201/202/207 con publicado, pendiente, fallo, target ausente y receipt ausente; 409; 5xx/timeout; listas no filtradas/paginadas y dos coincidencias ambiguas. Mantener tests actuales verdes.
- **Dependencies:** ninguna.

### 2. Batch con estados independientes y recuperación oficial — prioridad alta

- **Context:** no debería detenerse un lote completo por una cola normal ni requerir scripts especiales para continuarlo.
- **Files:** nuevos contratos/controlador/specs de batch; integración con creator y all-specs.
- **Action:**
  - Manifiesto schema-versioned con rutas contenidas de proyectos, identidades de clip/target, hashes y digests aprobados. No convertir automáticamente el JSON ad hoc del lote actual en contrato público.
  - Proponer comandos `creator-batch-plan`, `creator-batch-publish`, `creator-batch-status`, `creator-batch-resume` y `creator-batch-reconcile`; parámetros de mutación explícitos, confirmación y cap de generación 0.
  - `plan` es totalmente offline; `status` usa GET y no escribe; `reconcile` hace GET y persistencia explícita de evidencia; `resume` solo considera targets que nunca iniciaron un intento.
  - No reenviar publicados, pendientes, inciertos ni fallos definitivos ya intentados. Un fallo no equivale a permiso de retry.
  - Cambiar el alcance de ejecución dentro del controlador, no el preset ni la aprobación del usuario: los gates del proyecto siguen vigentes antes de cada submit. La pausa por transporte/incertidumbre alcanza las unidades dependientes; un problema compartido de autorización/capacidad puede pausar toda la cuenta.
  - Registrar la evaluación Typesafe como dependencia informativa o bloqueante según su relación real con la operación. No relajar el ledger de un mismo proyecto ni cerrar intentos sin evidencia.
  - Contadores separados: publicado, en cola, no iniciado, incierto, fallido y bloqueado. Cierre completo solo cuando todos los destinos requeridos tengan publicación confirmada.
- **End State:** fixture 8×3 registra 22 publicados y dos en cola. Reejecutar resume, competir con otra ejecución o recuperar un crash nunca eleva el contador de POST de una clave por encima de uno.
- **Verification:** nuevo test de integración de batch con transports falsos, crash entre intent y receipt, snapshot cambiado, path traversal, concurrencia y ledger abierto del proyecto. Un ledger de evaluación en una unidad legítimamente independiente se informa sin borrarlo ni falsear su estado.
- **Dependencies:** etapa 1.

### 3. Preflight de cuotas con incertidumbre visible — prioridad alta

- **Context:** salud/permisos no garantizan capacidad restante de publicación.
- **Files:** creator preflight/workflow, batch schema/specs y parser de respuestas del proveedor.
- **Action:**
  - Agregar observación por cuenta: capacidad confirmada, estimada o desconocida; fuente, hora de comprobación y reset/nextRetryAt cuando el proveedor los entregue.
  - Verificar qué endpoints/campos documentados existen antes de implementar un contador. Si no hay dato autoritativo, mostrar `desconocido`; no inventar `15 menos publicados hoy` ni un reset a medianoche.
  - El plan offline marca capacidad remota como no comprobada. El preflight de ejecución muestra consecuencias conocidas: cupo disponible, diferimiento por cuota o capacidad desconocida; revalida antes de escribir.
  - Ofrecer política explícita del lote: permitir cola del proveedor o exigir cupo de envío sin diferimiento por cuota. En la segunda opción, bloquear antes del submit afectado si no se puede probar capacidad. Ninguna opción garantiza publicación instantánea: puede haber procesamiento o moderación posteriores.
  - Reutilizar la cola ya aceptada; no añadir una cola local ni programar otro POST. Las fechas son estimaciones del proveedor, no garantía de hora exacta.
- **End State:** fixtures de cupo suficiente, agotado, desconocido y cambios concurrentes producen planes honestos y nunca clasifican pendientes como publicados.
- **Verification:** mocks de límites y respuestas de cola, reloj fijo y regresión 207. Un preflight no genera uploads ni POST.
- **Dependencies:** etapas 1 y 2. La disponibilidad de datos de cuota es una investigación breve dentro de esta etapa, no una garantía asumida.

### 4. Selección parcial y gasto comprensibles — prioridad media

- **Context:** el reporte v1 mezcla entradas detenidas con evaluaciones fallidas, y reserva histórica con dinero que sigue retenido.
- **Files:** schemas, specs, pipeline y tests de clip-selection.
- **Action:**
  - Diseñar resultado v2 con lifecycle explícito: evaluado, no evaluado/detenido, fallo comprobado e intento incierto; mantener clasificación editorial separada del estado de ejecución.
  - Mantener lectura de v1 y no reescribir la evidencia histórica. Versionar schemas/reportes y cualquier cambio de rúbrica; no cambiar digests/claves para saltarse submit-once o perder cache.
  - Mostrar gasto confirmado, reserva abierta del ledger y reservas históricas con nombres distintos. Calcular el estado actual a partir del último evento por intento, no sumando todo el journal.
  - Conservar la parada del gasto tras resultado incierto. No continuar la evaluación pagada ni liberar reservas sin evidencia.
  - Mostrar claramente si la selección final fue automática completa, parcial o editorial local.
- **End State:** fixture de 500 candidatos con nueve respuestas válidas, un intento incierto y 490 sin evaluar muestra esos tres grupos; el ledger conserva exactamente su intento abierto.
- **Verification:** tests de schemas v1/v2, render de reporte, cache, deadline antes/durante submit, contabilidad y ranking que excluya entradas sin evaluación. Cero llamadas reales.
- **Dependencies:** ninguna dependencia técnica de publicación; ejecutar después del núcleo prioritario para limitar cambios simultáneos.

### 5. Piloto editorial y QA antes del render masivo — prioridad media

- **Context:** es mejor demostrar calidad de transcript/rúbrica y montaje con una muestra que desplegar cientos de evaluaciones de entrada.
- **Files:** pipeline/specs de selección, sus tests y guía de creator. Reutilizar contratos de QA y aprobación existentes.
- **Action:**
  - Primera entrega sin flags nuevos: receta de piloto con `maxCandidates` reducido a 5–10, ejemplos positivos/negativos revisados, contentType correcto y presupuesto explícito. Primero fixtures offline; piloto pagado solo tras autorización y gates de gasto elegibles.
  - Evaluar retención de premisa, autonomía, remate y fidelidad. Fijar criterios antes de escalar; una muestra pequeña no demuestra calibración global ni viralidad.
  - Revisar segmentos ASR dudosos contra audio real; no asumir que un modelo mayor siempre basta. No quemar subtítulos dudosos en el final.
  - EDL con evidencia de inicios/cierres y cambios de layout. Usar un render de muestra antes del resto; no generalizar el seam y coordenadas específicos de POPER TV a otros videos.
  - Agregar fixtures para límites de palabra, reacción conservada, cambios de cámara y elección de encuadre seguro; evitar un rediseño completo del renderer en esta etapa.
- **End State:** piloto guardado con decisiones editoriales, muestra de montaje inspeccionable y checks de cortes/layout; el render masivo queda condicionado a la aprobación de la muestra cuando esa política esté activa.
- **Verification:** fixtures offline de casos positivos/negativos y QA sobre medios locales; ninguna evaluación/render de pago o nueva publicación como parte del test automático.
- **Dependencies:** etapa 4 para reportes claros. Una ejecución sobre material real mantiene sus propios gates y autorizaciones.

### 6. Preflight operativo y salida de revisión estable — prioridad media/baja

- **Context:** el acceso a credenciales y el preview no deberían fallar después de iniciar efectos costosos.
- **Files:** preflight de creator/batch, guía del workflow y seam de preview cuando se formalice; preservar contratos de credentials.
- **Action:**
  - Verificar acceso a los proveedores necesarios en un preflight de ejecución explícito y no mutante, antes de uploads/POST. Resolver secretos por las vías existentes, sin imprimirlos ni persistirlos.
  - Reportar por separado falta de credencial, error TLS, cuenta incorrecta y cuota desconocida. Mantener validación TLS; ajustes de confianza global, infraestructura o instalación requieren autorización aparte.
  - Mantener la corrección del preview: metadatos frescos por request, HTML completo al cambiar su tamaño, soporte Range y whitelist de archivos finales. No exponer source, journals, transcripciones o secretos.
  - Publicar resumen sanitizado con enlaces y fecha de comprobación, sin IDs/journals privados; no prometer monitoreo automático si no existe un servicio configurado.
- **End State:** fallos de credencial/TLS se informan antes del submit; el preview sirve dos versiones de tamaño distinto completas y permite seeking sin exponer archivos privados.
- **Verification:** transportes falsos, cero POST ante preflight fallido, ausencia de secretos en logs, pruebas HTTP locales de tamaño cambiante/206/404 y enlace remoto solo por Tailscale cuando se habilite una preview real.
- **Dependencies:** etapa 2 para salida uniforme. No es necesario tocar infraestructura para cubrir los tests.

## Risks and Edge Cases

- HTTP 207 con resultados mixtos: no promover todo el post a publicado ni descartar su ID.
- 202/2xx sin receipt: conservar incertidumbre; ningún retry automático.
- Lista de posts no filtrada o paginada: una coincidencia débil o ambigua no prueba identidad.
- La capacidad puede cambiar tras preflight; el manejo de cola sigue siendo necesario.
- Texto de error puede cambiar de idioma/formato. No basar decisiones destructivas o garantías de scheduling en una regex sobre el mensaje.
- Un error global de cuenta/servicio no justifica seguir enviando sin límite a los demás clips de esa misma cuenta.
- Cambios de schema no deben invalidar cache para reenviar llamadas pagadas ya realizadas ni reinterpretar un intento incierto como gratuito.
- Aprobación o medio cambiado durante el batch: detener la unidad antes de POST; nunca reemplazar su digest silenciosamente.
- Snapshot histórico de status puede quedar viejo: mostrar checkedAt y exigir GET para confirmar publicación final.

## Validation Strategy

### Baseline actual, ya ejecutado

```bash
bun test packages/providers/src/zernio/publish.test.ts packages/cli/src/creator/workflow.test.ts packages/schemas/src/clip-selection.test.ts packages/cli/src/pipeline/clip-selection.test.ts packages/cli/src/specs/clip-selection.test.ts
```

Resultado: **52 pass / 0 fail / 366 assertions**. Son fixtures offline, no publicaciones reales.

### Después de cada bloque aprobado

- Ejecutar una vez los tests focalizados de archivos cambiados y las regresiones existentes relacionadas; no reparar fallos ajenos al alcance.
- Para el núcleo: nuevo fixture 8×3, HTTP 207, GET de reconciliación, dos comandos resume y concurrencia; cada clave mantiene a lo sumo un POST.
- Para selección: fixture parcial y lector v1; conservar hashes de cache/ledger y no cerrar el intento incierto.
- Dry-run: snapshots de filesystem antes/después iguales, cero fetch, cero secretos, cero uploads y cero submit.
- Al integrar cambios de contratos/CLI: `bun run build` como comprobación de tipos/compilación, después de inspeccionar que el script siga siendo únicamente build.
- Validación live es una operación separada: primero consultas GET autorizadas; cualquier nueva publicación o evaluación pagada requiere material, destinos y presupuesto explícitos.

## Open Questions

1. ¿Qué contrato documentado ofrece Zernio para cupo restante/reset/retry de la cuenta TikTok? Hasta confirmarlo, la capacidad se informa como desconocida.
2. ¿Qué evidencia de correlación ofrece el proveedor además de remoteId y payload? Verificar semántica del lookup por clave y paginado antes de habilitar fallback automático.
3. ¿Qué mecanismo de reconciliación de Typesafe hay disponible? No asumir endpoints de usage/requests ni fabricar un receipt de cobro.
4. ¿Qué calidad editorial mínima exigiremos al piloto? Propuesta inicial: diez ejemplos etiquetados, revisión de falsos positivos y muestra audiovisual; no presentar ese tamaño como validación estadística.
5. ¿Se necesita seguimiento programado de pendientes? Primera entrega: consulta manual GET. Una tarea automática, notificaciones o servicio persistente se planifica y autoriza aparte.

## Propuesta para aprobar

- **Primer bloque recomendado:** etapas 1 y 2 — receipts correctos y batch recuperable. Entrega útil y verificable sin nuevas publicaciones reales.
- **Segundo bloque:** etapa 3 — cuotas y política de cola, condicionada a confirmar el contrato del proveedor.
- **Tercer bloque:** etapas 4 y 5 — selección parcial clara y piloto editorial/QA.
- **Complemento operativo:** etapa 6, sin cambios globales de infraestructura.

Los seis bloques quedaron implementados y verificados. La propuesta inicial permanece arriba como contexto y secuencia de trabajo; los límites de operaciones reales siguen vigentes.

## Resultado de la orquestación

| Bloque | Resultado verificado |
|---|---|
| Receipts y reconciliación | Estados por cuenta/perfil/plataforma, IDs conservados en incertidumbre, lookup paginado y ausencia no autoritativa sin liberar intents. |
| Batch | Cinco comandos registrados; fixture 8×3 con 22 publicados y dos pendientes, crash/resume/concurrencia y dry-run sin efectos. Ninguna clave duplica POST. |
| Preflight | Errores credential/TLS/identity/capability/quota/network separados; política de cola explícita y capacidad desconocida sin inventar contador o reset. |
| Selección V2 | Lectura V1/cache compatible, fixture 9 evaluadas + 1 incierta + 490 no evaluadas y retry sin nuevas llamadas; gasto confirmado, abierto e histórico separados. |
| Piloto/QA | Policy opcional, evidencia ligada a fuente/transcript/decisiones/frames/muestra, ejemplos revisados y gate antes de no-muestras; demo sintético local de cuatro segundos generado e inspeccionado. |
| Review/documentación | Snapshot público sanitizado con checkedAt/manual refresh, HTML fresco, seeking 206 y whitelist final-only; guía operativa actualizada. |

### Gates finales ejecutados

```bash
env -i PATH="$PATH" HOME=/nonexistent TMPDIR="${TMPDIR:-/tmp}" bun --no-env-file --no-install test
bun run build
git diff --check
```

Resultado: **1782 pass / 0 fail / 14876 assertions / 99 archivos**. El build es únicamente `tsc --noEmit -p tsconfig.build.json`.

Las revisiones de seguridad cerraron receipts sin identidad, carreras de symlinks de ancestros y navegación externa en HTML de review. El preview usa descriptores fijados con no-follow en Linux, sanitiza navegación con HTMLRewriter y mantiene íntegros los bytes sellados. La revisión final no encontró hallazgos altos/medios pendientes dentro de su alcance.

### Límites que permanecen

- Capacidad numérica/reset siguen siendo desconocidos por defecto: no se habilitó un endpoint de cuota inventado. `require-capacity` exige evidencia confirmada del adapter read-only.
- El intento incierto de Typesafe no se cerró, reembolsó ni repitió; la contabilidad solo proyecta evidencia existente.
- La muestra sintética usa formas y un tono; no prueba escucha humana, ASR real, calibración o viralidad. El piloto sobre material real necesita su revisión y autorización propias.
- No se hicieron publicaciones, evaluaciones pagadas, cambios de infraestructura ni commits. No se inició un servidor de preview ni seguimiento automático.

Guía de uso y recuperación: [`docs/creator-workflow.md`](../docs/creator-workflow.md). Muestra local: [`demo/creator-pilot/generated/sample.mp4`](../demo/creator-pilot/generated/sample.mp4); su fuente privada no forma parte de la whitelist.
