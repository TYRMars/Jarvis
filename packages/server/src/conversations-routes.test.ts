import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { MemoryConversationStore } from "@jarvis/store";
import { registerConversationsRoutes } from "./conversations-routes.ts";
import type { AppState } from "./state.ts";

function agentUnused(): never {
  throw new Error("agent not used in these route tests");
}

function makeState(opts: { store?: boolean } = {}): AppState {
  return {
    createAgent: agentUnused,
    store: opts.store === false ? undefined : new MemoryConversationStore(),
  };
}

async function buildApp(state: AppState) {
  const app = Fastify();
  registerConversationsRoutes(app, state);
  await app.ready();
  return app;
}

test("503 when no ConversationStore is configured", async () => {
  const app = await buildApp(makeState({ store: false }));
  assert.equal((await app.inject({ method: "GET", url: "/v1/conversations" })).statusCode, 503);
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/conversations", payload: {} })).statusCode,
    503,
  );
  assert.equal((await app.inject({ method: "GET", url: "/v1/conversations/x" })).statusCode, 503);
  await app.close();
});

test("create → 201 {id}, then it appears in the list", async () => {
  const app = await buildApp(makeState());
  const created = await app.inject({ method: "POST", url: "/v1/conversations", payload: { system: "be helpful" } });
  assert.equal(created.statusCode, 201);
  const { id } = created.json() as { id: string };
  assert.ok(id && typeof id === "string");

  const detail = (await app.inject({ method: "GET", url: `/v1/conversations/${id}` })).json() as {
    id: string;
    messages: unknown[];
    project_id: string | null;
  };
  assert.equal(detail.id, id);
  assert.ok(Array.isArray(detail.messages) && detail.messages.length === 1, "system message persisted");
  assert.equal(detail.project_id, null);
  await app.close();
});

test("GET /v1/conversations is a BARE ARRAY, not an { conversations } envelope", async () => {
  const app = await buildApp(makeState());
  await app.inject({ method: "POST", url: "/v1/conversations", payload: {} });
  await app.inject({ method: "POST", url: "/v1/conversations", payload: {} });

  const res = await app.inject({ method: "GET", url: "/v1/conversations" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  // The load-bearing contract assertion: a top-level array (parity with the Rust
  // server + what the web/iOS clients decode). A regression to { conversations }
  // would make `Array.isArray` false and break both clients.
  assert.ok(Array.isArray(body), `expected a bare array, got ${typeof body}: ${JSON.stringify(body).slice(0, 80)}`);
  assert.equal((body as unknown[]).length, 2);
  for (const row of body as Array<Record<string, unknown>>) {
    assert.ok(typeof row.id === "string");
    assert.ok("created_at" in row && "updated_at" in row && "message_count" in row);
  }
  await app.close();
});

test("limit query is honoured", async () => {
  const app = await buildApp(makeState());
  for (let i = 0; i < 3; i++) await app.inject({ method: "POST", url: "/v1/conversations", payload: {} });
  const body = (await app.inject({ method: "GET", url: "/v1/conversations?limit=2" })).json() as unknown[];
  assert.equal(body.length, 2);
  await app.close();
});

test("internal `__`-prefixed ids are rejected on create and hidden from the list", async () => {
  const app = await buildApp(makeState());
  // create rejects an internal id
  const bad = await app.inject({
    method: "POST",
    url: "/v1/conversations",
    payload: { id: "__memory__.summary:abc" },
  });
  assert.equal(bad.statusCode, 400);

  // a row written directly under an internal id is filtered from the list + 404 on get
  const state = makeState();
  const app2 = await buildApp(state);
  await state.store!.save("__memory__.summary:xyz", { messages: [] });
  await app2.inject({ method: "POST", url: "/v1/conversations", payload: {} });
  const body = (await app2.inject({ method: "GET", url: "/v1/conversations" })).json() as Array<{ id: string }>;
  assert.ok(!body.some((r) => r.id.startsWith("__")), "internal ids filtered from list");
  assert.equal(body.length, 1);
  assert.equal(
    (await app2.inject({ method: "GET", url: "/v1/conversations/__memory__.summary:xyz" })).statusCode,
    404,
  );
  await app.close();
  await app2.close();
});

test("delete removes the conversation", async () => {
  const app = await buildApp(makeState());
  const { id } = (await app.inject({ method: "POST", url: "/v1/conversations", payload: {} })).json() as {
    id: string;
  };
  assert.equal((await app.inject({ method: "DELETE", url: `/v1/conversations/${id}` })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/v1/conversations/${id}` })).statusCode, 404);
  await app.close();
});
