#!/bin/bash
# Restart the Jarvis app in the booted simulator (picks up a freshly
# started server on launch).
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! xcodebuild -version >/dev/null 2>&1; then
  [ -d /Applications/Xcode.app/Contents/Developer ] && \
    export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
echo "server health: $(curl -sf -m 2 http://localhost:7001/health || echo DOWN)"
xcrun simctl terminate booted dev.jarvis.ios 2>/dev/null
sleep 1
xcrun simctl launch booted dev.jarvis.ios
echo "RELAUNCHED"
exit 0
