import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";

import {
  Agent,
  ToolRegistry,
  defaultAgentConfig,
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

function makeState(turns: ScriptTurn[], opts: { store?: MemoryConversationStore; tools?: ToolRegistry } = {}): AppState {
  const provider = new ScriptedProvider(turns);
  const tools = opts.tools ?? new ToolRegistry();
  return {
    store: opts.store,
    createAgent: (approver) =>
      new Agent(provider, { ...defaultAgentConfig("test-model"), tools, maxIterations: 5, approver }),
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

// Contract test for the DEFAULT persisted-chat path (issue #397): the web
// Composer sends a single `start_turn` frame, not `new` + `user`. Exercise the
// real Node handler — not a mocked Rust error string — end to end.
test("WS: start_turn mode=new acknowledges `started`, runs the turn, persists", async () => {
  const store = new MemoryConversationStore();
  const app = await serve({ host: "127.0.0.1", port: 0 }, makeState([{ content: "hi there" }], { store }));
  const { port } = app.server.address() as { port: number };
  const client = await openWs(port);
  try {
    client.send({
      type: "start_turn",
      mode: "new",
      id: "conv-new",
      content: "hello",
      active_skills: [],
    });
    // The client waits on `started` before it will render the turn.
    const started = await client.waitFor((f) => f.type === "started");
    assert.equal(started.id as string, "conv-new");
    // The turn actually runs and completes.
    const done = await client.waitFor((f) => f.type === "done");
    assert.ok(done);
    // Persisted: the user message + assistant reply are saved under the id.
    const saved = await store.load("conv-new");
    assert.ok(saved);
    assert.equal(saved!.messages[0]!.role, "user");
    assert.equal(saved!.messages.at(-1)!.role, "assistant");
  } finally {
    client.close();
    await app.close();
  }
});

test("WS: start_turn mode=resume acknowledges `resumed`; unknown id → not-found", async () => {
  const store = new MemoryConversationStore();
  await store.save("conv-r", { messages: [{ role: "user", content: "earlier" }] });
  const app = await serve({ host: "127.0.0.1", port: 0 }, makeState([{ content: "ok" }], { store }));
  const { port } = app.server.address() as { port: number };
  const client = await openWs(port);
  try {
    client.send({ type: "start_turn", mode: "resume", id: "conv-r", content: "again" });
    const resumed = await client.waitFor((f) => f.type === "resumed");
    assert.equal(resumed.id as string, "conv-r");
    await client.waitFor((f) => f.type === "done");
    client.close();

    // A fresh socket resuming an unknown id: the not-found message matches the
    // client's `conversation `<id>` not found` regex so the stale sidebar row
    // is cleaned up rather than left hammering a ghost id.
    const client2 = await openWs(port);
    try {
      client2.send({ type: "start_turn", mode: "resume", id: "ghost", content: "x" });
      const err = await client2.waitFor((f) => f.type === "error");
      assert.match(err.message as string, /^conversation `ghost` not found$/);
    } finally {
      client2.close();
    }
  } finally {
    await app.close();
  }
});
