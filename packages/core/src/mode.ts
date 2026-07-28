// Mode-signal channel. Sibling to plan.ts / progress.ts / hitl.ts.
//
// Per-invocation sink scoped via `withModeSignal`, implemented with
// AsyncLocalStorage in place of Rust's tokio task_local. A tool (in practice
// `enter_plan_mode`) calls `emitModeSignal(mode)` to ask the session to switch
// permission mode; the agent loop relays it as `AgentEvent.mode_changed` and
// the transport applies it to its own mode handle. Outside a scope the sink is
// absent so emits are no-ops, keeping tool unit tests trivial.
//
// The switch takes effect on the NEXT request build, not mid-batch: the tool
// filter is resolved once per iteration in `Agent.buildRequest`, so a mode
// emitted from inside a tool call is honoured from the following iteration on.
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The harness's permission-mode vocabulary. Owned by core because
 * {@link ToolCategory} filtering ("plan") and the approval gate's fall-through
 * decision are both core concerns; `@jarvis/server` aliases this as
 * `PermissionMode` for its rule engine + REST surface so the two can't drift.
 */
export type AgentMode = "ask" | "accept-edits" | "plan" | "auto" | "bypass";

export const AGENT_MODES: readonly AgentMode[] = [
  "ask",
  "accept-edits",
  "plan",
  "auto",
  "bypass",
];

export function isAgentMode(v: unknown): v is AgentMode {
  return typeof v === "string" && (AGENT_MODES as readonly string[]).includes(v);
}

const store = new AsyncLocalStorage<(mode: AgentMode) => void>();

/** Request a session mode switch. No-op outside a `withModeSignal` scope. */
export function emitModeSignal(mode: AgentMode): void {
  store.getStore()?.(mode);
}

/** Whether a mode sink is installed for the current async context. */
export function modeSignalActive(): boolean {
  return store.getStore() !== undefined;
}

/** Run `fn` with `sink` installed as the active mode sink. */
export function withModeSignal<T>(sink: (mode: AgentMode) => void, fn: () => Promise<T>): Promise<T> {
  return store.run(sink, fn);
}

/**
 * The canonical Plan Mode tool filter: only `read` tools reach the model.
 * `exit_plan` / `enter_plan_mode` declare `category: "read"` precisely so they
 * survive it. Exported so every transport applies the same rule rather than
 * hand-rolling the predicate.
 */
export function planModeToolFilter(category: string): boolean {
  return category === "read";
}
