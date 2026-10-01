# Operación · creative-workspace

## Estado de esta entrega
Se prepararon el plan, contrato, seis fases, overlay, bootstrap, goal y launcher. El DAG se registra en climier mediante batch atómico; consultar estado vivo con el comando de abajo. Esta entrega NO implementa código de aplicación, NO inicia OMP/workers/servicios y NO prueba ni sube nada a R2. Las verificaciones de implementación descritas en las fases todavía no han sido ejecutadas; son criterios del trabajo futuro.

Fuente de perfiles: `models.yml`; enlace en `~/code/dotfiles/omp/profiles/video-maker-studio.yml`. El perfil se aplica por run, no cambia sesiones ya abiertas. No se modifican perfiles/launchers/objetivos anteriores.

## 1. Inspección/preflight (read-only)

Desde la raíz del repo:

```bash
node /home/leobar37/.agents/skills/planner/scripts/planner-checklist.js goal-check creative-workspace
bash -n .plans/creative-workspace/orchestration/launch.sh
.plans/creative-workspace/orchestration/launch.sh --print
climier status --initiative creative-workspace --all
climier context T-CW-001
```

`--print` valida binarios, archivos, goal de una línea iniciado por orchestrate y IDs contra catálogo vivo. Imprime el prompt, no abre una sesión. Un modelo existente no prueba cuotas o disponibilidad futura; si provider falla al ejecutar, no cambiar silenciosamente de modelo.

## 2. Registrar el DAG (solo si aún no se registró)

```bash
climier batch --file .plans/creative-workspace/orchestration/dag-batch.json --as plan-author
```

Efecto: crea UNA iniciativa, DOS gates y SEIS tasks en el estado local existente de climier. No ejecutar `climier init --force`. Batch es atómico pero NO asumir reejecución idempotente: si iniciativa/IDs existen, inspeccionar history/state y no reseed/reset automático. No toca R2 ni crea infraestructura.

## 3. Autorizar y lanzar implementación (OPERADOR)

Revisar `goal.md`, `contracts.md` y `phase-index.md`. Resolver gate solo si se quiere empezar a construir:

```bash
climier resolve G-cw-implement --choice approved --rationale "Apruebo contrato y seis fases; solo implementación y tests locales, sin R2 live ni exposición duradera" --as leobar37
.plans/creative-workspace/orchestration/launch.sh
```

Efectos: resolve modifica metadata local; launch abre sesión OMP y puede consumir cuota del proveedor de modelos. El bootstrap permite edits/tests de aplicación únicamente si gate está aprobado. No aprobar gates desde agentes ni presentar estos comandos como ya ejecutados.

Modelo main GLM-5.3; workers P-001/002/004/006 GLM-5.3, P-003/005 Flash. Roles del overlay no asignan fases automáticamente: coordinador verifica `set_model`/estado exacto antes de cada prompt. Vision Flash; GLM no soporta imágenes. Orden serial y un worker mutable por seguridad de integración.

## 4. Prueba R2 (otra autorización humana, no heredada)

Cuando existan scripts offline y se haya revisado el inventario del fixture:

```bash
climier resolve G-cw-live-r2 --choice approved --rationale "Autorizo requests/uploads de fixture privado <=20MiB en namespace único, sin delete, IA, publicación ni exposición pública" --as leobar37
```

Después, P-006 ejecuta `bun run studio:verify:r2`. Este script se crea durante implementación; no existe todavía. Solo usa buckets actuales; no setup, DB, migración o contenedores. Si no se autoriza, fase/goal quedan blocked; nunca cambiar el DoD a fake. Un límite de bytes de fixture no garantiza coste monetario máximo: operador puede exigir además presupuesto de requests o interrupción manual.

Arrancar dashboard duradero o compartirlo también requiere autorización del operador. El comando futuro `dashboard serve --host 0.0.0.0 --access trusted-tailnet` declara acceso de red de confianza, no auth pública. Antes de compartir, comprobar Tailscale IPv4 y listener all-interface; no links localhost. No arrancarlo al preparar este plan.

## 5. Ciclo de task y validación

```bash
climier take T-CW-001 --as CW:P-001
# Trabajar exclusivamente fase/contrato; correr verification al finalizar.
climier submit T-CW-001 --note "Archivos, requisitos, comandos y exit codes verificables" --as CW:P-001
# Coordinador reproduce verification personalmente antes de:
climier accept T-CW-001 --as coordinator
```

Repetir por ID real. Fallo propio => corregir/retest; fallo ajeno => add-note sin scope creep. No aceptar con cero tests, promesas, buffer o screenshot sin revisión. Sin live verde no aceptar P-006. Coordinar exportaciones/registry/lockfile sin solapar writers.

## 6. Reanudación y cierre

```bash
climier status --initiative creative-workspace --all
climier history T-CW-001
.plans/creative-workspace/orchestration/launch.sh
```

El estado persiste en climier; sesión nueva retoma task READY y no rehace accepted/submitted. Preservar cambios existentes del repo. Fase frontmatter refleja claim/accept/bloqueos; no es sustituto de la validación.

Presupuesto: 120 turnos de workers o 8 horas por sesión. Agotado => nota, release y budget-limited, nunca completed. Cierre completo exige `studio:verify`, `studio:verify:r2` y build exit 0, restore remote-only por SHA de dos revisiones imagen/Remotion, evidencia desktop/mobile y seis tasks accepted. `validation.json` de esta carpeta solo valida EL PLAN/CONFIG; no prueba que la aplicación esté implementada.
