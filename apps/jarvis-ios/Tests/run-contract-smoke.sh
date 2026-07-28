#!/usr/bin/env bash
# Compile + run the iOS /v1 contract smoke test (tasklist P7.10).
#
# The client models are Foundation-only, so we compile them together with the
# test entry using the host `swiftc` — no Xcode project or simulator required.
# Exit code is the gate: non-zero on any contract mismatch.
#
#   ./Tests/run-contract-smoke.sh                       # offline goldens only
#   JARVIS_SMOKE_BASE_URL=http://localhost:7001 \
#     ./Tests/run-contract-smoke.sh                     # + live diagnostics
#   JARVIS_SMOKE_BASE_URL=... JARVIS_SMOKE_STRICT=1 \
#     ./Tests/run-contract-smoke.sh                     # + gate on live too
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ios="$(dirname "$here")"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found — install the Swift toolchain (Xcode or swift.org)." >&2
  exit 127
fi

# Foundation-only client sources under test. Views/ViewModels pull in
# SwiftUI/Observation, so they are intentionally excluded; ChatSocket is
# Foundation-only (URLSessionWebSocketTask) and included for the ClientFrame
# wire-shape goldens.
sources=(
  "$ios"/Sources/Models/*.swift
  "$ios/Sources/Networking/ServerConfig.swift"
  "$ios/Sources/Networking/JarvisAPI.swift"
  "$ios/Sources/Networking/ChatSocket.swift"
  "$here/ContractSmoke/main.swift"
)

out="$(mktemp -d)/contract-smoke"
trap 'rm -rf "$(dirname "$out")"' EXIT

echo "compiling contract smoke test with swiftc…"
swiftc -O -o "$out" "${sources[@]}"

echo "running…"
"$out"
