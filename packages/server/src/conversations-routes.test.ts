import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  MemoryConversationStore,
  MemoryProjectStore,
  MemoryRequirementStore,
  MemoryRequirementRunStore,
  MemoryActivityStore,
  MemoryWorkspaceStore,
  ConversationStoreBase,
  type ConversationMetadata,
  type ConversationRecord,
} from "@jarvis/store";
import { newProject, newRequirement } from "@jarvis/project";
import { userMessage, type Conversation } from "@jarvis/core";
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

// ---------- enrichment (GET /v1/conversations) ----------------------------

type EnrichedRow = {
  id: string;
  title: string | null;
  source: string | null;
  requirement_id: string | null;
  requirement_title: string | null;
  requirement_status: string | null;
  workspace_path: string | null;
  lifecycle: string;
};

test("list derives a title from the first user message (capped, seed-prompt skipped)", async () => {
  const store = new MemoryConversationStore();
  const app = await buildApp({ createAgent: agentUnused, store });
  await store.saveEnvelope("c-plain", { messages: [userMessage("Hello world\nsecond line")] }, { lifecycle: "active" });
  // Auto-mode seed prompt → title comes from the NEXT line.
  await store.saveEnvelope(
    "c-seed",
    { messages: [userMessage("Please complete this requirement and reply with a one-line summary of what you did.\n\nFix the login bug")] },
    { lifecycle: "active" },
  );
  await store.saveEnvelope("c-long", { messages: [userMessage("x".repeat(80))] }, { lifecycle: "active" });

  const rows = (await app.inject({ method: "GET", url: "/v1/conversations" })).json() as EnrichedRow[];
  const byId = (id: string) => rows.find((r) => r.id === id)!;
  assert.equal(byId("c-plain").title, "Hello world");
  assert.equal(byId("c-seed").title, "Fix the login bug");
  assert.equal(Array.from(byId("c-long").title!).length, 61); // 60 chars + ellipsis
  assert.ok(byId("c-long").title!.endsWith("…"));
  assert.equal(byId("c-plain").source, "chat");
  await app.close();
});

test("list joins the bound requirement (source + requirement_*)", async () => {
  const store = new MemoryConversationStore();
  const projects = new MemoryProjectStore();
  const requirements = new MemoryRequirementStore();
  const workspaces = new MemoryWorkspaceStore();
  const proj = newProject("Proj", "");
  await projects.save(proj);
  await store.saveEnvelope("c-req", { messages: [userMessage("do the thing")] }, { lifecycle: "active", project_id: proj.id });
  const req = newRequirement(proj.id, "Build the widget");
  req.conversation_ids.push("c-req");
  await requirements.upsert(req);
  await workspaces.bind("c-req", "/tmp/ws-c-req");

  const app = await buildApp({ createAgent: agentUnused, store, projects, requirements, workspaces });
  const rows = (await app.inject({ method: "GET", url: "/v1/conversations" })).json() as EnrichedRow[];
  const row = rows.find((r) => r.id === "c-req")!;
  assert.equal(row.source, "requirement");
  assert.equal(row.requirement_id, req.id);
  assert.equal(row.requirement_title, "Build the widget");
  assert.equal(row.requirement_status, "backlog");
  assert.equal(row.workspace_path, "/tmp/ws-c-req");
  await app.close();
});

test("list lifecycle filter: valid filters, unknown → 400", async () => {
  const store = new MemoryConversationStore();
  const app = await buildApp({ createAgent: agentUnused, store });
  await store.saveEnvelope("a", { messages: [] }, { lifecycle: "active" });
  await store.saveEnvelope("b", { messages: [] }, { lifecycle: "archived" });

  const archived = (await app.inject({ method: "GET", url: "/v1/conversations?lifecycle=archived" })).json() as EnrichedRow[];
  assert.deepEqual(archived.map((r) => r.id), ["b"]);
  assert.equal(
    (await app.inject({ method: "GET", url: "/v1/conversations?lifecycle=bogus" })).statusCode,
    400,
  );
  await app.close();
});

// ---------- #470: filter-before-slice (over-fetch) ------------------------

// A ConversationStore with a deterministic, strictly-increasing clock so a
// test can control newest-first ordering exactly (the Memory/JSON stores stamp
// `Date.now()`, which ties within a test's sub-millisecond save loop).
class ClockedStore extends ConversationStoreBase {
  #rows = new Map<string, { created_at: string; updated_at: string; conv: Conversation; meta: ConversationMetadata }>();
  #seq = 0;
  saveEnvelope(id: string, conversation: Conversation, metadata: ConversationMetadata): Promise<void> {
    const ts = new Date((this.#seq += 1) * 1000).toISOString();
    const created = this.#rows.get(id)?.created_at ?? ts;
    this.#rows.set(id, {
      created_at: created,
      updated_at: ts,
      conv: { messages: [...conversation.messages] },
      meta: { project_id: metadata.project_id ?? null, lifecycle: metadata.lifecycle },
    });
    return Promise.resolve();
  }
  loadEnvelope(id: string): Promise<[Conversation, ConversationMetadata] | undefined> {
    const r = this.#rows.get(id);
    return Promise.resolve(r ? [{ messages: [...r.conv.messages] }, { ...r.meta }] : undefined);
  }
  list(limit: number): Promise<ConversationRecord[]> {
    const recs: ConversationRecord[] = [...this.#rows].map(([id, r]) => ({
      id,
      created_at: r.created_at,
      updated_at: r.updated_at,
      message_count: r.conv.messages.length,
      project_id: r.meta.project_id ?? null,
      lifecycle: r.meta.lifecycle,
    }));
    recs.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
    return Promise.resolve(recs.slice(0, limit));
  }
  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.#rows.delete(id));
  }
}

test("list: unbounded newer internal `__memory__` rows don't crowd real conversations out of the window (#470)", async () => {
  const store = new ClockedStore();
  const app = await buildApp({ createAgent: agentUnused, store });
  // One real conversation, then many *newer* internal summary rows — more than
  // the default limit, so a filter-after-slice window would be all-internal.
  await store.save("real-conv", { messages: [userMessage("keep me")] });
  for (let i = 0; i < 60; i++) {
    await store.save(`__memory__.summary:${i}`, { messages: [userMessage("synthetic")] });
  }

  const rows = (await app.inject({ method: "GET", url: "/v1/conversations" })).json() as EnrichedRow[];
  // Pre-fix: [] (the newest 50 were all internal, filtered away). Post-fix: the
  // real row surfaces via over-fetch.
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, "real-conv");
  await app.close();
});

test("list ?lifecycle=archived: an archived row crowded out of the newest-N window still surfaces (#470)", async () => {
  const store = new ClockedStore();
  const app = await buildApp({ createAgent: agentUnused, store });
  await store.saveEnvelope("old-archived", { messages: [userMessage("archived one")] }, { lifecycle: "archived" });
  for (let i = 0; i < 60; i++) {
    await store.saveEnvelope(`active-${i}`, { messages: [userMessage("active")] }, { lifecycle: "active" });
  }

  const rows = (await app.inject({ method: "GET", url: "/v1/conversations?lifecycle=archived" })).json() as EnrichedRow[];
  assert.deepEqual(rows.map((r) => r.id), ["old-archived"]);
  await app.close();
});

// ---------- POST /v1/conversations/:id/lifecycle --------------------------

test("set lifecycle returns previous + new, validates, 404s missing", async () => {
  const store = new MemoryConversationStore();
  const app = await buildApp({ createAgent: agentUnused, store });
  const { id } = (await app.inject({ method: "POST", url: "/v1/conversations", payload: {} })).json() as { id: string };

  const res = await app.inject({ method: "POST", url: `/v1/conversations/${id}/lifecycle`, payload: { lifecycle: "archived" } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { id, lifecycle: "archived", previous_lifecycle: "active" });
  // Persisted: it now shows under the archived filter.
  const archived = (await app.inject({ method: "GET", url: "/v1/conversations?lifecycle=archived" })).json() as EnrichedRow[];
  assert.ok(archived.some((r) => r.id === id));

  assert.equal(
    (await app.inject({ method: "POST", url: `/v1/conversations/${id}/lifecycle`, payload: { lifecycle: "nope" } })).statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/conversations/missing/lifecycle", payload: { lifecycle: "active" } })).statusCode,
    404,
  );
  await app.close();
});

// ---------- GET /v1/conversations/:id/work-context ------------------------

test("work-context returns the bound requirement + latest run, null when unbound", async () => {
  const store = new MemoryConversationStore();
  const projects = new MemoryProjectStore();
  const requirements = new MemoryRequirementStore();
  const requirementRuns = new MemoryRequirementRunStore();
  const activities = new MemoryActivityStore();
  const proj = newProject("Proj", "");
  await projects.save(proj);
  await store.saveEnvelope("c-wc", { messages: [userMessage("hi")] }, { lifecycle: "active", project_id: proj.id });
  const req = newRequirement(proj.id, "Ship it");
  req.conversation_ids.push("c-wc");
  await requirements.upsert(req);

  const app = await buildApp({ createAgent: agentUnused, store, projects, requirements, requirementRuns, activities });
  const wc = (await app.inject({ method: "GET", url: "/v1/conversations/c-wc/work-context" })).json() as {
    conversation_id: string;
    requirement: { id: string; title: string } | null;
    recent_activities: unknown[];
  };
  assert.equal(wc.conversation_id, "c-wc");
  assert.equal(wc.requirement?.id, req.id);
  assert.ok(Array.isArray(wc.recent_activities));

  // Unbound conversation → null requirement.
  await store.saveEnvelope("c-free", { messages: [] }, { lifecycle: "active" });
  const free = (await app.inject({ method: "GET", url: "/v1/conversations/c-free/work-context" })).json() as {
    requirement: unknown;
  };
  assert.equal(free.requirement, null);
  await app.close();
});
