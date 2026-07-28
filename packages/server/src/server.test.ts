import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";

import {
  Agent,
  ToolRegistry,
  defaultAgentConfig,
  emitModeSignal,
  requestHuman,
  type ChatRequest,
  type ChatResponse,
  type LlmChunk,
  type LlmProvider,
  type Message,
  type Tool,
  type ToolCall,
} from "@jarvis/core";
import { MemoryConversationStore } from "@jarvis/store";
import { buildServer, serve } from "./server.ts";
import {
  MemoryPermissionStore,
  type PermissionMode,
  type PermissionStore,
} from "./permissions-routes.ts";
import type { AppState } from "./state.ts";

// ---------- fixtures ----------

interface ScriptTurn {
  content?: string;
  toolCalls?: ToolCall[];
}

/** A deterministic provider that returns scripted turns in order. */
class ScriptedProvider implements LlmProvider {
  #turns: ScriptTurn[];
  #i = 0;
  constructor(turns: ScriptTurn[]) {
    this.#turns = turns;
  }
  #next(): ChatResponse {
    const turn = this.#turns[this.#i++] ?? { content: "(end of script)" };
    const toolCalls = turn.toolCalls ?? [];
    const message: Message = { role: "assistant" };
    if (turn.content != null) message.content = turn.content;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    return { message, finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop", response_id: null };
  }
  complete(_req: ChatRequest): Promise<ChatResponse> {
    return Promise.resolve(this.#next());
  }
  async *completeStream(_req: ChatRequest): AsyncGenerator<LlmChunk> {
    const resp = this.#next();
    if (resp.message.role === "assistant" && typeof resp.message.content === "string" && resp.message.content) {
      const c = resp.message.content;
      const mid = Math.ceil(c.length / 2);
      yield { type: "content_delta", content: c.slice(0, mid) };
      yield { type: "content_delta", content: c.slice(mid) };
    }
    yield { type: "finish", message: resp.message, finish_reason: resp.finish_reason, response_id: null };
  }
}

const echoTool: Tool = {
  name: "echo",
  description: "echo back args",
  parameters: { type: "object" },
  category: "read",
  invoke: (args) => Promise.resolve(JSON.stringify(args)),
};

const dangerTool: Tool = {
  name: "danger.run",
  description: "a gated tool",
  parameters: { type: "object" },
  category: "exec",
  requiresApproval: true,
  invoke: () => Promise.resolve("ran"),
};

// Surfaces a HITL question and returns the operator's answer (mirrors ask.text).
const askTool: Tool = {
  name: "ask.text",
  description: "ask the operator",
  parameters: { type: "object" },
  category: "read",
  invoke: async () => {
    const r = await requestHuman({ id: "q1", transport: "text", kind: "input", title: "Your name?" });
    return `hi ${String(r.payload)} [${r.status}]`;
  },
};

// Terminal tool: the loop must stop the turn as soon as this returns, and the
// WS must republish its output as `plan_proposed`.
const exitPlanTool: Tool = {
  name: "exit_plan",
  description: "submit a plan",
  parameters: { type: "object" },
  category: "read",
  isTerminal: true,
  invoke: (args) =>
    Promise.resolve(
      args && typeof args === "object" && !Array.isArray(args) && typeof args.plan === "string"
        ? args.plan
        : "",
    ),
};

// Asks the session to switch into Plan Mode (mirrors the enter_plan_mode tool).
const armPlanTool: Tool = {
  name: "enter_plan_mode",
  description: "arm plan mode",
  parameters: { type: "object" },
  category: "read",
  invoke: () => {
    emitModeSignal("plan");
    return Promise.resolve("armed");
  },
};

function makeState(
  turns: ScriptTurn[],
  opts: {
    store?: MemoryConversationStore;
    tools?: ToolRegistry;
    permissionStore?: PermissionStore;
  } = {},
): AppState {
  const provider = new ScriptedProvider(turns);
  const tools = opts.tools ?? new ToolRegistry();
  return {
    store: opts.store,
    permissionStore: opts.permissionStore,
    // `toolFilter` must be threaded through: it is how the WS hands the socket's
    // live Plan-Mode restriction to the loop.
    createAgent: (approver, human, toolFilter) =>
      new Agent(provider, {
        ...defaultAgentConfig("test-model"),
        tools,
        maxIterations: 5,
        approver,
        human,
        toolFilter,
      }),
  };
}

// ---------- blocking /v1/chat/completions ----------

test("POST /v1/chat/completions returns {message, iterations, history}", async () => {
  const app = await buildServer(makeState([{ content: "hello" }]));
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: { messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.message.content, "hello");
  assert.equal(body.iterations, 1);
  assert.equal(body.history.length, 2); // user + assistant
  await app.close();
});

test("POST /v1/chat/completions runs a tool loop", async () => {
  const tools = new ToolRegistry().register(echoTool);
  const app = await buildServer(
    makeState([{ toolCalls: [{ id: "c1", name: "echo", arguments: { x: 1 } }] }, { content: "done" }], { tools }),
  );
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: { messages: [{ role: "user", content: "echo please" }] },
  });
  const body = res.json();
  assert.equal(body.message.content, "done");
  assert.equal(body.iterations, 2);
  // user, assistant(tool_calls), tool, assistant(done)
  assert.equal(body.history.length, 4);
  assert.equal(body.history[2].role, "tool");
  assert.equal(body.history[2].content, '{"x":1}');
  await app.close();
});

test("POST /v1/chat/completions rejects a body without messages", async () => {
  const app = await buildServer(makeState([{ content: "x" }]));
  const res = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: {} });
  assert.equal(res.statusCode, 400);
  await app.close();
});

// ---------- SSE /v1/chat/completions/stream ----------

/** A decoded event/frame: a tagged `type` plus arbitrary other fields. */
type Frame = { type: string } & Record<string, unknown>;

async function readSse(res: Response): Promise<Frame[]> {
  const events: Frame[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let pos: number;
    while ((pos = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, pos);
      buf = buf.slice(pos + 2);
      for (const line of block.split("\n")) {
        if (line.startsWith("data:")) events.push(JSON.parse(line.slice(5).trim()) as Frame);
      }
    }
  }
  return events;
}

test("POST /v1/chat/completions/stream emits deltas + assistant_message + done", async () => {
  const app = await serve({ host: "127.0.0.1", port: 0 }, makeState([{ content: "hi there" }]));
  const { port } = app.server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    const events = await readSse(res);
    const deltas = events.filter((e) => e.type === "delta").map((e) => e.content as string);
    assert.deepEqual(deltas.join(""), "hi there");
    assert.ok(events.some((e) => e.type === "assistant_message"));
    const done = events.at(-1)!;
    assert.equal(done.type, "done");
    assert.ok((done.conversation as { messages: unknown[] }).messages.length >= 2);
  } finally {
    await app.close();
  }
});

// ---------- conversations CRUD ----------

test("conversations routes 503 when no store is configured", async () => {
  const app = await buildServer(makeState([{ content: "x" }]));
  assert.equal((await app.inject({ method: "GET", url: "/v1/conversations" })).statusCode, 503);
  assert.equal((await app.inject({ method: "POST", url: "/v1/conversations", payload: {} })).statusCode, 503);
  await app.close();
});

test("conversations create/get/post-message/list/delete round-trip", async () => {
  const store = new MemoryConversationStore();
  const tools = new ToolRegistry();
  const app = await buildServer(makeState([{ content: "assistant reply" }], { store, tools }));

  const created = await app.inject({ method: "POST", url: "/v1/conversations", payload: { system: "be terse" } });
  assert.equal(created.statusCode, 201);
  const id = created.json().id as string;

  const got = await app.inject({ method: "GET", url: `/v1/conversations/${id}` });
  assert.equal(got.json().messages[0].content, "be terse");

  const posted = await app.inject({
    method: "POST",
    url: `/v1/conversations/${id}/messages`,
    payload: { content: "hello" },
  });
  const pbody = posted.json();
  assert.equal(pbody.message.content, "assistant reply");
  assert.equal(pbody.iterations, 1);
  // system + user + assistant
  assert.equal(pbody.history.length, 3);

  // persisted: reloading shows the saved turn
  const reload = await app.inject({ method: "GET", url: `/v1/conversations/${id}` });
  assert.equal(reload.json().messages.length, 3);

  const list = await app.inject({ method: "GET", url: "/v1/conversations" });
  assert.ok((list.json() as { id: string }[]).some((r) => r.id === id));

  const del = await app.inject({ method: "DELETE", url: `/v1/conversations/${id}` });
  assert.deepEqual(del.json(), { deleted: true });
  assert.equal((await app.inject({ method: "DELETE", url: `/v1/conversations/${id}` })).statusCode, 404);
  await app.close();
});

test("conversations: internal __ ids are rejected/hidden", async () => {
  const store = new MemoryConversationStore();
  await store.save("__memory__.summary:abc", { messages: [{ role: "user", content: "secret" }] });
  const app = await buildServer(makeState([{ content: "x" }], { store }));

  // create rejects an explicit internal id
  const create = await app.inject({ method: "POST", url: "/v1/conversations", payload: { id: "__sneaky" } });
  assert.equal(create.statusCode, 400);
  // get / delete refuse
  assert.equal((await app.inject({ method: "GET", url: "/v1/conversations/__memory__.summary:abc" })).statusCode, 404);
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/conversations/__memory__.summary:abc" })).statusCode, 404);
  // list hides it
  const list = await app.inject({ method: "GET", url: "/v1/conversations" });
  assert.ok(!(list.json() as { id: string }[]).some((r) => r.id.startsWith("__")));
  await app.close();
});

// ---------- WebSocket /v1/chat/ws ----------

interface WsHarness {
  ws: WebSocket;
  frames: Frame[];
  send(obj: unknown): void;
  waitFor(pred: (f: Frame) => boolean): Promise<Frame>;
  close(): void;
}

async function openWs(port: number): Promise<WsHarness> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/chat/ws`);
  const frames: Frame[] = [];
  const waiters: { pred: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  // Attach BEFORE awaiting "open": the server sends `permission_mode` as soon as
  // the socket is up, and a listener attached after the await races it away. A
  // browser client attaches `onmessage` before the connection opens, so this
  // matches real client behaviour rather than papering over a server bug.
  ws.on("message", (data: Buffer) => {
    const frame = JSON.parse(data.toString()) as Frame;
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(frame)) {
        waiters[i]!.resolve(frame);
        waiters.splice(i, 1);
      }
    }
  });
  await once(ws, "open");
  return {
    ws,
    frames,
    send: (obj) => ws.send(JSON.stringify(obj)),
    waitFor: (pred) =>
      new Promise((resolve) => {
        const hit = frames.find(pred);
        if (hit) resolve(hit);
        else waiters.push({ pred, resolve });
      }),
    close: () => ws.close(),
  };
}

test("WS: approval flow — turn parks at approval_request, guard fires, approve completes", async () => {
  const tools = new ToolRegistry().register(dangerTool);
  const app = await serve(
    { host: "127.0.0.1", port: 0 },
    makeState([{ toolCalls: [{ id: "tc1", name: "danger.run", arguments: {} }] }, { content: "finished" }], { tools }),
  );
  const { port } = app.server.address() as { port: number };
  const client = await openWs(port);
  try {
    client.send({ type: "user", content: "go" });
    // The agent parks awaiting approval.
    const req = await client.waitFor((f) => f.type === "approval_request");
    assert.equal(req.id as string, "tc1");

    // A second user frame while the turn is parked → guard error.
    client.send({ type: "user", content: "again" });
    const guard = await client.waitFor((f) => f.type === "error");
    assert.match(guard.message as string, /turn in progress/);

    // Approve → tool runs, second turn produces the final answer, done.
    client.send({ type: "approve", tool_call_id: "tc1" });
    const toolEnd = await client.waitFor((f) => f.type === "tool_end");
    assert.equal(toolEnd.content as string, "ran");
    const done = await client.waitFor((f) => f.type === "done");
    assert.ok(done);
  } finally {
    client.close();
    await app.close();
  }
});

test("WS: deny surfaces 'tool denied' and unknown approval id errors", async () => {
  const tools = new ToolRegistry().register(dangerTool);
  const app = await serve(
    { host: "127.0.0.1", port: 0 },
    makeState([{ toolCalls: [{ id: "tc9", name: "danger.run", arguments: {} }] }, { content: "after deny" }], { tools }),
  );
  const { port } = app.server.address() as { port: number };
  const client = await openWs(port);
  try {
    // Unknown approval id with no turn running → error.
    client.send({ type: "approve", tool_call_id: "nope" });
    const e = await client.waitFor((f) => f.type === "error");
    assert.match(e.message as string, /no pending approval/);

    client.send({ type: "user", content: "go" });
    await client.waitFor((f) => f.type === "approval_request");
    client.send({ type: "deny", tool_call_id: "tc9", reason: "nope" });
    const toolEnd = await client.waitFor((f) => f.type === "tool_end");
    assert.match(toolEnd.content as string, /^tool denied: nope/);
    await client.waitFor((f) => f.type === "done");
  } finally {
    client.close();
    await app.close();
  }
});

test("WS: HITL flow — ask.text parks at hitl_request, response echoes and resolves it", async () => {
  const tools = new ToolRegistry().register(askTool);
  const app = await serve(
    { host: "127.0.0.1", port: 0 },
    makeState([{ toolCalls: [{ id: "tc1", name: "ask.text", arguments: {} }] }, { content: "finished" }], { tools }),
  );
  const { port } = app.server.address() as { port: number };
  const client = await openWs(port);
  try {
    client.send({ type: "user", content: "go" });
    // The agent parks awaiting the operator's answer.
    const req = await client.waitFor((f) => f.type === "hitl_request");
    assert.equal((req.request as { id: string }).id, "q1");
    assert.equal((req.request as { title: string }).title, "Your name?");

    // Answer with the flat frame the web AskTextCard sends.
    client.send({ type: "hitl_response", request_id: "q1", status: "submitted", payload: "Ada", reason: null });

    // The server echoes a nested hitl_response so the card resolves, then the
    // operator's answer reaches the tool and the turn completes.
    const echo = await client.waitFor((f) => f.type === "hitl_response");
    assert.equal((echo.response as { status: string }).status, "submitted");
    assert.equal((echo.response as { payload: string }).payload, "Ada");
    const toolEnd = await client.waitFor((f) => f.type === "tool_end");
    assert.equal(toolEnd.content as string, "hi Ada [submitted]");
    await client.waitFor((f) => f.type === "done");
  } finally {
    client.close();
    await app.close();
  }
});

test("WS: hitl_response with no pending request errors", async () => {
  const app = await serve({ host: "127.0.0.1", port: 0 }, makeState([{ content: "x" }]));
  const { port } = app.server.address() as { port: number };
  const client = await openWs(port);
  try {
    client.send({ type: "hitl_response", request_id: "nope", status: "submitted", payload: "x" });
    const e = await client.waitFor((f) => f.type === "error");
    assert.match(e.message as string, /no pending hitl request/);
  } finally {
    client.close();
    await app.close();
  }
});

test("WS: new allocates a session id; reset acks; resume loads from store", async () => {
  const store = new MemoryConversationStore();
  await store.save("conv-1", { messages: [{ role: "user", content: "earlier" }] });
  const app = await serve({ host: "127.0.0.1", port: 0 }, makeState([{ content: "ok" }], { store }));
  const { port } = app.server.address() as { port: number };
  const client = await openWs(port);
  try {
    client.send({ type: "new" });
    const session = await client.waitFor((f) => f.type === "session");
    assert.equal(typeof (session.id as string), "string");

    client.send({ type: "reset" });
    await client.waitFor((f) => f.type === "reset_ok");

    client.send({ type: "resume", id: "conv-1" });
    const resumed = await client.waitFor((f) => f.type === "resumed");
    assert.equal(resumed.id as string, "conv-1");

    client.send({ type: "resume", id: "does-not-exist" });
    const err = await client.waitFor((f) => f.type === "error" && /not found/.test(f.message as string));
    assert.ok(err);
  } finally {
    client.close();
    await app.close();
  }
});

// ---------- WebSocket: permission modes + Plan Mode ----------
//
// These assert the property that makes `JARVIS_PERMISSION_MODE` real: the mode
// reaches the approver and the tool filter. Before the engine was wired, every
// mode behaved like "ask" and Plan Mode was decorative.

/** Serve with a permission store whose persisted default mode is `mode`. */
async function servePermissions(
  turns: ScriptTurn[],
  mode: PermissionMode,
  tools: ToolRegistry,
): Promise<{ app: Awaited<ReturnType<typeof serve>>; client: WsHarness; store: MemoryPermissionStore }> {
  const store = new MemoryPermissionStore(mode);
  const app = await serve({ host: "127.0.0.1", port: 0 }, makeState(turns, { tools, permissionStore: store }));
  const { port } = app.server.address() as { port: number };
  const client = await openWs(port);
  return { app, client, store };
}

test("WS: announces the store's default mode on connect", async () => {
  const { app, client } = await servePermissions([{ content: "ok" }], "accept-edits", new ToolRegistry());
  try {
    const frame = await client.waitFor((f) => f.type === "permission_mode");
    assert.equal(frame.mode as string, "accept-edits");
  } finally {
    client.close();
    await app.close();
  }
});

test("WS: set_mode echoes permission_mode; an invalid mode errors", async () => {
  const { app, client } = await servePermissions([{ content: "ok" }], "ask", new ToolRegistry());
  try {
    await client.waitFor((f) => f.type === "permission_mode");

    client.send({ type: "set_mode", mode: "plan" });
    const echo = await client.waitFor((f) => f.type === "permission_mode" && f.mode === "plan");
    assert.equal(echo.via as string, "user");

    client.send({ type: "set_mode", mode: "turbo" });
    const err = await client.waitFor((f) => f.type === "error" && /valid mode/.test(f.message as string));
    assert.ok(err);
  } finally {
    client.close();
    await app.close();
  }
});

test("WS: auto mode resolves a gated tool without operator input, tagged mode_default", async () => {
  const tools = new ToolRegistry().register(dangerTool);
  const { app, client } = await servePermissions(
    [{ toolCalls: [{ id: "tc1", name: "danger.run", arguments: {} }] }, { content: "finished" }],
    "auto",
    tools,
  );
  try {
    client.send({ type: "user", content: "go" });
    // No `approve` frame is ever sent: reaching `done` at all is the proof the
    // mode resolved the gate. (Under "ask" this same script parks forever —
    // that's the pre-existing "approval flow" test above.)
    const done = await client.waitFor((f) => f.type === "done");
    assert.ok(done);

    const end = client.frames.find((f) => f.type === "tool_end");
    assert.equal(end?.content as string, "ran");

    // The request card is still emitted (auto-allowed calls stay visible in the
    // audit trail); what marks it auto is the provenance on the decision.
    const decision = client.frames.find((f) => f.type === "approval_decision");
    assert.equal((decision?.decision as { decision: string })?.decision, "approve");
    assert.deepEqual(decision?.source, { kind: "mode_default", mode: "auto" });
  } finally {
    client.close();
    await app.close();
  }
});

test("WS: a deny rule blocks the tool and names the rule as the source", async () => {
  const tools = new ToolRegistry().register(dangerTool);
  const { app, client, store } = await servePermissions(
    [{ toolCalls: [{ id: "tc1", name: "danger.run", arguments: {} }] }, { content: "after deny" }],
    "auto",
    tools,
  );
  await store.appendRule("user", "deny", { tool: "danger.run" });
  try {
    client.send({ type: "user", content: "go" });
    const end = await client.waitFor((f) => f.type === "tool_end");
    assert.match(end.content as string, /tool denied/);

    const decision = client.frames.find((f) => f.type === "approval_decision");
    assert.equal((decision?.source as { kind: string })?.kind, "rule");
    assert.equal((decision?.source as { scope: string })?.scope, "user");
  } finally {
    client.close();
    await app.close();
  }
});

test("WS: plan mode refuses a write tool the model names anyway", async () => {
  const tools = new ToolRegistry().register(dangerTool);
  const { app, client } = await servePermissions(
    [{ toolCalls: [{ id: "tc1", name: "danger.run", arguments: {} }] }, { content: "gave up" }],
    "plan",
    tools,
  );
  try {
    client.send({ type: "user", content: "go" });
    const end = await client.waitFor((f) => f.type === "tool_end");
    assert.match(end.content as string, /not available in the current mode/);
    // Never prompted — the filter short-circuits before the approval gate.
    assert.equal(client.frames.some((f) => f.type === "approval_request"), false);
  } finally {
    client.close();
    await app.close();
  }
});

test("WS: exit_plan ends the turn and surfaces plan_proposed; accept_plan switches mode and resumes", async () => {
  const tools = new ToolRegistry().register(exitPlanTool);
  const { app, client } = await servePermissions(
    [
      // One scripted turn for the plan; a second for the work after accept.
      { toolCalls: [{ id: "tc1", name: "exit_plan", arguments: { plan: "1. do the thing" } }] },
      { content: "carried it out" },
    ],
    "plan",
    tools,
  );
  try {
    client.send({ type: "user", content: "plan it" });
    const proposed = await client.waitFor((f) => f.type === "plan_proposed");
    assert.equal(proposed.plan as string, "1. do the thing");
    // Terminal tool ⇒ the turn stopped without another model round-trip.
    const done = await client.waitFor((f) => f.type === "done");
    assert.ok(done);

    client.send({ type: "accept_plan", post_mode: "accept-edits" });
    const switched = await client.waitFor((f) => f.type === "permission_mode" && f.mode === "accept-edits");
    assert.ok(switched);
    const finished = await client.waitFor((f) => f.type === "done" && f !== done);
    assert.ok(finished);
  } finally {
    client.close();
    await app.close();
  }
});

test("WS: the model calling enter_plan_mode switches the socket into plan mode", async () => {
  const tools = new ToolRegistry().register(armPlanTool).register(dangerTool);
  const { app, client } = await servePermissions(
    [{ toolCalls: [{ id: "tc1", name: "enter_plan_mode", arguments: {} }] }, { content: "now planning" }],
    "auto",
    tools,
  );
  try {
    client.send({ type: "user", content: "go" });
    const changed = await client.waitFor((f) => f.type === "permission_mode" && f.via === "tool");
    assert.equal(changed.mode as string, "plan");
    await client.waitFor((f) => f.type === "done");
  } finally {
    client.close();
    await app.close();
  }
});

test("WS: refine_plan requires non-empty feedback", async () => {
  const { app, client } = await servePermissions([{ content: "ok" }], "plan", new ToolRegistry());
  try {
    client.send({ type: "refine_plan", feedback: "   " });
    const err = await client.waitFor((f) => f.type === "error" && /feedback/.test(f.message as string));
    assert.ok(err);
  } finally {
    client.close();
    await app.close();
  }
});

test("WS: with no permission store the socket still reports a mode and prompts as before", async () => {
  const tools = new ToolRegistry().register(dangerTool);
  const app = await serve(
    { host: "127.0.0.1", port: 0 },
    makeState([{ toolCalls: [{ id: "tc1", name: "danger.run", arguments: {} }] }, { content: "done" }], { tools }),
  );
  const { port } = app.server.address() as { port: number };
  const client = await openWs(port);
  try {
    const frame = await client.waitFor((f) => f.type === "permission_mode");
    assert.equal(frame.mode as string, "ask");

    client.send({ type: "user", content: "go" });
    const req = await client.waitFor((f) => f.type === "approval_request");
    assert.equal(req.id as string, "tc1");

    // Answer it: a turn left parked keeps the WS request in flight, which
    // `app.close()` waits on.
    client.send({ type: "deny", tool_call_id: "tc1" });
    await client.waitFor((f) => f.type === "done");
  } finally {
    client.close();
    await app.close();
  }
});
