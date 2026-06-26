import { test } from "node:test";
import assert from "node:assert/strict";

import { ToolRegistry, type JsonValue } from "@jarvis/core";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  McpClient,
  McpError,
  RemoteTool,
  connectAllMcp,
  mcpClientConfig,
  stdioTransport,
  type McpClientConfig,
  type McpClientHandle,
} from "./client.ts";

// ---------------------------------------------------------------------------
// RemoteTool unit tests against a hand-rolled mock handle (no transport).
// ---------------------------------------------------------------------------

interface CallRecord {
  name: string;
  arguments?: Record<string, unknown>;
}

function mockHandle(
  reply: (rec: CallRecord) => Awaited<ReturnType<McpClientHandle["callTool"]>>,
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }> = [],
): { handle: McpClientHandle; calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  const handle: McpClientHandle = {
    async listTools() {
      return { tools };
    },
    async callTool(params) {
      calls.push(params);
      return reply(params);
    },
  };
  return { handle, calls };
}

test("RemoteTool.invoke returns joined text content", async () => {
  const { handle, calls } = mockHandle(() => ({
    content: [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ],
  }));
  const tool = new RemoteTool("srv.echo", "desc", { type: "object" }, "echo", handle);
  const out = await tool.invoke({ a: 1 });
  assert.equal(out, "hello\nworld");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "echo");
  assert.deepEqual(calls[0]?.arguments, { a: 1 });
});

test("RemoteTool.invoke appends structured content as JSON", async () => {
  const { handle } = mockHandle(() => ({
    content: [{ type: "text", text: "text-part" }],
    structuredContent: { ok: true },
  }));
  const tool = new RemoteTool("srv.t", "", { type: "object" }, "t", handle);
  assert.equal(await tool.invoke({}), 'text-part\n{"ok":true}');
});

test("RemoteTool.invoke renders non-text blocks as placeholders", async () => {
  const { handle } = mockHandle(() => ({
    content: [
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "audio", data: "BB", mimeType: "audio/mp3" },
      { type: "resource_link", uri: "file:///x" },
    ],
  }));
  const tool = new RemoteTool("srv.t", "", { type: "object" }, "t", handle);
  const out = await tool.invoke({});
  assert.equal(
    out,
    "<image mime=image/png size=4>\n<audio mime=audio/mp3 size=2>\n<resource link: file:///x>",
  );
});

test("RemoteTool.invoke throws McpError on is_error result", async () => {
  const { handle } = mockHandle(() => ({
    isError: true,
    content: [{ type: "text", text: "boom" }],
  }));
  const tool = new RemoteTool("srv.t", "", { type: "object" }, "t", handle);
  await assert.rejects(() => tool.invoke({}), (e: unknown) => {
    assert.ok(e instanceof McpError);
    assert.match((e as McpError).message, /boom/);
    return true;
  });
});

test("RemoteTool.invoke surfaces fallback error text when error content empty", async () => {
  const { handle } = mockHandle(() => ({ isError: true, content: [] }));
  const tool = new RemoteTool("srv.t", "", { type: "object" }, "t", handle);
  await assert.rejects(() => tool.invoke({}), /mcp tool error \(no content\)/);
});

test("RemoteTool.invoke passes no arguments for null args", async () => {
  const { handle, calls } = mockHandle(() => ({ content: [{ type: "text", text: "ok" }] }));
  const tool = new RemoteTool("srv.t", "", { type: "object" }, "t", handle);
  await tool.invoke(null);
  assert.equal(calls[0]?.arguments, undefined);
});

test("RemoteTool.invoke rejects non-object arguments", async () => {
  const { handle } = mockHandle(() => ({ content: [] }));
  const tool = new RemoteTool("srv.t", "", { type: "object" }, "t", handle);
  await assert.rejects(() => tool.invoke([1, 2] as unknown as JsonValue), /expected an object argument/);
});

test("RemoteTool is gated as a write-category tool", () => {
  const { handle } = mockHandle(() => ({ content: [] }));
  const tool = new RemoteTool("srv.t", "d", { type: "object" }, "t", handle);
  assert.equal(tool.category, "write");
  assert.equal(tool.name, "srv.t");
  assert.equal(tool.description, "d");
  assert.deepEqual(tool.parameters, { type: "object" });
});

// ---------------------------------------------------------------------------
// Config helpers.
// ---------------------------------------------------------------------------

test("mcpClientConfig builds a stdio shorthand", () => {
  const cfg = mcpClientConfig("srv", "node", ["server.js"]);
  assert.equal(cfg.prefix, "srv");
  assert.deepEqual(cfg.transport, { type: "stdio", command: "node", args: ["server.js"] });
});

test("connect rejects non-stdio transports", async () => {
  const cfg: McpClientConfig = {
    prefix: "srv",
    transport: { type: "http", url: "http://localhost" },
  };
  await assert.rejects(() => McpClient.connect(cfg), (e: unknown) => {
    assert.ok(e instanceof McpError);
    return true;
  });
});

test("stdioTransport defaults args to empty", () => {
  assert.deepEqual(stdioTransport("cmd"), { type: "stdio", command: "cmd", args: [] });
});

// ---------------------------------------------------------------------------
// Integration tests: a real low-level MCP Server linked in-memory to the
// client through InMemoryTransport.createLinkedPair().
// ---------------------------------------------------------------------------

interface FakeTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties?: Record<string, unknown> };
}

function buildServer(tools: FakeTool[]): { server: Server; transport: InMemoryTransport } {
  const server = new Server(
    { name: "fixture", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (name === "boom") {
      return { isError: true, content: [{ type: "text", text: "kaboom" }] };
    }
    return {
      content: [{ type: "text", text: `called ${name} with ${JSON.stringify(args ?? {})}` }],
    };
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // Connect the server side; the client side is handed to McpClient.fromHandle.
  void server.connect(serverTransport);
  return { server, transport: clientTransport };
}

async function linkedClient(prefix: string, tools: FakeTool[]): Promise<McpClient> {
  const { transport } = buildServer(tools);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const client = new Client({ name: "jarvis-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return McpClient.fromHandle(prefix, client as unknown as McpClientHandle, () => client.close());
}

const ECHO: FakeTool = {
  name: "echo",
  description: "Echoes the input",
  inputSchema: { type: "object", properties: { msg: { type: "string" } } },
};
const ADD: FakeTool = { name: "add", description: "Adds", inputSchema: { type: "object" } };
const BOOM: FakeTool = { name: "boom", description: "Always errors", inputSchema: { type: "object" } };

test("collectRemoteTools renames with <prefix>.<name> and copies schema/desc", async () => {
  const client = await linkedClient("srv", [ECHO]);
  try {
    const cfg = mcpClientConfig("srv", "unused");
    const tools = await client.collectRemoteTools(cfg);
    assert.equal(tools.length, 1);
    const [name, tool] = tools[0]!;
    assert.equal(name, "srv.echo");
    assert.equal(tool.name, "srv.echo");
    assert.equal(tool.description, "Echoes the input");
    assert.deepEqual(tool.parameters, ECHO.inputSchema);
  } finally {
    await client.shutdown();
  }
});

test("registerInto inserts adapters into the registry and routes a call", async () => {
  const client = await linkedClient("srv", [ECHO, ADD]);
  try {
    const registry = new ToolRegistry();
    const names = await client.registerInto(registry, mcpClientConfig("srv", "unused"));
    assert.deepEqual(names.sort(), ["srv.add", "srv.echo"]);
    const echo = registry.resolve("srv.echo");
    assert.ok(echo);
    const out = await echo.invoke({ msg: "hi" });
    assert.equal(out, 'called echo with {"msg":"hi"}');
  } finally {
    await client.shutdown();
  }
});

test("registerInto accepts a bare prefix string", async () => {
  const client = await linkedClient("srv", [ECHO]);
  try {
    const registry = new ToolRegistry();
    const names = await client.registerInto(registry, "srv");
    assert.deepEqual(names, ["srv.echo"]);
  } finally {
    await client.shutdown();
  }
});

test("allowTools / denyTools / alias filter and rename", async () => {
  const client = await linkedClient("srv", [ECHO, ADD, BOOM]);
  try {
    const cfg: McpClientConfig = {
      prefix: "srv",
      transport: stdioTransport("unused"),
      allowTools: ["echo", "add"],
      denyTools: ["add"],
      alias: { echo: "say" },
    };
    const tools = await client.collectRemoteTools(cfg);
    const names = tools.map(([n]) => n);
    assert.deepEqual(names, ["srv.say"]); // add denied, boom not allowed, echo aliased
  } finally {
    await client.shutdown();
  }
});

test("health reports the advertised tool count", async () => {
  const client = await linkedClient("srv", [ECHO, ADD]);
  try {
    assert.equal(await client.health(), 2);
  } finally {
    await client.shutdown();
  }
});

test("RemoteTool.invoke over a real server throws on is_error", async () => {
  const client = await linkedClient("srv", [BOOM]);
  try {
    const registry = new ToolRegistry();
    await client.registerInto(registry, mcpClientConfig("srv", "unused"));
    const boom = registry.resolve("srv.boom");
    assert.ok(boom);
    await assert.rejects(() => boom.invoke({}), /kaboom/);
  } finally {
    await client.shutdown();
  }
});

test("connectAllMcp skips disabled entries", async () => {
  // We can't spawn real processes here, so verify the disabled-skip branch
  // produces no clients (and never touches the transport).
  const registry = new ToolRegistry();
  const clients = await connectAllMcp(
    [{ prefix: "off", transport: stdioTransport("never-run"), enabled: false }],
    registry,
  );
  assert.equal(clients.length, 0);
  assert.equal(registry.names().length, 0);
});

test("connectAllMcp rolls back earlier servers' tools when a later server fails", async () => {
  // Server "a" connects and registers a tool; server "b" then fails to connect.
  // The catch block must close "a" AND unregister "a.echo" so the shared
  // registry is left exactly as it was before the call (no zombie adapter
  // pointing at a closed transport).
  const registry = new ToolRegistry();
  let aClosed = false;
  // A real in-memory client for server "a" with a spy close().
  const { transport } = buildServer([ECHO]);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const aClient = new Client({ name: "jarvis-test", version: "0.0.0" }, { capabilities: {} });
  await aClient.connect(transport);
  const wrapped = McpClient.fromHandle(
    "a",
    aClient as unknown as McpClientHandle,
    async () => {
      aClosed = true;
      await aClient.close();
    },
  );

  const configs: McpClientConfig[] = [
    { prefix: "a", transport: stdioTransport("unused") },
    { prefix: "b", transport: stdioTransport("unused") },
  ];
  const connect = async (cfg: McpClientConfig): Promise<McpClient> => {
    if (cfg.prefix === "a") return wrapped;
    throw new McpError("failed to connect to mcp server 'b': boom");
  };

  await assert.rejects(
    () => connectAllMcp(configs, registry, connect),
    /failed to connect to mcp server 'b'/,
  );
  assert.equal(aClosed, true, "earlier client should be closed on rollback");
  assert.equal(registry.contains("a.echo"), false, "earlier tools must be unregistered");
  assert.equal(registry.names().length, 0, "registry restored to pre-call state");
});

test("connectAllMcp keeps registered tools on full success", async () => {
  const registry = new ToolRegistry();
  const a = await linkedClient("a", [ECHO]);
  const b = await linkedClient("b", [ADD]);
  const configs: McpClientConfig[] = [
    { prefix: "a", transport: stdioTransport("unused") },
    { prefix: "b", transport: stdioTransport("unused") },
  ];
  const queue = [a, b];
  const connect = async (): Promise<McpClient> => queue.shift()!;

  const clients = await connectAllMcp(configs, registry, connect);
  try {
    assert.equal(clients.length, 2);
    assert.equal(registry.contains("a.echo"), true);
    assert.equal(registry.contains("b.add"), true);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
  }
});

test("shutdown closes the underlying session", async () => {
  let closed = false;
  const handle: McpClientHandle = {
    async listTools() {
      return { tools: [] };
    },
    async callTool() {
      return { content: [] };
    },
  };
  const client = McpClient.fromHandle("srv", handle, async () => {
    closed = true;
  });
  await client.shutdown();
  assert.equal(closed, true);
});
