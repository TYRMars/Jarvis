#!/bin/bash
# One-shot bootstrap for the Jarvis iPhone client.
# Double-click in Finder (or run from a terminal). Everything is
# logged to bootstrap.log next to this script.
#
#   1. xcodegen generate          (installs xcodegen via brew if missing)
#   2. xcodebuild for simulator   (no signing needed)
#   3. boot simulator, install + launch the app
#   4. best-effort: start `jarvis serve` on :7001 if not already running

cd "$(dirname "$0")" || exit 1
LOG="$PWD/bootstrap.log"
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.cargo/bin:$PATH"

step() { echo ""; echo "==== [$(date +%H:%M:%S)] $1 ===="; }
fail() { echo ""; echo "BOOTSTRAP FAILED: $1"; exit 1; }

step "0/5 environment"
# xcode-select may point at CommandLineTools; route to Xcode.app via
# DEVELOPER_DIR (no sudo needed).
if ! xcodebuild -version >/dev/null 2>&1; then
  for XC in /Applications/Xcode.app /Applications/Xcode*.app; do
    if [ -d "$XC/Contents/Developer" ]; then
      export DEVELOPER_DIR="$XC/Contents/Developer"
      echo "使用 DEVELOPER_DIR=$DEVELOPER_DIR"
      break
    fi
  done
fi
xcodebuild -version || fail "Xcode 未安装或未配置 (xcode-select / DEVELOPER_DIR)"

step "1/5 xcodegen"
if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen 未安装,尝试 brew install xcodegen ..."
  command -v brew >/dev/null 2>&1 || fail "缺少 Homebrew,无法安装 xcodegen"
  brew install xcodegen || fail "brew install xcodegen 失败"
fi
xcodegen generate || fail "xcodegen generate 失败"

step "2/5 pick a simulator"
DEVICE=$(xcrun simctl list devices available \
  | grep -E '^\s+iPhone' \
  | sed -E 's/^ *([^(]+) \(.*/\1/' \
  | sed -E 's/ +$//' \
  | tail -1)
[ -n "$DEVICE" ] || fail "没有可用的 iPhone 模拟器 (Xcode > Settings > Platforms 安装 iOS runtime)"
echo "使用模拟器: $DEVICE"

step "3/5 build (Debug, iphonesimulator)"
xcodebuild \
  -project JarvisiOS.xcodeproj \
  -scheme Jarvis \
  -configuration Debug \
  -destination "platform=iOS Simulator,name=$DEVICE" \
  -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO \
  build || fail "xcodebuild 构建失败(往上翻 error: 行)"

APP="build/Build/Products/Debug-iphonesimulator/Jarvis.app"
[ -d "$APP" ] || fail "未找到构建产物 $APP"

step "4/5 install + launch in simulator"
xcrun simctl boot "$DEVICE" 2>/dev/null
open -a Simulator
xcrun simctl bootstatus "$DEVICE" -b || true
xcrun simctl install "$DEVICE" "$APP" || fail "simctl install 失败"
xcrun simctl launch "$DEVICE" dev.jarvis.ios || fail "simctl launch 失败"
echo "APP LAUNCHED"

step "5/5 jarvis server on :7001 (best effort)"
if curl -sf -m 2 http://localhost:7001/health >/dev/null 2>&1; then
  echo "服务端已在运行,跳过"
else
  REPO_ROOT="$(cd ../.. && pwd)"
  SERVER_LOG="$PWD/jarvis-server.log"
  ENV_PREFIX=""
  if [ -n "$OPENAI_API_KEY" ]; then
    ENV_PREFIX=""
  elif [ -f "$HOME/.codex/auth.json" ]; then
    ENV_PREFIX="JARVIS_PROVIDER=codex"
  elif [ -n "$ANTHROPIC_API_KEY" ]; then
    ENV_PREFIX="JARVIS_PROVIDER=anthropic"
  elif [ -n "$KIMI_API_KEY" ] || [ -n "$MOONSHOT_API_KEY" ]; then
    ENV_PREFIX="JARVIS_PROVIDER=kimi"
  else
    echo "SERVER SKIPPED: 没有检测到任何 provider key (OPENAI/ANTHROPIC/KIMI 或 ~/.codex/auth.json)"
    echo "app 可以打开,但聊天会显示连接错误。配置 key 后运行: cargo run -p jarvis"
    echo ""
    echo "BOOTSTRAP OK (no server)"
    exit 0
  fi
  echo "启动服务端 ($ENV_PREFIX cargo run -p jarvis),首次编译可能要几分钟..."
  echo "服务端日志: $SERVER_LOG"
  ( cd "$REPO_ROOT" && env $ENV_PREFIX \
      JARVIS_ENABLE_FS_WRITE=1 JARVIS_ENABLE_FS_EDIT=1 JARVIS_ENABLE_SHELL_EXEC=1 \
      nohup cargo run -p jarvis > "$SERVER_LOG" 2>&1 & )
  for i in $(seq 1 120); do
    if curl -sf -m 2 http://localhost:7001/health >/dev/null 2>&1; then
      echo "SERVER UP"
      break
    fi
    sleep 5
  done
  curl -sf -m 2 http://localhost:7001/health >/dev/null 2>&1 || \
    echo "SERVER NOT UP YET(可能还在编译,看 $SERVER_LOG)"
fi

echo ""
echo "BOOTSTRAP OK"
