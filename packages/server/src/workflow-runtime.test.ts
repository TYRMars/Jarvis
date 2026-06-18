import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Agent,
  defaultAgentConfig,
  type ChatRequest,
  type ChatResponse,
  type LlmChunk,
  type LlmProvider,
} from "@jarvis/core";
import { MemoryConversationStore } from "@jarvis/store";
import {
  newWorkflowDefinition,
  newWorkflowRun,
  newWorkflowStep,
  finishWorkflowRun,
  type WorkflowDefinition,
  type WorkflowRunStatus,
  type WorkflowStep,
} from "@jarvis/workflow";
import { MemoryWorkflowStore } from "@jarvis/store";

import type { AppState } from "./state.ts";
import { WorkflowRunGate } from "./workflow-concurrency.ts";
import {
  driveWorkflow,
  failRunIfRunning,
  reapStaleWorkflowRuns,
  renderTemplate,
  SILENT_LOGGER,
} from "./workflow-runtime.ts";

// ---------- fakes -----------------------------------------------------------

/**
 * A provider that replies with a function of the *last user message text* (the
 * rendered step prompt). Records every prompt it sees so tests can assert step
 * ordering and `{{ prev }}` / `{{ outputs.<key> }}` threading.
 */
class PromptResponder implements LlmProvider {
  readonly seen: string[] = [];
  readonly #reply: (prompt: string) => string;
  readonly #delayMs: number;

  constructor(reply: (prompt: string) => string, delayMs = 0) {
    this.#reply = reply;
    this.#delayMs = delayMs;
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const prompt = lastUser && lastUser.role === "user" ? lastUser.content : "";
    this.seen.push(prompt);
    if (this.#delayMs > 0) await new Promise((r) => setTimeout(r, this.#delayMs));
    return { message: { role: "assistant", content: this.#reply(prompt) }, finish_reason: "stop", response_id: null };
  }

  async *completeStream(req: ChatRequest): AsyncGenerator<LlmChunk> {
    const resp = await this.complete(req);
    if (resp.message.role === "assistant" && typeof resp.message.content === "string") {
      yield { type: "content_delta", content: resp.message.content };
    }
    yield { type: "finish", message: resp.message, finish_reason: resp.finish_reason, response_id: null };
  }
}

/** A provider whose `complete` rejects, so every agent step fails. */
class FailingProvider implements LlmProvider {
  complete(_req: ChatRequest): Promise<ChatResponse> {
    return Promise.reject(new Error("provider boom"));
  }
  async *completeStream(_req: ChatRequest): AsyncGenerator<LlmChunk> {
    yield { type: "finish", message: { role: "assistant", content: "" }, finish_reason: "stop", response_id: null };
  }
}

function makeState(
  provider: LlmProvider,
  overrides: Partial<AppState> = {},
): AppState {
  return {
    workflows: new MemoryWorkflowStore(),
    createAgent: () => new Agent(provider, { ...defaultAgentConfig("test-model"), maxIterations: 5 }),
    ...overrides,
  };
}

// Agent step helper.
function agent(name: string, prompt: string, outputKey?: string): WorkflowStep {
  return newWorkflowStep(name, { type: "agent", prompt, output_key: outputKey });
}

const opts = { timeoutMs: 5_000, logger: SILENT_LOGGER } as const;

// ---------- renderTemplate ---------------------------------------------------

test("renderTemplate substitutes prev and outputs (spaced + tight)", () => {
  const outputs = new Map([["research", "FINDINGS"]]);
  const rendered = renderTemplate("Use {{ prev }} and {{ outputs.research }} and {{outputs.research}}", "PREV", outputs);
  assert.equal(rendered, "Use PREV and FINDINGS and FINDINGS");
});

test("renderTemplate leaves unknown placeholders untouched", () => {
  const rendered = renderTemplate("keep {{ outputs.missing }}", undefined, new Map());
  assert.equal(rendered, "keep {{ outputs.missing }}");
});

// ---------- step ordering + status (Agent + Pipeline + Parallel) ------------

test("drives an Agent+Pipeline+Parallel def: ordering, threading, status", async () => {
  // Reply echoes a tag so we can read threading: each step's output is
  // `out:<rendered-prompt>`.
  const provider = new PromptResponder((p) => `out:${p}`);
  const state = makeState(provider);

  // Top-level: [ agent A (output_key=a) , pipeline[ B uses {{prev}}, C ] ,
  //             parallel[ D , E ] ]
  const def: WorkflowDefinition = newWorkflowDefinition("ship");
  const stepA = agent("A", "do A", "a");
  const stepB = agent("B", "B sees {{ prev }} and {{ outputs.a }}");
  const stepC = agent("C", "C runs");
  const stepD = agent("D", "D one");
  const stepE = agent("E", "E two");
  const pipeline = newWorkflowStep("pipe", { type: "pipeline", steps: [stepB, stepC] });
  const parallel = newWorkflowStep("par", { type: "parallel", steps: [stepD, stepE], join: "all_required" });
  def.steps = [stepA, pipeline, parallel];

  const run = await driveWorkflow(state, def, opts);

  assert.equal(run.status, "succeeded");
  // 5 leaf results, in execution order (parallel children preserve array order).
  assert.deepEqual(
    run.step_results.map((r) => r.name),
    ["A", "B", "C", "D", "E"],
  );
  assert.ok(run.step_results.every((r) => r.status === "succeeded"));

  // A's output threads into B as both {{ prev }} and {{ outputs.a }}.
  const outA = "out:do A";
  const bResult = run.step_results.find((r) => r.name === "B")!;
  assert.equal(bResult.output, `out:B sees ${outA} and ${outA}`);

  // Every leaf got a conversation id; the run is persisted + terminal.
  assert.ok(run.step_results.every((r) => typeof r.conversation_id === "string"));
  assert.ok(typeof run.finished_at === "string");

  const persisted = await state.workflows!.getRun(run.id);
  assert.equal(persisted?.status, "succeeded");
  assert.equal(persisted?.step_results.length, 5);
});

test("a failing step fails the run and stops the sequential tail", async () => {
  const provider = new FailingProvider();
  const state = makeState(provider);
  const def = newWorkflowDefinition("boom");
  def.steps = [agent("A", "first"), agent("B", "second")];

  const run = await driveWorkflow(state, def, opts);

  assert.equal(run.status, "failed");
  assert.equal(run.error, "one or more workflow steps failed");
  // Sequential parent stops at the first failure → only A executed.
  assert.equal(run.step_results.length, 1);
  assert.equal(run.step_results[0].status, "failed");
  assert.match(run.step_results[0].error ?? "", /agent error:/);
});

test("best_effort parallel tolerates a child failure; all_required does not", async () => {
  // Provider fails only on the prompt containing "FAIL".
  const provider: LlmProvider = {
    complete(req) {
      const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
      const prompt = lastUser && lastUser.role === "user" ? lastUser.content : "";
      if (prompt.includes("FAIL")) return Promise.reject(new Error("nope"));
      return Promise.resolve({ message: { role: "assistant", content: "ok" }, finish_reason: "stop", response_id: null });
    },
    async *completeStream() {
      yield { type: "finish", message: { role: "assistant", content: "ok" }, finish_reason: "stop", response_id: null };
    },
  };

  // best_effort: one child fails but the group (and run) succeed.
  {
    const state = makeState(provider);
    const def = newWorkflowDefinition("be");
    def.steps = [
      newWorkflowStep("par", {
        type: "parallel",
        steps: [agent("ok", "fine"), agent("bad", "FAIL here")],
        join: "best_effort",
      }),
    ];
    const run = await driveWorkflow(state, def, opts);
    assert.equal(run.status, "succeeded");
    assert.equal(run.step_results.length, 2);
  }

  // all_required: the same child failure fails the run.
  {
    const state = makeState(provider);
    const def = newWorkflowDefinition("ar");
    def.steps = [
      newWorkflowStep("par", {
        type: "parallel",
        steps: [agent("ok", "fine"), agent("bad", "FAIL here")],
        join: "all_required",
      }),
    ];
    const run = await driveWorkflow(state, def, opts);
    assert.equal(run.status, "failed");
  }
});

test("persists initial conversations through the configured store", async () => {
  const store = new MemoryConversationStore();
  const provider = new PromptResponder((p) => `out:${p}`);
  const state = makeState(provider, { store });
  const def = newWorkflowDefinition("persist");
  def.steps = [agent("A", "do A")];

  const run = await driveWorkflow(state, def, opts);
  const convId = run.step_results[0].conversation_id!;
  const loaded = await store.load(convId);
  assert.ok(loaded, "the step conversation was persisted");
  // The final assistant text is on the persisted (re-saved) conversation.
  assert.ok(loaded!.messages.some((m) => m.role === "assistant" && m.content === "out:do A"));
});

// ---------- cancel ----------------------------------------------------------

test("cancel via the run gate aborts an in-flight run between steps", async () => {
  // Each step takes ~40ms; we abort after the first reply so step 2 sees the
  // signal and the run finalises as cancelled.
  const provider = new PromptResponder((p) => `out:${p}`, 40);
  const gate = new WorkflowRunGate(2);
  const state = makeState(provider, { workflowRunGate: gate });

  const def = newWorkflowDefinition("slow");
  def.steps = [agent("A", "A"), agent("B", "B"), agent("C", "C")];

  const run = newWorkflowRun(def.id, undefined);
  const controller = new AbortController();
  gate.registerController(run.id, controller);

  const drive = driveWorkflow(state, def, { ...opts, run, signal: controller.signal });
  // Abort partway through.
  setTimeout(() => gate.cancel(run.id), 50);

  const finished = await drive;
  assert.equal(finished.status, "cancelled");
  assert.equal(finished.error, "run cancelled by operator");
  // It did NOT run all three steps to completion.
  assert.ok(finished.step_results.length < 3, "cancellation stopped the run early");
});

// ---------- reaper: reclaim only orphans ------------------------------------

function reaperState(): { state: AppState; store: MemoryWorkflowStore; gate: WorkflowRunGate } {
  const store = new MemoryWorkflowStore();
  const gate = new WorkflowRunGate(2);
  const state: AppState = {
    createAgent: () => {
      throw new Error("agent not used in reaper tests");
    },
    workflows: store,
    workflowRunGate: gate,
  };
  return { state, store, gate };
}

function runWithAge(status: WorkflowRunStatus, ageMs: number) {
  const run = newWorkflowRun("wf-1", undefined);
  run.status = status;
  run.started_at = new Date(Date.now() - ageMs).toISOString();
  return run;
}

test("reaper reclaims an old running run (past 3× budget) as cancelled", async () => {
  const { state, store } = reaperState();
  const run = runWithAge("running", 10_000); // older than 1000 × 3
  await store.upsertRun(run);

  const reaped = await reapStaleWorkflowRuns(state, 1_000, SILENT_LOGGER);
  assert.equal(reaped, 1);
  const got = await store.getRun(run.id);
  assert.equal(got?.status, "cancelled");
  assert.ok(typeof got?.finished_at === "string");
  assert.ok(got?.error);
});

test("reaper leaves a fresh running run alone", async () => {
  const { state, store } = reaperState();
  const run = runWithAge("running", 100);
  await store.upsertRun(run);

  const reaped = await reapStaleWorkflowRuns(state, 60_000, SILENT_LOGGER);
  assert.equal(reaped, 0);
  assert.equal((await store.getRun(run.id))?.status, "running");
});

test("reaper skips a run still alive in-process despite age", async () => {
  const { state, store, gate } = reaperState();
  const run = runWithAge("running", 10_000);
  await store.upsertRun(run);
  // Mark it alive locally — the reaper must not touch it.
  const guard = gate.markInflight(run.id);

  const reaped = await reapStaleWorkflowRuns(state, 1_000, SILENT_LOGGER);
  assert.equal(reaped, 0);
  assert.equal((await store.getRun(run.id))?.status, "running");
  guard.clear();
});

test("reaper reclaims an old pending run at the 1× budget", async () => {
  const { state, store } = reaperState();
  const run = runWithAge("pending", 2_000); // older than budget (1000), younger than 3×
  await store.upsertRun(run);

  const reaped = await reapStaleWorkflowRuns(state, 1_000, SILENT_LOGGER);
  assert.equal(reaped, 1);
  assert.equal((await store.getRun(run.id))?.status, "cancelled");
});

test("reaper ignores terminal runs", async () => {
  const { state, store } = reaperState();
  const run = runWithAge("succeeded", 10_000);
  finishWorkflowRun(run, "succeeded");
  await store.upsertRun(run);

  const reaped = await reapStaleWorkflowRuns(state, 1_000, SILENT_LOGGER);
  assert.equal(reaped, 0);
  assert.equal((await store.getRun(run.id))?.status, "succeeded");
});

test("reaper no-ops without a workflow store", async () => {
  const state: AppState = { createAgent: () => { throw new Error("unused"); } };
  assert.equal(await reapStaleWorkflowRuns(state, 1_000, SILENT_LOGGER), 0);
});

// ---------- failRunIfRunning ------------------------------------------------

test("failRunIfRunning flips a running run to failed", async () => {
  const { state, store } = reaperState();
  const run = newWorkflowRun("wf", undefined); // status "running"
  await store.upsertRun(run);

  await failRunIfRunning(state, run.id, "workflow run crashed", SILENT_LOGGER);
  const got = await store.getRun(run.id);
  assert.equal(got?.status, "failed");
  assert.equal(got?.error, "workflow run crashed");
  assert.ok(typeof got?.finished_at === "string");
});

test("failRunIfRunning leaves a terminal run untouched", async () => {
  const { state, store } = reaperState();
  const run = newWorkflowRun("wf", undefined);
  finishWorkflowRun(run, "succeeded");
  await store.upsertRun(run);

  await failRunIfRunning(state, run.id, "should not apply", SILENT_LOGGER);
  const got = await store.getRun(run.id);
  assert.equal(got?.status, "succeeded");
  assert.equal(got?.error, undefined);
});
