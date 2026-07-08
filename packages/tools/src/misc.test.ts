// Tests for the always-on misc tool group: echo, time.now, ask.text,
// plan.update, exit_plan, enter_plan_mode. Ported from the #[cfg(test)]
// modules of the corresponding Rust files, plus the deferral behaviors for
// ask.text / enter_plan_mode (no HITL / mode-signal channel in @jarvis/core).
import assert from "node:assert/strict";
import { test } from "node:test";

import type { PlanItem } from "@jarvis/core";
import { withPlan } from "@jarvis/core";

import { EchoTool } from "./echo.ts";
import { TimeNowTool } from "./time.ts";
import { AskTextTool } from "./ask.ts";
import { PlanUpdateTool } from "./plan-update.ts";
import { ExitPlanTool } from "./exit-plan.ts";
import { EnterPlanModeTool } from "./enter-plan-mode.ts";

// ---------------------------------------------------------------- echo

test("echo: echoes text verbatim", async () => {
  const out = await new EchoTool().invoke({ text: "hi" });
  assert.equal(out, "hi");
});

test("echo: rejects missing text", async () => {
  await assert.rejects(() => new EchoTool().invoke({}), /text/);
});

test("echo: metadata", () => {
  const t = new EchoTool();
  assert.equal(t.name, "echo");
  assert.equal(t.category, "read");
  assert.equal(t.cacheable, true);
});

// ------------------------------------------------------------- time.now

test("time.now: returns both unix and iso", async () => {
  const s = await new TimeNowTool().invoke({});
  const v = JSON.parse(s) as { unix: unknown; iso: unknown };
  assert.equal(typeof v.unix, "number");
  assert.equal(Number.isInteger(v.unix), true);
  assert.equal(typeof v.iso, "string");
  // iso must be RFC3339-ish (parseable, round-trips through Date).
  assert.equal(Number.isNaN(Date.parse(v.iso as string)), false);
});

test("time.now: metadata", () => {
  const t = new TimeNowTool();
  assert.equal(t.name, "time.now");
  assert.equal(t.category, "read");
});

// ------------------------------------------------------------- ask.text

test("ask.text: defaults to input kind", async () => {
  const out = await new AskTextTool().invoke({ title: "What?" });
  const parsed = JSON.parse(out) as { deferred: string; request: { kind: string } };
  assert.equal(parsed.deferred, "no HITL channel");
  assert.equal(parsed.request.kind, "input");
});

test("ask.text: requires non-empty title", async () => {
  await assert.rejects(() => new AskTextTool().invoke({}), /title/);
  await assert.rejects(() => new AskTextTool().invoke({ title: "   " }), /title/);
});

test("ask.text: choice requires non-empty options", async () => {
  await assert.rejects(
    () => new AskTextTool().invoke({ kind: "choice", title: "Pick", options: [] }),
    /must not be empty/,
  );
});

test("ask.text: choice maps options to value+label", async () => {
  const out = await new AskTextTool().invoke({
    kind: "choice",
    title: "Pick",
    options: ["a", "b"],
  });
  const parsed = JSON.parse(out) as {
    request: { kind: string; options: { value: string; label: string }[] };
  };
  assert.equal(parsed.request.kind, "choice");
  assert.deepEqual(parsed.request.options, [
    { value: "a", label: "a" },
    { value: "b", label: "b" },
  ]);
});

test("ask.text: unsupported kind errors", async () => {
  await assert.rejects(
    () => new AskTextTool().invoke({ kind: "wat", title: "x" }),
    /unsupported ask\.text kind/,
  );
});

test("ask.text: carries body, default_value, multiline metadata", async () => {
  const out = await new AskTextTool().invoke({
    title: "T",
    body: "context",
    default_value: "preset",
    multiline: false,
  });
  const parsed = JSON.parse(out) as {
    request: {
      title: string;
      body: string;
      default_value: string;
      metadata: { tool: string; multiline: boolean };
      transport: string;
      id: string;
    };
  };
  assert.equal(parsed.request.title, "T");
  assert.equal(parsed.request.body, "context");
  assert.equal(parsed.request.default_value, "preset");
  assert.equal(parsed.request.transport, "text");
  assert.equal(parsed.request.metadata.tool, "ask.text");
  assert.equal(parsed.request.metadata.multiline, false);
  assert.match(parsed.request.id, /^hitl_[0-9a-f-]{36}$/);
});

test("ask.text: multiline defaults to true", async () => {
  const out = await new AskTextTool().invoke({ title: "T" });
  const parsed = JSON.parse(out) as { request: { metadata: { multiline: boolean } } };
  assert.equal(parsed.request.metadata.multiline, true);
});

test("ask.text: schema requires only title", () => {
  const schema = new AskTextTool().parameters as { required: string[] };
  assert.deepEqual(schema.required, ["title"]);
});

// ----------------------------------------------------------- plan.update

test("plan.update: emits through an active channel", async () => {
  const tool = new PlanUpdateTool();
  let captured: PlanItem[] | undefined;
  const result = await withPlan(
    (items) => {
      captured = items;
    },
    () =>
      tool.invoke({
        items: [
          { id: "a", title: "Inspect", status: "in_progress" },
          { id: "b", title: "Patch", status: "pending" },
        ],
      }),
  );
  assert.match(result, /2 item/);
  assert.ok(captured);
  assert.equal(captured!.length, 2);
  assert.equal(captured![0].id, "a");
  assert.equal(captured![0].status, "in_progress");
  assert.equal(captured![1].status, "pending");
});

test("plan.update: empty items errors", async () => {
  await assert.rejects(
    () => new PlanUpdateTool().invoke({ items: [] }),
    /must not be empty/,
  );
});

test("plan.update: unknown status errors with 'invalid'", async () => {
  await assert.rejects(
    () => new PlanUpdateTool().invoke({ items: [{ id: "a", title: "A", status: "wat" }] }),
    /invalid/,
  );
});

test("plan.update: missing id errors with 'invalid'", async () => {
  await assert.rejects(
    () => new PlanUpdateTool().invoke({ items: [{ title: "A", status: "pending" }] }),
    /invalid/,
  );
});

test("plan.update: outside scope is a no-op (still ok)", async () => {
  const result = await new PlanUpdateTool().invoke({
    items: [{ id: "x", title: "X", status: "pending" }],
  });
  assert.match(result, /1 item/);
});

test("plan.update: optional note is preserved", async () => {
  let captured: PlanItem[] | undefined;
  await withPlan(
    (items) => {
      captured = items;
    },
    () =>
      new PlanUpdateTool().invoke({
        items: [{ id: "a", title: "A", status: "pending", note: "blocked: x" }],
      }),
  );
  assert.equal(captured![0].note, "blocked: x");
});

// ------------------------------------------------------------- exit_plan

test("exit_plan: returns plan verbatim", async () => {
  const out = await new ExitPlanTool().invoke({ plan: "1. read foo\n2. patch bar" });
  assert.match(out, /read foo/);
});

test("exit_plan: rejects empty plan", async () => {
  await assert.rejects(() => new ExitPlanTool().invoke({ plan: "   " }), /must not be empty/);
});

test("exit_plan: rejects missing plan", async () => {
  await assert.rejects(() => new ExitPlanTool().invoke({}), /missing/);
});

test("exit_plan: is terminal and read-only", () => {
  const t = new ExitPlanTool();
  assert.equal(t.isTerminal, true);
  assert.equal(t.category, "read");
});

// --------------------------------------------------------- enter_plan_mode

test("enter_plan_mode: returns ack (no-op signal-wise)", async () => {
  const out = await new EnterPlanModeTool().invoke({});
  assert.match(out, /plan mode/);
});

test("enter_plan_mode: read-only metadata", () => {
  const t = new EnterPlanModeTool();
  assert.equal(t.category, "read");
  assert.equal(t.cacheable, true);
});
