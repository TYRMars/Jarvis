// Message model. Ported from harness-core/src/message.rs.
//
// `Message` is an externally-tagged union keyed on `role`, shaped like the
// OpenAI chat-completions wire format so providers map both ways losslessly.
// Tool-call `arguments` are stored as already-parsed JSON (the OpenAI
// provider re-serialises them to the JSON-string form OpenAI expects).
//
// Wire parity: optional fields (`cache`, assistant `content` / `tool_calls` /
// `reasoning_content`) are simply absent when unset, so JSON.stringify omits
// them — matching serde's `skip_serializing_if`.
import type { JsonValue } from "./json.ts";

/**
 * Prompt-cache breakpoint hint. Only the Anthropic provider acts on it;
 * other providers ignore the field.
 */
export type CacheHint = "ephemeral" | "persistent";

/** A function-style tool call emitted by the assistant. */
export interface ToolCall {
  id: string;
  name: string;
  /** Arguments, already parsed from the provider's raw JSON string. */
  arguments: JsonValue;
}

export type Message =
  | { role: "system"; content: string; cache?: CacheHint }
  | { role: "user"; content: string; cache?: CacheHint }
  | {
      role: "assistant";
      content?: string | null;
      tool_calls?: ToolCall[];
      reasoning_content?: string | null;
      cache?: CacheHint;
    }
  | { role: "tool"; tool_call_id: string; content: string; cache?: CacheHint };

export function systemMessage(content: string): Message {
  return { role: "system", content };
}

export function userMessage(content: string): Message {
  return { role: "user", content };
}

export function assistantText(content: string): Message {
  return { role: "assistant", content };
}

export function toolResult(toolCallId: string, content: string): Message {
  return { role: "tool", tool_call_id: toolCallId, content };
}

/** Attach a cache hint to any message variant. */
export function withCache(message: Message, hint: CacheHint): Message {
  return { ...message, cache: hint };
}
