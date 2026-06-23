import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import type { Agent, AgentEvent, ApprovalDecision, Approver, Conversation } from "@jarvis/core";
import { ChatRunRegistry } from "./chat-runs.ts";
import { handleWsConnection, registerChatRoutes } from "./chat-routes.ts";
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

// ---------- WS close handling (issue #202) --------------------------------

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Minimal fake `ws` socket capturing listeners by event name + sent frames. */
function fakeSocket() {
  const listeners = new Map<string, (data: { toString(): string }) => void>();
  const sent: Record<string, unknown>[] = [];
  const socket = {
    OPEN: 1,
    readyState: 1,
    send(s: string) {
      sent.push(JSON.parse(s) as Record<string, unknown>);
    },
    on(event: string, fn: (data: { toString(): string }) => void) {
      listeners.set(event, fn);
    },
  };
  return { socket, listeners, sent };
}

/**
 * Agent whose turn parks on a single gated tool awaiting the approver — the
 * disconnect-mid-approval scenario from issue #202. Records the decision the
 * tool ultimately receives so the test can assert the close drain.
 */
function parkingAgentState(extra?: Partial<AppState>): {
  state: AppState;
  decision: () => ApprovalDecision | undefined;
} {
  let resolved: ApprovalDecision | undefined;
  const state = {
    createAgent(approver?: Approver): Agent {
      const fake = {
        runStream(conv: Conversation) {
          return (async function* (): AsyncGenerator<AgentEvent> {
            const d = await approver!.approve({
              tool_call_id: "tc1",
              tool_name: "shell.exec",
              arguments: {},
              category: "exec",
            });
            resolved = d;
            yield { type: "done", conversation: conv } as AgentEvent;
          })();
        },
      };
      return fake as unknown as Agent;
    },
    ...extra,
  } as AppState;
  return { state, decision: () => resolved };
}

test("ws registers a close handler that denies pending approvals (issue #202)", async () => {
  const { socket, listeners } = fakeSocket();
  const { state, decision } = parkingAgentState();

  handleWsConnection(socket as never, state);
  assert.ok(listeners.has("close"), "regression: ws must register a `close` handler");

  // Start a turn (non-persisted) → it parks awaiting the approval.
  listeners.get("message")!({ toString: () => JSON.stringify({ type: "user", content: "hi" }) });
  await flush();
  assert.equal(decision(), undefined, "tool still parked before disconnect");

  // Disconnect mid-approval: the parked tool must be unblocked with a deny so
  // its generator can settle (instead of pinning the turn forever).
  listeners.get("close")!({ toString: () => "" });
  await flush();
  assert.equal(decision()?.decision, "deny", "close drains the pending approval as a deny");
});

test("ws close marks the persisted run cancelled in the registry (issue #202)", async () => {
  const { socket, listeners } = fakeSocket();
  const reg = new ChatRunRegistry();
  const { state } = parkingAgentState({ chatRuns: reg });

  handleWsConnection(socket as never, state);

  // `new` sets persistedId (no store needed) → the turn is registry-tracked.
  listeners.get("message")!({ toString: () => JSON.stringify({ type: "new", id: "conv-1" }) });
  await flush();
  listeners.get("message")!({ toString: () => JSON.stringify({ type: "user", content: "hi" }) });
  await flush();
  assert.equal(reg.list(false).find((r) => r.conversation_id === "conv-1")?.status, "running");

  listeners.get("close")!({ toString: () => "" });
  await flush();
  assert.equal(
    reg.list(false).find((r) => r.conversation_id === "conv-1")?.status,
    "cancelled",
    "socket close cancels the persisted run (not just the REST interrupt route)",
  );
});
