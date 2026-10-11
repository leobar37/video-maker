#!/usr/bin/env bash
# Lanza la sesión OMP del plan serie-sabias-que con overlay de roles
# (xiaomi-token-plan-sgp/mimo-v2.6-pro orquestador, .../mimo-v2.6-flash worker).
# El goal se inyecta de una vez al inicio (/goal set con la keyword "orchestrate").
#
# Preflight (falla ANTES de abrir omp):
#   - omp y climier instalados.
#   - overlay, bootstrap y goal presentes; goal = UNA línea que arranca con "orchestrate".
#   - anti fuzzy-match: cada <provider>/<modelo> del overlay se verifica contra
#     `omp models <provider> --json`.
#
# Uso:
#   .plans/serie-sabias-que/orchestration/launch.sh                  # worker en pane herdr (default)
#   .plans/serie-sabias-que/orchestration/launch.sh --print          # preflight + prompt, sin invocar omp
#   .plans/serie-sabias-que/orchestration/launch.sh --no-herdr       # exec en tu TTY
#   .plans/serie-sabias-que/orchestration/launch.sh --no-goal        # sin goal automático
#   .plans/serie-sabias-que/orchestration/launch.sh --skip-model-check
#   .plans/serie-sabias-que/orchestration/launch.sh --agent-name orch-x --initiative serie-sabias-que
#
# Variables:
#   OMP_PROFILE   overlay (default: ~/code/dotfiles/omp/profiles/serie-sabias-que.yml)
#   OMP_CATALOG   catálogo de providers (default: ~/code/dotfiles/omp/catalog.json)
#
# ⚠️ OMP_PROFILE/OMP_CATALOG se leen UNA vez y se hacen unset: `omp` interpreta la
# env OMP_PROFILE como NOMBRE de profile (no ruta). El overlay se pasa SIEMPRE por --config.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROFILE="${OMP_PROFILE:-$HOME/code/dotfiles/omp/profiles/serie-sabias-que.yml}"
CATALOG="${OMP_CATALOG:-$HOME/code/dotfiles/omp/catalog.json}"
unset OMP_PROFILE OMP_CATALOG
BOOTSTRAP_FILE="$REPO_ROOT/.plans/serie-sabias-que/orchestration/bootstrap.md"
GOAL_FILE="$REPO_ROOT/.plans/serie-sabias-que/orchestration/goal-objective.txt"

PRINT_ONLY=0
WITH_GOAL=1
SKIP_MODEL_CHECK=0
HERDR_MODE=1
AGENT_NAME=""
INITIATIVE=""
EXTRA=""

usage() {
  awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "${BASH_SOURCE[0]}"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --print) PRINT_ONLY=1 ;;
    --no-goal) WITH_GOAL=0 ;;
    --skip-model-check) SKIP_MODEL_CHECK=1 ;;
    --herdr) HERDR_MODE=1 ;;
    --no-herdr) HERDR_MODE=0 ;;
    --agent-name) AGENT_NAME="${2:-}"; shift ;;
    --initiative) INITIATIVE="${2:-}"; shift ;;
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

# --- Preflight 1: binarios ---
command -v omp >/dev/null 2>&1 || die "omp no está instalado (command -v omp falló)"
command -v climier >/dev/null 2>&1 || die "climier no está instalado (command -v climier falló)"
command -v python3 >/dev/null 2>&1 || die "python3 no está instalado (lo usa el check de modelos)"

# --- Preflight 2: archivos ---
[[ -f "$PROFILE" ]] || die "no existe el overlay: $PROFILE"
[[ -f "$BOOTSTRAP_FILE" ]] || die "no existe el prompt bootstrap: $BOOTSTRAP_FILE"
if [[ "$WITH_GOAL" -eq 1 ]]; then
  [[ -f "$GOAL_FILE" ]] || die "no existe el objetivo del goal: $GOAL_FILE"
fi

# --- Preflight 3: goal = UNA línea que arranca con "orchestrate" ---
if [[ "$WITH_GOAL" -eq 1 ]]; then
  [[ -s "$GOAL_FILE" ]] || die "$GOAL_FILE está vacío"
  GOAL_LINES="$(grep -c "" "$GOAL_FILE")"
  [[ "$GOAL_LINES" -eq 1 ]] || die "$GOAL_FILE debe tener UNA sola línea (tiene $GOAL_LINES)"
  FIRST_WORD="$(awk 'NR==1{print $1; exit}' "$GOAL_FILE")"
  [[ "$FIRST_WORD" == "orchestrate" ]] || die "$GOAL_FILE debe arrancar con 'orchestrate' (arranca con '$FIRST_WORD')"
fi

# --- Preflight 4: anti fuzzy-match de modelos del overlay ---
if grep -vE '^[[:space:]]*#' "$PROFILE" | grep -qE '<(provider|modelo)'; then
  die "$PROFILE contiene placeholders sin completar (<provider>/<modelo>)"
fi

extract_pairs() {
  sed -E -n 's/^[[:space:]]*[A-Za-z_][A-Za-z0-9_-]*:[[:space:]]+([^#[:space:]]+).*/\1/p' "$PROFILE" \
    | grep -E '^[A-Za-z0-9_.:-]+/[A-Za-z0-9_.-]+(:[A-Za-z0-9]+)?$' \
    | sed -E 's/:[A-Za-z0-9]+$//' \
    | sort -u
}

check_one() {
  local pair="$1" provider model models_json
  provider="${pair%%/*}"; model="${pair#*/}"
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
    sys.exit("  ✗ %s/%s: el provider %r no tiene modelos en el catálogo" % (provider, want, provider))
if want in ids:
    print("  ✓ %s/%s" % (provider, want), file=sys.stderr); sys.exit(0)
sys.exit("  ✗ %s/%s: el modelo NO existe. Disponibles: %s\n  ⚠ omp haría fuzzy match." % (provider, want, ", ".join(ids)))
' || die "preflight de modelos falló — corregí $PROFILE o usá --skip-model-check (no recomendado)"
}

if [[ "$SKIP_MODEL_CHECK" -eq 1 ]]; then
  echo "preflight: verificación de modelos SALTADA; revisá la status line al arrancar" >&2
else
  MODEL_PAIRS="$(extract_pairs || true)"
  if [[ -z "$MODEL_PAIRS" ]]; then
    echo "preflight: el overlay no declara pares provider/modelo verificables" >&2
  else
    echo "preflight: verificando modelos del overlay contra omp..." >&2
    while IFS= read -r pair; do
      [[ -z "$pair" ]] && continue
      check_one "$pair"
    done <<< "$MODEL_PAIRS"
  fi
fi

if [[ ! -f "$REPO_ROOT/.climier.json" ]]; then
  echo "aviso: no hay .climier.json en $REPO_ROOT (¿corriste 'climier init' y sembraste el DAG?)" >&2
fi

PROMPT=""
if [[ "$WITH_GOAL" -eq 1 ]]; then
  GOAL_OBJECTIVE="$(tr -d '\n' < "$GOAL_FILE")"
  PROMPT="/goal set ${GOAL_OBJECTIVE}"
fi
if [[ -n "$PROMPT" ]]; then
  PROMPT="$PROMPT

$(cat "$BOOTSTRAP_FILE")"
else
  PROMPT="$(cat "$BOOTSTRAP_FILE")"
fi
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

# --- Modo orquestador: worker en un pane de herdr ---
if [[ "$HERDR_MODE" -eq 1 ]]; then
  [[ "${HERDR_ENV:-}" == "1" ]] || die "--herdr requiere correr dentro de una sesión Herdr (HERDR_ENV=1)"
  command -v herdr >/dev/null 2>&1 || die "herdr no está en PATH"
  command -v jq    >/dev/null 2>&1 || die "jq no está en PATH (lo usa el modo --herdr)"

  if [[ -z "$AGENT_NAME" ]]; then
    AGENT_NAME="orch-$(basename "${PROFILE%.yml}" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_-' '-')"
    AGENT_NAME="${AGENT_NAME:0:31}"
    AGENT_NAME="${AGENT_NAME%-}"
  fi
  [[ "$AGENT_NAME" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || die "--agent-name '$AGENT_NAME' inválido"
  SLUG="${INITIATIVE:-serie-sabias-que}"

  PANE_JSON="$(herdr pane split --current --direction right --cwd "$REPO_ROOT" --no-focus)" \
    || die "herdr pane split falló"
  PANE="$(jq -r '.result.pane.pane_id // empty' <<<"$PANE_JSON")"
  [[ -n "$PANE" ]] || die "herdr pane split no devolvió pane_id: $PANE_JSON"

  herdr agent start "$AGENT_NAME" --kind omp --pane "$PANE" --timeout 60000 -- --config "$PROFILE" >/dev/null \
    || die "herdr agent start falló (pane $PANE quedó abierto)"
  herdr agent prompt "$AGENT_NAME" "$PROMPT" >/dev/null \
    || die "herdr agent prompt falló (pane $PANE quedó abierto)"

  cat >&2 <<EOF
worker lanzado: agente '$AGENT_NAME' en pane $PANE (cwd $REPO_ROOT)
supervisar:
  herdr agent get  $AGENT_NAME
  herdr agent read $AGENT_NAME --source recent-unwrapped --lines 40
  climier status --initiative $SLUG --all
ancla de sesión: .plans/serie-sabias-que/orchestration/session.md
EOF
  exit 0
fi

exec omp --config "$PROFILE" --cwd "$REPO_ROOT" "$PROMPT"
