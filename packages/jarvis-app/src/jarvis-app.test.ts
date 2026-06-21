// Smoke test for the composition root. Deterministic, no network, no real keys:
//   * loadConfig on a fixture env (never touches the real process.env).
//   * buildProvider selection with an injected fetch (no API key resolution
//     path is exercised against the network).
//   * buildAppState with makeMemoryStores + a STUB provider returning a canned
//     reply, then buildServer(state) and inject GET /health + POST
//     /v1/chat/completions to prove the whole wiring boots and serves.
import { test } from "node:test";
import assert from "node:assert/strict";

import type { ChatRequest, ChatResponse, LlmChunk, LlmProvider } from "@jarvis/core";
import { assistantText, defaultCompleteStream } from "@jarvis/core";
import { makeMemoryStores } from "@jarvis/store";
import { buildServer } from "@jarvis/server";

import { loadConfig } from "./config.ts";
import { buildProvider } from "./provider.ts";
import { buildAppState } from "./state.ts";

/** A fixture env — passed explicitly so we never read/mutate process.env. */
const FIXTURE_ENV: Record<string, string | undefined> = {
  JARVIS_PROVIDER: "openai",
  JARVIS_MODEL: "gpt-4o-mini",
  OPENAI_API_KEY: "sk-test-not-real",
  JARVIS_ADDR: "127.0.0.1:0",
  JARVIS_FS_ROOT: "/tmp/jarvis-smoke",
  JARVIS_ENABLE_FS_WRITE: "1",
  JARVIS_MCP_SERVERS: "",
};

/** A stub LlmProvider that returns one canned assistant reply, then stops. */
class StubProvider implements LlmProvider {
  readonly reply: string;
  calls = 0;
  constructor(reply: string) {
    this.reply = reply;
  }
  complete(_req: ChatRequest): Promise<ChatResponse> {
    this.calls += 1;
    return Promise.resolve({ message: assistantText(this.reply), finish_reason: "stop" });
  }
  completeStream(req: ChatRequest): AsyncIterable<LlmChunk> {
    return defaultCompleteStream(this, req);
  }
}

test("loadConfig parses a fixture env without touching process.env", () => {
  const config = loadConfig(FIXTURE_ENV);
  assert.equal(config.provider, "openai");
  assert.equal(config.model, "gpt-4o-mini");
  assert.equal(config.openaiApiKey, "sk-test-not-real");
  assert.equal(config.addr, "127.0.0.1:0");
  assert.equal(config.fsRoot, "/tmp/jarvis-smoke");
  assert.equal(config.gating.enableFsWrite, true);
  assert.equal(config.gating.enableShellExec, false);
  assert.equal(config.gating.enableGitRead, true); // on unless disabled
  assert.equal(config.permissionMode, "ask");
  assert.equal(config.router.enabled, false);
  assert.equal(config.mcpServers.length, 0);
});

test("loadConfig parses legacy stdio MCP servers into transport configs", () => {
  const config = loadConfig({
    ...FIXTURE_ENV,
    JARVIS_MCP_SERVERS: "fs=uvx mcp-server-filesystem /tmp,git=uvx mcp-server-git",
  });
  assert.equal(config.mcpServers.length, 2);
  assert.deepEqual(config.mcpServers[0], {
    prefix: "fs",
    transport: { type: "stdio", command: "uvx", args: ["mcp-server-filesystem", "/tmp"] },
  });
  assert.deepEqual(config.mcpServers[1], {
    prefix: "git",
    transport: { type: "stdio", command: "uvx", args: ["mcp-server-git"] },
  });
});

test("loadConfig maps Composio env to a streamable HTTP MCP server", () => {
  const config = loadConfig({
    ...FIXTURE_ENV,
    COMPOSIO_API_KEY: "cmp-test",
    JARVIS_COMPOSIO_MCP_SERVER_ID: "mcp_123",
    JARVIS_COMPOSIO_USER_ID: "user 123",
    JARVIS_COMPOSIO_PREFIX: "apps",
    JARVIS_COMPOSIO_ALLOW_TOOLS: "GMAIL_FETCH_EMAILS, GMAIL_SEND_EMAIL",
    JARVIS_COMPOSIO_DENY_TOOLS: "GMAIL_DELETE_EMAIL",
  });
  assert.equal(config.mcpServers.length, 1);
  assert.deepEqual(config.mcpServers[0], {
    prefix: "apps",
    transport: {
      type: "streamable-http",
      url: "https://backend.composio.dev/v3/mcp/mcp_123?user_id=user%20123",
      headers: { "x-api-key": "cmp-test" },
    },
    allowTools: ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"],
    denyTools: ["GMAIL_DELETE_EMAIL"],
  });
});

test("loadConfig accepts a full Composio MCP URL", () => {
  const config = loadConfig({
    ...FIXTURE_ENV,
    JARVIS_COMPOSIO_API_KEY: "cmp-test",
    JARVIS_COMPOSIO_MCP_URL: "https://backend.composio.dev/v3/mcp/server?user_id=u",
  });
  assert.equal(config.mcpServers.length, 1);
  assert.deepEqual(config.mcpServers[0], {
    prefix: "composio",
    transport: {
      type: "streamable-http",
      url: "https://backend.composio.dev/v3/mcp/server?user_id=u",
      headers: { "x-api-key": "cmp-test" },
    },
  });
});

test("loadConfig honors per-provider defaults + base-url + disable flags", () => {
  const config = loadConfig({
    JARVIS_PROVIDER: "kimi",
    KIMI_API_KEY: "kk",
    KIMI_BASE_URL: "https://api.moonshot.ai/v1",
    JARVIS_DISABLE_GIT_READ: "1",
    JARVIS_MEMORY_TOKENS: "4000",
    JARVIS_MEMORY_MODE: "summary",
    JARVIS_ROUTER_ENABLED: "1",
    JARVIS_ROUTER_TIER_SIMPLE: "openai/gpt-4o-mini",
  });
  assert.equal(config.provider, "kimi");
  assert.equal(config.model, "kimi-k2-thinking"); // per-provider default
  assert.equal(config.kimiBaseUrl, "https://api.moonshot.ai/v1");
  assert.equal(config.gating.enableGitRead, false);
  assert.equal(config.memoryTokens, 4000);
  assert.equal(config.memoryMode, "summary");
  assert.equal(config.router.enabled, true);
  assert.equal(config.router.simple, "openai/gpt-4o-mini");
});

test("buildProvider selects + wraps a provider with an injected fetch", async () => {
  // An injected fetch proves we never touch the network: it throws if called.
  const fetchImpl = (() => {
    throw new Error("network access is not allowed in the smoke test");
  }) as unknown as typeof fetch;
  const config = loadConfig(FIXTURE_ENV);
  const provider = await buildProvider(config, { fetchImpl });
  // The capability-validating wrapper is the public surface; we only assert it
  // constructed (a known model passes validation without a network call).
  assert.ok(typeof provider.complete === "function");
});

test("buildAppState + buildServer boots and serves health + a chat completion", async () => {
  const config = loadConfig(FIXTURE_ENV);
  const stub = new StubProvider("hello from the stub");
  const stores = makeMemoryStores();

  const { state } = await buildAppState(config, {
    provider: stub,
    stores,
    // Skip the filesystem project-context read for determinism.
    systemPrompt: "You are a test agent.",
  });

  const app = await buildServer(state);
  try {
    const health = await app.inject({ method: "GET", url: "/health" });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: "ok" });

    // The model-picker catalog is wired through buildAppState → AppState → route.
    const providers = await app.inject({ method: "GET", url: "/v1/providers" });
    assert.equal(providers.statusCode, 200);
    const pbody = providers.json() as {
      default: string;
      providers: Array<{ name: string; default_model: string; is_default: boolean }>;
    };
    assert.equal(pbody.default, config.provider);
    assert.ok(pbody.providers.some((p) => p.is_default && p.name === config.provider));

    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(chat.statusCode, 200);
    const body = chat.json() as { message: { role: string; content?: string }; iterations: number };
    assert.equal(body.message.role, "assistant");
    assert.equal(body.message.content, "hello from the stub");
    assert.equal(body.iterations, 1);
    assert.equal(stub.calls, 1);
  } finally {
    await app.close();
  }
});

test("buildAppState wires the domain stores into AppState", async () => {
  const config = loadConfig(FIXTURE_ENV);
  const stores = makeMemoryStores();
  const { state } = await buildAppState(config, {
    provider: new StubProvider("x"),
    stores,
    systemPrompt: "test",
  });
  // The conversation store + each domain store flow through to AppState so the
  // routes that 503-when-absent are live.
  assert.equal(state.store, stores.conversations);
  assert.equal(state.projects, stores.projects);
  assert.equal(state.requirements, stores.requirements);
  assert.equal(state.workflows, stores.workflows);
  assert.equal(state.workspaceRoot, config.fsRoot);
  assert.ok(state.subagents !== undefined);
});

test("memoryRuntime: absent by default, wired when JARVIS_ENABLE_MEMORY is set", async () => {
  const off = await buildAppState(loadConfig(FIXTURE_ENV), {
    provider: new StubProvider("x"),
    stores: makeMemoryStores(),
    systemPrompt: "test",
  });
  assert.equal(off.state.memoryRuntime, undefined, "no runtime without JARVIS_ENABLE_MEMORY");

  const config = loadConfig({
    ...FIXTURE_ENV,
    JARVIS_ENABLE_MEMORY: "1",
    JARVIS_MEMORY_SYNC_BACKEND: "git",
    JARVIS_MEMORY_USER_ROOT: "/tmp/jarvis-user-mem",
  });
  assert.equal(config.enableMemory, true);
  assert.equal(config.memorySyncBackend, "git");
  const { state } = await buildAppState(config, {
    provider: new StubProvider("x"),
    stores: makeMemoryStores(),
    systemPrompt: "test",
  });
  assert.deepEqual(state.memoryRuntime, {
    workspaceRoot: config.fsRoot,
    userRoot: "/tmp/jarvis-user-mem",
    backend: "git",
  });
});
