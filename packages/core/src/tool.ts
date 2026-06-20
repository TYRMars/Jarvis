// Tool surface + registry. Ported from harness-core/src/tool.rs.
//
// Optional behaviour flags (`requiresApproval`, `category`, …) are expressed
// as optional members read through the `tool*` helpers below, which apply the
// same defaults as the Rust trait's default methods. Names are namespaced
// (`<group>.<verb>`); same-named registration silently overwrites.
import type { JsonValue } from "./json.ts";

/**
 * Side-effect category. Drives Plan Mode filtering (only `read` tools reach
 * the model in plan mode) and concurrency/destructiveness defaults.
 */
export type ToolCategory = "read" | "write" | "exec" | "network";

export interface Tool {
  readonly name: string;
  readonly description: string;
  /** JSON schema for the `arguments` object passed to `invoke` (object-shaped). */
  readonly parameters: JsonValue;
  invoke(args: JsonValue): Promise<string>;

  /** Gate this tool behind a configured Approver. Default: false. */
  readonly requiresApproval?: boolean;
  /** Side-effect category. Default: "write" (conservative). */
  readonly category?: ToolCategory;
  /** Hint that the tool spec belongs in a cached prefix. Default: false. */
  readonly cacheable?: boolean;
  /** Call ends the turn even if more tool calls were emitted. Default: false. */
  readonly isTerminal?: boolean;
  /** Override concurrency-safety (default: true for `read`, else false). */
  isConcurrencySafe?(): boolean;
  /** Override destructiveness (default: true for `write`/`exec`). */
  isDestructive?(): boolean;
}

/** Provider-agnostic tool description serialised into a `tools` array. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonValue;
  cacheable?: boolean;
}

export function toolCategory(t: Tool): ToolCategory {
  return t.category ?? "write";
}

export function toolRequiresApproval(t: Tool): boolean {
  return t.requiresApproval ?? false;
}

export function toolIsConcurrencySafe(t: Tool): boolean {
  if (t.isConcurrencySafe) return t.isConcurrencySafe();
  return toolCategory(t) === "read";
}

export function toolIsDestructive(t: Tool): boolean {
  if (t.isDestructive) return t.isDestructive();
  const c = toolCategory(t);
  return c === "write" || c === "exec";
}

function toolSpec(t: Tool): ToolSpec {
  const spec: ToolSpec = { name: t.name, description: t.description, parameters: t.parameters };
  if (t.cacheable) spec.cacheable = true;
  return spec;
}

/**
 * A thin `Map<string, Tool>`. `register` keys by `tool.name`, so same-named
 * tools silently overwrite. Muted tools stay registered but vanish from
 * `specs()` and `resolve()` so the model can't see or call them.
 */
export class ToolRegistry {
  #tools = new Map<string, Tool>();
  #muted = new Set<string>();

  register(tool: Tool): this {
    this.#tools.set(tool.name, tool);
    return this;
  }

  resolve(name: string): Tool | undefined {
    if (this.#muted.has(name)) return undefined;
    return this.#tools.get(name);
  }

  has(name: string): boolean {
    return this.#tools.has(name) && !this.#muted.has(name);
  }

  mute(name: string): this {
    this.#muted.add(name);
    return this;
  }

  unmute(name: string): this {
    this.#muted.delete(name);
    return this;
  }

  /** Non-muted tool names. */
  names(): string[] {
    return [...this.#tools.keys()].filter((n) => !this.#muted.has(n));
  }

  /** Every registered name, INCLUDING muted ones (the catalog view). */
  allNames(): string[] {
    return [...this.#tools.keys()];
  }

  /** Registered (ignores mute) — distinct from {@link has}, the 404 check. */
  contains(name: string): boolean {
    return this.#tools.has(name);
  }

  /** Resolve a tool by name INCLUDING muted ones (catalog metadata). */
  resolveUnchecked(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  /** Whether a tool is currently muted. */
  isMuted(name: string): boolean {
    return this.#muted.has(name);
  }

  /** Count of muted tools (for `PATCH /v1/tools/:name`'s `muted_count`). */
  mutedCount(): number {
    return this.#muted.size;
  }

  /** Specs for every non-muted tool (the LLM-visible catalogue). */
  specs(): ToolSpec[] {
    return this.specsFiltered(() => true);
  }

  specsFiltered(predicate: (tool: Tool) => boolean): ToolSpec[] {
    const out: ToolSpec[] = [];
    for (const [name, tool] of this.#tools) {
      if (this.#muted.has(name)) continue;
      if (!predicate(tool)) continue;
      out.push(toolSpec(tool));
    }
    return out;
  }
}
