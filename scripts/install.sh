#!/usr/bin/env bash
# Install Jarvis as a CLI on this machine.
#
# Builds the web SPA (apps/jarvis-web) so harness-server can embed the
# fresh assets via include_dir!, then `cargo install`s the `jarvis`
# binary into ~/.cargo/bin (or $CARGO_HOME/bin if set). Also installs
# `jarvis-cli` by default — the in-process terminal coding agent.
#
# Once installed:
#
#   jarvis             # → starts HTTP server on 0.0.0.0:7001 + Web UI at /
#   jarvis serve --open  # same, but auto-opens the browser
#   jarvis-cli         # interactive terminal agent (no HTTP)
#
# The web UI lives at http://127.0.0.1:7001 by default; override with
# `--addr` or $JARVIS_ADDR. Provider auth via `jarvis login` — see
# `jarvis status` for what's configured.
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WEB_DIR="$REPO_ROOT/apps/jarvis-web"

if [[ -t 1 ]]; then
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_BLUE=$'\033[34m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RESET=$'\033[0m'
else
  C_BOLD=""; C_DIM=""; C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RESET=""
fi

stage() { printf '%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
note()  { printf '%s   %s%s\n' "$C_DIM" "$*" "$C_RESET"; }
warn()  { printf '%swarn:%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
ok()    { printf '%sok%s    %s\n' "$C_GREEN" "$C_RESET" "$*"; }

usage() {
  cat <<'EOF'
Usage: scripts/install.sh [options]

Install the `jarvis` (and `jarvis-cli`) binaries to ~/.cargo/bin.

Options:
  -f, --features <list>    forward to cargo as --features <list>
                           e.g. sqlite, "sqlite,postgres"
      --skip-web           reuse existing apps/jarvis-web/dist (no npm build)
      --skip-install       skip "npm ci" even when node_modules is missing
      --no-cli             only install `jarvis`, skip `jarvis-cli`
      --server-only        alias for --no-cli (kept for symmetry)
      --force              pass --force to cargo install (overwrite existing)
      --root <PATH>        install root for cargo (defaults to $CARGO_HOME or ~/.cargo)
  -h, --help               print this help and exit

Examples:
  scripts/install.sh                       # default: jarvis + jarvis-cli
  scripts/install.sh --features sqlite     # build jarvis with the SQLite backend
  scripts/install.sh --skip-web --force    # rebuild only Rust, overwrite binaries
  scripts/install.sh --no-cli              # only the HTTP server binary
EOF
}

FEATURES=""
SKIP_WEB=0
SKIP_INSTALL=0
INSTALL_CLI=1
FORCE=0
INSTALL_ROOT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|--features)
      [[ $# -ge 2 ]] || { warn "--features requires an argument"; usage; exit 2; }
      FEATURES="$2"; shift 2 ;;
    --features=*)      FEATURES="${1#*=}"; shift ;;
    --skip-web)        SKIP_WEB=1; shift ;;
    --skip-install)    SKIP_INSTALL=1; shift ;;
    --no-cli|--server-only) INSTALL_CLI=0; shift ;;
    --force)           FORCE=1; shift ;;
    --root)
      [[ $# -ge 2 ]] || { warn "--root requires a path"; usage; exit 2; }
      INSTALL_ROOT="$2"; shift 2 ;;
    --root=*)          INSTALL_ROOT="${1#*=}"; shift ;;
    -h|--help)         usage; exit 0 ;;
    --)                shift; break ;;
    -*) warn "unknown option: $1"; usage; exit 2 ;;
    *)  warn "unexpected argument: $1"; usage; exit 2 ;;
  esac
done

command -v cargo >/dev/null 2>&1 || {
  warn "cargo not found on PATH — install Rust toolchain first (https://rustup.rs)"
  exit 1
}

# --- Stage 1: web frontend --------------------------------------------------
build_web() {
  if [[ ! -d "$WEB_DIR" ]]; then
    warn "web dir not found: $WEB_DIR"
    return 1
  fi
  command -v npm >/dev/null 2>&1 || {
    warn "npm not found on PATH — install Node.js to build the Web UI, or rerun with --skip-web"
    exit 1
  }
  stage "building web frontend (apps/jarvis-web)"
  cd "$WEB_DIR"
  if [[ $SKIP_INSTALL -eq 1 ]]; then
    note "skipping npm install (--skip-install)"
  elif [[ -d node_modules ]]; then
    note "node_modules present, skipping npm ci"
  else
    note "node_modules missing, running npm ci"
    npm ci
  fi
  npm run build
  cd "$REPO_ROOT"
}

if [[ $SKIP_WEB -eq 1 ]]; then
  note "--skip-web: reusing apps/jarvis-web/dist"
  if [[ ! -d "$WEB_DIR/dist" ]]; then
    warn "apps/jarvis-web/dist does not exist; harness-server will embed an empty placeholder"
  fi
else
  build_web
fi

# --- Stage 2: cargo install -------------------------------------------------
CARGO_INSTALL_FLAGS=(--path)

CARGO_FEATURE_FLAG=()
if [[ -n "$FEATURES" ]]; then
  CARGO_FEATURE_FLAG=(--features "$FEATURES")
fi

CARGO_FORCE_FLAG=()
[[ $FORCE -eq 1 ]] && CARGO_FORCE_FLAG=(--force)

CARGO_ROOT_FLAG=()
if [[ -n "$INSTALL_ROOT" ]]; then
  CARGO_ROOT_FLAG=(--root "$INSTALL_ROOT")
fi

stage "installing jarvis (HTTP server + Web UI)"
cd "$REPO_ROOT"
set -x
cargo install \
  "${CARGO_INSTALL_FLAGS[@]}" "$REPO_ROOT/apps/jarvis" \
  --locked \
  ${CARGO_ROOT_FLAG[@]+"${CARGO_ROOT_FLAG[@]}"} \
  ${CARGO_FEATURE_FLAG[@]+"${CARGO_FEATURE_FLAG[@]}"} \
  ${CARGO_FORCE_FLAG[@]+"${CARGO_FORCE_FLAG[@]}"}
{ set +x; } 2>/dev/null

if [[ $INSTALL_CLI -eq 1 ]]; then
  stage "installing jarvis-cli (terminal agent)"
  set -x
  cargo install \
    "${CARGO_INSTALL_FLAGS[@]}" "$REPO_ROOT/apps/jarvis-cli" \
    --locked \
    ${CARGO_ROOT_FLAG[@]+"${CARGO_ROOT_FLAG[@]}"} \
    ${CARGO_FORCE_FLAG[@]+"${CARGO_FORCE_FLAG[@]}"}
  { set +x; } 2>/dev/null
fi

# --- Summary ----------------------------------------------------------------
INSTALL_BIN_DIR="${INSTALL_ROOT:-${CARGO_HOME:-$HOME/.cargo}}/bin"

echo
ok "install complete"
printf '  %s%s/jarvis%s\n' "$C_BOLD" "$INSTALL_BIN_DIR" "$C_RESET"
[[ $INSTALL_CLI -eq 1 ]] && \
  printf '  %s%s/jarvis-cli%s\n' "$C_BOLD" "$INSTALL_BIN_DIR" "$C_RESET"

# PATH hint — only nudge if the install dir isn't already on PATH.
case ":$PATH:" in
  *":$INSTALL_BIN_DIR:"*) ;;
  *)
    echo
    warn "$INSTALL_BIN_DIR is not on PATH"
    note "add it to your shell rc, e.g.:"
    note "  echo 'export PATH=\"$INSTALL_BIN_DIR:\$PATH\"' >> ~/.zshrc"
    ;;
esac

cat <<EOF

next steps:
  jarvis status              # show what's configured
  jarvis login --provider openai   # store an API key (or anthropic / google / kimi)
  jarvis serve --open        # start the server and open the Web UI
EOF
