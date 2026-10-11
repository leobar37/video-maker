# Operación · serie-sabias-que

## Estado de esta entrega
Se prepararon el plan, contrato, seis fases, serie creativa (`series.md`), overlay, bootstrap, goal,
launcher y ancla. **No** se implementó código de aplicación, **no** se ejecutó TTS/fal, **no** se
renderizó ni publicó nada. Las verificaciones de las fases son criterios del trabajo futuro.

Fuente de modelos: `models.yml` → enlace `~/code/dotfiles/omp/profiles/serie-sabias-que.yml`. El perfil se
aplica por run (`--config`), no cambia sesiones abiertas. Los gates solo los resuelve el operador.

## 1. Inspección / preflight (read-only)

```bash
cd /home/leobar37/code/video-maker
node /home/leobar37/.agents/skills/planner/scripts/planner-checklist.js goal-check serie-sabias-que
bash -n .plans/serie-sabias-que/orchestration/launch.sh
.plans/serie-sabias-que/orchestration/launch.sh --print
climier status --initiative serie-sabias-que --all
climier context T-SSQ-001
```

`--print` corre el preflight completo (binarios, archivos, goal de una línea iniciado por `orchestrate`,
anti fuzzy-match de los modelos). Imprime el prompt, no abre sesión.

## 2. Registrar el DAG (solo si aún no se registró)

```bash
climier batch --file .plans/serie-sabias-que/orchestration/dag-batch.json --as plan-author
```

Crea UNA iniciativa, DOS gates y SEIS tasks. No ejecutar `climier init --force`. Batch es atómico pero no
idempotente: si la iniciativa/IDs ya existen, inspeccionar `history`/`status` y no reseed.

## 3. Autorizar y lanzar implementación (OPERADOR)

```bash
climier resolve G-start --choice approved --rationale "Apruebo contract y 6 fases; solo implementación local sin gasto" --as leobar37
.plans/serie-sabias-que/orchestration/launch.sh            # worker en pane herdr (default)
```

Efectos: `resolve` cambia metadata local; `launch.sh` abre un pane herdr, arranca un agente OMP con el
overlay y le manda el prompt con el goal. **Requiere `HERDR_ENV=1`**; sin herdr usá `--no-herdr` (exec en
tu TTY). No lanzar dentro de Docker ni sin autorización.

## 4. Autorizar gasto real (otra decisión humana, no heredada)

```bash
climier resolve G-ai-spend --choice approved --rationale "Autorizo TTS ElevenLabs + fal con tope US$X" --as leobar37
```

Después, P-003 (`vm gen-media --spend-cap`) y P-004 (`vm gen-audio --spend-cap`) pueden correr. Sin este
gate esas fases quedan `blocked`; P-002 (motion gratis) sigue válido. Nunca cambiar el DoD ni usar fakes.

## 5. Ciclo de task y validación

```bash
climier take T-SSQ-001 --as orq:P-001
# trabajar la fase completa; correr verification al finalizar
climier submit T-SSQ-001 --note "archivos, comandos + exit codes" --as orq:P-001
climier accept T-SSQ-001 --as coordinator   # tras reproducir el acceptance personalmente
```

Repetir por ID real. Fallo propio => corregir/retest; fallo ajeno => `add-note` sin scope creep.

## 6. Enlace de revisión

P-006 levanta `0.0.0.0:7099` con los seis MP4. Verificación:

```bash
ss -tlnp | grep 7099
curl -sI "http://$(tailscale ip -4):7099/" | head -1   # HTTP 200/206
```

Compartir SIEMPRE `http://<tailscale-ipv4>:7099/`, nunca localhost. Si Tailscale no corre, decirlo y no
caer a loopback.

## 7. Publicación (fuera del plan)
Si más adelante se quiere publicar de verdad: crear/verificar el preset con cuentas reales y usar el
flujo `creator-init → creator-qa → creator-publish` con aprobación específica del render exacto. No es
parte de este goal y no se ejecuta aquí.

## 8. Reanudación y cierre

```bash
climier status --initiative serie-sabias-que --all
climier history T-SSQ-001
.plans/serie-sabias-que/orchestration/launch.sh
```

El estado persiste en climier; una sesión nueva retoma la task READY sin rehacer `submitted`/`done`. Cierre
completo exige `verify-series.ts --stage final` exit 0, `vm qa` verde en los seis, bind `0.0.0.0:7099` con
HTTP 200/206 y seis tasks `accepted`.
