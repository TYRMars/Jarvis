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

export interface ApprovalDecisionFrame {
  type: "approval_decision";
  id: string;
  name: string;
  decision: { decision: "approve" | "deny"; reason?: string };
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
}

export interface ConfigureClientFrame {
  type: "configure";
  model?: string;
  provider?: string;
}

export interface ApproveClientFrame { type: "approve"; tool_call_id: string; }
export interface DenyClientFrame { type: "deny"; tool_call_id: string; reason?: string | null; }
export interface InterruptClientFrame { type: "interrupt"; }
export interface ForkClientFrame {
  type: "fork";
  user_ordinal: number;
  content: string;
  model?: string;
  provider?: string;
}

export type ClientFrame =
  | UserClientFrame
  | ResetClientFrame
  | ResumeClientFrame
  | NewClientFrame
  | ConfigureClientFrame
  | ApproveClientFrame
  | DenyClientFrame
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
}

export interface ConvoDetail {
  id: string;
  messages: AnyMessage[];
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";
