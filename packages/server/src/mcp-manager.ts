// Dynamic MCP server manager. Ported from harness-mcp's McpManager (+ the
// harness-server mcp_routes wiring). Tracks configured MCP servers by prefix,
// spawns/registers their tools into the SHARED ToolRegistry on add/reload, and
// unregisters them on remove — so a server added at runtime becomes visible to
// the next agent turn (which builds from the same registry instance).
//
// Mutations are serialized through an internal promise chain so concurrent REST
// requests can't interleave a connect/register against a remove (Node is
// single-threaded but `await` yields). The `connect` seam is injectable so
// tests can exercise add/remove/health/reload without spawning a child process.
import type { Tool, ToolRegistry } from "@jarvis/core";
import { McpClient, type McpClientConfig } from "@jarvis/mcp";

export type McpServerStatus = "running" | "stopped" | "unhealthy";

/** Wire-shape config (snake_case) exchanged with the web client. */
export interface McpClientConfigWire {
  prefix: string;
  transport: McpClientConfig["transport"];
  allow_tools?: string[] | null;
  deny_tools?: string[];
  alias?: Record<string, string>;
  enabled?: boolean;
}

/** One server's catalog entry returned by the list/get routes. */
export interface McpServerInfo {
  prefix: string;
  config: McpClientConfigWire;
  status: McpServerStatus;
  tools: string[];
}

/** A 4xx/409 the routes surface verbatim with the carried status code. */
export class McpManagerError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "McpManagerError";
    this.status = status;
  }
}

/** How the manager spawns a client — overridable in tests. */
export type McpConnect = (cfg: McpClientConfig) => Promise<McpClient>;

const defaultConnect: McpConnect = (cfg) => McpClient.connect(cfg);

/** Wire (snake_case) → internal (camelCase) config. */
export function wireToConfig(w: McpClientConfigWire): McpClientConfig {
  const cfg: McpClientConfig = { prefix: w.prefix, transport: w.transport };
  if (w.allow_tools != null) cfg.allowTools = w.allow_tools;
  if (w.deny_tools !== undefined) cfg.denyTools = w.deny_tools;
  if (w.alias !== undefined) cfg.alias = w.alias;
  if (w.enabled !== undefined) cfg.enabled = w.enabled;
  return cfg;
}

/** Internal (camelCase) → wire (snake_case) config. */
export function configToWire(c: McpClientConfig): McpClientConfigWire {
  const w: McpClientConfigWire = { prefix: c.prefix, transport: c.transport };
  if (c.allowTools !== undefined) w.allow_tools = c.allowTools;
  if (c.denyTools !== undefined) w.deny_tools = c.denyTools;
  if (c.alias !== undefined) w.alias = c.alias;
  if (c.enabled !== undefined) w.enabled = c.enabled;
  return w;
}

interface Slot {
  config: McpClientConfig;
  client?: McpClient;
  tools: string[];
  status: McpServerStatus;
}

export class McpManager {
  #slots = new Map<string, Slot>();
  #tail: Promise<unknown> = Promise.resolve();
  readonly #registry: ToolRegistry;
  readonly #connect: McpConnect;

  constructor(registry: ToolRegistry, connect: McpConnect = defaultConnect) {
    this.#registry = registry;
    this.#connect = connect;
  }

  /** Serialize a mutation so connect/register/remove never interleave. */
  #withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(fn, fn);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Live clients (for the composition root to keep alive). */
  clients(): McpClient[] {
    return [...this.#slots.values()].flatMap((s) => (s.client ? [s.client] : []));
  }

  list(): McpServerInfo[] {
    const out = [...this.#slots.entries()].map(([prefix, s]) => this.#info(prefix, s));
    out.sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
    return out;
  }

  get(prefix: string): McpServerInfo | undefined {
    const s = this.#slots.get(prefix);
    return s ? this.#info(prefix, s) : undefined;
  }

  #info(prefix: string, s: Slot): McpServerInfo {
    return { prefix, config: configToWire(s.config), status: s.status, tools: [...s.tools] };
  }

  /** Spawn + register a server. `enabled:false` records a Stopped slot only. */
  add(cfg: McpClientConfig): Promise<string[]> {
    return this.#withLock(() => this.#addInner(cfg));
  }

  async #addInner(cfg: McpClientConfig): Promise<string[]> {
    if (cfg.prefix.trim() === "") throw new McpManagerError("prefix must not be empty", 400);
    if (this.#slots.has(cfg.prefix)) {
      throw new McpManagerError(`mcp server '${cfg.prefix}' already registered`, 409);
    }
    if (cfg.enabled === false) {
      this.#slots.set(cfg.prefix, { config: cfg, tools: [], status: "stopped" });
      return [];
    }
    let client: McpClient;
    try {
      client = await this.#connect(cfg);
    } catch (e) {
      throw new McpManagerError(`failed to connect to '${cfg.prefix}': ${msg(e)}`, 400);
    }
    let pairs: Array<[string, Tool]>;
    try {
      pairs = await client.collectRemoteTools(cfg);
    } catch (e) {
      await safeShutdown(client);
      throw new McpManagerError(`failed to list tools for '${cfg.prefix}': ${msg(e)}`, 400);
    }
    // Collision check BEFORE mutating the registry.
    for (const [name] of pairs) {
      if (this.#registry.contains(name)) {
        await safeShutdown(client);
        throw new McpManagerError(`tool '${name}' is already registered`, 409);
      }
    }
    const names: string[] = [];
    for (const [name, tool] of pairs) {
      this.#registry.register(tool);
      names.push(name);
    }
    this.#slots.set(cfg.prefix, { config: cfg, client, tools: names, status: "running" });
    return names;
  }

  /** Unregister a server's tools + shut down its client. Idempotent. */
  remove(prefix: string): Promise<boolean> {
    return this.#withLock(() => this.#removeInner(prefix));
  }

  async #removeInner(prefix: string): Promise<boolean> {
    const slot = this.#slots.get(prefix);
    if (!slot) return false;
    this.#registry.unregisterPrefix(prefix);
    this.#slots.delete(prefix);
    if (slot.client) await safeShutdown(slot.client);
    return true;
  }

  /** Probe the server (`tools/list`); updates status; returns the tool count. */
  health(prefix: string): Promise<number> {
    return this.#withLock(async () => {
      const slot = this.#slots.get(prefix);
      if (!slot) throw new McpManagerError(`unknown mcp server '${prefix}'`, 404);
      if (!slot.client) throw new McpManagerError(`mcp server '${prefix}' is stopped`, 400);
      try {
        const count = await slot.client.health();
        slot.status = "running";
        return count;
      } catch (e) {
        slot.status = "unhealthy";
        throw new McpManagerError(`health probe failed for '${prefix}': ${msg(e)}`, 400);
      }
    });
  }

  /** Replace a server's config (remove + add). The prefix must already exist. */
  async replace(prefix: string, cfg: McpClientConfig): Promise<string[]> {
    if (cfg.prefix !== prefix) {
      throw new McpManagerError(`body prefix '${cfg.prefix}' does not match path '${prefix}'`, 400);
    }
    if (!this.#slots.has(prefix)) throw new McpManagerError(`unknown mcp server '${prefix}'`, 400);
    await this.remove(prefix);
    return this.add(cfg);
  }

  /** Restart using the slot's stored config; restore a Stopped slot on failure. */
  async reload(prefix: string): Promise<string[]> {
    const slot = this.#slots.get(prefix);
    if (!slot) throw new McpManagerError(`unknown mcp server '${prefix}'`, 400);
    const cfg = slot.config;
    await this.remove(prefix);
    try {
      return await this.add(cfg);
    } catch (e) {
      // Preserve the slot as Stopped so the operator can retry.
      this.#slots.set(prefix, { config: cfg, tools: [], status: "stopped" });
      throw e;
    }
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function safeShutdown(client: McpClient): Promise<void> {
  try {
    await client.shutdown();
  } catch {
    /* best-effort reap */
  }
}
