// Adapter exposing a SubAgent as a @jarvis/core Tool named `subagent.<name>`.
// The main agent invokes it like any other tool; the wrapper picks up the
// workspace root, builds a SubAgentInput, delegates, and returns the final
// message. Ported from harness-subagents/src/tool_adapter.rs.
//
// Frames emitted by the subagent reach the outer agent loop's subagent sink
// directly because the wrapper runs inside the outer loop's tool-invocation
// scope (the Node @jarvis/core agent loop will install the sink via
// `withSubagent` once that lands; until then the batch tool re-installs it for
// children and standalone unit tests scope it explicitly).
import type { JsonValue, Tool, ToolCategory } from "@jarvis/core";
import {
  activeWorkspaceOr,
  subAgentRequiresApproval,
  type SubAgent,
  type SubAgentInput,
} from "./subagent.ts";

/**
 * Wraps a SubAgent as a Tool. The tool name is `subagent.<sub.name>` so the
 * main agent's catalogue distinguishes built-in tools from delegated
 * subagents.
 */
export class SubAgentTool implements Tool {
  readonly name: string;
  readonly #sub: SubAgent;
  readonly #defaultRoot: string;

  constructor(sub: SubAgent, defaultRoot: string) {
    this.#sub = sub;
    this.#defaultRoot = defaultRoot;
    this.name = `subagent.${sub.name}`;
  }

  get description(): string {
    return this.#sub.description;
  }

  get parameters(): JsonValue {
    return this.#sub.inputSchema();
  }

  get requiresApproval(): boolean {
    return subAgentRequiresApproval(this.#sub);
  }

  get category(): ToolCategory {
    // Workspace-mutating subagents (codex, claude_code) belong to the Write
    // lane so the accept-edits / plan-mode filters apply; read-only delegates
    // land in Read.
    return subAgentRequiresApproval(this.#sub) ? "write" : "read";
  }

  async invoke(args: JsonValue): Promise<string> {
    const task = readTask(args);
    if (task === undefined) {
      throw new Error("subagent invocation missing required `task` string");
    }

    const workspaceRoot = activeWorkspaceOr(this.#defaultRoot);
    const input: SubAgentInput = {
      task,
      workspace_root: workspaceRoot,
      // v1.0 forbids recursion. Informational + a safety net for transports.
      caller_chain: [this.#sub.name],
    };
    const context = readContext(args);
    if (context !== undefined) input.context = context;

    const out = await this.#sub.invoke(input);
    return out.message;
  }
}

function readTask(args: JsonValue): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const task = (args as Record<string, JsonValue>)["task"];
  return typeof task === "string" ? task : undefined;
}

function readContext(args: JsonValue): JsonValue | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const ctx = (args as Record<string, JsonValue>)["context"];
  return ctx === undefined ? undefined : ctx;
}
