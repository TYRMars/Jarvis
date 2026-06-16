// Channel + registry + workspace-seam tests. Ported from the unit tests in
// harness-core/src/subagent.rs + the registry test in lib.rs + workspace.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SubAgentRegistry,
  emitSubagent,
  subagentActive,
  activeSender,
  withSubagent,
  activeWorkspace,
  activeWorkspaceOr,
  withSessionWorkspace,
  type SubAgentFrame,
} from "./subagent.ts";
import { EchoSubAgent } from "./echo.ts";

test("registry dedupes by name (last-write-wins)", () => {
  const reg = new SubAgentRegistry();
  reg.register(new EchoSubAgent("a"));
  reg.register(new EchoSubAgent("a"));
  reg.register(new EchoSubAgent("b"));
  assert.equal(reg.length, 2);
  assert.ok(reg.get("a"));
  assert.ok(reg.get("b"));
  assert.equal(reg.get("c"), undefined);
});

test("registry isEmpty + iter ordering", () => {
  const reg = new SubAgentRegistry();
  assert.ok(reg.isEmpty());
  reg.register(new EchoSubAgent("x"));
  reg.register(new EchoSubAgent("y"));
  assert.ok(!reg.isEmpty());
  assert.deepEqual(
    reg.iter().map((s) => s.name),
    ["x", "y"],
  );
});

test("emit inside withSubagent reaches the sink", async () => {
  const frames: SubAgentFrame[] = [];
  await withSubagent(
    (f) => frames.push(f),
    async () => {
      assert.ok(subagentActive());
      emitSubagent({
        subagent_id: "sub-1",
        subagent_name: "review",
        event: { kind: "started", task: "verify the kanban renders", model: "claude-sonnet-4-6" },
      });
    },
  );
  assert.equal(frames.length, 1);
  const f = frames[0]!;
  assert.equal(f.subagent_id, "sub-1");
  assert.equal(f.event.kind, "started");
  if (f.event.kind === "started") {
    assert.equal(f.event.task, "verify the kanban renders");
    assert.equal(f.event.model, "claude-sonnet-4-6");
  }
});

test("emit outside any scope is a no-op (does not throw)", () => {
  assert.ok(!subagentActive());
  assert.equal(activeSender(), undefined);
  emitSubagent({ subagent_id: "x", subagent_name: "x", event: { kind: "status", message: "x" } });
});

test("event wire shape uses kind discriminator + snake_case", () => {
  const f: SubAgentFrame = {
    subagent_id: "sub-1",
    subagent_name: "claude_code",
    event: { kind: "tool_start", name: "fs.read", arguments: { path: "/etc/hosts" } },
  };
  const json = JSON.stringify(f);
  assert.ok(json.includes('"kind":"tool_start"'));
  assert.ok(json.includes('"subagent_id":"sub-1"'));
  assert.ok(json.includes('"name":"fs.read"'));
});

test("session-workspace seam: active inside scope, fallback outside", async () => {
  assert.equal(activeWorkspace(), undefined);
  assert.equal(activeWorkspaceOr("/default"), "/default");
  const observed = await withSessionWorkspace("/pinned", async () => activeWorkspaceOr("/default"));
  assert.equal(observed, "/pinned");
  // Out of scope again.
  assert.equal(activeWorkspace(), undefined);
});
