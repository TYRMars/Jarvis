// tools.ts — assemble the agent's ToolRegistry from a JarvisConfig + stores.
//
// Mirrors the Rust composition root's tool wiring (apps/jarvis/src/serve.rs):
//   1. `registerBuiltins(reg, builtinsConfig)` — read primitives always on,
//      write/exec gated by the config flags, `fs.*` rooted at `fsRoot`, the
//      `http.fetch` byte cap + `shell.exec` timeout threaded through.
//   2. Conditionally register the store-backed families: `requirement.*` (when
//      both the requirement + activity stores exist), `doc.*` (DocStore), and
//      `learning.memory.*` (the @jarvis/learning MemoryStore). `registerBuiltins`
//      itself does this conditional registration when the stores are passed in
//      its config, so we just forward the handles.
//   3. `subagent.<name>` adapters from a SubAgentRegistry (built here with the
//      internal `review` + `read_doc` subagents) plus `subagent.batch`.
//   4. External MCP servers from `JARVIS_MCP_SERVERS` (`connectAllMcp`), each
//      renamed `<prefix>.<tool>`. The returned clients are handed back so the
//      caller keeps them alive for the process lifetime.
//
// Deferred (documented): the `memory.*` markdown surface, `channel.send`,
// `roadmap.import`, `codex.run` / `claude_code.run` CLI sidecars, and the
// `enter_plan_mode` coding-mode default — none are on the @jarvis/tools surface
// or needed for the P1 server boot.
import { ToolRegistry, type LlmProvider } from "@jarvis/core";
import { registerBuiltins, type BuiltinsConfig } from "@jarvis/tools";
import { mcpClientConfig, type McpClient } from "@jarvis/mcp";
import { McpManager } from "@jarvis/server";
import {
  InternalSubAgent,
  SubAgentRegistry,
  subagentTools,
  reviewer,
  docReader,
  type CreateAgent,
} from "@jarvis/subagents";

import type { JarvisConfig } from "./config.ts";
import type { ToolStores } from "./state.ts";

/** Result of {@link buildToolRegistry}: the registry + live MCP clients. */
export interface ToolRegistryBundle {
  registry: ToolRegistry;
  /** Connected MCP clients — keep alive; call `.close()` on shutdown. */
  mcpClients: McpClient[];
  /** Manages the MCP servers (list/add/remove/health/reload) over the registry. */
  mcpManager: McpManager;
  /** The subagent registry the adapters were built from (shared into AppState). */
  subagents: SubAgentRegistry;
}

/** Dependency seam: how to build a fresh inner agent for an internal subagent. */
export interface BuildToolsDeps {
  /**
   * Factory the internal subagents (`review` / `read_doc`) use to spin up a
   * per-call inner agent loop. Supplied by `state.ts` (which owns provider +
   * tool + config construction). When absent, no internal subagents are
   * registered — the `subagent.*` tools simply won't appear.
   */
  createAgent?: CreateAgent;
}

/**
 * Build the agent's tool registry. `stores` carries the optional domain stores
 * that gate the store-backed tool families; `deps.createAgent` (when present)
 * lets the internal subagents spin up inner loops.
 */
export async function buildToolRegistry(
  config: JarvisConfig,
  stores: ToolStores,
  deps: BuildToolsDeps = {},
): Promise<ToolRegistryBundle> {
  const registry = new ToolRegistry();

  const builtins: BuiltinsConfig = {
    fsRoot: config.fsRoot,
    httpMaxBytes: config.gating.httpMaxBytes,
    httpBlockPrivateHosts: !config.gating.httpAllowPrivate,
    enableFsWrite: config.gating.enableFsWrite,
    enableFsEdit: config.gating.enableFsEdit,
    enableFsPatch: config.gating.enableFsPatch,
    enableShellExec: config.gating.enableShellExec,
    shellDefaultTimeoutMs: config.gating.shellTimeoutMs,
    enableGitRead: config.gating.enableGitRead,
    // Coding mode defaults `enter_plan_mode` on so the model can volunteer a
    // plan-first round before risky edits (mirrors the Rust default).
    enableEnterPlanMode: codingMode(config),
  };
  // Store-backed families register conditionally inside registerBuiltins when
  // their handles are present (mirrors the Rust "registered when their stores
  // are present" rule).
  if (stores.requirements !== undefined) builtins.requirements = stores.requirements;
  if (stores.activities !== undefined) builtins.activities = stores.activities;
  if (stores.projects !== undefined) builtins.projects = stores.projects;
  if (stores.docs !== undefined) builtins.docs = stores.docs;
  if (stores.learningMemory !== undefined) builtins.learningMemory = stores.learningMemory;

  registerBuiltins(registry, builtins);

  // Built-in subagents + their `subagent.<name>` tool adapters. Only wired when
  // a createAgent factory is available (the inner loop needs a provider/tools).
  const subagents = new SubAgentRegistry();
  if (deps.createAgent !== undefined) {
    subagents.register(reviewer.build(deps.createAgent, config.model));
    subagents.register(docReader.build(deps.createAgent, config.model));
    for (const tool of subagentTools(subagents, { defaultRoot: config.fsRoot })) {
      registry.register(tool);
    }
  }

  // External MCP servers from JARVIS_MCP_SERVERS. Routed through the McpManager
  // so they're listable / reloadable at runtime via /v1/mcp/servers; `add`
  // connects + registers each server's tools into the shared registry. A bad
  // config fails the boot, same as the prior connectAllMcp.
  const mcpManager = new McpManager(registry);
  for (const s of config.mcpServers) {
    await mcpManager.add(mcpClientConfig(s.prefix, s.command, s.args));
  }

  return { registry, mcpClients: mcpManager.clients(), mcpManager, subagents };
}

/** Coding mode = any write/exec primitive enabled (mirrors the Rust switch). */
export function codingMode(config: JarvisConfig): boolean {
  const g = config.gating;
  return g.enableFsWrite || g.enableFsEdit || g.enableFsPatch || g.enableShellExec;
}

export { InternalSubAgent };
