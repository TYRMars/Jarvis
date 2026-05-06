// Type-safe wire shapes for the WS protocol used by the frontend.
//
// Mirrors the server-side `AgentEvent` enum (server-to-client) and
// the `WsClientMessage` enum (client-to-server). Kept in one file
// so a backend rename surfaces as a typed compile error rather than
// a silent runtime miss.

export interface UsageFrame {
  type: "usage";
  model?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_prompt_tokens?: number;
  reasoning_tokens?: number;
}

export interface DeltaFrame {
  type: "delta";
  content: string;
}

export interface AssistantMessageFrame {
  type: "assistant_message";
  message: AssistantMessage;
  finish_reason?: string;
}

export interface ToolStartFrame {
  type: "tool_start";
  id: string;
  name: string;
  arguments: any;
}

export interface ToolEndFrame {
  type: "tool_end";
  id: string;
  name: string;
  content: string;
}

export interface ApprovalRequestFrame {
  type: "approval_request";
  id: string;
  name: string;
  arguments: any;
}

/// Where the approval decision came from. Matches
/// `harness_core::permission::HitSource`. The `kind` discriminator
/// drives the per-variant fields:
///   - "rule"          → scope, bucket, index of the matched rule
///   - "mode_default"  → the active mode that supplied the default
///   - "user_prompt"   → the user clicked Approve / Deny
export type ApprovalSource =
  | { kind: "rule"; scope: "user" | "project" | "session"; bucket: "deny" | "ask" | "allow"; index: number }
  | { kind: "mode_default"; mode: "ask" | "accept-edits" | "plan" | "auto" | "bypass" }
  | { kind: "user_prompt" };

export interface ApprovalDecisionFrame {
  type: "approval_decision";
  id: string;
  name: string;
  decision: { decision: "approve" | "deny"; reason?: string };
  /// Optional. Older servers (or builds without the permission
  /// store wired up) omit it; new servers always set it. The UI
  /// uses this to render "auto-approved by user-scope rule" chips
  /// rather than implying every approval was a user click.
  source?: ApprovalSource;
}

export interface HitlOption {
  value: string;
  label: string;
}

export interface HitlRequest {
  id: string;
  transport?: "text" | "voice" | "video";
  kind: "confirm" | "input" | "choice" | "review";
  title: string;
  body?: string | null;
  options?: HitlOption[];
  default_value?: any;
  response_schema?: any;
  metadata?: any;
}

export interface HitlResponse {
  request_id: string;
  status: "approved" | "denied" | "submitted" | "cancelled" | "expired";
  payload?: any;
  reason?: string | null;
}

export interface HitlRequestFrame {
  type: "hitl_request";
  request: HitlRequest;
}

export interface HitlResponseFrame {
  type: "hitl_response";
  response: HitlResponse;
}

export interface DoneFrame {
  type: "done";
  outcome?: any;
  conversation?: any;
}

export interface ErrorFrame {
  type: "error";
  message: string;
}

export interface StartedFrame {
  type: "started";
  id: string;
}

export interface ResumedFrame {
  type: "resumed";
  id: string;
  message_count?: number;
  /// Server already sends these on resume (`routes.rs:1535-1544`);
  /// the web client now rehydrates `draftProjectId` /
  /// `draftWorkspacePath` from them so the in-session execution
  /// shoulder can find the bound Requirement without a round-trip
  /// to `GET /v1/conversations/:id`.
  project_id?: string | null;
  workspace_path?: string | null;
  workspace?: any;
}

export interface ConfiguredFrame {
  type: "configured";
}

export interface ResetFrame {
  type: "reset";
}

export interface InterruptedFrame {
  type: "interrupted";
}

export interface ForkedFrame {
  type: "forked";
  user_ordinal: number;
}

export type ServerFrame =
  | UsageFrame
  | DeltaFrame
  | AssistantMessageFrame
  | ToolStartFrame
  | ToolEndFrame
  | ApprovalRequestFrame
  | ApprovalDecisionFrame
  | HitlRequestFrame
  | HitlResponseFrame
  | DoneFrame
  | ErrorFrame
  | StartedFrame
  | ResumedFrame
  | ConfiguredFrame
  | ResetFrame
  | InterruptedFrame
  | ForkedFrame;

// ---------- Client-to-server frames ----------

export interface UserClientFrame {
  type: "user";
  content: string;
  model?: string;
  provider?: string;
  soul_prompt?: string;
}

export interface ResetClientFrame { type: "reset"; }

export interface ResumeClientFrame {
  type: "resume";
  id: string;
  model?: string;
  provider?: string;
}

export interface NewClientFrame {
  type: "new";
  id?: string;
  model?: string;
  provider?: string;
  project_id?: string;
  workspace_path?: string;
}

export interface ConfigureClientFrame {
  type: "configure";
  model?: string;
  provider?: string;
}

export interface ApproveClientFrame { type: "approve"; tool_call_id: string; }
export interface DenyClientFrame { type: "deny"; tool_call_id: string; reason?: string | null; }
export interface HitlResponseClientFrame {
  type: "hitl_response";
  request_id: string;
  status: "approved" | "denied" | "submitted" | "cancelled" | "expired";
  payload?: any;
  reason?: string | null;
}
export interface InterruptClientFrame { type: "interrupt"; }
export interface ForkClientFrame {
  type: "fork";
  user_ordinal: number;
  content: string;
  model?: string;
  provider?: string;
  soul_prompt?: string;
}

export type ClientFrame =
  | UserClientFrame
  | ResetClientFrame
  | ResumeClientFrame
  | NewClientFrame
  | ConfigureClientFrame
  | ApproveClientFrame
  | DenyClientFrame
  | HitlResponseClientFrame
  | InterruptClientFrame
  | ForkClientFrame;

// ---------- Message shapes (mirror harness-core) ----------

export interface ToolCall {
  id: string;
  name: string;
  arguments: any;
}

export interface SystemMessage { role: "system"; content: string; cache?: "ephemeral" | "persistent"; }
export interface UserMessage { role: "user"; content: string; }
export interface AssistantMessage {
  role: "assistant";
  content?: string;
  tool_calls?: ToolCall[];
  reasoning_content?: string;
}
export interface ToolMessage { role: "tool"; tool_call_id: string; content: string; }

export type AnyMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

// ---------- REST shapes ----------

export interface ConvoListRow {
  id: string;
  title?: string | null;
  message_count: number;
  created_at?: string | null;
  updated_at?: string | null;
  /// Stable id of the project this conversation is bound to, when
  /// the server has projects configured. Free-chat conversations omit
  /// this field. Resolve to a name by looking up `appStore.projectsById`.
  project_id?: string | null;
  /// Workspace root bound to this conversation, when known. Older
  /// servers omit this; clients can fall back to the bound project's
  /// first workspace.
  workspace_path?: string | null;
}

export interface ConvoDetail {
  id: string;
  messages: AnyMessage[];
  project_id?: string | null;
  workspace_path?: string | null;
}

/// One workspace folder a [`Project`] knows about. Mirrors
/// `harness_core::ProjectWorkspace`. The `path` is canonicalised
/// server-side on insert; clients should treat it as read-only.
export interface ProjectWorkspace {
  path: string;
  name?: string | null;
}

/// Wire shape returned by `GET /v1/projects` (and the create / get /
/// update endpoints). Mirrors `harness_core::Project` field-for-field
/// plus the optional `conversation_count` only the list endpoint
/// supplies.
export interface Project {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  instructions: string;
  tags: string[];
  /// Optional for back-compat with servers that pre-date the field.
  /// Clients should treat `undefined` and `[]` as equivalent.
  workspaces?: ProjectWorkspace[];
  archived: boolean;
  /// Custom kanban columns. `null` / absent means "use the four
  /// built-in defaults" — see `defaultBoardColumns` in
  /// `Projects/columns.tsx`. When present, the saved labels are
  /// rendered verbatim (no i18n lookup).
  columns?: KanbanColumn[] | null;
  created_at: string;
  updated_at: string;
  conversation_count?: number;
}

/// One user-configurable column on a project's kanban. Mirrors
/// `harness_core::KanbanColumn`.
export interface KanbanColumn {
  /// Stable id; what `Requirement.status` references.
  id: string;
  /// Display label, free-form, language-of-the-user.
  label: string;
  /// Optional kind hint that drives the icon. One of
  /// `"backlog" | "in_progress" | "review" | "done"`. Custom columns
  /// omit this and get a neutral dot.
  kind?: "backlog" | "in_progress" | "review" | "done" | null;
}

/// The four built-in column ids — useful when callers want to hint at
/// "one of the default lanes" specifically (e.g. the home grid count
/// chips). `RequirementStatus` itself is just `string` since custom
/// columns can use any id matching the project's `columns[i].id`.
export type BuiltinStatus = "backlog" | "in_progress" | "review" | "done";
export type RequirementStatus = string;

/// v1.0 — triage gate. Distinguishes user-approved work (default,
/// also the absent-on-wire shape) from agent-proposed / scan-
/// surfaced candidates that are waiting for human approval. Auto
/// executor only consumes `approved`.
export type TriageState = "approved" | "proposed_by_agent" | "proposed_by_scan";

export interface Requirement {
  id: string;
  project_id: string;
  title: string;
  description?: string | null;
  status: RequirementStatus;
  conversation_ids: string[];
  /** Phase 3.6: optional `AgentProfile.id` this requirement is
   *  assigned to. `null` / absent ⇒ "anyone / use server default". */
  assignee_id?: string | null;
  /** v1.0 — defaults to `"approved"` when absent (server omits the
   *  field via skip_serializing_if for back-compat). */
  triage_state?: TriageState;
  /** v1.0 — other requirement ids that must reach `done` before
   *  the auto executor will pick this one up. Empty / absent = no
   *  dependencies. */
  depends_on?: string[];
  /** Optional pinned VerificationPlan that auto mode (and the manual
   *  "Run verification" form) executes after each RequirementRun.
   *  Server-side type: `Option<VerificationPlan>`. */
  verification_plan?: VerificationPlan | null;
  /** Structured per-requirement checklist / execution items. These
   *  are distinct from the workspace-wide TODO rail: they travel with
   *  the requirement and can represent CI/CD commands, manual review
   *  gates, or workflow steps. */
  todos?: RequirementTodo[];
  created_at: string;
  updated_at: string;
}

export type RequirementTodoKind =
  | "work"
  | "check"
  | "ci"
  | "deploy"
  | "review"
  | "manual";

export type RequirementTodoStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "skipped"
  | "blocked";

export interface RequirementTodoEvidence {
  run_id?: string | null;
  exit_code?: number | null;
  stdout_excerpt?: string | null;
  stderr_excerpt?: string | null;
  artifact_url?: string | null;
  note?: string | null;
}

export interface RequirementTodo {
  id: string;
  title: string;
  kind: RequirementTodoKind;
  status: RequirementTodoStatus;
  command?: string | null;
  evidence?: RequirementTodoEvidence | null;
  depends_on?: string[];
  created_by: "human" | "agent" | "workflow";
  created_at: string;
  updated_at: string;
}

/// Mirrors `harness_core::VerificationPlan`. Pinned on a Requirement
/// so the auto-mode loop and the detail-panel manual form share one
/// source of truth for what success looks like.
export interface VerificationPlan {
  /// Shell-style commands to run after the agent finishes.
  commands: string[];
  /// When true, a successful command run still parks the run in
  /// `Review` instead of flipping to `Done` — used for changes that
  /// need a human eyeball before merge.
  require_human_review?: boolean;
}

// ----------------- AgentProfile types ------------------------------

/// Named agent identity. Mirrors `harness_core::AgentProfile`.
export interface AgentProfile {
  id: string;
  name: string;
  avatar?: string | null;
  provider: string;
  model: string;
  system_prompt?: string | null;
  default_workspace?: string | null;
  allowed_tools?: string[];
  created_at: string;
  updated_at: string;
}

// ----------------- RequirementRun types ----------------------------

/// Lifecycle of a per-requirement execution run. Matches the wire
/// form of `harness_core::RequirementRunStatus`.
export type RequirementRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/// Aggregate verification outcome (matches
/// `harness_core::VerificationStatus` wire form).
export type VerificationStatus =
  | "passed"
  | "failed"
  | "needs_review"
  | "skipped";

export interface CommandResult {
  command: string;
  exit_code?: number | null;
  stdout?: string;
  stderr?: string;
  duration_ms: number;
}

export interface VerificationResult {
  status: VerificationStatus;
  command_results?: CommandResult[];
  diff_summary?: string | null;
  notes?: string | null;
}

export type RequirementRunLogLevel = "info" | "warn" | "error" | "success";

export interface RequirementRunLog {
  id: string;
  level: RequirementRunLogLevel;
  message: string;
  data?: Record<string, unknown> | null;
  created_at: string;
}

/// One execution attempt against a Requirement. Mirrors
/// `harness_core::RequirementRun`.
export interface RequirementRun {
  id: string;
  requirement_id: string;
  conversation_id: string;
  status: RequirementRunStatus;
  summary?: string | null;
  error?: string | null;
  verification?: VerificationResult | null;
  logs?: RequirementRunLog[];
  /** Phase 5 — absolute path to the per-run git worktree, when
   *  the server's `JARVIS_WORKTREE_MODE=per_run` is on and the
   *  workspace was a clean git repo at start time. `null` /
   *  absent ⇒ the run uses the main checkout. */
  worktree_path?: string | null;
  started_at: string;
  finished_at?: string | null;
}

// ----------------- Activity timeline types -------------------------

/// What happened. Wire form mirrors `harness_core::ActivityKind`.
export type ActivityKind =
  | "status_change"
  | "run_started"
  | "run_finished"
  | "verification_finished"
  | "assignee_change"
  | "comment"
  | "blocked"
  | "unblocked";

/// Who triggered an activity. Externally-tagged enum on the wire
/// (matches `harness_core::ActivityActor`).
export type ActivityActor =
  | { type: "human" }
  | { type: "agent"; profile_id: string }
  | { type: "system" };

/// One audit-timeline row. `body` shape varies by `kind`; see
/// `harness-core/src/activity.rs` for the canonical per-kind
/// payload.
export interface Activity {
  id: string;
  requirement_id: string;
  kind: ActivityKind;
  actor: ActivityActor;
  body: Record<string, unknown>;
  created_at: string;
}

// ----------------- Doc workspace types -----------------------------

export type DocKind = "note" | "research" | "report" | "design" | "guide";

export interface DocProject {
  id: string;
  workspace: string;
  title: string;
  kind: DocKind;
  created_at: string;
  updated_at: string;
  /** Free-form labels. New since the three-pane redesign — old wire
   *  payloads may omit this; readers should default to []. */
  tags?: string[];
  /** Soft "favourite" flag. Defaults to false on legacy payloads. */
  pinned?: boolean;
  /** Soft delete flag. Defaults to false on legacy payloads. */
  archived?: boolean;
}

export interface DocDraft {
  id: string;
  project_id: string;
  format: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";
