import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { ToolRegistry, type LlmProvider, type ChatRequest } from "@jarvis/core";
import { registerMetaRoutes } from "./meta-routes.ts";
import type { AppState, ServerInfo } from "./state.ts";

function agentUnused(): never {
  throw new Error("agent not used in these route tests");
}

/** Fake provider: complete() resolves, or rejects with `failWith` if set. */
function fakeProvider(failWith?: string): LlmProvider {
  let calls = 0;
  return {
    async complete(_req: ChatRequest) {
      calls++;
      if (failWith) throw new Error(failWith);
      return { message: { role: "assistant", content: "" }, finish_reason: "stop", usage: undefined } as never;
    },
    async *completeStream() {
      void calls;
      throw new Error("not used");
    },
  } as unknown as LlmProvider;
}

const SERVER_INFO: ServerInfo = {
  version: "0.2.0",
  listen_addr: "127.0.0.1:7001",
  persistence: "json",
  approval_mode: "ask",
  coding_mode: true,
  max_iterations: 80,
  workspace_root: "/tmp/ws",
};

async function buildApp(state: AppState) {
  const app = Fastify();
  registerMetaRoutes(app, state);
  await app.ready();
  return app;
}

test("GET /v1/server/info merges the static snapshot with live tools/providers", async () => {
  const tools = new ToolRegistry();
  tools.register({ name: "fs.read", description: "", parameters: {}, invoke: async () => "" });
  tools.register({ name: "echo", description: "", parameters: {}, invoke: async () => "" });
  const app = await buildApp({
    createAgent: agentUnused,
    serverInfo: SERVER_INFO,
    tools,
    providerCatalog: {
      default: "openai",
      providers: [{ name: "openai", default_model: "gpt-4o-mini", models: ["gpt-4o-mini"], is_default: true }],
    },
  });
  const info = (await app.inject({ method: "GET", url: "/v1/server/info" })).json() as {
    version: string;
    approval_mode: string;
    tools: string[];
    tool_count: number;
    mcp_servers: string[];
    providers: { name: string }[];
  };
  assert.equal(info.version, "0.2.0");
  assert.equal(info.approval_mode, "ask");
  assert.deepEqual(info.tools.sort(), ["echo", "fs.read"]);
  assert.equal(info.tool_count, 2);
  assert.deepEqual(info.mcp_servers, []);
  assert.equal(info.providers[0]!.name, "openai");
  await app.close();
});

test("GET /v1/version returns {name, version}", async () => {
  const app = await buildApp({ createAgent: agentUnused, serverInfo: SERVER_INFO });
  assert.deepEqual((await app.inject({ method: "GET", url: "/v1/version" })).json(), {
    name: "jarvis",
    version: "0.2.0",
  });
  // Falls back to 0.0.0 when no serverInfo.
  const bare = await buildApp({ createAgent: agentUnused });
  assert.deepEqual((await bare.inject({ method: "GET", url: "/v1/version" })).json(), {
    name: "jarvis",
    version: "0.0.0",
  });
  await app.close();
  await bare.close();
});

test("probe 503 when no provider; reports auth_ok on success/failure", async () => {
  const catalog = {
    default: "openai",
    providers: [{ name: "openai", default_model: "gpt-4o-mini", models: ["gpt-4o-mini"], is_default: true }],
  };
  const noProv = await buildApp({ createAgent: agentUnused });
  assert.equal(
    (await noProv.inject({ method: "POST", url: "/v1/providers/openai/probe", payload: {} })).statusCode,
    503,
  );
  await noProv.close();

  // success
  const okApp = await buildApp({ createAgent: agentUnused, provider: fakeProvider(), providerCatalog: catalog });
  const ok = (await okApp.inject({ method: "POST", url: "/v1/providers/openai/probe", payload: {} })).json() as {
    auth_ok: boolean;
    model: string;
    supports_streaming: boolean;
    latency_ms: number;
  };
  assert.equal(ok.auth_ok, true);
  assert.equal(ok.model, "gpt-4o-mini"); // resolved from the catalog default
  assert.equal(ok.supports_streaming, true);
  assert.ok(typeof ok.latency_ms === "number");
  await okApp.close();

  // failure surfaces error + auth_ok false
  const badApp = await buildApp({
    createAgent: agentUnused,
    provider: fakeProvider("401 invalid api key"),
    providerCatalog: catalog,
  });
  const bad = (await badApp.inject({
    method: "POST",
    url: "/v1/providers/openai/probe",
    payload: { model: "gpt-x" },
  })).json() as { auth_ok: boolean; error: string; model: string };
  assert.equal(bad.auth_ok, false);
  assert.match(bad.error, /invalid api key/);
  assert.equal(bad.model, "gpt-x"); // body override wins
  await badApp.close();
});

test("probe test_tools exercises a second completion → supports_tool_calls", async () => {
  const app = await buildApp({
    createAgent: agentUnused,
    provider: fakeProvider(),
    providerCatalog: {
      default: "openai",
      providers: [{ name: "openai", default_model: "m", models: ["m"], is_default: true }],
    },
  });
  const r = (await app.inject({
    method: "POST",
    url: "/v1/providers/openai/probe",
    payload: { test_tools: true },
  })).json() as { supports_tool_calls: boolean | null };
  assert.equal(r.supports_tool_calls, true);
  await app.close();
});
