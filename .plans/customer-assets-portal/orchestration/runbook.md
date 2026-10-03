# Runbook · preparación para orchestrate-session

## Estado actual
Plan persistido y batch/bootstrap/goal preparados. NO iniciativa sembrada, NO overlay/launcher nuevo, NO workers, implementación, DB/migraciones, infra ni deploy. Los comandos de aceptación de app/CLI nuevos son futuros. `decisions.json` NO usa schema match/action del supervisor; convertirlo solo al preparar una sesión supervisada, sin inventar permisos.

## 1. Validar plan (read-only)
Desde raíz:
```sh
node /home/leobar37/.agents/skills/planner/scripts/planner-checklist.js goal-check customer-assets-portal
climier status --initiative customer-assets-portal --all
```
Validación de planificación vive aquí en `validation.json`; NO prueba la aplicación ni gates aprobados. Inspeccionar links, DAG acíclico y acceptance contra fases además del goal-check.

## 2. Sembrar DAG local (acción posterior, no ejecutada)
```sh
climier batch --file .plans/customer-assets-portal/orchestration/dag-batch.json --as plan-author
```
Efecto: metadata local de una iniciativa, tres gates y seis tasks. Inspeccionar estado antes de correr, no re-seed si IDs existen; no reset ni `init --force`. Si no existe estado local, revisar primero setup climier y pedir inicialización cuando corresponda. Batch no aprueba gates ni inicia código.

## 3. Preparar y autorizar sesión
- Revisar goal/contracts/decisions con operador; confirmar ownership de cambios existentes.
- Operador fija presupuesto y perfil OMP exacto. Crear overlay/launcher de orchestrate-session específico DENTRO del plan después de esa selección; no editar launcher de creative-workspace ni archivos globales por conveniencia.
- Comprobar provider/model con `omp models <provider> --json`; catálogo de otra fecha o fuzzy match no sirve. Si modelo no disponible, detener/reportar, no sustituir.
- Lanzador con `--print` debe ejecutar preflight y mostrar primera línea `/goal set orchestrate ...` sin arrancar sesión; `bash -n` para shell. Estos artefactos NO están creados todavía.
- Operador resuelve G-cap-implement y G-cap-local tras revisar sus cuerpos (el segundo incluye permiso explícito de schemas de fixture y runtime emulado). Preparar plan no los aprueba.
- Lanzar OMP únicamente después de autorización; lanzamiento puede consumir cuotas de modelo. Herdr no requerido por este plan; no abrir pane/grid por defecto.

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

## 5. Gate live después del milestone offline
Revisar inventario en apps/customer-assets/ops (creado por P-005), cuenta/zona, Worker, DB, bucket privado aislado, SQL exacto, sender/recipient, secrets/domain, presupuesto de requests/emails/bytes, y rollback. Humano resuelve G-cap-live. No un consentimiento genérico heredado del backup Studio. P-006 ejecuta solo ese inventario/smoke, ningún delete/IA/publicación.

## 6. Networking y cierre
Preview de workstation solo Tailscale IPv4 verificada con `tailscale ip -4`, listener all-interface con `ss -tlnp`; no compartir loopback ni exponer viewer legacy a Internet. Si tailnet no activo informar antes de cualquier exposición. El dominio público del portal usa HTTPS tras deploy autorizado y smoke; no decir que existe antes.

Cierre total: seis tasks accepted, verification de goal exit 0 offline/live, screenshots desktop/móvil revisados y logs redacted. Offline completo y permiso nube pendiente se reporta como hito, no DoD completo.
