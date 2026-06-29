import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { WebSocket } from "ws";
import {
  Agent,
  defaultAgentConfig,
  type ChatRequest,
  type ChatResponse,
  type LlmChunk,
  type LlmProvider,
} from "@jarvis/core";
import { MemoryConversationStore } from "@jarvis/store";
import { ChatRunRegistry } from "./chat-runs.ts";
import { registerChatRoutes } from "./chat-routes.ts";
import type { AppState } from "./state.ts";

function agentUnused(): never {
  throw new Error("agent not used in these route tests");
}

// ---------- ChatRunRegistry unit ------------------------------------------

test("registry tracks status transitions from events", () => {
  const reg = new ChatRunRegistry();
  reg.start("c1");
  assert.deepEqual(reg.list(false).map((r) => r.status), ["running"]);

  reg.event("c1", { type: "tool_start", id: "t1", name: "fs.read", arguments: {} });
  let rec = reg.list(false)[0]!;
  assert.equal(rec.status, "running");
  assert.equal(rec.current_tool, "fs.read");
  assert.equal(rec.latest_seq, 1);

  reg.event("c1", { type: "tool_end", id: "t1", name: "fs.read", content: "x" });
  assert.equal(reg.list(false)[0]!.current_tool, null);

  reg.event("c1", { type: "approval_request", id: "t2", name: "shell.exec", arguments: {} });
  assert.equal(reg.list(false)[0]!.status, "waiting_approval");
  reg.event("c1", { type: "approval_decision", id: "t2", name: "shell.exec", decision: { kind: "approve" } });
  assert.equal(reg.list(false)[0]!.status, "running");
});

test("finish is sticky-terminal; activeOnly filters", () => {
  const reg = new ChatRunRegistry();
  reg.start("c1");
  reg.start("c2");
  reg.finish("c1", "completed");
  reg.finish("c1", "failed"); // sticky — stays completed
  assert.equal(reg.list(false).find((r) => r.conversation_id === "c1")!.status, "completed");
  assert.deepEqual(
    reg.list(true).map((r) => r.conversation_id),
    ["c2"],
  );
});

test("interrupt cancels an active run, returns false when none/terminal", () => {
  const reg = new ChatRunRegistry();
  const signal = reg.start("c1");
  assert.equal(signal.aborted, false);
  assert.equal(reg.interrupt("c1"), true);
  assert.equal(signal.aborted, true);
  assert.equal(reg.list(false)[0]!.status, "cancelled");
  assert.equal(reg.interrupt("c1"), false); // already terminal
  assert.equal(reg.interrupt("missing"), false);
});

test("events filters by ?after seq", () => {
  const reg = new ChatRunRegistry();
  reg.start("c1");
  reg.event("c1", { type: "delta", content: "a" });
  reg.event("c1", { type: "delta", content: "b" });
  assert.deepEqual(reg.events("c1", 0).map((e) => e.seq), [1, 2]);
  assert.deepEqual(reg.events("c1", 1).map((e) => e.seq), [2]);
  assert.deepEqual(reg.events("missing", 0), []);
});

// ---------- routes ---------------------------------------------------------

async function buildApp(state: AppState) {
  const app = Fastify();
  await app.register(fastifyWebsocket);
  registerChatRoutes(app, state);
  await app.ready();
  return app;
}

test("chat-run routes 503 when no registry", async () => {
  const app = await buildApp({ createAgent: agentUnused });
  assert.equal((await app.inject({ method: "GET", url: "/v1/chat/runs" })).statusCode, 503);
  assert.equal((await app.inject({ method: "GET", url: "/v1/chat/runs/c1/events" })).statusCode, 503);
  assert.equal((await app.inject({ method: "POST", url: "/v1/chat/runs/c1/interrupt" })).statusCode, 503);
  await app.close();
});

test("GET /v1/chat/runs is a bare array; events + interrupt round-trip", async () => {
  const reg = new ChatRunRegistry();
  reg.start("c1");
  reg.event("c1", { type: "delta", content: "hi" });
  const app = await buildApp({ createAgent: agentUnused, chatRuns: reg });

  const runs = (await app.inject({ method: "GET", url: "/v1/chat/runs" })).json();
  assert.ok(Array.isArray(runs), "bare array, not { items }");
  assert.equal((runs as { conversation_id: string }[])[0].conversation_id, "c1");

  const events = (await app.inject({ method: "GET", url: "/v1/chat/runs/c1/events?after=0" })).json() as {
    seq: number;
  }[];
  assert.deepEqual(events.map((e) => e.seq), [1]);

  const ok = await app.inject({ method: "POST", url: "/v1/chat/runs/c1/interrupt" });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { ok: true });
  // now terminal → 404
  assert.equal((await app.inject({ method: "POST", url: "/v1/chat/runs/c1/interrupt" })).statusCode, 404);
  await app.close();
});

// ---------- WS turn → run-status reconciliation (regression for #264) --------

/** A provider that always fails — runStream YIELDS `{type:"error"}`, never throws. */
class ThrowingProvider implements LlmProvider {
  complete(_req: ChatRequest): Promise<ChatResponse> {
    return Promise.reject(new Error("boom: provider exploded"));
  }
  async *completeStream(_req: ChatRequest): AsyncGenerator<LlmChunk> {
    await Promise.resolve();
    throw new Error("boom: provider exploded");
  }
}

async function listen(state: AppState): Promise<{ app: Awaited<ReturnType<typeof buildApp>>; port: number }> {
  const app = await buildApp(state);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address() as { port: number };
  return { app, port: addr.port };
}

test("a mid-stream provider error finishes the WS run as 'failed', not 'completed' (#264)", async () => {
  const store = new MemoryConversationStore();
  const reg = new ChatRunRegistry();
  const state: AppState = {
    store,
    chatRuns: reg,
    createAgent: (approver) =>
      new Agent(new ThrowingProvider(), { ...defaultAgentConfig("test-model"), maxIterations: 5, approver }),
  };
  const { app, port } = await listen(state);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/chat/ws`);
  await once(ws, "open");
  const frames: { type: string; message?: string }[] = [];
  const waiters: { pred: (f: { type: string }) => boolean; resolve: (f: { type: string }) => void }[] = [];
  ws.on("message", (data: Buffer) => {
    const f = JSON.parse(data.toString()) as { type: string };
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(f)) {
        waiters[i]!.resolve(f);
        waiters.splice(i, 1);
      }
    }
  });
  const waitFor = (pred: (f: { type: string }) => boolean): Promise<{ type: string }> =>
    new Promise((resolve) => {
      const hit = frames.find(pred);
      if (hit) resolve(hit);
      else waiters.push({ pred, resolve });
    });
  try {
    // Persisted session so the turn is tracked (runId = persistedId).
    ws.send(JSON.stringify({ type: "new", id: "conv-fail" }));
    await waitFor((f) => f.type === "session");

    ws.send(JSON.stringify({ type: "user", content: "go" }));
    const err = (await waitFor((f) => f.type === "error")) as { message?: string };
    assert.match(err.message ?? "", /boom: provider exploded/);

    // The run finishes right after the error frame; poll the registry for the
    // terminal status (no `done`/`cancelled` frame is sent on the error path).
    let rec: { status: string; last_error?: string | null } | undefined;
    for (let i = 0; i < 50; i++) {
      rec = reg.list(false).find((r) => r.conversation_id === "conv-fail");
      if (rec && rec.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(rec, "run should be tracked");
    assert.equal(rec!.status, "failed", "a yielded error must mark the run failed, not completed");
    assert.match(rec!.last_error ?? "", /boom: provider exploded/);
  } finally {
    ws.close();
    await app.close();
  }
});
