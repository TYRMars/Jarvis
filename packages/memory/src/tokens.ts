// Token estimation surface. Ported from harness-core/src/memory.rs (the
// TokenEstimator trait + estimate_tokens helper live in core there; in the
// Node port they belong to @jarvis/memory so @jarvis/core stays a pure leaf,
// per the note in @jarvis/core's memory.ts).
//
// These are heuristics (~chars/4 + per-message overhead), NOT precise
// tiktoken counts — enough for budget-driven compaction without a tokeniser
// dependency. A js-tiktoken-backed estimator can plug into this interface
// later (P2.9 refinement) and be wired through the provider.
import type { Message } from "@jarvis/core";

/** Count Unicode scalar values, matching Rust's `chars().count()`. */
function charCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

const PER_MESSAGE_OVERHEAD = 4;

/**
 * Per-message / per-text token-counting strategy. Memory backends consume
 * one of these so a provider with a real tokeniser can plug in accurate
 * counts without each backend caring how counting works.
 */
export interface TokenEstimator {
  /** Tokens for a single message, including role/separator overhead. */
  estimateMessage(message: Message): number;
  /** Tokens for raw text — used when sizing a summary prompt. */
  estimateText(text: string): number;
}

/** Sum a TokenEstimator across a slice. */
export function estimateMessages(est: TokenEstimator, messages: Message[]): number {
  return messages.reduce((acc, m) => acc + est.estimateMessage(m), 0);
}

/**
 * Cheap, provider-agnostic estimate: roughly `chars/4` plus a fixed
 * per-message overhead. Mirrors Rust's `estimate_tokens` free function.
 */
export function estimateTokens(message: Message): number {
  let chars: number;
  switch (message.role) {
    case "system":
    case "user":
      chars = charCount(message.content);
      break;
    case "assistant": {
      const body = message.content != null ? charCount(message.content) : 0;
      const reasoning = message.reasoning_content != null ? charCount(message.reasoning_content) : 0;
      let calls = 0;
      for (const tc of message.tool_calls ?? []) {
        calls += charCount(tc.id) + charCount(tc.name) + charCount(JSON.stringify(tc.arguments));
      }
      chars = body + reasoning + calls;
      break;
    }
    case "tool":
      chars = charCount(message.tool_call_id) + charCount(message.content);
      break;
  }
  return Math.ceil(chars / 4) + PER_MESSAGE_OVERHEAD;
}

/** Sum of estimateTokens over a slice. */
export function estimateTotalTokens(messages: Message[]): number {
  return messages.reduce((acc, m) => acc + estimateTokens(m), 0);
}

/** `chars/4` for natural-language text. Mirrors Rust's `estimate_text`. */
export function estimateText(text: string): number {
  return Math.ceil(charCount(text) / 4);
}

/** The default estimator: the `chars/4 + 4` char-ratio heuristic. */
export const charRatioEstimator: TokenEstimator = {
  estimateMessage: estimateTokens,
  estimateText,
};

/**
 * Variant that keeps char-ratio numbers for prose but applies a tighter
 * ratio (`chars*2/7`) + larger overhead for `tool` payloads, which are
 * dense JSON the `chars/4` heuristic underestimates by ~15-25%. Mirrors
 * Rust's `JsonAwareEstimator`.
 */
export const jsonAwareEstimator: TokenEstimator = {
  estimateMessage(message: Message): number {
    if (message.role === "tool") {
      const chars = charCount(message.tool_call_id) + charCount(message.content);
      return Math.ceil((chars * 2) / 7) + 8;
    }
    return estimateTokens(message);
  },
  estimateText,
};

/** The default `TokenEstimator` (char-ratio). */
export function defaultEstimator(): TokenEstimator {
  return charRatioEstimator;
}

/**
 * Indices of every message carrying an explicit `cache` hint. Memory
 * backends consult this to keep cache-anchored prefixes intact during
 * compaction. Mirrors Rust's `cache_breakpoint_indices`.
 */
export function cacheBreakpointIndices(messages: Message[]): number[] {
  const out: number[] = [];
  messages.forEach((m, i) => {
    if (m.cache !== undefined) out.push(i);
  });
  return out;
}
