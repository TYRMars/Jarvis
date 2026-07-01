import { test, mock } from "node:test";
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

test("evicts non-terminal runs left idle past the staleness window (#289)", () => {
  mock.timers.enable({ apis: ["Date"] });
  try {
    const reg = new ChatRunRegistry();
    reg.start("abandoned"); // stays non-terminal (running) — client disconnected mid-turn
    assert.deepEqual(reg.list(false).map((r) => r.conversation_id), ["abandoned"]);

    // Idle just under the window, then a new turn sweeps: abandoned still retained.
    mock.timers.tick(29 * 60_000);
    reg.start("fresh1");
    assert.ok(
      reg.list(false).some((r) => r.conversation_id === "abandoned"),
      "not yet stale — must survive",
    );

    // Cross the staleness window; the next sweep reclaims the abandoned run.
    mock.timers.tick(2 * 60_000);
    reg.start("fresh2");
    const ids = reg.list(false).map((r) => r.conversation_id).sort();
    assert.deepEqual(ids, ["fresh1", "fresh2"], "abandoned run reclaimed; active runs kept");
  } finally {
    mock.timers.reset();
  }
});

test("an actively-updating run is never mistaken for stale", () => {
  mock.timers.enable({ apis: ["Date"] });
  try {
    const reg = new ChatRunRegistry();
    reg.start("busy");
    // Emit an event every 10 min for over an hour — updated_at keeps refreshing.
    for (let i = 0; i < 7; i++) {
      mock.timers.tick(10 * 60_000);
      reg.event("busy", { type: "delta", content: "chunk" });
      reg.start("nudge"); // trigger an eviction sweep alongside the activity
    }
    assert.ok(
      reg.list(false).some((r) => r.conversation_id === "busy"),
      "long-but-active run must not be evicted",
    );
  } finally {
    mock.timers.reset();
  }
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
