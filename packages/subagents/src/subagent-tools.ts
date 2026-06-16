// `subagentTools(registry, defaultRoot)` — fold a SubAgentRegistry into the
// `Tool[]` the composition root registers into the main agent's ToolRegistry.
// One `subagent.<name>` adapter per registered subagent, plus the
// `subagent.batch` fan-out tool. Mirrors Rust's
// `apps/jarvis/src/subagents.rs::register_as_tools` shape.
import type { Tool } from "@jarvis/core";
import { SubAgentBatchTool, DEFAULT_MAX_CONCURRENCY } from "./batch.ts";
import { SubAgentTool } from "./tool-adapter.ts";
import type { SubAgentRegistry } from "./subagent.ts";

/** Options for {@link subagentTools}. */
export interface SubagentToolsOptions {
  /**
   * Fallback workspace root used when no session workspace is pinned. Mirrors
   * the `default_root: PathBuf` Rust constructors take. Default `"."`.
   */
  defaultRoot?: string;
  /**
   * Include the `subagent.batch` fan-out tool. Default true. Set false to
   * expose only the per-subagent adapters (e.g. inside a nested context where
   * batch-of-batches is forbidden).
   */
  includeBatch?: boolean;
  /** `subagent.batch` fan-out cap. Default {@link DEFAULT_MAX_CONCURRENCY}. */
  batchMaxConcurrency?: number;
}

/**
 * Build the `subagent.<name>` tool adapters for every registered subagent,
 * plus (by default) the `subagent.batch` fan-out tool. The returned `Tool[]`
 * implements the @jarvis/core `Tool` interface; the caller registers each into
 * its ToolRegistry.
 */
export function subagentTools(registry: SubAgentRegistry, options: SubagentToolsOptions = {}): Tool[] {
  const defaultRoot = options.defaultRoot ?? ".";
  const tools: Tool[] = [];
  for (const sub of registry.iter()) {
    tools.push(new SubAgentTool(sub, defaultRoot));
  }
  const includeBatch = options.includeBatch ?? true;
  if (includeBatch && !registry.isEmpty()) {
    const cap = options.batchMaxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    tools.push(new SubAgentBatchTool(registry, defaultRoot, cap));
  }
  return tools;
}
