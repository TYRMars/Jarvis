// Expose a harness `ToolRegistry` to external MCP clients.
//
// Ported from crates/harness-mcp/src/server.rs. The Rust side implements
// `rmcp::ServerHandler` directly because the tool set is only known at runtime;
// here we use the SDK's low-level `Server` + `setRequestHandler` for the same
// reason (the high-level `McpServer` registers tools statically).
//
// `tools/list` returns the registry's specs (name / description /
// inputSchema = parameters, substituting `{}` for any non-object schema so the
// schema stays object-shaped). `tools/call` dispatches to the registered Tool
// and returns its string result as text content; tool errors surface as
// `isError` results (NOT protocol errors), exactly like the Rust
// `CallToolResult::error` path. An unknown tool is the one genuine protocol
// error (MethodNotFound), mirroring the Rust `ErrorCode::METHOD_NOT_FOUND`.
import type { JsonValue, ToolRegistry } from "@jarvis/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type ListToolsResult,
  type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

const SERVER_NAME = "jarvis-harness";
const SERVER_VERSION = "0.0.0";
const INSTRUCTIONS = "Jarvis harness exposing its local ToolRegistry over MCP.";

/** A `tools/list`-shaped `inputSchema`: `{type:"object", ...}`. */
type ObjectSchema = McpTool["inputSchema"];

/**
 * Coerce a tool's `parameters` into an object-shaped JSON schema. Non-object
 * schemas (or anything that isn't a plain JSON object) collapse to
 * `{type:"object"}`, mirroring the Rust `JsonObject::new()` fallback. The MCP
 * `inputSchema` requires `type:"object"`, so we always force that field.
 */
function toInputSchema(parameters: JsonValue): ObjectSchema {
  if (
    parameters !== null &&
    typeof parameters === "object" &&
    !Array.isArray(parameters)
  ) {
    return { ...(parameters as Record<string, unknown>), type: "object" };
  }
  return { type: "object" };
}

/**
 * An MCP server backed by a `ToolRegistry`. Construct it, then either `connect`
 * it to a transport yourself or use {@link serveRegistryStdio}.
 */
export class McpServer {
  readonly #registry: ToolRegistry;
  readonly #server: Server;

  constructor(registry: ToolRegistry) {
    this.#registry = registry;
    this.#server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
    );
    this.#install();
  }

  /** The underlying SDK server (for `connect` / `close` from callers). */
  get server(): Server {
    return this.#server;
  }

  /** Connect this server to a transport (stdio, in-memory, …). */
  async connect(transport: Parameters<Server["connect"]>[0]): Promise<void> {
    await this.#server.connect(transport);
  }

  /** Close the underlying server / transport. */
  async close(): Promise<void> {
    await this.#server.close();
  }

  /** Synchronous `tools/list` body — exposed for unit tests. */
  listToolsSync(): ListToolsResult {
    const tools: McpTool[] = this.#registry.specs().map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: toInputSchema(spec.parameters),
    }));
    return { tools };
  }

  /**
   * `tools/call` body — exposed for unit tests. Returns an `isError` result for
   * tool failures; throws `McpError(MethodNotFound)` for an unknown tool.
   */
  async callToolSync(
    name: string,
    args: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const tool = this.#registry.resolve(name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `unknown tool: ${name}`);
    }
    // Rust passes `Value::Object(args)` or `Value::Null`; we pass the args
    // object or `null` so a Tool can branch on absence the same way.
    const invokeArgs: JsonValue = (args ?? null) as JsonValue;
    try {
      const text = await tool.invoke(invokeArgs);
      return { content: [{ type: "text", text }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }

  #install(): void {
    this.#server.setRequestHandler(ListToolsRequestSchema, () =>
      this.listToolsSync(),
    );
    this.#server.setRequestHandler(CallToolRequestSchema, (request) =>
      this.callToolSync(request.params.name, request.params.arguments),
    );
  }
}

/**
 * Serve `registry` over stdio until the peer disconnects. This is what the
 * `--mcp-serve` subcommand calls; no LLM / HTTP setup is involved.
 */
export async function serveRegistryStdio(registry: ToolRegistry): Promise<void> {
  const server = new McpServer(registry);
  await server.connect(new StdioServerTransport());
}
