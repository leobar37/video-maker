# Runbook · preparación para orchestrate-session

## Estado actual
Plan operativo en el worktree customer-assets-portal, iniciativa sembrada en Climier con seis tasks. Consultar `climier status/context/history` al retomar: los estados y aprobaciones de una captura anterior no sustituyen el registro vigente. Perfil `models.yml`: GLM-5.3 orquestador y GLM-5.3-Flash para todos los workers. Sesión existente en Herdr `cap-orchestrator`, pane `w7R:p1`; no relanzar ni repetir baseline por conveniencia. Cada autorización cubre solo su inventario y límites; este runbook no aprueba infraestructura, schemas, proveedores, email ni deploy. `decisions.json` NO usa schema match/action del supervisor.

## 1. Validar plan (read-only)
Desde raíz:
```sh
node /home/leobar37/.agents/skills/planner/scripts/planner-checklist.js goal-check customer-assets-portal
climier status --initiative customer-assets-portal --all
```
Validación de planificación vive aquí en `validation.json`; NO prueba la aplicación ni gates aprobados. Inspeccionar links, DAG acíclico y acceptance contra fases además del goal-check.

## 2. DAG ya registrado (no repetir batch)
```sh
climier batch --file .plans/customer-assets-portal/orchestration/dag-batch.json --as plan-author
```
Efecto: metadata local de una iniciativa, tres gates y seis tasks. Inspeccionar estado antes de correr, no re-seed si IDs existen; no reset ni `init --force`. Si no existe estado local, revisar primero setup climier y pedir inicialización cuando corresponda. Batch no aprueba gates ni inicia código.

## 3. Preparar y autorizar sesión
- Revisar goal/contracts/decisions con operador; confirmar ownership de cambios existentes.
- Perfil elegido por operador en `models.yml`: `zai/glm-5.3:high` coordina y `zai/glm-5.3-flash:high` ejecuta TODAS las fases; asignar explícitamente Flash al arrancar cada worker, no heredar default. Launcher impone modelo main, thinking high, desactiva prewalk y limita sesión a 8h; ese tope no autoriza gasto o infraestructura.
- Comprobar provider/model con `omp models <provider> --json`; catálogo de otra fecha o fuzzy match no sirve. Si modelo no disponible, detener/reportar, no sustituir.
- Preflight reproducible: `bash -n .plans/customer-assets-portal/orchestration/launch.sh && bash .plans/customer-assets-portal/orchestration/launch.sh --print`. Verifica modelos y objetivo; no inicia sesión ni modifica gates.
- Operador resuelve G-cap-implement y G-cap-local antes de implementar/probar DB (el segundo incluye schemas de fixture y runtime emulado). Lanzar la sesión no los aprueba; el orquestador debe informar bloqueo y esperar sin polling.
- Inicio autorizado en Herdr: `herdr pane run w7R:p1 "bash .plans/customer-assets-portal/orchestration/launch.sh"`. Ejecutar solo con shell disponible en el worktree; inicia OMP con perfil explícito y puede consumir cuota. No crear grid o panes extra por defecto.

## 4. Trabajar y validar
```sh
climier context T-CAP-001
climier take T-CAP-001 --as CAP:P-001
# fase y pruebas autorizadas
climier submit T-CAP-001 --note 'Evidence path, commands, exits y counts' --as CAP:P-001
# solo coordinator tras reproducir:
climier accept T-CAP-001 --as coordinator
```
Repetir por IDs reales. Sin permission/schema emulado, P-001 blocked. Sin permission live, P-006 blocked y goal NO completed. Keep frontmatter al día con claims/evidencia, sin nuevas features por presupuesto.

### Política de ejecución eficiente · enmienda del operador
- **Retomar, no reiniciar.** Consultar la task activa y sus notas; no reabrir fases accepted ni repetir sus verificaciones sin una regresión o un cambio relevante. Mantener gates, modelos, ownership y acceptance vigentes.
- **Una ejecución, un resultado.** Conservar stdout/stderr, código de salida real, comando, revisión/diff y firma del fallo en un artefacto o log único por ejecución. Leer ese resultado con read/grep; nunca relanzar una suite solo para cambiar tail/grep/sed. Una pipeline debe conservar el exit del proceso probado (pipefail o captura explícita), no el del filtro.
- **Un runner activo.** Worker y coordinator no ejecutan verificaciones simultáneas contra el mismo puerto, fixture o `.state`. Si una herramienta devuelve un job en background, esperar su evento de finalización antes de otro lanzamiento; no polling ni sleeps auxiliares. No usar pkill amplio, borrar estado compartido o arrancar otro servidor para sortear la espera.
- **Implementar antes de validar.** No ejecutar build/lint/tests/formatters a mitad de implementación. Al terminar una corrección, comprobar primero el caso afectado; ejecutar el acceptance completo una vez por responsable (worker y coordinator) al cierre, sin añadir suites ajenas ni checks redundantes. No omitir ningún comando exigido por el acceptance vigente. Si falta un filtro, usar un repro mínimo dentro del harness existente, no construir otro sistema de pruebas.
- **Cortar el bucle, no fabricar verde.** Dos fallos consecutivos con la misma firma sin evidencia nueva, o 15 minutos de diagnóstico sin avance, requieren nota `Q:` con repro, log/exit, cambios intentados y siguiente hipótesis concreta. No lanzar otro intento automático; pausar solo la corrección afectada hasta acordar el siguiente paso. Un timeout de presupuesto nunca significa accepted.
- **Diagnóstico acotado.** Reutilizar el worker dueño de la regresión; no crear agentes para reintentos o fixtures. No alterar permisos ni debilitar assertions para pasar. Conservar autenticación, aislamiento entre clientes, archivos privados, revocación e integridad.
- **Contexto y progreso.** Tras un hito verificado o antes de compactar, dejar un checkpoint breve: resultado, archivos, comando/exit, bloqueo y siguiente acción, con links a logs en vez de volcarlos completos. Leer fase activa y secciones normativas pertinentes; no releer todo el plan ni todos los logs en cada turno.
- **Una integración reutilizable.** P-005 reutiliza el harness y la evidencia browser de P-004 y añade solo el recorrido CLI/Studio y negativas faltantes; no crea una segunda suite equivalente. P-006 prueba únicamente el smoke live autorizado, sin repetir offline mientras espera una dependencia externa. Un email/proveedor pendiente se reporta como decisión externa, no como fallo que se resuelve con más tests.

Esta enmienda cambia la forma de ejecutar, no el estado ni los criterios de aceptación de las fases ya registradas. No completar E2E fallidos ni responder un diálogo de autorización en nombre del operador.

## 5. Gate live después del milestone offline
Revisar inventario en apps/customer-assets/ops (creado por P-005), cuenta/zona, Worker, DB, bucket privado aislado, SQL exacto, sender/recipient, secrets/domain, presupuesto de requests/emails/bytes, y rollback. Humano resuelve G-cap-live. No un consentimiento genérico heredado del backup Studio. P-006 ejecuta solo ese inventario/smoke, ningún delete/IA/publicación.

## 6. Networking y cierre
Preview de workstation solo Tailscale IPv4 verificada con `tailscale ip -4`, listener all-interface con `ss -tlnp`; no compartir loopback ni exponer viewer legacy a Internet. Si tailnet no activo informar antes de cualquier exposición. El dominio público del portal usa HTTPS tras deploy autorizado y smoke; no decir que existe antes.

Cierre total: seis tasks accepted, verification de goal exit 0 offline/live, screenshots desktop/móvil revisados y logs redacted. Offline completo y permiso nube pendiente se reporta como hito, no DoD completo.
