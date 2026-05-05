// Shared store types extracted from `appStore.ts` so individual
// slices can import them without depending on the unified store
// module. Pure type exports — no runtime values, no slice imports —
// keeps the dependency graph acyclic at the value level even as the
// slice modules import `FullState` from `appStore` at the type
// level.

import type { ApprovalSource, ConvoListRow, HitlRequest, HitlResponse } from "../types/frames";

/// Status of the conversation list panel. Drives an empty-state
/// banner the sidebar renders in place of the recent rows.
export type ConvoStatusKind = "" | "empty" | "noMatches" | "disabled";

/// One row in the workspace tasks rail. Mirrors enough of
/// `ToolBlockEntry` to render the card without re-walking the chat
/// history; `updatedAt` powers ordering and recency hints.
export interface TaskRailEntry {
  id: string;
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any;
  status: "running" | "ok" | "error" | "denied";
  startedAt: number;
  updatedAt: number;
}

/// One step in the agent's working plan. Shape mirrors
/// `harness_core::PlanItem` (snake_case wire format → camelCase note
/// is identical here since `note` matches both). The plan card
/// renders these as a checklist; each `plan_update` event replaces
/// the whole array (typed snapshot, not patch).
export interface PlanItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  note?: string | null;
}

/// One persistent project TODO. Distinct from `PlanItem` (per-turn
/// ephemeral checklist) — TODOs survive across turns and process
/// restarts. Wire shape mirrors `harness_core::TodoItem`.
export interface TodoItem {
  id: string;
  workspace: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "cancelled" | "blocked";
  priority?: "low" | "medium" | "high" | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
}

/// Provider description served by `GET /v1/providers`. The model
/// menu groups options under provider, surfaces the default model
/// first, and marks one provider as `is_default` so we can
/// pre-select on first connect.
export interface ProviderInfo {
  name: string;
  default_model: string;
  models: string[];
  is_default: boolean;
}

/// Effort levels surfaced in the model menu's right column. Names
/// match the legacy enum so `state.effort` round-trips through
/// localStorage unchanged.
export type EffortLevel = "low" | "medium" | "high" | "extra-high" | "max";

export interface UsageSnapshot {
  prompt: number;
  completion: number;
  cached: number;
  reasoning: number;
  calls: number;
}

/// Single chat-area entry the React `<MessageList>` renders. Order
/// matches insertion: history items load via `loadHistory`, live
/// items append as frames arrive. `assistant` entries carry an
/// ordered list of associated `toolCallIds` so each tool block can
/// render right under the assistant turn that triggered it.
export type UiMessage =
  | { uid: string; kind: "system"; content: string }
  | { uid: string; kind: "user"; content: string; userOrdinal: number }
  | {
      uid: string;
      kind: "assistant";
      content: string;
      reasoning: string;
      toolCallIds: string[];
      finalised: boolean;
    }
  | { uid: string; kind: "system_hint"; idShort: string };

/// One imperative tool invocation. Lives in a flat map keyed by id;
/// the `<AssistantBubble>` looks them up by the ids it owns.
///
/// `progress` accumulates streaming chunks pushed by
/// `AgentEvent::ToolProgress` (only emitted by tools that opted in,
/// e.g. `shell.exec` line-by-line). Cleared when `output` is set so
/// the final result the model saw is what the UI shows.
export interface ToolBlockEntry {
  id: string;
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any;
  status: "running" | "ok" | "error" | "denied";
  output: string | null;
  progress: string;
  /// Where the approval decision came from. Set by the
  /// `approval_decision` frame handler when the server attaches
  /// a `source` field. `null` means the tool didn't go through
  /// the approval gate (read-only tools), or the server didn't
  /// supply a source (older builds without the permission store).
  decisionSource: ApprovalSource | null;
  /// Wall-clock millis at `tool_start`. Used by `<ToolBlock>` to
  /// render an execution-duration chip alongside the result, so
  /// users can spot a slow `code.grep` / `shell.exec` without
  /// reading raw logs. Synthesised at `loadHistory` time for
  /// historical entries (no real timestamp persisted).
  startedAt: number;
  /// Wall-clock millis at `tool_end`; null while running.
  finishedAt: number | null;
}

/// Pending or resolved approval card in the right rail.
export interface ApprovalCardState {
  id: string;
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  arguments: any;
  status: "pending" | "approved" | "denied";
  reason: string | null;
}

/// Pending or resolved native HITL card in the right rail.
export interface HitlCardState {
  request: HitlRequest;
  status: "pending" | HitlResponse["status"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any;
  reason: string | null;
}

/// Composer paste-blob map. The key is a short hex token; the value
/// is the original (potentially huge) text the user pasted. The
/// composer textarea shows `[Pasted N KB] #<token>` placeholders
/// instead, and `expandPastedPlaceholders` substitutes them back at
/// submit time.
export type PastedBlobs = Record<string, string>;

export type ConversationRunStatus =
  | "idle"
  | "running"
  | "waiting_approval"
  | "waiting_hitl"
  | "completed"
  | "failed"
  | "cancelled";

export interface ConversationRuntime {
  conversationId: string;
  status: ConversationRunStatus;
  startedAt: number | null;
  updatedAt: number;
  currentTool: string | null;
  lastError: string | null;
}

export interface ConversationSurfaceSnapshot {
  messages: UiMessage[];
  emptyHintIdShort: string | null;
  toolBlocks: Record<string, ToolBlockEntry>;
  approvals: ApprovalCardState[];
  hitls: HitlCardState[];
  tasks: TaskRailEntry[];
  plan: PlanItem[];
  proposedPlan: string | null;
  // Keep this deliberately loose here to avoid tying the shared
  // store-types module to the SubAgent component graph.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subAgentRuns: Record<string, any>;
}

/// Local re-export so callers can import `ConvoListRow` from the
/// store namespace if they prefer.
export type { ConvoListRow };
