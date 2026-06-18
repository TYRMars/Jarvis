// Mutable conversation state. Ported from harness-core/src/conversation.rs.
// The agent appends to `messages` on every turn. `last_response_id` /
// `last_response_chain_origin` carry Responses-API chaining state (unused
// until the Responses provider lands; round-trips harmlessly otherwise).
import { systemMessage, type Message } from "./message.ts";

export interface Conversation {
  messages: Message[];
  last_response_id?: string | null;
  last_response_chain_origin?: number | null;
}

export function newConversation(): Conversation {
  return { messages: [] };
}

export function conversationWithSystem(prompt: string): Conversation {
  return { messages: [systemMessage(prompt)] };
}

/** Most recent assistant message's text content, if any. */
export function lastAssistantText(conv: Conversation): string | undefined {
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m && m.role === "assistant" && typeof m.content === "string") {
      return m.content;
    }
  }
  return undefined;
}
