// OpenAI Chat Completions provider. Ported from harness-llm/src/openai.rs
// (the load-bearing subset). Kimi / Ollama reuse this provider unchanged via
// a swapped `baseUrl`.
//
// Invariants preserved from the Rust implementation:
//   * Tool-call `arguments` go out as a JSON-encoded STRING and come back
//     parsed (empty string → `{}`). See toWireMessage / parseToolCall.
//   * Dotted tool names (`fs.read`) are sanitised to `fs_read` on the wire
//     (OpenAI/Kimi name policy) and restored via a per-request name map so
//     the agent loop always routes by the original name.
//   * `finish_reason`: missing + non-empty tool_calls → "tool_calls", else
//     "stop".
//   * Streaming: manual SSE framing (`data: <json>\n\n`, `[DONE]` sentinel);
//     StreamAccumulator reassembles argument fragments in index order and
//     normalises cumulative content snapshots; exactly one `finish` is
//     emitted, held back until stream close so a trailing usage-only chunk is
//     surfaced first (issue #48 parity).
//   * Optional `prompt_cache_key` auto-derived from (model, systems, tools).
import { ProviderError, errorText } from "@jarvis/core";
import type {
  ChatRequest,
  ChatResponse,
  FinishReason,
  JsonValue,
  LlmChunk,
  LlmProvider,
  Message,
  ToolCall,
  ToolSpec,
  Usage,
} from "@jarvis/core";
import { autoCacheKey } from "./cache-key.ts";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface OpenAiConfig {
  apiKey: string;
  /** Defaults to `https://api.openai.com/v1`. Swap for Kimi / Ollama. */
  baseUrl?: string;
  /**
   * Emit an empty `reasoning_content` on historical assistant tool-call
   * messages. Required by Kimi K2 thinking endpoints; off for standard OpenAI.
   */
  includeEmptyReasoningContentForToolCalls?: boolean;
  /** Pin a `prompt_cache_key`; unset → auto-derive from (model, system, tools). */
  promptCacheKey?: string;
  /** Inject a `fetch` implementation (tests / proxies). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class OpenAiProvider implements LlmProvider {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #includeEmptyReasoning: boolean;
  readonly #promptCacheKey: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(cfg: OpenAiConfig) {
    this.#apiKey = cfg.apiKey;
    this.#baseUrl = cfg.baseUrl ?? DEFAULT_BASE_URL;
    this.#includeEmptyReasoning = cfg.includeEmptyReasoningContentForToolCalls ?? false;
    this.#promptCacheKey = cfg.promptCacheKey;
    this.#fetch = cfg.fetchImpl ?? fetch;
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    const { request, nameMap } = buildOpenAiRequest(
      req,
      false,
      this.#includeEmptyReasoning,
      this.#promptCacheKey,
    );
    const resp = await this.#post(request);

    let text: string;
    try {
      text = await resp.text();
    } catch (e) {
      throw new ProviderError(`read body: ${errorText(e)}`);
    }
    if (!resp.ok) throw new ProviderError(`status ${resp.status}: ${text}`);

    let parsed: OaResponseRaw;
    try {
      parsed = JSON.parse(text) as OaResponseRaw;
    } catch (e) {
      throw new ProviderError(`decode: ${errorText(e)}; body=${text}`);
    }
    return intoChatResponse(parsed, nameMap);
  }

  async completeStream(req: ChatRequest): Promise<AsyncIterable<LlmChunk>> {
    const { request, nameMap } = buildOpenAiRequest(
      req,
      true,
      this.#includeEmptyReasoning,
      this.#promptCacheKey,
    );
    const resp = await this.#post(request);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new ProviderError(`status ${resp.status}: ${text}`);
    }
    if (!resp.body) throw new ProviderError("stream response had no body");
    return sseChunks(resp.body, new StreamAccumulator(nameMap));
  }

  async #post(body: unknown): Promise<Response> {
    const url = `${this.#baseUrl}/chat/completions`;
    try {
      return await this.#fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new ProviderError(`transport: ${errorText(e)}`);
    }
  }
}

// ---------- Tool-name sanitisation ----------

/**
 * OpenAI Chat Completions tool names must match `^[a-zA-Z0-9_-]+$`; strict
 * forks (Kimi Code) further require a leading letter/underscore. Dotted
 * harness names (`fs.read`) get rewritten on the way out and restored on the
 * way back via a per-request map.
 */
export function sanitizeToolName(name: string): string {
  const chars = [...name];
  let out = "";
  const first = chars[0];
  if (first !== undefined) {
    if (/[a-zA-Z]/.test(first)) {
      out += first;
    } else {
      out += "_";
      if (/[0-9_]/.test(first)) out += first;
    }
  }
  for (const c of chars.slice(1)) {
    out += /[a-zA-Z0-9_-]/.test(c) ? c : "_";
  }
  return out === "" ? "_" : out;
}

function restoreToolName(map: Map<string, string>, sanitized: string): string {
  return map.get(sanitized) ?? sanitized;
}

// ---------- Outbound request building ----------

export interface Outbound {
  request: Record<string, unknown>;
  /** sanitized → original tool-name map, for restoring on response/stream. */
  nameMap: Map<string, string>;
}

/**
 * Build the wire request body + the name map. Mirrors
 * `OpenAiRequest::from_request`. Empty `tools` / falsy `stream` are omitted
 * to match serde's `skip_serializing_if`.
 */
export function buildOpenAiRequest(
  r: ChatRequest,
  stream: boolean,
  includeEmptyReasoning: boolean,
  promptCacheKeyOverride: string | undefined,
): Outbound {
  const tools = r.tools ?? [];
  const nameMap = new Map<string, string>();
  for (const t of tools) nameMap.set(sanitizeToolName(t.name), t.name);

  const messages = r.messages.map((m) => toWireMessage(m, includeEmptyReasoning));
  const wireTools = tools.map(toWireTool);

  // Derive the cache key from the post-sanitise wire shapes so the hash
  // matches what we actually send (specs() already sorted alphabetically).
  let systems = "";
  for (const m of messages) {
    if (m.role === "system" && typeof m.content === "string") {
      if (systems !== "") systems += "\n\n";
      systems += m.content;
    }
  }
  const cacheKey = promptCacheKeyOverride ?? autoCacheKey(r.model, systems, JSON.stringify(wireTools));

  const request: Record<string, unknown> = { model: r.model, messages };
  if (wireTools.length > 0) request.tools = wireTools;
  if (r.temperature !== undefined) request.temperature = r.temperature;
  if (r.max_tokens !== undefined) request.max_tokens = r.max_tokens;
  if (stream) {
    request.stream = true;
    request.stream_options = { include_usage: true };
  }
  request.prompt_cache_key = cacheKey;
  if (r.parallel_tool_calls !== undefined) request.parallel_tool_calls = r.parallel_tool_calls;
  return { request, nameMap };
}

interface WireMessage {
  role: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

function toWireMessage(m: Message, includeEmptyReasoning: boolean): WireMessage {
  switch (m.role) {
    case "system":
      return { role: "system", content: m.content };
    case "user":
      return { role: "user", content: m.content };
    case "assistant": {
      const toolCalls = (m.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: sanitizeToolName(tc.name), arguments: JSON.stringify(tc.arguments) },
      }));
      // reasoning_content priority: captured reasoning > empty placeholder
      // (flag on AND a tool_call present) > omit.
      let reasoning: string | undefined;
      if (m.reasoning_content != null) reasoning = m.reasoning_content;
      else if (includeEmptyReasoning && toolCalls.length > 0) reasoning = "";

      const out: WireMessage = { role: "assistant" };
      if (m.content != null) out.content = m.content;
      if (reasoning !== undefined) out.reasoning_content = reasoning;
      if (toolCalls.length > 0) out.tool_calls = toolCalls;
      return out;
    }
    case "tool":
      return { role: "tool", content: m.content, tool_call_id: m.tool_call_id };
  }
}

function toWireTool(t: ToolSpec): Record<string, unknown> {
  return {
    type: "function",
    function: { name: sanitizeToolName(t.name), description: t.description, parameters: t.parameters },
  };
}

// ---------- Non-streaming response ----------

interface OaResponseRaw {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { id: string; type?: string; function: { name: string; arguments: string } }[];
      reasoning_content?: string | null;
    };
    finish_reason?: string | null;
  }[];
  usage?: OaUsageRaw;
}

function intoChatResponse(parsed: OaResponseRaw, nameMap: Map<string, string>): ChatResponse {
  const choices = parsed.choices ?? [];
  const choice = choices[choices.length - 1];
  if (!choice) throw new ProviderError("response had no choices");
  const msg = choice.message ?? {};

  const toolCalls = (msg.tool_calls ?? []).map((tc) =>
    parseToolCall(tc.id, restoreToolName(nameMap, tc.function.name), tc.function.arguments),
  );
  const finishReason = mapFinishReason(choice.finish_reason, toolCalls);
  const usage = parsed.usage ? usageIntoCore(parsed.usage) : undefined;

  return {
    message: assistantMessage(msg.content, toolCalls, msg.reasoning_content),
    finish_reason: finishReason,
    response_id: null,
    usage,
  };
}

/** Assemble an assistant message, omitting empty `content`/`tool_calls`/`reasoning` to match serde `skip_serializing_if`. */
function assistantMessage(
  content: string | null | undefined,
  toolCalls: ToolCall[],
  reasoning: string | null | undefined,
): Message {
  const m: Extract<Message, { role: "assistant" }> = { role: "assistant" };
  if (content != null) m.content = content;
  if (toolCalls.length > 0) m.tool_calls = toolCalls;
  if (reasoning != null) m.reasoning_content = reasoning;
  return m;
}

function parseToolCall(id: string, name: string, rawArgs: string): ToolCall {
  let args: JsonValue;
  if (rawArgs.trim() === "") {
    args = {};
  } else {
    try {
      args = JSON.parse(rawArgs) as JsonValue;
    } catch (e) {
      throw new ProviderError(`invalid tool arguments for ${name}: ${errorText(e)}; raw=${rawArgs}`);
    }
  }
  return { id, name, arguments: args };
}

function mapFinishReason(raw: string | null | undefined, toolCalls: ToolCall[]): FinishReason {
  switch (raw) {
    case "stop":
      return "stop";
    case "tool_calls":
      return "tool_calls";
    case "length":
      return "length";
    case null:
    case undefined:
      return toolCalls.length > 0 ? "tool_calls" : "stop";
    default:
      return { other: raw };
  }
}

// ---------- Usage ----------

interface OaUsageRaw {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

function usageIntoCore(u: OaUsageRaw): Usage {
  const out: Usage = {};
  if (u.prompt_tokens !== undefined) out.prompt_tokens = u.prompt_tokens;
  if (u.completion_tokens !== undefined) out.completion_tokens = u.completion_tokens;
  const cached = u.prompt_tokens_details?.cached_tokens;
  if (cached !== undefined) out.cached_prompt_tokens = cached;
  const reasoning = u.completion_tokens_details?.reasoning_tokens;
  if (reasoning !== undefined) out.reasoning_tokens = reasoning;
  return out;
}

// ---------- Streaming wire types + accumulator ----------

interface StreamChunkRaw {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
      reasoning_content?: string | null;
    };
    finish_reason?: string | null;
  }[];
  usage?: OaUsageRaw;
}

interface ToolCallBuilder {
  id?: string;
  name?: string;
  arguments: string;
}

/**
 * Reassembles a streamed completion. `ingest` returns the chunks to forward;
 * `flush` releases the buffered terminal `finish` on stream close. Ported
 * from the Rust StreamAccumulator including the held-back-finish behaviour so
 * a trailing usage-only chunk surfaces before `finish`.
 */
export class StreamAccumulator {
  #content = "";
  #toolCalls: ToolCallBuilder[] = [];
  #finishReason: string | null | undefined;
  #finished = false;
  #pendingFinish: LlmChunk | undefined;
  #reasoning = "";
  readonly #nameMap: Map<string, string>;

  constructor(nameMap: Map<string, string> = new Map()) {
    this.#nameMap = nameMap;
  }

  ingest(chunk: StreamChunkRaw): LlmChunk[] {
    const out: LlmChunk[] = [];

    // Usage-only chunks ship with `choices: []`, after the finish_reason
    // chunk. Surface usage, then release the held finish so usage lands first.
    if (chunk.usage) {
      out.push({ type: "usage", usage: usageIntoCore(chunk.usage) });
      if (this.#pendingFinish) {
        out.push(this.#pendingFinish);
        this.#pendingFinish = undefined;
      }
    }

    const choice = chunk.choices?.[0];
    if (!choice) return out;
    const delta = choice.delta ?? {};

    if (delta.reasoning_content != null) {
      appendStreamFragment({ acc: this.#reasoning }, delta.reasoning_content, (v) => (this.#reasoning = v));
    }

    if (delta.content != null) {
      const fragment = appendStreamFragment({ acc: this.#content }, delta.content, (v) => (this.#content = v));
      if (fragment !== undefined) out.push({ type: "content_delta", content: fragment });
    }

    for (const td of delta.tool_calls ?? []) {
      while (this.#toolCalls.length <= td.index) this.#toolCalls.push({ arguments: "" });
      const slot = this.#toolCalls[td.index]!;
      if (td.id !== undefined) slot.id = td.id;

      let nameUpdate: string | undefined;
      let argsUpdate: string | undefined;
      if (td.function) {
        if (td.function.name != null && td.function.name !== "") {
          const original = restoreToolName(this.#nameMap, td.function.name);
          slot.name = original;
          nameUpdate = original;
        }
        if (td.function.arguments != null && td.function.arguments !== "") {
          slot.arguments += td.function.arguments;
          argsUpdate = td.function.arguments;
        }
      }
      if (nameUpdate !== undefined || argsUpdate !== undefined || td.id !== undefined) {
        const d: Extract<LlmChunk, { type: "tool_call_delta" }> = { type: "tool_call_delta", index: td.index };
        if (td.id !== undefined) d.id = td.id;
        if (nameUpdate !== undefined) d.name = nameUpdate;
        if (argsUpdate !== undefined) d.arguments_fragment = argsUpdate;
        out.push(d);
      }
    }

    if (choice.finish_reason != null) {
      this.#finishReason = choice.finish_reason;
      this.#pendingFinish = this.#finalise();
    }

    return out;
  }

  /** The chunk still buffered at stream close: a held `finish`, or a freshly synthesised one. */
  flush(): LlmChunk | undefined {
    if (this.#pendingFinish) {
      const f = this.#pendingFinish;
      this.#pendingFinish = undefined;
      return f;
    }
    if (!this.#finished) return this.#finalise();
    return undefined;
  }

  #finalise(): LlmChunk {
    this.#finished = true;

    const toolCalls: ToolCall[] = [];
    for (const b of this.#toolCalls) {
      if (b.id !== undefined && b.name !== undefined) {
        try {
          toolCalls.push(parseToolCall(b.id, b.name, b.arguments));
        } catch {
          // Drop malformed tool calls on the streaming path (Rust `.ok()`).
        }
      }
    }
    this.#toolCalls = [];

    const finishReason = mapFinishReason(this.#finishReason, toolCalls);
    const content = this.#content === "" ? undefined : this.#content;
    const reasoning = this.#reasoning === "" ? undefined : this.#reasoning;
    this.#content = "";
    this.#reasoning = "";

    return {
      type: "finish",
      message: assistantMessage(content, toolCalls, reasoning),
      finish_reason: finishReason,
      response_id: null,
    };
  }
}

/**
 * Append `incoming` to `state.acc`, returning only the NEW fragment. Handles
 * providers that stream cumulative snapshots ("Hel" → "Hello") as well as
 * pure deltas. Mirrors Rust `append_stream_fragment`.
 */
function appendStreamFragment(
  state: { acc: string },
  incoming: string,
  commit: (v: string) => void,
): string | undefined {
  if (incoming === "") return undefined;
  if (state.acc !== "") {
    if (incoming === state.acc) return undefined;
    if (incoming.startsWith(state.acc)) {
      const fragment = incoming.slice(state.acc.length);
      commit(incoming);
      return fragment === "" ? undefined : fragment;
    }
  }
  commit(state.acc + incoming);
  return incoming;
}

// ---------- SSE consumption ----------

async function* sseChunks(
  body: ReadableStream<Uint8Array>,
  acc: StreamAccumulator,
): AsyncGenerator<LlmChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Normalize CRLF → LF so `\n\n` framing works even behind a proxy that
      // rewrites SSE with `\r\n` terminators (the spec permits them). Re-running
      // over the whole buffer also joins a `\r\n` split across chunk boundaries.
      buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");

      let pos: number;
      while ((pos = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, pos + 2);
        buf = buf.slice(pos + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice("data:".length).trim();
          if (data === "" || data === "[DONE]") continue;
          let parsed: StreamChunkRaw;
          try {
            parsed = JSON.parse(data) as StreamChunkRaw;
          } catch (e) {
            throw new ProviderError(`decode chunk: ${errorText(e)}; raw=${data}`);
          }
          for (const c of acc.ingest(parsed)) yield c;
        }
      }
    }
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(`stream: ${errorText(e)}`);
  } finally {
    reader.releaseLock();
  }

  const finish = acc.flush();
  if (finish) yield finish;
}
