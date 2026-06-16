// SubAgent surface + event channel. Ported from harness-subagents/src/lib.rs
// (the trait + registry + input/output/artifact types) and
// harness-core/src/subagent.rs (the SubAgentFrame / SubAgentEvent stream types
// + the task-local `with_subagent` channel) and harness-core/src/workspace.rs
// (the `active_workspace` session-workspace seam).
//
// Why the channel + workspace helpers live HERE and not in @jarvis/core: the
// Rust crate *re-exports* them from core, but the Node @jarvis/core port has
// not yet landed `subagent.rs` / `workspace.rs`. To keep this package
// self-contained we define them locally (mirroring the Rust wire shapes
// exactly) and re-export so a later @jarvis/core port can adopt them verbatim.
//
// The wire model mirrors `progress.ts` in @jarvis/core: a tool installs a
// sink in an AsyncLocalStorage (Rust's `tokio::task_local`) before invoking
// the subagent body via `withSubagent`, the subagent emits via `emitSubagent`,
// and the agent loop drains the listener and forwards each frame as
// `AgentEvent::SubAgentEvent`. Outside a scope, emits are no-ops.
import { AsyncLocalStorage } from "node:async_hooks";
import type { JsonValue } from "@jarvis/core";
import type { Usage } from "@jarvis/core";

// ---------------------------------------------------------------------------
// SubAgent input / output / artifacts (harness-subagents/src/lib.rs)
// ---------------------------------------------------------------------------

/** What the main agent hands a subagent when it invokes it. */
export interface SubAgentInput {
  /** Free-form natural-language task. The subagent interprets it. */
  task: string;
  /**
   * Sandbox root the subagent may read / write within. Mirrors the main
   * agent's workspace root. Subagents should refuse paths outside it.
   */
  workspace_root: string;
  /** Optional structured context — verification_plan, run id, etc. */
  context?: JsonValue;
  /**
   * Recursion guard: every nested subagent invocation appends its id. v1.0
   * forbids depth >= 1 from registering further `subagent.*` tools, but the
   * chain travels with frames so the UI can draw nesting later. Absent when
   * empty (matches serde `skip_serializing_if = "Vec::is_empty"`).
   */
  caller_chain?: string[];
}

/**
 * A typed product a subagent can attach to its output. Discriminated on
 * `kind` (serde `tag = "kind", rename_all = "snake_case"`). Renderers treat
 * unknown variants as "ignore" for forward-compat.
 */
export type Artifact =
  | { kind: "files_changed"; paths: string[] }
  | { kind: "review_verdict"; pass: boolean; commentary: string; evidence: string[] }
  | { kind: "doc_summary"; summary: string; quotes: string[] };

/**
 * What a subagent returns when it finishes. `message` is the textual output
 * the main agent sees (matching the `Done.final_message` frame); `artifacts`
 * are optional structured products. Absent when empty (serde skip).
 */
export interface SubAgentOutput {
  message: string;
  artifacts?: Artifact[];
}

/**
 * A delegated agent the main Agent may invoke through a `subagent.<name>`
 * tool. The Node analogue of Rust's `#[async_trait] trait SubAgent`.
 */
export interface SubAgent {
  /** Registry key. Becomes the `subagent.<name>` tool name. */
  readonly name: string;
  /** One-line description shown to the main agent in the tool spec. */
  readonly description: string;
  /** JSON schema for the tool input (object-shaped). */
  inputSchema(): JsonValue;
  /**
   * Whether the wrapping `subagent.<name>` tool is approval-gated. Subagents
   * that mutate the workspace (claude_code / codex) must return true;
   * read-only subagents (read_doc / review) return false. Default false.
   */
  requiresApproval?(): boolean;
  /**
   * Run the subagent. Implementations emit `started` early, stream
   * `delta` / `tool_start` / `tool_end` / `status` frames, and exactly one
   * `done` or `error` at the end. The harness wraps the call in a
   * `withSubagent(...)` scope so `emitSubagent` reaches the main loop.
   */
  invoke(input: SubAgentInput): Promise<SubAgentOutput>;
}

/** Read a subagent's approval gate, applying the trait's `false` default. */
export function subAgentRequiresApproval(sub: SubAgent): boolean {
  return sub.requiresApproval ? sub.requiresApproval() : false;
}

// ---------------------------------------------------------------------------
// Registry (harness-subagents/src/lib.rs::SubAgentRegistry)
// ---------------------------------------------------------------------------

/**
 * Registry of available subagents. Held by the composition root; the
 * `subagentTools` helper folds each subagent into a `Tool[]`.
 *
 * Last-write-wins on `name`: a later `register` with the same name replaces
 * the prior entry, so the composition root is the single source of truth
 * (collisions are intentional overrides, not silent bugs).
 */
export class SubAgentRegistry {
  // Insertion order preserved; `register` removes any prior same-named entry
  // before pushing, so iteration order reflects last registration.
  #entries: SubAgent[] = [];

  register(sub: SubAgent): this {
    this.#entries = this.#entries.filter((s) => s.name !== sub.name);
    this.#entries.push(sub);
    return this;
  }

  /** All registered subagents, ordered by (latest) insertion. */
  iter(): readonly SubAgent[] {
    return this.#entries;
  }

  /** Look up by name; the most-recently registered entry wins. */
  get(name: string): SubAgent | undefined {
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      const s = this.#entries[i];
      if (s && s.name === name) return s;
    }
    return undefined;
  }

  isEmpty(): boolean {
    return this.#entries.length === 0;
  }

  get length(): number {
    return this.#entries.length;
  }
}

// ---------------------------------------------------------------------------
// Event channel (harness-core/src/subagent.rs)
// ---------------------------------------------------------------------------

/**
 * One frame in a subagent's execution stream. `subagent_id` is a
 * per-invocation uuid (assigned when `invoke` starts) so the UI can correlate
 * frames from concurrent subagents on the same conversation.
 */
export interface SubAgentFrame {
  subagent_id: string;
  subagent_name: string;
  event: SubAgentEvent;
}

/**
 * A point-in-time event in a subagent's run. Discriminated on `kind` (serde
 * `tag = "kind", rename_all = "snake_case"`). `model` on `started` is absent
 * when unknown (serde `skip_serializing_if = "Option::is_none"`); `usage`
 * fields are flattened onto the `usage` variant.
 */
export type SubAgentEvent =
  | { kind: "started"; task: string; model?: string }
  | { kind: "delta"; text: string }
  | { kind: "tool_start"; name: string; arguments: JsonValue }
  | { kind: "tool_end"; name: string; output: string }
  | ({ kind: "usage"; model: string } & Usage)
  | { kind: "status"; message: string }
  | { kind: "done"; final_message: string }
  | { kind: "error"; message: string };

/** A sink that receives emitted subagent frames. */
export type SubAgentSink = (frame: SubAgentFrame) => void;

const channel = new AsyncLocalStorage<SubAgentSink>();

/** Publish a frame. No-op outside a `withSubagent` scope (unit-test path). */
export function emitSubagent(frame: SubAgentFrame): void {
  channel.getStore()?.(frame);
}

/** Whether a subagent sink is installed for the current async context. */
export function subagentActive(): boolean {
  return channel.getStore() !== undefined;
}

/**
 * The currently-installed sink, if any. Used by the parallel-batch tool so
 * each spawned child can re-enter a fresh `withSubagent` scope and forward
 * frames into the same outer transport. `undefined` outside a scope.
 */
export function activeSender(): SubAgentSink | undefined {
  return channel.getStore();
}

/** Run `fn` with `sink` installed as the active subagent sink. */
export function withSubagent<T>(sink: SubAgentSink, fn: () => Promise<T>): Promise<T> {
  return channel.run(sink, fn);
}

// ---------------------------------------------------------------------------
// Session-workspace seam (harness-core/src/workspace.rs)
// ---------------------------------------------------------------------------
//
// The Rust `active_workspace_or` reads a task-local pinned by the agent loop's
// `with_session_workspace`. The Node @jarvis/core port has not landed this
// yet, so we provide a local AsyncLocalStorage seam. The batch + tool-adapter
// fall back to a construction-time `default_root` when no scope is active —
// identical to Rust's `active_workspace_or(default)`.

const workspace = new AsyncLocalStorage<string>();

/** The active session workspace, or `undefined` outside a scope. */
export function activeWorkspace(): string | undefined {
  return workspace.getStore();
}

/** The active session workspace, or `fallback` when none is pinned. */
export function activeWorkspaceOr(fallback: string): string {
  return workspace.getStore() ?? fallback;
}

/** Run `fn` with `root` pinned as the active session workspace. */
export function withSessionWorkspace<T>(root: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (root === undefined) return fn();
  return workspace.run(root, fn);
}
