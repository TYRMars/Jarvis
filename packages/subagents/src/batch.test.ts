// SubAgentBatchTool tests. Ported from harness-subagents/src/batch.rs::tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { JsonValue } from "@jarvis/core";
import { SubAgentBatchTool } from "./batch.ts";
import { EchoSubAgent } from "./echo.ts";
import { SubAgentRegistry, withSubagent, type SubAgent, type SubAgentFrame } from "./subagent.ts";

function registryWithEcho(): SubAgentRegistry {
  const reg = new SubAgentRegistry();
  reg.register(new EchoSubAgent("echo"));
  reg.register(new EchoSubAgent("echo-2"));
  return reg;
}

/** A subagent that always rejects — for best_effort / all_required paths. */
class FailingSubAgent implements SubAgent {
  readonly name: string;
  readonly description = "always fails";
  constructor(name: string) {
    this.name = name;
  }
  inputSchema(): JsonValue {
    return { type: "object", properties: { task: { type: "string" } }, required: ["task"] };
  }
  invoke(): Promise<never> {
    return Promise.reject(new Error("kaboom"));
  }
}

test("rejects empty tasks", async () => {
  const tool = new SubAgentBatchTool(registryWithEcho(), "/tmp", 3);
  await assert.rejects(() => tool.invoke({ tasks: [] }), /at least one task/);
});

test("rejects an unknown subagent (upfront, fail-fast)", async () => {
  const tool = new SubAgentBatchTool(registryWithEcho(), "/tmp", 3);
  await assert.rejects(
    () => tool.invoke({ tasks: [{ subagent: "no-such", task: "hi" }] }),
    /unknown subagent/,
  );
});

test("summarize aggregates all children", async () => {
  const tool = new SubAgentBatchTool(registryWithEcho(), "/tmp", 3);
  const out = await tool.invoke({
    tasks: [
      { subagent: "echo", task: "hello" },
      { subagent: "echo-2", task: "world" },
    ],
    join: "summarize",
  });
  assert.ok(out.includes("[ok] echo"), out);
  assert.ok(out.includes("[ok] echo-2"), out);
  assert.ok(out.includes("echoed: hello"), out);
  assert.ok(out.includes("echoed: world"), out);
});

test("frames from each child reach the outer sink", async () => {
  const tool = new SubAgentBatchTool(registryWithEcho(), "/tmp", 3);
  const frames: SubAgentFrame[] = [];
  await withSubagent(
    (f) => frames.push(f),
    () =>
      tool.invoke({
        tasks: [
          { subagent: "echo", task: "alpha" },
          { subagent: "echo-2", task: "beta" },
        ],
      }),
  );
  const started = frames.filter((f) => f.event.kind === "started").length;
  const done = frames.filter((f) => f.event.kind === "done").length;
  assert.equal(started, 2);
  assert.equal(done, 2);
  const names = new Set(frames.map((f) => f.subagent_name));
  assert.ok(names.has("echo"));
  assert.ok(names.has("echo-2"));
});

test("all_required fails the whole batch when a child errors", async () => {
  const reg = registryWithEcho();
  reg.register(new FailingSubAgent("boom"));
  const tool = new SubAgentBatchTool(reg, "/tmp", 3);
  await assert.rejects(
    () =>
      tool.invoke({
        tasks: [
          { subagent: "echo", task: "ok" },
          { subagent: "boom", task: "fail" },
        ],
        join: "all_required",
      }),
    /all_required.*boom.*failed/,
  );
});

test("best_effort surfaces a child error as a [warning] line, not a throw", async () => {
  const reg = registryWithEcho();
  reg.register(new FailingSubAgent("boom"));
  const tool = new SubAgentBatchTool(reg, "/tmp", 3);
  const out = await tool.invoke({
    tasks: [
      { subagent: "echo", task: "ok" },
      { subagent: "boom", task: "fail" },
    ],
    join: "best_effort",
  });
  assert.ok(out.includes("[ok] echo"), out);
  assert.ok(out.includes("[error] boom"), out);
  assert.ok(out.includes("[warning] kaboom"), out);
});

test("race returns at least one ok", async () => {
  const tool = new SubAgentBatchTool(registryWithEcho(), "/tmp", 3);
  const out = await tool.invoke({
    tasks: [
      { subagent: "echo", task: "fast" },
      { subagent: "echo-2", task: "also-fast" },
    ],
    join: "race",
  });
  const okCount = (out.match(/\[ok\] /g) ?? []).length;
  assert.ok(okCount >= 1, out);
});

test("parameters schema is well-formed (object + required tasks)", () => {
  const tool = new SubAgentBatchTool(registryWithEcho(), "/tmp", 3);
  const p = tool.parameters as Record<string, unknown>;
  assert.equal(p["type"], "object");
  const props = p["properties"] as Record<string, unknown>;
  assert.equal(typeof props["tasks"], "object");
  assert.ok((p["required"] as string[]).includes("tasks"));
});

test("concurrency cap is honoured (never more than `cap` children in flight)", async () => {
  // A subagent that holds a permit until released, tracking peak concurrency.
  let inFlight = 0;
  let peak = 0;
  const gates: Array<() => void> = [];
  class GatedSubAgent implements SubAgent {
    readonly name: string;
    readonly description = "gated";
    constructor(name: string) {
      this.name = name;
    }
    inputSchema(): JsonValue {
      return { type: "object", properties: {}, required: [] };
    }
    async invoke(): Promise<{ message: string }> {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => gates.push(resolve));
      inFlight--;
      return { message: "ok" };
    }
  }
  const reg = new SubAgentRegistry();
  reg.register(new GatedSubAgent("g"));
  const tool = new SubAgentBatchTool(reg, "/tmp", 2);
  const tasks = Array.from({ length: 5 }, (_, i) => ({ subagent: "g", task: `t${i}` }));
  const pending = tool.invoke({ tasks, max_concurrency: 2 });
  // Release gates as they appear until the batch settles. With cap 2 at most
  // two children can ever be parked at once, so `peak` must stay <= 2.
  const drain = async (): Promise<void> => {
    for (;;) {
      const g = gates.shift();
      if (g !== undefined) {
        g();
      } else if (inFlight === 0) {
        // No parked children and none running -> the batch has settled.
        await new Promise((r) => setImmediate(r));
        if (gates.length === 0 && inFlight === 0) return;
      }
      await new Promise((r) => setImmediate(r));
    }
  };
  await Promise.all([pending, drain()]);
  assert.ok(peak <= 2, `peak concurrency ${peak} exceeded cap 2`);
  assert.ok(peak >= 2, `expected to reach cap 2, only saw ${peak}`);
});
