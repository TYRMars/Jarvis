import { test } from "node:test";
import assert from "node:assert/strict";

import { systemMessage, userMessage, assistantText, toolResult, withCache } from "./message.ts";
import { addUsage, usageIsEmpty, emptyUsage, type Usage } from "./llm.ts";
import { ToolRegistry, type Tool } from "./tool.ts";
import { AlwaysApprove, AlwaysDeny, ChannelApprover, type ApprovalRequest } from "./approval.ts";

test("message: wire shapes omit unset optional fields", () => {
  assert.equal(JSON.stringify(systemMessage("plain")), '{"role":"system","content":"plain"}');
  assert.equal(JSON.stringify(userMessage("hi")), '{"role":"user","content":"hi"}');
  assert.equal(JSON.stringify(assistantText("done")), '{"role":"assistant","content":"done"}');
  assert.equal(
    JSON.stringify(toolResult("c1", "ok")),
    '{"role":"tool","tool_call_id":"c1","content":"ok"}',
  );
});

test("message: withCache adds the cache field", () => {
  assert.equal(
    JSON.stringify(withCache(userMessage("hi"), "ephemeral")),
    '{"role":"user","content":"hi","cache":"ephemeral"}',
  );
});

test("usage: add merges (saturating sum / adopt / keep)", () => {
  const target: Usage = { prompt_tokens: 5, completion_tokens: 2 };
  addUsage(target, { prompt_tokens: 3, cached_prompt_tokens: 1 });
  assert.equal(target.prompt_tokens, 8); // Some + Some
  assert.equal(target.completion_tokens, 2); // Some + None keeps
  assert.equal(target.cached_prompt_tokens, 1); // None + Some adopts
  assert.equal(target.reasoning_tokens, undefined); // None + None stays absent
});

test("usage: isEmpty", () => {
  assert.equal(usageIsEmpty(emptyUsage()), true);
  assert.equal(usageIsEmpty({ prompt_tokens: 1 }), false);
});

test("registry: same name overwrites; resolve / specs / mute", () => {
  const t1: Tool = { name: "a", description: "first", parameters: { type: "object" }, invoke: async () => "1" };
  const t2: Tool = { name: "a", description: "second", parameters: { type: "object" }, invoke: async () => "2" };
  const reg = new ToolRegistry().register(t1).register(t2);

  assert.equal(reg.resolve("a")?.description, "second"); // second registration wins
  assert.equal(reg.specs().length, 1);

  reg.mute("a");
  assert.equal(reg.resolve("a"), undefined); // muted → invisible to dispatch
  assert.equal(reg.specs().length, 0); // and to the LLM catalogue
  reg.unmute("a");
  assert.equal(reg.has("a"), true);
});

test("approval: AlwaysApprove / AlwaysDeny verdicts", async () => {
  const req: ApprovalRequest = { tool_call_id: "c", tool_name: "fs.write", arguments: {}, category: "write" };
  assert.deepEqual(await new AlwaysApprove().approve(req), { decision: "approve" });
  assert.deepEqual(await new AlwaysDeny().approve(req), { decision: "deny", reason: "default deny policy" });
});

test("approval: ChannelApprover round-trips through the responder", async () => {
  const approver = new ChannelApprover((pending) => pending.respond({ decision: "approve" }));
  const req: ApprovalRequest = { tool_call_id: "c", tool_name: "fs.write", arguments: {}, category: "write" };
  assert.deepEqual(await approver.approve(req), { decision: "approve" });
});

test("approval: ChannelApprover rejects when the consumer throws", async () => {
  const approver = new ChannelApprover(() => {
    throw new Error("channel closed");
  });
  const req: ApprovalRequest = { tool_call_id: "c", tool_name: "fs.write", arguments: {}, category: "write" };
  await assert.rejects(() => approver.approve(req), /channel closed/);
});
