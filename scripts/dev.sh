#!/usr/bin/env bash
# Run Jarvis in dev mode. Targets:
#   serve  (default)  apps/jarvis HTTP server with verbose logging
#   cli               apps/jarvis-cli interactive REPL
#   web               vite dev server (apps/jarvis-web), HMR on :5173
#   full              web + serve in parallel; vite proxies /v1 + /health to :7001
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_DIR="$REPO_ROOT/apps/jarvis-web"

if [[ -t 1 ]]; then
  C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_BLUE=$'\033[34m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_MAGENTA=$'\033[35m'; C_CYAN=$'\033[36m'
  C_RESET=$'\033[0m'
else
  C_BOLD=""; C_DIM=""; C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_MAGENTA=""; C_CYAN=""; C_RESET=""
fi
stage() { printf '%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
note()  { printf '%s   %s%s\n' "$C_DIM" "$*" "$C_RESET"; }
warn()  { printf '%swarn:%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }

usage() {
  cat <<'EOF'
Usage: scripts/dev.sh [target] [options] [-- <extra args>]

Targets:
  serve   (default)  run apps/jarvis HTTP server (port 7001)
  cli                run apps/jarvis-cli interactively
  web                run vite dev server (apps/jarvis-web) on :5173
  full               run web + serve in parallel (vite proxies to backend)

Options:
  -w, --workspace <path>   pass --workspace <path> to jarvis (serve/cli/full)
  -r, --release            cargo run --release
  -q, --quiet              RUST_LOG=warn (default: debug for jarvis crates)
  -h, --help               print this help and exit

Anything after `--` is forwarded to the underlying binary verbatim.

Examples:
  scripts/dev.sh                              # serve, debug logging
  scripts/dev.sh full                         # vite dev + jarvis backend
  scripts/dev.sh cli -w ~/code/some-project   # cli pinned to a workspace
  scripts/dev.sh serve -- --addr 0.0.0.0:7777 # forward extra flags to jarvis
EOF
}

TARGET="serve"
WORKSPACE=""
RELEASE=0
QUIET=0
EXTRA_ARGS=()

# First positional (if any and not starting with -) is the target.
if [[ $# -gt 0 ]]; then
  case "$1" in
    serve|cli|web|full) TARGET="$1"; shift ;;
    -*|"") ;;  # leave for option parser
    *) warn "unknown target: $1"; usage; exit 2 ;;
  esac
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    -w|--workspace)
      [[ $# -ge 2 ]] || { warn "--workspace requires a path"; exit 2; }
      WORKSPACE="$2"; shift 2 ;;
    --workspace=*) WORKSPACE="${1#*=}"; shift ;;
    -r|--release)  RELEASE=1; shift ;;
    -q|--quiet)    QUIET=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    --)            shift; EXTRA_ARGS=("$@"); break ;;
    -*)            warn "unknown option: $1"; usage; exit 2 ;;
    *)             warn "unexpected argument: $1"; usage; exit 2 ;;
  esac
done

if [[ -n "$WORKSPACE" && "$TARGET" == "web" ]]; then
  warn "--workspace has no effect on the 'web' target; ignoring"
  WORKSPACE=""
fi

CARGO_PROFILE_FLAG=()
[[ $RELEASE -eq 1 ]] && CARGO_PROFILE_FLAG=(--release)

if [[ -z "${RUST_LOG:-}" ]]; then
  if [[ $QUIET -eq 1 ]]; then
    export RUST_LOG="warn"
  else
    export RUST_LOG="info,jarvis=debug,harness_core=debug,harness_server=debug,harness_tools=debug,harness_llm=debug"
  fi
else
  note "RUST_LOG=$RUST_LOG (from env)"
fi

# Auto-load .env files from the repo root so users can drop OPENAI_API_KEY etc.
# in a file instead of exporting every shell. Order: .env first, then .env.local
# overrides. `set -a` makes every assignment exported; `set +a` restores.
for env_file in "$REPO_ROOT/.env" "$REPO_ROOT/.env.local"; do
  if [[ -f "$env_file" ]]; then
    note "loading $(basename "$env_file")"
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  fi
done

# Resolve the persistence URL the same way apps/jarvis does, so we can show the
# user where their data lives + how much is already there. Precedence:
#   JARVIS_DB_URL env > [persistence].url in ~/.config/jarvis/config.json >
#   default JSON store at $XDG_DATA_HOME/jarvis/conversations.
resolve_store_url() {
  if [[ -n "${JARVIS_DB_URL:-}" ]]; then
    printf '%s' "$JARVIS_DB_URL"; return
  fi
  local cfg="${XDG_CONFIG_HOME:-$HOME/.config}/jarvis/config.json"
  if [[ -f "$cfg" ]] && command -v jq >/dev/null 2>&1; then
    local url
    url=$(jq -r '.persistence.url // empty' "$cfg" 2>/dev/null)
    if [[ -n "$url" ]]; then printf '%s' "$url"; return; fi
  fi
  local data="${XDG_DATA_HOME:-$HOME/.local/share}/jarvis/conversations"
  printf 'json://%s' "$data"
}

report_store() {
  local url="$1" path count
  case "$url" in
    json://*)        path="${url#json://}" ;;
    json:///*)       path="/${url#json:///}" ;;
    json:*)          path="${url#json:}" ;;
    *)               note "store: $url"; return ;;
  esac
  if [[ -d "$path" ]]; then
    # Visible conversations only — exclude __memory__.summary internal rows.
    count=$(find "$path" -maxdepth 1 -type f -name '*.json' \
            ! -name '__memory__*' 2>/dev/null | wc -l | tr -d ' ')
    note "store: $url ($count conversations)"
  else
    note "store: $url (empty / missing)"
  fi
}

report_store "$(resolve_store_url)"

# Build the per-binary trailing args. `--workspace` goes to the binary, not cargo.
JARVIS_BIN_ARGS=(serve)
[[ -n "$WORKSPACE" ]] && JARVIS_BIN_ARGS+=(--workspace "$WORKSPACE")
JARVIS_BIN_ARGS+=("${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}")

CLI_BIN_ARGS=()
[[ -n "$WORKSPACE" ]] && CLI_BIN_ARGS+=(--workspace "$WORKSPACE")
CLI_BIN_ARGS+=("${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}")

run_serve() {
  stage "running apps/jarvis (serve) — RUST_LOG=$RUST_LOG"
  cd "$REPO_ROOT"
  exec cargo run -p jarvis ${CARGO_PROFILE_FLAG[@]+"${CARGO_PROFILE_FLAG[@]}"} -- \
    "${JARVIS_BIN_ARGS[@]}"
}

run_cli() {
  stage "running apps/jarvis-cli — RUST_LOG=$RUST_LOG"
  cd "$REPO_ROOT"
  if [[ ${#CLI_BIN_ARGS[@]} -gt 0 ]]; then
    exec cargo run -p jarvis-cli ${CARGO_PROFILE_FLAG[@]+"${CARGO_PROFILE_FLAG[@]}"} -- \
      "${CLI_BIN_ARGS[@]}"
  else
    exec cargo run -p jarvis-cli ${CARGO_PROFILE_FLAG[@]+"${CARGO_PROFILE_FLAG[@]}"}
  fi
}

run_web() {
  stage "running vite dev server (apps/jarvis-web) on :5173"
  cd "$WEB_DIR"
  if [[ ! -d node_modules ]]; then
    note "node_modules missing, running npm ci"
    npm ci
  fi
  exec npm run dev
}

run_full() {
  stage "running web + jarvis backend in parallel"
  note "vite dev → http://127.0.0.1:5173 (proxies /v1 + /health to :7001)"
  note "jarvis serve → http://127.0.0.1:7001"

  if [[ ! -d "$WEB_DIR/node_modules" ]]; then
    note "node_modules missing in apps/jarvis-web, running npm ci"
    (cd "$WEB_DIR" && npm ci)
  fi

  PIDS=()
  cleanup() {
    trap - INT TERM EXIT
    for pid in "${PIDS[@]+"${PIDS[@]}"}"; do
      kill "$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true
  }
  trap cleanup INT TERM EXIT

  ( cd "$WEB_DIR" && npm run dev 2>&1 | sed -u "s/^/${C_MAGENTA}[web]${C_RESET} /" ) &
  PIDS+=($!)

  ( cd "$REPO_ROOT" && \
    cargo run -p jarvis ${CARGO_PROFILE_FLAG[@]+"${CARGO_PROFILE_FLAG[@]}"} -- \
      "${JARVIS_BIN_ARGS[@]}" 2>&1 \
    | sed -u "s/^/${C_CYAN}[srv]${C_RESET} /" ) &
  PIDS+=($!)

  # Wait for whichever child exits first, then bail (the trap kills the other).
  wait -n 2>/dev/null || wait
}

case "$TARGET" in
  serve) run_serve ;;
  cli)   run_cli ;;
  web)   run_web ;;
  full)  run_full ;;
  *)     warn "unknown target: $TARGET"; usage; exit 2 ;;
esac
