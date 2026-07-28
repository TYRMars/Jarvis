import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";

import {
  Agent,
  ToolRegistry,
  defaultAgentConfig,
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
import { ChatRunRegistry } from "./chat-runs.ts";
import { MemoryPermissionStore, type PermissionMode, type PermissionStore } from "./permissions-routes.ts";
import { buildServer, serve } from "./server.ts";
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

function makeState(
  turns: ScriptTurn[],
  opts: {
    store?: MemoryConversationStore;
    tools?: ToolRegistry;
    chatRuns?: ChatRunRegistry;
    /** Captures the model each createAgent call resolved (configure tests). */
    modelSpy?: string[];
    /** Captures whether each turn got a Plan-Mode tool filter. */
    filterSpy?: boolean[];
    defaultPermissionMode?: PermissionMode;
    permissionStore?: PermissionStore;
  } = {},
): AppState {
  const provider = new ScriptedProvider(turns);
  const tools = opts.tools ?? new ToolRegistry();
  return {
    store: opts.store,
    chatRuns: opts.chatRuns,
    providerCatalog: { default: "scripted", providers: [] },
    defaultPermissionMode: opts.defaultPermissionMode,
    permissionStore: opts.permissionStore,
    createAgent: (approver, human, agentOpts) => {
      const model = agentOpts?.model ?? "test-model";
      opts.modelSpy?.push(model);
      opts.filterSpy?.push(agentOpts?.toolFilter !== undefined);
      const config = { ...defaultAgentConfig(model), tools, maxIterations: 5, approver, human };
      if (agentOpts?.toolFilter) config.toolFilter = agentOpts.toolFilter;
      return new Agent(provider, config);
    },
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
  await once(ws, "open");
  const frames: Frame[] = [];
  const waiters: { pred: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
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

// ---------- WS session protocol (start_turn / seq replay / interrupt / configure) ----------

test("WS: start_turn new — started, seq-stamped events, persisted conversation", async () => {
  const store = new MemoryConversationStore();
  const chatRuns = new ChatRunRegistry();
  const app = await serve({ host: "127.0.0.1", port: 0 }, makeState([{ content: "hello there" }], { store, chatRuns }));
  const { port } = app.server.address() as { port: number };
  const client = await openWs(port);
  try {
    client.send({ type: "start_turn", mode: "new", id: "conv-st", content: "hi" });
    const started = await client.waitFor((f) => f.type === "started");
    assert.equal(started.id as string, "conv-st");

    const done = await client.waitFor((f) => f.type === "done");
    // Tracked events carry the registry's monotonic seq stamp.
    assert.equal(typeof done.seq, "number");
    const deltas = client.frames.filter((f) => f.type === "delta");
    assert.ok(deltas.length > 0 && deltas.every((f) => typeof f.seq === "number"));

    const savedConv = await store.load("conv-st");
    assert.equal(savedConv?.messages.length, 2); // user + assistant
  } finally {
    client.close();
    await app.close();
  }
});

test("WS: resume with after_seq replays the tail between reconnects", async () => {
  const store = new MemoryConversationStore();
  const chatRuns = new ChatRunRegistry();
  const app = await serve({ host: "127.0.0.1", port: 0 }, makeState([{ content: "first answer" }], { store, chatRuns }));
  const { port } = app.server.address() as { port: number };
  const a = await openWs(port);
  let b: WsHarness | undefined;
  try {
    a.send({ type: "start_turn", mode: "new", id: "conv-replay", content: "hi" });
    const done = await a.waitFor((f) => f.type === "done");
    const lastSeq = done.seq as number;

    // A second socket resumes from seq 0 → full tail replay of the turn.
    b = await openWs(port);
    b.send({ type: "resume", id: "conv-replay", after_seq: 0 });
    const resumed = await b.waitFor((f) => f.type === "resumed");
    assert.equal(resumed.live, false);
    assert.equal(resumed.message_count, 2);
    const start = await b.waitFor((f) => f.type === "tail_replay_start");
    assert.equal(start.first_seq, 1);
    await b.waitFor((f) => f.type === "tail_replay_done");
    const replayedDone = b.frames.find((f) => f.type === "done");
    assert.equal(replayedDone?.seq, lastSeq);
  } finally {
    a.close();
    b?.close();
    await app.close();
  }
});

test("WS: mid-run reconnect adopts the pending approval and finishes on the new socket", async () => {
  const store = new MemoryConversationStore();
  const chatRuns = new ChatRunRegistry();
  const tools = new ToolRegistry().register(dangerTool);
  const app = await serve(
    { host: "127.0.0.1", port: 0 },
    makeState([{ toolCalls: [{ id: "tc9", name: "danger.run", arguments: {} }] }, { content: "finished" }], {
      store,
      chatRuns,
      tools,
    }),
  );
  const { port } = app.server.address() as { port: number };
  const a = await openWs(port);
  let b: WsHarness | undefined;
  try {
    a.send({ type: "start_turn", mode: "new", id: "conv-adopt", content: "go" });
    const req = await a.waitFor((f) => f.type === "approval_request");
    const cursor = req.seq as number;
    a.close(); // phone lost the network mid-approval

    b = await openWs(port);
    b.send({ type: "resume", id: "conv-adopt", after_seq: cursor });
    const resumed = await b.waitFor((f) => f.type === "resumed");
    assert.equal(resumed.live, true);
    // The blocking approval is re-prompted on the new socket…
    const pending = await b.waitFor((f) => f.type === "approval_pending");
    assert.equal(pending.id as string, "tc9");
    // …and answerable from it; the turn then completes on this socket.
    b.send({ type: "approve", tool_call_id: "tc9" });
    const toolEnd = await b.waitFor((f) => f.type === "tool_end");
    assert.equal(toolEnd.content as string, "ran");
    await b.waitFor((f) => f.type === "done");
  } finally {
    a.close();
    b?.close();
    await app.close();
  }
});

test("WS: mid-run reconnect re-prompts a pending hitl_request, answerable from the new socket", async () => {
  const store = new MemoryConversationStore();
  const chatRuns = new ChatRunRegistry();
  const tools = new ToolRegistry().register(askTool);
  const app = await serve(
    { host: "127.0.0.1", port: 0 },
    makeState([{ toolCalls: [{ id: "tc-ask", name: "ask.text", arguments: {} }] }, { content: "thanks" }], {
      store,
      chatRuns,
      tools,
    }),
  );
  const { port } = app.server.address() as { port: number };
  const a = await openWs(port);
  let b: WsHarness | undefined;
  try {
    a.send({ type: "start_turn", mode: "new", id: "conv-hitl", content: "go" });
    const req = await a.waitFor((f) => f.type === "hitl_request");
    const cursor = req.seq as number;
    a.close();

    b = await openWs(port);
    b.send({ type: "resume", id: "conv-hitl", after_seq: cursor });
    const reprompt = await b.waitFor((f) => f.type === "hitl_request");
    assert.equal((reprompt.request as { id: string }).id, "q1");
    b.send({ type: "hitl_response", request_id: "q1", status: "submitted", payload: "ada" });
    const toolEnd = await b.waitFor((f) => f.type === "tool_end");
    assert.equal(toolEnd.content as string, "hi ada [submitted]");
    await b.waitFor((f) => f.type === "done");
  } finally {
    a.close();
    b?.close();
    await app.close();
  }
});

test("WS: interrupt cancels the parked turn and emits interrupted", async () => {
  const store = new MemoryConversationStore();
  const chatRuns = new ChatRunRegistry();
  const tools = new ToolRegistry().register(dangerTool);
  const app = await serve(
    { host: "127.0.0.1", port: 0 },
    makeState([{ toolCalls: [{ id: "tc-int", name: "danger.run", arguments: {} }] }, { content: "never" }], {
      store,
      chatRuns,
      tools,
    }),
  );
  const { port } = app.server.address() as { port: number };
  const client = await openWs(port);
  try {
    client.send({ type: "start_turn", mode: "new", id: "conv-int", content: "go" });
    await client.waitFor((f) => f.type === "approval_request");
    client.send({ type: "interrupt" });
    await client.waitFor((f) => f.type === "interrupted");
    await client.waitFor((f) => f.type === "cancelled");
    const rec = chatRuns.list(false).find((r) => r.conversation_id === "conv-int");
    assert.equal(rec?.status, "cancelled");
  } finally {
    client.close();
    await app.close();
  }
});

test("WS: configure sets a sticky per-socket model; provider switching is rejected", async () => {
  const store = new MemoryConversationStore();
  const chatRuns = new ChatRunRegistry();
  const modelSpy: string[] = [];
  const app = await serve(
    { host: "127.0.0.1", port: 0 },
    makeState([{ content: "one" }, { content: "two" }], { store, chatRuns, modelSpy }),
  );
  const { port } = app.server.address() as { port: number };
  const client = await openWs(port);
  try {
    client.send({ type: "configure", model: "fancy-model" });
    const configured = await client.waitFor((f) => f.type === "configured");
    assert.equal(configured.model, "fancy-model");
    assert.equal(configured.provider, "scripted");

    client.send({ type: "start_turn", mode: "new", id: "conv-cfg", content: "hi" });
    await client.waitFor((f) => f.type === "done");
    assert.deepEqual(modelSpy, ["fancy-model"]);

    client.send({ type: "configure", provider: "other-provider" });
    const err = await client.waitFor((f) => f.type === "error" && /provider switching/.test(f.message as string));
    assert.ok(err);
  } finally {
    client.close();
    await app.close();
  }
});

// ---------- WS Plan Mode (set_mode / plan_proposed / accept_plan / refine_plan) ----------

/** Stands in for @jarvis/tools' ExitPlanTool (server must not depend on it). */
const exitPlanTool: Tool = {
  name: "exit_plan",
  description: "submit a plan",
  parameters: { type: "object" },
  category: "read",
  isTerminal: true,
  invoke: (args) =>
    Promise.resolve(
      typeof (args as { plan?: unknown })?.plan === "string" ? ((args as { plan: string }).plan) : "",
    ),
};

test("WS: announces the permission mode on connect and honours set_mode", async () => {
  const app = await serve(
    { host: "127.0.0.1", port: 0 },
    makeState([{ content: "ok" }], { defaultPermissionMode: "accept-edits" }),
  );
  const { port } = app.server.address() as { port: number };
  const client = await openWs(port);
  try {
    const hello = await client.waitFor((f) => f.type === "permission_mode");
    assert.equal(hello.mode, "accept-edits");
    // The starting state is announced WITHOUT `via` — it is not a change, and
    // a `via` would make the clients surface a "mode switched" notice.
    assert.equal(hello.via, undefined);

    client.send({ type: "set_mode", mode: "plan" });
    const changed = await client.waitFor((f) => f.type === "permission_mode" && f.via === "user");
    assert.equal(changed.mode, "plan");

    client.send({ type: "set_mode", mode: "nonsense" });
    const err = await client.waitFor((f) => f.type === "error" && /mode must be one of/.test(f.message as string));
    assert.ok(err);
  } finally {
    client.close();
    await app.close();
  }
});

test("WS: plan mode filters the tool catalogue and exit_plan proposes a plan", async () => {
  const filterSpy: boolean[] = [];
  const tools = new ToolRegistry().register(exitPlanTool).register(dangerTool);
  const app = await serve(
    { host: "127.0.0.1", port: 0 },
    makeState([{ toolCalls: [{ id: "p1", name: "exit_plan", arguments: { plan: "1. look\n2. leap" } }] }], {
      tools,
      filterSpy,
      defaultPermissionMode: "plan",
    }),
  );
  const { port } = app.server.address() as { port: number };
  const client = await openWs(port);
  try {
    client.send({ type: "user", content: "how would you do it?" });
    const proposed = await client.waitFor((f) => f.type === "plan_proposed");
    assert.equal(proposed.plan, "1. look\n2. leap");
    await client.waitFor((f) => f.type === "done");
    assert.deepEqual(filterSpy, [true], "the plan-mode turn got a tool filter");
  } finally {
    client.close();
    await app.close();
  }
});

test("WS: accept_plan leaves plan mode, briefs the model with the plan, and runs", async () => {
  const filterSpy: boolean[] = [];
  const tools = new ToolRegistry().register(exitPlanTool);
  const store = new MemoryConversationStore();
  const app = await serve(
    { host: "127.0.0.1", port: 0 },
    makeState(
      [
        { toolCalls: [{ id: "p1", name: "exit_plan", arguments: { plan: "delete nothing" } }] },
        { content: "executed" },
      ],
      { tools, filterSpy, store, defaultPermissionMode: "plan" },
    ),
  );
  const { port } = app.server.address() as { port: number };
  const client = await openWs(port);
  try {
    client.send({ type: "start_turn", mode: "new", id: "conv-plan", content: "how?" });
    await client.waitFor((f) => f.type === "plan_proposed");
    await client.waitFor((f) => f.type === "done");

    client.send({ type: "accept_plan", post_mode: "accept-edits" });
    const modeFrame = await client.waitFor((f) => f.type === "permission_mode" && f.via === "user");
    assert.equal(modeFrame.mode, "accept-edits");
    await client.waitFor((f) => f.type === "done" && (f.outcome as { kind: string }).kind === "stopped");

    // Execution turn ran WITHOUT the plan filter, and the accepted plan was
    // handed to the model as a synthetic user turn.
    assert.deepEqual(filterSpy, [true, false]);
    const saved = await store.load("conv-plan");
    const briefs = (saved?.messages ?? []).filter(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.includes("delete nothing"),
    );
    assert.equal(briefs.length, 1, "the accepted plan is quoted back to the model");
  } finally {
    client.close();
    await app.close();
  }
});

test("WS: refine_plan stays in plan mode and re-runs with the feedback", async () => {
  const filterSpy: boolean[] = [];
  const tools = new ToolRegistry().register(exitPlanTool);
  const app = await serve(
    { host: "127.0.0.1", port: 0 },
    makeState(
      [
        { toolCalls: [{ id: "p1", name: "exit_plan", arguments: { plan: "v1" } }] },
        { toolCalls: [{ id: "p2", name: "exit_plan", arguments: { plan: "v2 (shorter)" } }] },
      ],
      { tools, filterSpy, defaultPermissionMode: "plan" },
    ),
  );
  const { port } = app.server.address() as { port: number };
  const client = await openWs(port);
  try {
    client.send({ type: "user", content: "how?" });
    const first = await client.waitFor((f) => f.type === "plan_proposed");
    assert.equal(first.plan, "v1");
    await client.waitFor((f) => f.type === "done");

    client.send({ type: "refine_plan", feedback: "make it shorter" });
    const second = await client.waitFor((f) => f.type === "plan_proposed" && f.plan === "v2 (shorter)");
    assert.ok(second);
    assert.deepEqual(filterSpy, [true, true], "refinement stays filtered");

    client.send({ type: "refine_plan", feedback: "   " });
    const err = await client.waitFor((f) => f.type === "error" && /requires feedback/.test(f.message as string));
    assert.ok(err);
  } finally {
    client.close();
    await app.close();
  }
});

test("WS: auto mode approves gated tools without prompting; a deny rule blocks them", async () => {
  const tools = new ToolRegistry().register(dangerTool);
  const app = await serve(
    { host: "127.0.0.1", port: 0 },
    makeState([{ toolCalls: [{ id: "t1", name: "danger.run", arguments: {} }] }, { content: "done" }], {
      tools,
      defaultPermissionMode: "auto",
    }),
  );
  const { port } = app.server.address() as { port: number };
  const client = await openWs(port);
  try {
    client.send({ type: "user", content: "go" });
    const end = await client.waitFor((f) => f.type === "tool_end");
    assert.equal(end.content, "ran");
    assert.equal(
      client.frames.some((f) => f.type === "approval_request"),
      false,
      "auto mode must not prompt",
    );
  } finally {
    client.close();
    await app.close();
  }

  // Same setup, but a deny rule in the store overrides the permissive mode.
  const permissionStore: PermissionStore = new MemoryPermissionStore();
  await permissionStore.appendRule("session", "deny", { tool: "danger.run" });
  const app2 = await serve(
    { host: "127.0.0.1", port: 0 },
    makeState([{ toolCalls: [{ id: "t2", name: "danger.run", arguments: {} }] }, { content: "done" }], {
      tools: new ToolRegistry().register(dangerTool),
      defaultPermissionMode: "auto",
      permissionStore,
    }),
  );
  const { port: port2 } = app2.server.address() as { port: number };
  const client2 = await openWs(port2);
  try {
    client2.send({ type: "user", content: "go" });
    const end = await client2.waitFor((f) => f.type === "tool_end");
    assert.match(end.content as string, /tool denied/);
  } finally {
    client2.close();
    await app2.close();
  }
});

test("WS: a default_mode persisted in the store wins over the env seed", async () => {
  const permissionStore = new MemoryPermissionStore();
  await permissionStore.setDefaultMode("user", "auto");
  const app = await serve(
    { host: "127.0.0.1", port: 0 },
    // env said "ask"; the persisted table says "auto" — the store is
    // authoritative, otherwise persisting a mode would change nothing.
    makeState([{ content: "ok" }], { defaultPermissionMode: "ask", permissionStore }),
  );
  const { port } = app.server.address() as { port: number };
  const client = await openWs(port);
  try {
    const hello = await client.waitFor((f) => f.type === "permission_mode");
    assert.equal(hello.mode, "auto");
  } finally {
    client.close();
    await app.close();
  }
});
