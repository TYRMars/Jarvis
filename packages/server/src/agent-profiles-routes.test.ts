import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import {
  Agent,
  assistantText,
  defaultAgentConfig,
  type ChatRequest,
  type ChatResponse,
  type LlmChunk,
  type LlmProvider,
} from "@jarvis/core";
import {
  MemoryAgentProfileStore,
  type AgentProfile,
  type AgentProfileStore,
} from "@jarvis/agent-profile";
import { registerAgentProfilesRoutes } from "./agent-profiles-routes.ts";
import type { AppState } from "./state.ts";

// ---------- test scaffolding ------------------------------------------------

/** Stub provider — the agent is never driven by these routes. */
class StubProvider implements LlmProvider {
  complete(_req: ChatRequest): Promise<ChatResponse> {
    return Promise.resolve({ message: assistantText("stub"), finish_reason: "stop" });
  }
  async *completeStream(_req: ChatRequest): AsyncGenerator<LlmChunk> {
    yield { type: "finish", message: assistantText("stub"), finish_reason: "stop" };
  }
}

function makeState(opts: { agentProfiles?: AgentProfileStore } = {}): AppState {
  return {
    createAgent: () => new Agent(new StubProvider(), defaultAgentConfig("stub-model")),
    agentProfiles: opts.agentProfiles,
  };
}

async function buildApp(state: AppState) {
  const app = Fastify();
  registerAgentProfilesRoutes(app, state);
  await app.ready();
  return app;
}

/** Create a profile and return its parsed JSON body. */
async function createProfile(
  app: Awaited<ReturnType<typeof buildApp>>,
  payload: Record<string, unknown>,
): Promise<AgentProfile> {
  const res = await app.inject({ method: "POST", url: "/v1/agent-profiles", payload });
  assert.equal(res.statusCode, 201);
  return res.json() as AgentProfile;
}

// ---------- 503 (store absent) ---------------------------------------------

test("agent-profile routes 503 when no store is configured", async () => {
  const app = await buildApp(makeState({ agentProfiles: undefined }));
  assert.equal((await app.inject({ method: "GET", url: "/v1/agent-profiles" })).statusCode, 503);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/agent-profiles",
        payload: { name: "a", provider: "openai", model: "gpt-4o" },
      })
    ).statusCode,
    503,
  );
  assert.equal((await app.inject({ method: "GET", url: "/v1/agent-profiles/x" })).statusCode, 503);
  assert.equal(
    (await app.inject({ method: "PATCH", url: "/v1/agent-profiles/x", payload: { name: "z" } })).statusCode,
    503,
  );
  assert.equal((await app.inject({ method: "DELETE", url: "/v1/agent-profiles/x" })).statusCode, 503);
  await app.close();
});

// ---------- create / list ---------------------------------------------------

test("POST creates a profile, lists it; optional fields absent when unset", async () => {
  const app = await buildApp(makeState({ agentProfiles: new MemoryAgentProfileStore() }));
  const p = await createProfile(app, { name: "Alice", provider: "openai", model: "gpt-4o-mini" });
  assert.equal(p.name, "Alice");
  assert.equal(p.provider, "openai");
  assert.equal(p.model, "gpt-4o-mini");
  assert.ok(p.id);
  assert.ok(p.created_at);
  assert.ok(p.updated_at);
  // skip_serializing_if parity: blank optionals are ABSENT, not null/"".
  assert.ok(!("avatar" in p), "avatar absent when unset");
  assert.ok(!("system_prompt" in p), "system_prompt absent when unset");
  assert.ok(!("default_workspace" in p), "default_workspace absent when unset");
  assert.deepEqual(p.allowed_tools, []);

  const list = await app.inject({ method: "GET", url: "/v1/agent-profiles" });
  assert.equal(list.statusCode, 200);
  const body = list.json() as { items: AgentProfile[] };
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0]!.id, p.id);
  await app.close();
});

test("POST trims name/provider/model and honours optional fields", async () => {
  const app = await buildApp(makeState({ agentProfiles: new MemoryAgentProfileStore() }));
  const p = await createProfile(app, {
    name: "  Bob  ",
    provider: "  anthropic ",
    model: " claude-3-5-sonnet-latest ",
    avatar: " 🦊 ",
    system_prompt: "  You are Bob.  ",
    default_workspace: " /tmp/ws ",
    allowed_tools: ["fs.read", "code.grep"],
  });
  assert.equal(p.name, "Bob");
  assert.equal(p.provider, "anthropic");
  assert.equal(p.model, "claude-3-5-sonnet-latest");
  assert.equal(p.avatar, "🦊");
  assert.equal(p.system_prompt, "You are Bob.");
  assert.equal(p.default_workspace, "/tmp/ws");
  assert.deepEqual(p.allowed_tools, ["fs.read", "code.grep"]);
  await app.close();
});

test("POST treats blank optional strings as absent", async () => {
  const app = await buildApp(makeState({ agentProfiles: new MemoryAgentProfileStore() }));
  const p = await createProfile(app, {
    name: "Cara",
    provider: "openai",
    model: "gpt-4o",
    avatar: "   ",
    system_prompt: "",
  });
  assert.ok(!("avatar" in p));
  assert.ok(!("system_prompt" in p));
  await app.close();
});

// ---------- create validation -----------------------------------------------

test("POST rejects blank name / provider / model → 400", async () => {
  const app = await buildApp(makeState({ agentProfiles: new MemoryAgentProfileStore() }));
  const blankName = await app.inject({
    method: "POST",
    url: "/v1/agent-profiles",
    payload: { name: "   ", provider: "openai", model: "gpt-4o" },
  });
  assert.equal(blankName.statusCode, 400);
  assert.match(blankName.json().error, /name/);

  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/agent-profiles",
        payload: { name: "x", provider: "  ", model: "gpt-4o" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/agent-profiles",
        payload: { name: "x", provider: "openai", model: "" },
      })
    ).statusCode,
    400,
  );
  await app.close();
});

// ---------- get one ---------------------------------------------------------

test("GET one returns the profile; 404 when absent", async () => {
  const app = await buildApp(makeState({ agentProfiles: new MemoryAgentProfileStore() }));
  const p = await createProfile(app, { name: "Alice", provider: "openai", model: "gpt-4o-mini" });

  const got = await app.inject({ method: "GET", url: `/v1/agent-profiles/${p.id}` });
  assert.equal(got.statusCode, 200);
  assert.equal((got.json() as AgentProfile).id, p.id);

  const miss = await app.inject({ method: "GET", url: "/v1/agent-profiles/nope" });
  assert.equal(miss.statusCode, 404);
  assert.match(miss.json().error, /not found/);
  await app.close();
});

// ---------- patch -----------------------------------------------------------

test("PATCH updates fields, bumps updated_at", async () => {
  const app = await buildApp(makeState({ agentProfiles: new MemoryAgentProfileStore() }));
  const p = await createProfile(app, { name: "Alice", provider: "openai", model: "gpt-4o-mini" });

  // Ensure the rfc3339 millisecond value can differ.
  await new Promise((r) => setTimeout(r, 5));

  const patched = await app.inject({
    method: "PATCH",
    url: `/v1/agent-profiles/${p.id}`,
    payload: { system_prompt: "You are Alice.", avatar: "🦊", allowed_tools: ["fs.read"] },
  });
  assert.equal(patched.statusCode, 200);
  const t = patched.json() as AgentProfile;
  assert.equal(t.system_prompt, "You are Alice.");
  assert.equal(t.avatar, "🦊");
  assert.deepEqual(t.allowed_tools, ["fs.read"]);
  assert.notEqual(t.updated_at, p.updated_at);
  await app.close();
});

test("PATCH clears an optional when given a blank string", async () => {
  const app = await buildApp(makeState({ agentProfiles: new MemoryAgentProfileStore() }));
  const p = await createProfile(app, {
    name: "Alice",
    provider: "openai",
    model: "gpt-4o-mini",
    avatar: "🦊",
    system_prompt: "hi",
  });
  assert.equal(p.avatar, "🦊");

  const patched = await app.inject({
    method: "PATCH",
    url: `/v1/agent-profiles/${p.id}`,
    payload: { avatar: "   ", system_prompt: "" },
  });
  assert.equal(patched.statusCode, 200);
  const t = patched.json() as AgentProfile;
  assert.ok(!("avatar" in t), "blank avatar clears the field");
  assert.ok(!("system_prompt" in t), "empty system_prompt clears the field");
  await app.close();
});

test("PATCH rejects blank required fields → 400", async () => {
  const app = await buildApp(makeState({ agentProfiles: new MemoryAgentProfileStore() }));
  const p = await createProfile(app, { name: "Alice", provider: "openai", model: "gpt-4o-mini" });

  assert.equal(
    (await app.inject({ method: "PATCH", url: `/v1/agent-profiles/${p.id}`, payload: { name: "  " } })).statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: "PATCH", url: `/v1/agent-profiles/${p.id}`, payload: { provider: "" } })).statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: "PATCH", url: `/v1/agent-profiles/${p.id}`, payload: { model: "   " } })).statusCode,
    400,
  );
  await app.close();
});

test("PATCH on a missing profile → 404", async () => {
  const app = await buildApp(makeState({ agentProfiles: new MemoryAgentProfileStore() }));
  const res = await app.inject({ method: "PATCH", url: "/v1/agent-profiles/nope", payload: { name: "x" } });
  assert.equal(res.statusCode, 404);
  await app.close();
});

// ---------- delete ----------------------------------------------------------

test("DELETE removes a profile → 200 {deleted:true}, then 404 {deleted:false}", async () => {
  const app = await buildApp(makeState({ agentProfiles: new MemoryAgentProfileStore() }));
  const p = await createProfile(app, { name: "Alice", provider: "openai", model: "gpt-4o-mini" });

  const del = await app.inject({ method: "DELETE", url: `/v1/agent-profiles/${p.id}` });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.json(), { deleted: true });

  const again = await app.inject({ method: "DELETE", url: `/v1/agent-profiles/${p.id}` });
  assert.equal(again.statusCode, 404);
  const body = again.json() as { deleted: boolean; error: string };
  assert.equal(body.deleted, false);
  assert.match(body.error, /not found/);
  await app.close();
});
