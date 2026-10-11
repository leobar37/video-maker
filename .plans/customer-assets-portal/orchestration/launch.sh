#!/usr/bin/env bash
# Lanza una sesión OMP para ejecutar un plan con overlay de roles.
# El goal se inyecta de una vez al inicio (/goal set con la keyword "orchestrate").
#
# Preflight (falla ANTES de abrir omp):
#   - omp y climier instalados.
#   - overlay, bootstrap y goal presentes; goal = UNA línea que arranca con "orchestrate".
#   - anti fuzzy-match: cada <provider>/<modelo> del overlay se verifica contra
#     `omp models <provider> --json` (omp hace fuzzy match y resuelve OTRO modelo sin avisar).
#
# Uso:
#   bash .plans/customer-assets-portal/orchestration/launch.sh                  # sesión con goal automático
#   bash .plans/customer-assets-portal/orchestration/launch.sh "haz X"          # agrega una instrucción extra al prompt
#   bash .plans/customer-assets-portal/orchestration/launch.sh --no-goal        # sin goal automático
#   bash .plans/customer-assets-portal/orchestration/launch.sh --print          # imprime el prompt y corre el preflight, sin invocar omp
#   bash .plans/customer-assets-portal/orchestration/launch.sh --skip-model-check  # salta la verificación de modelos (no recomendado)
#
# Variables:
#   OMP_PROFILE   ruta al overlay (default: ~/code/dotfiles/omp/profiles/video-maker-studio.yml)
#   OMP_CATALOG   catálogo de providers (default: ~/code/dotfiles/omp/catalog.json)
#
# ⚠️ OMP_PROFILE/OMP_CATALOG se leen UNA vez y se hacen unset: `omp` interpreta la
# env OMP_PROFILE como NOMBRE de profile (no ruta) y falla con "Invalid OMP profile"
# (trampa verificada). El overlay se pasa SIEMPRE por --config.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROFILE="${OMP_PROFILE:-$REPO_ROOT/.plans/customer-assets-portal/orchestration/models.yml}"
CATALOG="${OMP_CATALOG:-$HOME/code/dotfiles/omp/catalog.json}"
unset OMP_PROFILE OMP_CATALOG
BOOTSTRAP_FILE="$REPO_ROOT/.plans/customer-assets-portal/orchestration/bootstrap.md"
GOAL_FILE="$REPO_ROOT/.plans/customer-assets-portal/orchestration/goal-objective.txt"

PRINT_ONLY=0
WITH_GOAL=1
SKIP_MODEL_CHECK=0
EXTRA=""

usage() {
  sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --print) PRINT_ONLY=1 ;;
    --no-goal) WITH_GOAL=0 ;;
    --skip-model-check) SKIP_MODEL_CHECK=1 ;;
    -h|--help) usage ;;
    *)
      if [[ -n "$EXTRA" ]]; then
        echo "error: se esperaba como máximo un argumento libre (instrucción extra), recibí: $1" >&2
        exit 2
      fi
      EXTRA="$1"
      ;;
  esac
  shift
done

die() { echo "error: $*" >&2; exit 1; }

# --- Preflight 1: binarios ---------------------------------------------------
command -v omp >/dev/null 2>&1 || die "omp no está instalado (command -v omp falló)"
command -v climier >/dev/null 2>&1 || die "climier no está instalado (command -v climier falló)"
command -v python3 >/dev/null 2>&1 || die "python3 no está instalado (lo usa el check de modelos)"

# --- Preflight 2: archivos ---------------------------------------------------
[[ -f "$PROFILE" ]] || die "no existe el overlay: $PROFILE"
[[ -f "$BOOTSTRAP_FILE" ]] || die "no existe el prompt bootstrap: $BOOTSTRAP_FILE"
if [[ "$WITH_GOAL" -eq 1 ]]; then
  [[ -f "$GOAL_FILE" ]] || die "no existe el objetivo del goal: $GOAL_FILE"
fi

# --- Preflight 3: goal = UNA línea que arranca con "orchestrate" -------------
if [[ "$WITH_GOAL" -eq 1 ]]; then
  [[ -s "$GOAL_FILE" ]] || die "$GOAL_FILE está vacío"
  GOAL_LINES="$(grep -c "" "$GOAL_FILE")"
  [[ "$GOAL_LINES" -eq 1 ]] || die "$GOAL_FILE debe tener UNA sola línea (tiene $GOAL_LINES); el /goal set no soporta multilínea"
  FIRST_WORD="$(awk 'NR==1{print $1; exit}' "$GOAL_FILE")"
  [[ "$FIRST_WORD" == "orchestrate" ]] || die "$GOAL_FILE debe arrancar con la keyword 'orchestrate' (arranca con '$FIRST_WORD')"
fi

# --- Preflight 4: anti fuzzy-match de modelos del overlay --------------------
# Extrae pares <provider>/<modelo> de las líneas "rol: provider/modelo[:thinking]".
# Verifica cada provider y su modelo exacto contra `omp models <provider> --json`.
if grep -qE '<(provider|modelo)' "$PROFILE"; then
  die "$PROFILE contiene placeholders sin completar (<provider>/<modelo>): llená los IDs reales antes de lanzar"
fi

extract_pairs() {
  sed -E -n 's/^[[:space:]]*[A-Za-z_][A-Za-z0-9_-]*:[[:space:]]+([^#[:space:]]+).*/\1/p' "$PROFILE" \
    | grep -E '^[A-Za-z0-9_.:-]+/[A-Za-z0-9_.-]+(:[A-Za-z0-9]+)?$' \
    | sed -E 's/:[A-Za-z0-9]+$//' \
    | sort -u
}

check_one() { # $1 = provider/modelo
  local pair="$1" provider model models_json
  provider="${pair%%/*}"
  model="${pair#*/}"
  models_json="$(omp models "$provider" --json 2>/dev/null)" \
    || die "$pair: 'omp models $provider --json' falló (¿provider inexistente o broker caído?)"
  printf '%s' "$models_json" | PROVIDER="$provider" MODEL="$model" python3 -c '
import json, sys, os
provider, want = os.environ["PROVIDER"], os.environ["MODEL"]
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit("  ✗ %s/%s: salida no-JSON de omp models" % (provider, want))
models = data.get("models", []) if isinstance(data, dict) else []
ids = sorted({m.get("id") for m in models if m.get("id")})
if not ids:
    sys.exit("  ✗ %s/%s: el provider %r no tiene modelos en el catálogo (¿existe? ¿está autenticado en catalog.json?)" % (provider, want, provider))
if want in ids:
    print("  ✓ %s/%s" % (provider, want), file=sys.stderr)
    sys.exit(0)
sys.exit("  ✗ %s/%s: el modelo NO existe en el provider. Disponibles: %s\n  ⚠ omp haría fuzzy match y cargaría OTRO modelo sin avisar." % (provider, want, ", ".join(ids)))
' || die "preflight de modelos falló — corregí $PROFILE o lanzá con --skip-model-check (no recomendado)"
}

if [[ "$SKIP_MODEL_CHECK" -eq 1 ]]; then
  echo "preflight: verificación de modelos SALTADA (--skip-model-check); revisá la status line al arrancar" >&2
else
  MODEL_PAIRS="$(extract_pairs || true)"
  if [[ -z "$MODEL_PAIRS" ]]; then
    die "el overlay no declara pares provider/modelo verificables"
  else
    echo "preflight: verificando modelos del overlay contra omp..." >&2
    while IFS= read -r pair; do
      [[ -z "$pair" ]] && continue
      check_one "$pair"
    done <<< "$MODEL_PAIRS"
  fi
fi

# --- Advertencia suave: DAG sin sembrar --------------------------------------
if [[ ! -f "$REPO_ROOT/.climier.json" ]]; then
  echo "aviso: no hay .climier.json en $REPO_ROOT (¿corriste 'climier init' y sembraste el DAG?)" >&2
fi

PROMPT=""

# 1. Goal de una vez: /goal set con el objetivo en una sola línea.
if [[ "$WITH_GOAL" -eq 1 ]]; then
  GOAL_OBJECTIVE="$(tr -d '\n' < "$GOAL_FILE")"
  PROMPT="/goal set ${GOAL_OBJECTIVE}"
fi

# 2. Bootstrap de la sesión (identidad, plan, reglas de climier).
if [[ -n "$PROMPT" ]]; then
  PROMPT="$PROMPT

$(cat "$BOOTSTRAP_FILE")"
else
  PROMPT="$(cat "$BOOTSTRAP_FILE")"
fi

PROMPT="$PROMPT

## Autorización de esta sesión
El usuario pidió lanzar el script en el primer pane de Herdr. Autorizado iniciar esta sesión y coordinar el plan. No resolver gates humanos ni inferir permiso de migraciones por arrancar OMP. Consultar gates antes de implementar; si están cerrados, informar el permiso concreto requerido y esperar sin hacer polling ni auto-resolve. Mantener toda ejecución en este worktree. TODOS los workers deben usar zai/glm-5.3-flash:high explícitamente. Tope de esta sesión 8 horas, nunca completed por presupuesto. No Docker, DB real/emulada con schema aplicado, R2/email live, DNS ni deploy sin el gate humano correspondiente."

# 3. Instrucción extra del operador.
if [[ -n "$EXTRA" ]]; then
  PROMPT="$PROMPT

## Instrucción adicional del operador
$EXTRA"
fi

if [[ "$PRINT_ONLY" -eq 1 ]]; then
  echo "=== profile: $PROFILE ==="
  echo "=== cwd:     $REPO_ROOT ==="
  echo "=== prompt ==="
  echo "$PROMPT"
  exit 0
fi

echo "launch: orquestador=zai/glm-5.3:high workers=zai/glm-5.3-flash:high cwd=$REPO_ROOT" >&2
exec omp --config "$PROFILE" --model zai/glm-5.3 --thinking high --no-prewalk --max-time 8h --cwd "$REPO_ROOT" "$PROMPT"
