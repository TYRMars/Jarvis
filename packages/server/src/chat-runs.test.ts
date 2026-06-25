import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
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

test("hitl_request pauses the run as waiting_hitl; hitl_response/delta resumes it", () => {
  const reg = new ChatRunRegistry();
  reg.start("c1");

  // A native HITL question blocks the turn on the operator.
  reg.event("c1", { type: "hitl_request", id: "h1", kind: "input", prompt: "name?" });
  assert.equal(reg.list(false)[0]!.status, "waiting_hitl");
  assert.equal(reg.list(false)[0]!.current_tool, null);

  // The operator's answer resumes the turn.
  reg.event("c1", { type: "hitl_response", id: "h1", answer: "Ada" });
  assert.equal(reg.list(false)[0]!.status, "running");

  // A streamed delta also recovers a stalled HITL pause (resume without an
  // explicit response frame).
  reg.event("c1", { type: "hitl_request", id: "h2", kind: "confirm", prompt: "ok?" });
  assert.equal(reg.list(false)[0]!.status, "waiting_hitl");
  reg.event("c1", { type: "delta", content: "continuing" });
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
