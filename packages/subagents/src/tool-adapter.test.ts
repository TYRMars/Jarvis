// SubAgentTool adapter tests. Ported from
// harness-subagents/src/tool_adapter.rs::tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolCategory, toolRequiresApproval } from "@jarvis/core";
import { SubAgentTool } from "./tool-adapter.ts";
import { EchoSubAgent } from "./echo.ts";
import { withSubagent, type SubAgentFrame } from "./subagent.ts";

test("wrapper exposes a subagent as a `subagent.<name>` tool", () => {
  const tool = new SubAgentTool(new EchoSubAgent("echo"), "/tmp");
  assert.equal(tool.name, "subagent.echo");
  assert.equal(typeof tool.parameters, "object");
  // EchoSubAgent doesn't require approval -> Read category.
  assert.ok(!toolRequiresApproval(tool));
  assert.equal(toolCategory(tool), "read");
});

test("wrapper runs inside a withSubagent scope and relays frames", async () => {
  const tool = new SubAgentTool(new EchoSubAgent("echo"), "/tmp");
  const frames: SubAgentFrame[] = [];
  const result = await withSubagent(
    (f) => frames.push(f),
    () => tool.invoke({ task: "hello" }),
  );
  assert.equal(result, "echoed: hello");
  const started = frames.filter((f) => f.event.kind === "started").length;
  const done = frames.filter((f) => f.event.kind === "done").length;
  assert.equal(started, 1);
  assert.equal(done, 1);
});

test("wrapper rejects a missing `task` arg", async () => {
  const tool = new SubAgentTool(new EchoSubAgent("echo"), "/tmp");
  await assert.rejects(() => tool.invoke({}), /task/);
});

test("approval-gated subagent lands in the Write category", () => {
  const gated = new EchoSubAgent("codex-like");
  // Give it an approval gate to mimic codex/claude_code.
  (gated as unknown as { requiresApproval(): boolean }).requiresApproval = () => true;
  const tool = new SubAgentTool(gated, "/tmp");
  assert.ok(toolRequiresApproval(tool));
  assert.equal(toolCategory(tool), "write");
});
