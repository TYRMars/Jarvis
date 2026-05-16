#!/usr/bin/env bash
# start.sh — Jarvis 快速启动脚本。
#
#   ./start.sh         # 嵌入式 UI：先 build web，再 cargo run。一个进程同时服务 API + UI。
#   ./start.sh --dev   # 双进程：后台 Vite (5173) + 前台 cargo (7001)，热重载工作流。
#
# 通用选项：
#   -h | --help        # 打印用法
#   --no-env           # 即便存在 .env 也不加载
#   --release          # cargo 用 release profile（嵌入式模式才生效）
#   --port <N>         # 覆盖 JARVIS_ADDR 端口（默认 7001）
#
# Web bundle 是增量构建：dist/ 缺失，或 src/ / package.json / vite.config.ts
# 比 dist/ 新时才重新 build。命中缓存时启动 < 1s。

set -euo pipefail

cd "$(dirname "$0")"

mode="serve"
load_env=1
profile="debug"
port=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev)        mode="dev"; shift ;;
    --no-env)     load_env=0; shift ;;
    --release)    profile="release"; shift ;;
    --port)       port="${2:?--port 需要一个端口号}"; shift 2 ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "start.sh: 未知参数 '$1'（用 -h 查看用法）" >&2; exit 64 ;;
  esac
done

log()  { printf '\033[36m[start]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[start]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[start]\033[0m %s\n' "$*" >&2; exit 1; }

# 端口占用检查 —— 启动前显式报错胜过看着两个进程瞎打架
#
# 注意：开启 `set -o pipefail` 时 lsof 没找到匹配会返回 1，再走管道会把整个
# `$(...)` 标成失败，触发 set -e 让脚本静默退出。所以这里用 `|| true` 把
# "没人占用" 这种正常路径吞掉。
check_port_free() {
  local port="$1" name="$2" holder_pid
  if ! command -v lsof >/dev/null; then return 0; fi
  holder_pid=$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  holder_pid="${holder_pid%%$'\n'*}"
  if [[ -n "$holder_pid" ]]; then
    local cmd
    cmd=$(ps -p "$holder_pid" -o comm= 2>/dev/null || echo "?")
    die "端口 ${port}（${name}）已被进程 ${holder_pid} (${cmd}) 占用。释放后重试：kill ${holder_pid}"
  fi
}

# 给子进程的输出加前缀，免得 vite 和 cargo 的日志混成一团分不清
prefix_stream() {
  local tag="$1"
  while IFS= read -r line; do printf '\033[2m[%s]\033[0m %s\n' "$tag" "$line"; done
}

# .env 加载 —— 仅当文件存在且未禁用时。set -a 让 source 的 KEY=VAL 自动 export。
if [[ $load_env -eq 1 && -f .env ]]; then
  log "加载 .env"
  set -a; . ./.env; set +a
fi

# 端口覆盖
if [[ -n "$port" ]]; then
  export JARVIS_ADDR="127.0.0.1:${port}"
elif [[ -z "${JARVIS_ADDR:-}" ]]; then
  export JARVIS_ADDR="127.0.0.1:7001"
fi

# 工作区固定到仓库根，避免无意中沙箱化别处
export JARVIS_FS_ROOT="${JARVIS_FS_ROOT:-$PWD}"

WEB_DIR="apps/jarvis-web"
WEB_DIST="$WEB_DIR/dist"

ensure_web_deps() {
  if [[ ! -d "$WEB_DIR/node_modules" ]]; then
    log "首次运行：安装 web 依赖（npm ci）"
    (cd "$WEB_DIR" && npm ci --no-audit --no-fund)
  fi
}

# 增量 web build：dist/ 不存在，或 src/package.json/vite.config.ts 新于 dist/
need_web_build() {
  [[ ! -d "$WEB_DIST" ]] && return 0
  local newest_src newest_dist
  newest_src=$(find "$WEB_DIR/src" "$WEB_DIR/package.json" "$WEB_DIR/vite.config.ts" "$WEB_DIR/index.html" \
                 -type f -newer "$WEB_DIST" -print -quit 2>/dev/null || true)
  [[ -n "$newest_src" ]]
}

build_web_if_needed() {
  ensure_web_deps
  if need_web_build; then
    log "web bundle 过时，重新构建（npm run build）"
    (cd "$WEB_DIR" && npm run build)
  else
    log "web bundle 命中缓存，跳过 build"
  fi
}

cargo_port() { echo "${JARVIS_ADDR##*:}"; }

run_serve_mode() {
  build_web_if_needed
  check_port_free "$(cargo_port)" "jarvis"
  log "启动 jarvis（${profile}）—— http://${JARVIS_ADDR}"
  if [[ "$profile" == "release" ]]; then
    exec cargo run --release -p jarvis -- serve --workspace "$JARVIS_FS_ROOT"
  else
    exec cargo run -p jarvis -- serve --workspace "$JARVIS_FS_ROOT"
  fi
}

run_dev_mode() {
  ensure_web_deps

  local vite_port="${VITE_PORT:-5173}"
  check_port_free "$vite_port"     "vite"
  check_port_free "$(cargo_port)" "jarvis"

  # 后台 Vite，输出经 prefix_stream 加 [vite] 前缀。subshell 拿到的是 pipeline 的最末一段，
  # 但 vite 真正运行在子 shell 内的 npm 之下，所以 cleanup 时要 pkill -P 一路追下去。
  log "启动 Vite （后台，http://127.0.0.1:${vite_port}）"
  ( cd "$WEB_DIR" && exec npm run dev ) > >(prefix_stream vite) 2> >(prefix_stream vite >&2) &
  local vite_pid=$!

  cleanup() {
    if kill -0 "$vite_pid" 2>/dev/null; then
      log "停止 Vite (pid=$vite_pid)"
      pkill -P "$vite_pid" 2>/dev/null || true
      kill "$vite_pid" 2>/dev/null || true
      wait "$vite_pid" 2>/dev/null || true
    fi
  }
  trap cleanup EXIT INT TERM

  # 给 Vite 半秒抢到第一条 banner 打印，再让 cargo 接管前台，免得日志互相打断
  sleep 0.5

  log "启动 jarvis （前台，http://${JARVIS_ADDR}）"
  log "Ctrl-C 可同时停止两个进程"
  # 不 exec：保留当前 shell 以触发 EXIT trap 清理 Vite
  cargo run -p jarvis -- serve --workspace "$JARVIS_FS_ROOT"
}

# 基础依赖兜底检查 —— 缺失了直接说，不要等 cargo / npm 抛混乱错
command -v cargo >/dev/null || die "未找到 cargo（请安装 Rust toolchain）"
command -v npm   >/dev/null || die "未找到 npm（请安装 Node.js）"

case "$mode" in
  serve) run_serve_mode ;;
  dev)   run_dev_mode ;;
esac
