// Short-term memory trait. Ported (minimal subset) from
// harness-core/src/memory.rs.
//
// The loop calls `compact` inside `buildRequest` every iteration and ships
// the result to the LLM; the canonical Conversation is NOT mutated, so the
// terminal `done` event keeps full history. Concrete impls (SlidingWindow,
// Summarizing) and the token-estimator surface land in @jarvis/memory (P2).
import type { Message } from "./message.ts";

export interface Memory {
  /** Return the messages to send this iteration (possibly summarised/dropped). */
  compact(messages: Message[]): Promise<Message[]>;
}
