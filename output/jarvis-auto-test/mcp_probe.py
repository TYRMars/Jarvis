#!/usr/bin/env python3
"""Drive `jarvis mcp-serve` over stdio: initialize, list tools, call a few."""
import json
import os
import subprocess
import sys
import time

ROOT = "/Users/zhangjianan/Documents/GitHub/Jarvis"
FIXTURE = f"{ROOT}/output/jarvis-auto-test/servlet-fixture"
BIN = f"{ROOT}/target/debug/jarvis"

env = os.environ.copy()
env["JARVIS_FS_ROOT"] = FIXTURE
env["RUST_LOG"] = "warn"
# Avoid touching ~/.local/share/jarvis with persistence side-effects.
env["JARVIS_DB_URL"] = f"json:///tmp/mcp-probe-store"

proc = subprocess.Popen(
    [BIN, "mcp-serve"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env=env,
    text=True,
    bufsize=1,
)

def send(req):
    line = json.dumps(req)
    proc.stdin.write(line + "\n")
    proc.stdin.flush()

def recv():
    line = proc.stdout.readline()
    if not line:
        return None
    return json.loads(line)

results = {}

# 1. initialize
send({
    "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": {
        "protocolVersion": "2024-11-05",
        "capabilities": {},
        "clientInfo": {"name": "mcp-probe", "version": "0.1"},
    },
})
results["initialize"] = recv()

# 2. initialized notification
send({"jsonrpc": "2.0", "method": "notifications/initialized"})

# 3. tools/list
send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
results["tools_list"] = recv()

# 4. workspace.context
send({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
      "params": {"name": "workspace.context", "arguments": {}}})
results["workspace.context"] = recv()

# 5. triage.scan_candidates
send({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
      "params": {"name": "triage.scan_candidates",
                 "arguments": {"limit": 20}}})
results["triage.scan_candidates"] = recv()

# 6. code.grep — hunt for SQL injection markers in the fixture
send({"jsonrpc": "2.0", "id": 5, "method": "tools/call",
      "params": {"name": "code.grep",
                 "arguments": {"pattern": "Statement|hunter2|TODO|FIXME",
                               "max_results": 30}}})
results["code.grep"] = recv()

# 7. project.checks
send({"jsonrpc": "2.0", "id": 6, "method": "tools/call",
      "params": {"name": "project.checks", "arguments": {}}})
results["project.checks"] = recv()

# 8. harness.health (requirement-run store should connect from JARVIS_DB_URL)
send({"jsonrpc": "2.0", "id": 7, "method": "tools/call",
      "params": {"name": "harness.health",
                 "arguments": {"limit": 5, "include_evidence": False}}})
results["harness.health"] = recv()

proc.stdin.close()
try:
    proc.wait(timeout=5)
except subprocess.TimeoutExpired:
    proc.terminate()

stderr_tail = proc.stderr.read()[-1000:] if proc.stderr else ""

# Print as JSON for downstream consumption.
print(json.dumps({"results": results, "stderr_tail": stderr_tail}, indent=2))
