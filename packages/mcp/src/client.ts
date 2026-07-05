// Adapt external MCP servers as `@jarvis/core` Tool implementations.
// Ported from harness-mcp/src/client.rs.
//
// Spawn an MCP server as a child process over stdio, discover its tools on
// connect, and adapt each one into a harness `Tool` renamed `<prefix>.<name>`
// so tools from multiple servers don't collide. Every remote tool call becomes
// a `tools/call` JSON-RPC request under the hood.
//
// The Rust original models multiple transports via `McpTransport`; today only
// `stdio` is fully wired. `http` / `streamable-http` are recognised by the API
// surface but `connect` rejects them so callers (config, REST API, UI) can build
// against the final shape now.
//
// The SDK `Client` owns the spawned child process through its
// `StdioClientTransport`; `McpClient` owns that `Client` and exposes
// `shutdown()` / `close()` to kill the child (the JS analogue of Rust's drop).

import type { JsonValue } from "@jarvis/core";
import { type Tool, type ToolCategory, ToolRegistry } from "@jarvis/core";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/** Identity advertised to the remote server during the MCP handshake. */
const CLIENT_INFO = { name: "jarvis", version: "0.0.0" } as const;

/** Wire-level transport selection for an MCP server. */
export type McpTransport =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "streamable-http"; url: string; headers?: Record<string, string> };

/** Build a stdio transport descriptor. */
export function stdioTransport(command: string, args: string[] = []): McpTransport {
  return { type: "stdio", command, args };
}

/**
 * Shape of a single MCP server to spawn / connect to.
 *
 * Mirrors Rust's `McpClientConfig`. Use `mcpClientConfig(prefix, command, args)`
 * for the common stdio shorthand.
 */
export interface McpClientConfig {
  /**
   * Human-readable label; prepended to each remote tool's name as
   * `<prefix>.<tool>` so tools from multiple servers don't collide.
   */
  prefix: string;
  /** How to reach the server. */
  transport: McpTransport;
  /**
   * Optional allowlist of remote tool names. When present, only tools whose
   * remote name appears here get registered.
   */
  allowTools?: string[];
  /** Tool names to skip even if otherwise allowed. */
  denyTools?: string[];
  /**
   * Per-tool rename: `remoteName -> localShortName`. The final registered name
   * is still `<prefix>.<short>`.
   */
  alias?: Record<string, string>;
  /**
   * Whether this server should be auto-started by the manager. Defaults to
   * `true`. Disabled servers stay in the catalog but are skipped by
   * `connectAllMcp`.
   */
  enabled?: boolean;
}

/** Backwards-compatible constructor: a stdio entry with no filtering/aliasing. */
export function mcpClientConfig(
  prefix: string,
  command: string,
  args: string[] = [],
): McpClientConfig {
  return { prefix, transport: stdioTransport(command, args) };
}

/** Error raised by the MCP bridge. */
export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpError";
  }
}

/** The SDK content-block / call-tool shapes we actually read. */
interface TextBlock {
  type: "text";
  text: string;
}
interface BinaryBlock {
  type: "image" | "audio";
  data: string;
  mimeType: string;
}
interface ResourceBlock {
  type: "resource";
  resource: { uri?: string } & Record<string, unknown>;
}
interface ResourceLinkBlock {
  type: "resource_link";
  uri: string;
}
type ContentBlock = TextBlock | BinaryBlock | ResourceBlock | ResourceLinkBlock | { type: string };

interface CallToolResultLike {
  content?: ContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

interface RemoteToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * Minimal slice of the SDK `Client` that `RemoteTool` depends on. Declaring it
 * lets tests inject a mock client without spawning a process.
 */
export interface McpClientHandle {
  listTools(): Promise<{ tools: RemoteToolDescriptor[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResultLike>;
}

/**
 * A connected MCP client holding a running child process (through the SDK
 * transport). The child is killed when `shutdown()` / `close()` is called; keep
 * the value alive for as long as you want to use the adapted tools.
 */
export class McpClient {
  readonly #prefix: string;
  readonly #client: McpClientHandle;
  readonly #close: () => Promise<void>;

  private constructor(prefix: string, client: McpClientHandle, close: () => Promise<void>) {
    this.#prefix = prefix;
    this.#client = client;
    this.#close = close;
  }

  /** Spawn / connect to the server described by `cfg` and perform the handshake. */
  static async connect(cfg: McpClientConfig): Promise<McpClient> {
    if (cfg.transport.type !== "stdio") {
      throw new McpError(
        "http transport is not wired in this build (only stdio is supported)",
      );
    }
    const { command, args, env } = cfg.transport;
    const transport: Transport = new StdioClientTransport({
      command,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
    });
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    try {
      await client.connect(transport);
    } catch (e) {
      // Best-effort cleanup so a failed handshake doesn't leak the child.
      await client.close().catch(() => {});
      throw new McpError(`failed to connect to mcp server '${cfg.prefix}': ${describe(e)}`);
    }
    return new McpClient(cfg.prefix, client as unknown as McpClientHandle, () => client.close());
  }

  /**
   * Build a client around an already-connected SDK client (or a compatible
   * mock). Used by tests and by callers wiring a non-stdio transport directly.
   */
  static fromHandle(
    prefix: string,
    client: McpClientHandle,
    close: () => Promise<void> = async () => {},
  ): McpClient {
    return new McpClient(prefix, client, close);
  }

  /** Prefix this client registers tools under. */
  get prefix(): string {
    return this.#prefix;
  }

  /**
   * Fetch every tool the remote server exposes and build an adapter per tool,
   * applying the config's allow/deny/alias. Returns `(finalName, Tool)` pairs so
   * callers decide when/where to insert them.
   */
  async collectRemoteTools(cfg: McpClientConfig): Promise<Array<[string, Tool]>> {
    const { tools } = await this.#client.listTools();
    const out: Array<[string, Tool]> = [];
    for (const tool of tools) {
      const remoteName = tool.name;
      if (cfg.allowTools && !cfg.allowTools.includes(remoteName)) continue;
      if (cfg.denyTools?.includes(remoteName)) continue;
      const short = cfg.alias?.[remoteName] ?? remoteName;
      const name = `${this.#prefix}.${short}`;
      const adapter = new RemoteTool(
        name,
        tool.description ?? "",
        normalizeSchema(tool.inputSchema),
        remoteName,
        this.#client,
      );
      out.push([name, adapter]);
    }
    return out;
  }

  /**
   * Collect remote tools and register them into `registry`. Returns the final
   * registered names.
   *
   * Mirrors Rust's `register_into`; the optional `prefixCfg` lets callers pass a
   * bare prefix override (matching the task's `registerInto(registry, prefix)`
   * shape) while still supporting full allow/deny/alias configs.
   */
  async registerInto(
    registry: ToolRegistry,
    cfgOrPrefix?: McpClientConfig | string,
  ): Promise<string[]> {
    const cfg = this.#resolveCfg(cfgOrPrefix);
    const tools = await this.collectRemoteTools(cfg);
    const names: string[] = [];
    for (const [name, tool] of tools) {
      registry.register(tool);
      names.push(name);
    }
    return names;
  }

  #resolveCfg(cfgOrPrefix?: McpClientConfig | string): McpClientConfig {
    if (cfgOrPrefix === undefined) {
      return { prefix: this.#prefix, transport: stdioTransport("") };
    }
    if (typeof cfgOrPrefix === "string") {
      return { prefix: cfgOrPrefix, transport: stdioTransport("") };
    }
    return cfgOrPrefix;
  }

  /** Probe the server with a `tools/list` round-trip; returns the tool count. */
  async health(): Promise<number> {
    const { tools } = await this.#client.listTools();
    return tools.length;
  }

  /** Gracefully close the MCP session and reap the child. */
  async shutdown(): Promise<void> {
    await this.#close();
  }

  /** Alias for `shutdown()` (drop semantics). */
  async close(): Promise<void> {
    await this.#close();
  }
}

/** Adapts a single remote MCP tool into a harness `Tool`. */
export class RemoteTool implements Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonValue;
  // Remote tools are opaque side effects; gate them conservatively. The agent
  // loop keys the approval gate exclusively off `requiresApproval` (category
  // only drives Plan-Mode read/write filtering), so both must be set for a
  // remote MCP tool to be prompted under an approver.
  readonly category: ToolCategory = "write";
  readonly requiresApproval = true;
  readonly #remoteName: string;
  readonly #client: McpClientHandle;

  constructor(
    name: string,
    description: string,
    parameters: JsonValue,
    remoteName: string,
    client: McpClientHandle,
  ) {
    this.name = name;
    this.description = description;
    this.parameters = parameters;
    this.#remoteName = remoteName;
    this.#client = client;
  }

  async invoke(args: JsonValue): Promise<string> {
    let argumentsObj: Record<string, unknown> | undefined;
    if (args === null || args === undefined) {
      argumentsObj = undefined;
    } else if (typeof args === "object" && !Array.isArray(args)) {
      argumentsObj = args as Record<string, unknown>;
    } else {
      throw new McpError(
        `mcp tool ${this.#remoteName} expected an object argument, got ${JSON.stringify(args)}`,
      );
    }

    const result = await this.#client.callTool({
      name: this.#remoteName,
      ...(argumentsObj ? { arguments: argumentsObj } : {}),
    });

    if (result.isError === true) {
      throw new McpError(formatError(result.content));
    }
    return formatContent(result.content, result.structuredContent);
  }
}

/** Render the result's content blocks (+ optional structured content) to text. */
function formatContent(content: ContentBlock[] | undefined, structured: unknown): string {
  const parts: string[] = [];
  for (const c of content ?? []) {
    switch (c.type) {
      case "text":
        parts.push((c as TextBlock).text);
        break;
      case "image": {
        const b = c as BinaryBlock;
        parts.push(`<image mime=${b.mimeType} size=${b.data.length}>`);
        break;
      }
      case "audio": {
        const b = c as BinaryBlock;
        parts.push(`<audio mime=${b.mimeType} size=${b.data.length}>`);
        break;
      }
      case "resource":
        parts.push(`<resource: ${JSON.stringify((c as ResourceBlock).resource)}>`);
        break;
      case "resource_link":
        parts.push(`<resource link: ${(c as ResourceLinkBlock).uri}>`);
        break;
      default:
        parts.push(`<${c.type}>`);
        break;
    }
  }
  if (structured !== undefined && structured !== null) {
    parts.push(JSON.stringify(structured));
  }
  return parts.join("\n");
}

function formatError(content: ContentBlock[] | undefined): string {
  const text = formatContent(content, undefined);
  return text.length === 0 ? "mcp tool error (no content)" : text;
}

/** Coerce a remote tool's input schema into an object-shaped JSON schema. */
function normalizeSchema(schema: unknown): JsonValue {
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    return schema as JsonValue;
  }
  return { type: "object" };
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Connect to every server in `configs` and register their tools into
 * `registry`. Returns the still-connected clients so the caller keeps them
 * alive for the lifetime of the agent. Disabled entries (`enabled === false`)
 * are skipped silently. On any failure the already-opened clients are closed
 * before the error propagates.
 */
export async function connectAllMcp(
  configs: McpClientConfig[],
  registry: ToolRegistry,
): Promise<McpClient[]> {
  const clients: McpClient[] = [];
  try {
    for (const cfg of configs) {
      if (cfg.enabled === false) continue;
      const client = await McpClient.connect(cfg);
      clients.push(client);
      await client.registerInto(registry, cfg);
    }
  } catch (e) {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    throw e;
  }
  return clients;
}
