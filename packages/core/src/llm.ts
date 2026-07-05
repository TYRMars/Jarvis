// LLM provider surface. Ported from harness-core/src/llm.rs.
//
// `Conversation` is the lingua franca; each provider owns conversion to/from
// its native wire format and MUST preserve tool-call/tool-result pairing.
// Streaming lives on its own method (`completeStream`) paralleling `complete`.
import type { Message } from "./message.ts";
import type { ToolSpec } from "./tool.ts";

/**
 * Why a completion ended. Serialises as a snake_case string for the unit
 * cases and as `{ other: "<reason>" }` for anything provider-specific —
 * matching serde's `rename_all = "snake_case"` + `Other(String)`.
 */
export type FinishReason = "stop" | "tool_calls" | "length" | { other: string };

/**
 * Per-call token accounting. Every field is optional: absent means "the
 * provider didn't report this counter", NOT zero.
 */
export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_prompt_tokens?: number;
  reasoning_tokens?: number;
}

export function emptyUsage(): Usage {
  return {};
}

/** True when no counter was reported. */
export function usageIsEmpty(u: Usage): boolean {
  return (
    u.prompt_tokens === undefined &&
    u.completion_tokens === undefined &&
    u.cached_prompt_tokens === undefined &&
    u.reasoning_tokens === undefined
  );
}

/**
 * Fold `other` into `target` in place. `Some + Some` → saturating sum,
 * `Some + None` keeps existing, `None + Some` adopts new. Mirrors
 * `Usage::add` so the agent loop can roll per-iteration usage into a total.
 */
export function addUsage(target: Usage, other: Usage): void {
  const merge = (a: number | undefined, b: number | undefined): number | undefined => {
    if (a !== undefined && b !== undefined) return a + b;
    if (a === undefined && b !== undefined) return b;
    return a;
  };
  target.prompt_tokens = merge(target.prompt_tokens, other.prompt_tokens);
  target.completion_tokens = merge(target.completion_tokens, other.completion_tokens);
  target.cached_prompt_tokens = merge(target.cached_prompt_tokens, other.cached_prompt_tokens);
  target.reasoning_tokens = merge(target.reasoning_tokens, other.reasoning_tokens);
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolSpec[];
  temperature?: number;
  max_tokens?: number;
  previous_response_id?: string | null;
  chain_origin?: number | null;
  parallel_tool_calls?: boolean;
}

export interface ChatResponse {
  message: Message;
  finish_reason: FinishReason;
  response_id?: string | null;
  /**
   * True iff the provider is maintaining a *server-side response chain* for
   * this conversation — i.e. it will honour `previous_response_id` next turn
   * and already holds the prior history server-side. Only then should the
   * agent anchor the chain and skip client-side memory compaction; a bare
   * `response_id` with `chaining` unset (the default) means the id is
   * informational and the full history must still be compacted and re-sent.
   */
  chaining?: boolean;
  usage?: Usage;
}

/**
 * One piece of a streamed response. Providers emit `content_delta` per token,
 * optionally `tool_call_delta` for argument assembly, may emit one `usage`,
 * and finally exactly one `finish` carrying the reconstructed message.
 */
export type LlmChunk =
  | { type: "content_delta"; content: string }
  | {
      type: "tool_call_delta";
      index: number;
      id?: string;
      name?: string;
      arguments_fragment?: string;
    }
  | { type: "usage"; usage: Usage }
  | {
      type: "finish";
      message: Message;
      finish_reason: FinishReason;
      response_id?: string | null;
      /** See {@link ChatResponse.chaining}. */
      chaining?: boolean;
    };

export interface LlmProvider {
  complete(req: ChatRequest): Promise<ChatResponse>;
  /** Stream a completion. May return the iterable directly or a Promise of it. */
  completeStream(req: ChatRequest): AsyncIterable<LlmChunk> | Promise<AsyncIterable<LlmChunk>>;
}

/**
 * Default streaming: call `complete` and emit a single synthesised `finish`.
 * Providers without real streaming can delegate to this — mirrors the Rust
 * trait's default `complete_stream` impl.
 */
export async function* defaultCompleteStream(
  provider: Pick<LlmProvider, "complete">,
  req: ChatRequest,
): AsyncGenerator<LlmChunk> {
  const resp = await provider.complete(req);
  yield {
    type: "finish",
    message: resp.message,
    finish_reason: resp.finish_reason,
    response_id: resp.response_id ?? null,
    chaining: resp.chaining ?? false,
  };
}

/**
 * Optional base class supplying the default `completeStream`. Providers that
 * only implement `complete` can extend this; those with real streaming
 * implement `completeStream` directly against the interface instead.
 */
export class LlmProviderBase implements LlmProvider {
  complete(_req: ChatRequest): Promise<ChatResponse> {
    return Promise.reject(new Error("complete() not implemented"));
  }
  completeStream(req: ChatRequest): AsyncIterable<LlmChunk> {
    return defaultCompleteStream(this, req);
  }
}
