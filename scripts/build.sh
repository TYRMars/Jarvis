#!/usr/bin/env bash
# Build Jarvis: web SPA first (embedded into the Rust binary via include_dir!),
# then the cargo workspace.
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
Usage: scripts/build.sh [options]

Build Jarvis: web frontend (apps/jarvis-web) → Rust workspace.

Options:
  -r, --release            cargo build with --release (default: debug)
  -f, --features <list>    forward to cargo as --features <list>
                           e.g. sqlite, sqlite,postgres
      --skip-web           skip the web build, reuse existing apps/jarvis-web/dist
      --skip-install       skip "npm ci" even when node_modules is missing
      --cli-only           only build apps/jarvis-cli (skips web; jarvis-cli does
                           not need the SPA). --features is ignored in this mode.
  -h, --help               print this help and exit

Examples:
  scripts/build.sh                       # debug, full workspace
  scripts/build.sh --release             # release, full workspace
  scripts/build.sh --release -f sqlite   # release jarvis with the SQLite backend
  scripts/build.sh --skip-web            # iterate on Rust without rebuilding SPA
  scripts/build.sh --cli-only --release  # only apps/jarvis-cli
EOF
}

RELEASE=0
FEATURES=""
SKIP_WEB=0
SKIP_INSTALL=0
CLI_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -r|--release)      RELEASE=1; shift ;;
    -f|--features)
      [[ $# -ge 2 ]] || { warn "--features requires an argument"; usage; exit 2; }
      FEATURES="$2"; shift 2 ;;
    --features=*)      FEATURES="${1#*=}"; shift ;;
    --skip-web)        SKIP_WEB=1; shift ;;
    --skip-install)    SKIP_INSTALL=1; shift ;;
    --cli-only)        CLI_ONLY=1; shift ;;
    -h|--help)         usage; exit 0 ;;
    --)                shift; break ;;
    -*)
      warn "unknown option: $1"
      usage; exit 2 ;;
    *)
      warn "unexpected argument: $1"
      usage; exit 2 ;;
  esac
done

if [[ $CLI_ONLY -eq 1 && -n "$FEATURES" ]]; then
  warn "--features is ignored with --cli-only (jarvis-cli has no SQL backend feature)"
  FEATURES=""
fi

CARGO_PROFILE_DIR="debug"
CARGO_PROFILE_FLAG=()
if [[ $RELEASE -eq 1 ]]; then
  CARGO_PROFILE_DIR="release"
  CARGO_PROFILE_FLAG=(--release)
fi

CARGO_FEATURE_FLAG=()
if [[ -n "$FEATURES" ]]; then
  CARGO_FEATURE_FLAG=(--features "$FEATURES")
fi

# --- Stage 1: web frontend --------------------------------------------------
build_web() {
  if [[ ! -d "$WEB_DIR" ]]; then
    warn "web dir not found: $WEB_DIR"
    return 1
  fi
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

if [[ $CLI_ONLY -eq 1 ]]; then
  note "cli-only mode: skipping web build"
elif [[ $SKIP_WEB -eq 1 ]]; then
  note "--skip-web: reusing apps/jarvis-web/dist"
  if [[ ! -d "$WEB_DIR/dist" ]]; then
    warn "apps/jarvis-web/dist does not exist; harness-server will embed an empty placeholder"
  fi
else
  build_web
fi

# --- Stage 2: cargo ---------------------------------------------------------
cd "$REPO_ROOT"

if [[ $CLI_ONLY -eq 1 ]]; then
  stage "building rust binary (apps/jarvis-cli)"
  set -x
  cargo build -p jarvis-cli ${CARGO_PROFILE_FLAG[@]+"${CARGO_PROFILE_FLAG[@]}"}
  { set +x; } 2>/dev/null
else
  stage "building rust workspace"
  set -x
  cargo build --workspace \
    ${CARGO_PROFILE_FLAG[@]+"${CARGO_PROFILE_FLAG[@]}"} \
    ${CARGO_FEATURE_FLAG[@]+"${CARGO_FEATURE_FLAG[@]}"}
  { set +x; } 2>/dev/null
fi

# --- Summary ----------------------------------------------------------------
echo
ok "build complete"
if [[ $CLI_ONLY -eq 1 ]]; then
  printf '  %s%s%s\n' "$C_BOLD" "target/$CARGO_PROFILE_DIR/jarvis-cli" "$C_RESET"
else
  printf '  %s%s%s\n' "$C_BOLD" "target/$CARGO_PROFILE_DIR/jarvis" "$C_RESET"
  printf '  %s%s%s\n' "$C_BOLD" "target/$CARGO_PROFILE_DIR/jarvis-cli" "$C_RESET"
fi
