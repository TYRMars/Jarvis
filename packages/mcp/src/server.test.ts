// Tests for the MCP server adapter (ported from the Rust `server.rs` tests),
// plus an end-to-end pass over the SDK's in-memory linked-transport pair so we
// exercise the real `tools/list` + `tools/call` request handlers.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { JsonValue, Tool } from "@jarvis/core";
import { ToolRegistry } from "@jarvis/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import { McpServer, serveRegistryStdio } from "./server.ts";

// Mirrors the Rust `HelloTool` fixture.
class HelloTool implements Tool {
  readonly name = "hello";
  readonly description = "Say hello.";
  readonly parameters: JsonValue = {
    type: "object",
    properties: { who: { type: "string" } },
  };
  readonly category = "read" as const;

  async invoke(args: JsonValue): Promise<string> {
    let who = "world";
    if (args !== null && typeof args === "object" && !Array.isArray(args)) {
      const v = (args as Record<string, unknown>).who;
      if (typeof v === "string") who = v;
    }
    return `hello, ${who}`;
  }
}

// A tool whose `parameters` is NOT an object schema — must collapse to
// `{type:"object"}` in `inputSchema`.
class ScalarSchemaTool implements Tool {
  readonly name = "scalar";
  readonly description = "Non-object schema tool.";
  readonly parameters: JsonValue = "not-an-object";
  async invoke(): Promise<string> {
    return "ok";
  }
}

// A tool that throws — its error must become an `isError` text result, not a
// thrown protocol error.
class BoomTool implements Tool {
  readonly name = "boom";
  readonly description = "Always throws.";
  readonly parameters: JsonValue = { type: "object" };
  async invoke(): Promise<string> {
    throw new Error("kaboom");
  }
}

function registryWith(...tools: Tool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  return registry;
}

test("listToolsSync returns registered specs", () => {
  const server = new McpServer(registryWith(new HelloTool()));
  const res = server.listToolsSync();
  assert.equal(res.tools.length, 1);
  assert.equal(res.tools[0]!.name, "hello");
  assert.equal(res.tools[0]!.description, "Say hello.");
  assert.equal(res.tools[0]!.inputSchema.type, "object");
});

test("listToolsSync substitutes {} for a non-object schema", () => {
  const server = new McpServer(registryWith(new ScalarSchemaTool()));
  const res = server.listToolsSync();
  assert.equal(res.tools.length, 1);
  assert.deepEqual(res.tools[0]!.inputSchema, { type: "object" });
});

test("callToolSync routes to the registered tool", async () => {
  const server = new McpServer(registryWith(new HelloTool()));
  const res = await server.callToolSync("hello", { who: "jarvis" });
  assert.notEqual(res.isError, true);
  const content = res.content[0]!;
  assert.equal(content.type, "text");
  assert.equal((content as { text: string }).text, "hello, jarvis");
});

test("callToolSync defaults missing arguments", async () => {
  const server = new McpServer(registryWith(new HelloTool()));
  const res = await server.callToolSync("hello", undefined);
  assert.equal((res.content[0] as { text: string }).text, "hello, world");
});

test("callToolSync surfaces a tool error as isError, not a throw", async () => {
  const server = new McpServer(registryWith(new BoomTool()));
  const res = await server.callToolSync("boom", {});
  assert.equal(res.isError, true);
  assert.equal((res.content[0] as { text: string }).text, "kaboom");
});

test("callToolSync throws MethodNotFound for an unknown tool", async () => {
  const server = new McpServer(registryWith());
  await assert.rejects(
    () => server.callToolSync("missing", undefined),
    (err: unknown) => {
      assert.ok(err instanceof McpError);
      assert.equal(err.code, ErrorCode.MethodNotFound);
      return true;
    },
  );
});

test("muted tools are invisible to list and call", async () => {
  const registry = registryWith(new HelloTool());
  registry.mute("hello");
  const server = new McpServer(registry);
  assert.equal(server.listToolsSync().tools.length, 0);
  await assert.rejects(() => server.callToolSync("hello", {}), McpError);
});

test("end-to-end: a Client lists and calls over a linked transport pair", async () => {
  const server = new McpServer(registryWith(new HelloTool(), new BoomTool()));
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["boom", "hello"]);

    const ok = await client.callTool({
      name: "hello",
      arguments: { who: "mcp" },
    });
    assert.notEqual(ok.isError, true);
    assert.equal(
      ((ok.content as { text: string }[])[0]).text,
      "hello, mcp",
    );

    // Tool errors come back as isError results, not thrown protocol errors.
    const boom = await client.callTool({ name: "boom", arguments: {} });
    assert.equal(boom.isError, true);
    assert.equal(((boom.content as { text: string }[])[0]).text, "kaboom");

    // Unknown tool IS a protocol error.
    await assert.rejects(
      () => client.callTool({ name: "nope", arguments: {} }),
      (err: unknown) => {
        assert.ok(err instanceof McpError);
        assert.equal(err.code, ErrorCode.MethodNotFound);
        return true;
      },
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("serveRegistryStdio is exported and is a function", () => {
  assert.equal(typeof serveRegistryStdio, "function");
});
