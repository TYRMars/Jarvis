// Type-safe wire shapes for the WS protocol used by the frontend.
//
// Mirrors the server-side `AgentEvent` enum (server-to-client) and
// the `WsClientMessage` enum (client-to-server). Kept in one file
// so a backend rename surfaces as a typed compile error rather than
// a silent runtime miss.

export interface UsageFrame {
  type: "usage";
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
}

export interface ConvoDetail {
  id: string;
  messages: AnyMessage[];
  project_id?: string | null;
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
  archived: boolean;
  created_at: string;
  updated_at: string;
  conversation_count?: number;
}

export type RequirementStatus = "backlog" | "in_progress" | "review" | "done";

export interface Requirement {
  id: string;
  project_id: string;
  title: string;
  description?: string | null;
  status: RequirementStatus;
  conversation_ids: string[];
  /// Optional `AgentProfile.id` this requirement is assigned to.
  /// `null` / absent means "no specific assignee" — runs use the
  /// global default provider/model.
  assignee_id?: string | null;
  created_at: string;
  updated_at: string;
}

// ----------------- AgentProfile -----------------------------------

/// Server-global named agent identity. See
/// `crates/harness-core/src/agent_profile.rs` for the wire shape.
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
