// EchoSubAgent tests. Ported from harness-subagents/src/echo.rs::tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EchoSubAgent } from "./echo.ts";
import { withSubagent, type SubAgentFrame } from "./subagent.ts";

test("echo emits started + 3 deltas + done in order", async () => {
  const frames: SubAgentFrame[] = [];
  const sub = new EchoSubAgent("echo");
  const out = await withSubagent(
    (f) => frames.push(f),
    () => sub.invoke({ task: "verify the kanban renders", workspace_root: "/tmp" }),
  );
  assert.equal(out.message, "echoed: verify the kanban renders");
  assert.equal(frames.length, 5, JSON.stringify(frames.map((f) => f.event.kind)));
  assert.deepEqual(
    frames.map((f) => f.event.kind),
    ["started", "delta", "delta", "delta", "done"],
  );
  const id0 = frames[0]!.subagent_id;
  for (const f of frames) {
    assert.equal(f.subagent_id, id0);
    assert.equal(f.subagent_name, "echo");
  }
});

test("echo attaches a doc_summary artifact", async () => {
  const out = await new EchoSubAgent("echo").invoke({ task: "hi", workspace_root: "/tmp" });
  assert.ok(out.artifacts && out.artifacts.length === 1);
  const a = out.artifacts[0]!;
  assert.equal(a.kind, "doc_summary");
  if (a.kind === "doc_summary") assert.equal(a.summary, "hi");
});

test("echo with a short task emits a single delta", async () => {
  const frames: SubAgentFrame[] = [];
  await withSubagent(
    (f) => frames.push(f),
    () => new EchoSubAgent("e").invoke({ task: "ab", workspace_root: "/tmp" }),
  );
  // started + 1 delta + done
  assert.deepEqual(
    frames.map((f) => f.event.kind),
    ["started", "delta", "done"],
  );
});
