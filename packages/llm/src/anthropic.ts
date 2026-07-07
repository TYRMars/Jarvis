// Anthropic Messages API provider. Ported from harness-llm/src/anthropic.rs.
//
// The wire shape diverges from OpenAI in three load-bearing ways and we convert
// in both directions:
//
//   1. System prompts are TOP-LEVEL, not in the `messages` array. Every
//      `system` message is pulled out and joined into the request's `system`
//      field (multiple → joined with "\n\n"). When any system message carries a
//      cache hint we emit the block-array form so `cache_control` has somewhere
//      to land; otherwise we keep the historical joined-string form.
//   2. Tool calls and results are CONTENT BLOCKS, not separate message types.
//      An assistant turn that uses a tool emits `[{type:"text"},{type:"tool_use",
//      id,name,input}]`; the next user turn replies with `{type:"tool_result",
//      tool_use_id,content}` blocks. `input` is the parsed JSON object (NOT a
//      string — unlike OpenAI). Consecutive `tool` messages are coalesced into
//      ONE user message with multiple `tool_result` blocks so Anthropic sees the
//      canonical pairing with the preceding assistant `tool_use` blocks.
//   3. Streaming uses TYPED SSE events (`message_start`, `content_block_start`,
//      `content_block_delta`, `content_block_stop`, `message_delta`,
//      `message_stop`, `ping`). `tool_use` input arrives as `input_json_delta`
//      fragments that are concatenated and parsed at `content_block_stop`. One
//      `finish` is emitted on `message_stop`.
//
// `max_tokens` is REQUIRED by Anthropic; we default to 4096 when the caller
// hasn't supplied one. Headers: `x-api-key`, `anthropic-version` (config,
// default "2023-06-01").
import { ProviderError, errorText } from "@jarvis/core";
import type {
  CacheHint,
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

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
/**
 * Anthropic requires `max_tokens`; we pick a generous default that matches
 * Claude 3.5 Sonnet's per-request cap when the caller hasn't supplied one.
 */
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicConfig {
  apiKey: string;
  /** Defaults to `https://api.anthropic.com/v1`. */
  baseUrl?: string;
  /** `anthropic-version` header. Defaults to `2023-06-01`. */
  anthropicVersion?: string;
  /** Inject a `fetch` implementation (tests / proxies). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class AnthropicProvider implements LlmProvider {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #anthropicVersion: string;
  readonly #fetch: typeof fetch;

  constructor(cfg: AnthropicConfig) {
    this.#apiKey = cfg.apiKey;
    this.#baseUrl = cfg.baseUrl ?? DEFAULT_BASE_URL;
    this.#anthropicVersion = cfg.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;
    this.#fetch = cfg.fetchImpl ?? fetch;
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    const body = buildAnthropicRequest(req, false);
    const resp = await this.#post(body);

    let text: string;
    try {
      text = await resp.text();
    } catch (e) {
      throw new ProviderError(`read body: ${errorText(e)}`);
    }
    if (!resp.ok) throw new ProviderError(`status ${resp.status}: ${text}`);

    let parsed: AnthropicResponseRaw;
    try {
      parsed = JSON.parse(text) as AnthropicResponseRaw;
    } catch (e) {
      throw new ProviderError(`decode: ${errorText(e)}; body=${text}`);
    }
    return intoChatResponse(parsed);
  }

  async completeStream(req: ChatRequest): Promise<AsyncIterable<LlmChunk>> {
    const body = buildAnthropicRequest(req, true);
    const resp = await this.#post(body);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new ProviderError(`status ${resp.status}: ${text}`);
    }
    if (!resp.body) throw new ProviderError("stream response had no body");
    return sseChunks(resp.body, new StreamAccumulator());
  }

  async #post(body: unknown): Promise<Response> {
    const url = `${this.#baseUrl}/messages`;
    try {
      return await this.#fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": this.#anthropicVersion,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new ProviderError(`transport: ${errorText(e)}`);
    }
  }
}

// ---------- Outbound wire types ----------

/** `{type:"ephemeral"}` (5-min) or `{type:"ephemeral", ttl:"1h"}` (persistent). */
interface CacheControl {
  type: "ephemeral";
  ttl?: "1h";
}

function cacheControl(hint: CacheHint): CacheControl {
  return hint === "persistent" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

interface TextBlock {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}
interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: JsonValue;
  cache_control?: CacheControl;
}
interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  cache_control?: CacheControl;
}
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

/** Content is a plain string (common case) or an array of blocks (tool mixins). */
type WireContent = string | ContentBlock[];

interface WireMessage {
  role: "user" | "assistant";
  content: WireContent;
}

interface SystemTextBlock {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}
/** `system` is a string (historical) or an array of text blocks (cache hints). */
type WireSystem = string | SystemTextBlock[];

interface WireTool {
  name: string;
  description: string;
  input_schema: JsonValue;
  cache_control?: CacheControl;
}

interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  system?: WireSystem;
  messages: WireMessage[];
  tools?: WireTool[];
  temperature?: number;
  stream?: true;
}

/** Mirrors `AnthropicRequest::from_request`. */
export function buildAnthropicRequest(r: ChatRequest, stream: boolean): AnthropicRequestBody {
  const { system, messages } = convertMessages(r.messages);
  const tools = convertTools(r.tools ?? []);

  const body: AnthropicRequestBody = {
    model: r.model,
    max_tokens: r.max_tokens ?? DEFAULT_MAX_TOKENS,
    messages,
  };
  if (system !== undefined) body.system = system;
  if (tools.length > 0) body.tools = tools;
  if (r.temperature !== undefined) body.temperature = r.temperature;
  if (stream) body.stream = true;
  return body;
}

/**
 * If any tool's `cacheable` flag is set, attach `cache_control` to the LAST
 * tool entry. Anthropic interprets the breakpoint as "everything up to and
 * including this block stays cached" — putting it on the last entry caches the
 * whole tools list.
 */
function convertTools(specs: ToolSpec[]): WireTool[] {
  const anyCacheable = specs.some((t) => t.cacheable);
  const tools: WireTool[] = specs.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
  if (anyCacheable && tools.length > 0) {
    tools[tools.length - 1]!.cache_control = { type: "ephemeral" };
  }
  return tools;
}

/**
 * Pull every `system` message into a top-level system prompt and rewrite the
 * rest into Anthropic's `messages` shape. Consecutive `tool` messages are
 * coalesced into one user message with multiple `tool_result` blocks.
 */
export function convertMessages(messages: Message[]): {
  system: WireSystem | undefined;
  messages: WireMessage[];
} {
  const systems: { text: string; cache: CacheHint | undefined }[] = [];
  const out: WireMessage[] = [];

  for (const m of messages) {
    switch (m.role) {
      case "system":
        systems.push({ text: m.content, cache: m.cache });
        break;
      case "user": {
        // Without a cache hint we keep the historical plain-text wire shape;
        // with one we promote to a single text block so `cache_control` has
        // somewhere to land.
        const content: WireContent = m.cache
          ? [{ type: "text", text: m.content, cache_control: cacheControl(m.cache) }]
          : m.content;
        out.push({ role: "user", content });
        break;
      }
      case "assistant": {
        const blocks: ContentBlock[] = [];
        if (m.content != null && m.content !== "") {
          blocks.push({ type: "text", text: m.content });
        }
        for (const tc of m.tool_calls ?? []) {
          blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
        }
        if (blocks.length === 0) {
          // Empty assistant message — Anthropic rejects these, but emitting ""
          // lets us round-trip.
          blocks.push({ type: "text", text: "" });
        }
        if (m.cache) {
          const last = blocks[blocks.length - 1]!;
          last.cache_control = cacheControl(m.cache);
        }
        out.push({ role: "assistant", content: blocks });
        break;
      }
      case "tool": {
        // Coalesce consecutive tool results into the previous user message if
        // it already collected only tool_result blocks; otherwise start a new
        // one — so Anthropic sees the natural pairing with the preceding
        // assistant `tool_use` blocks.
        const block: ToolResultBlock = {
          type: "tool_result",
          tool_use_id: m.tool_call_id,
          content: m.content,
        };
        if (m.cache) block.cache_control = cacheControl(m.cache);

        const last = out[out.length - 1];
        if (
          last !== undefined &&
          last.role === "user" &&
          Array.isArray(last.content) &&
          last.content.every((b) => b.type === "tool_result")
        ) {
          last.content.push(block);
        } else {
          out.push({ role: "user", content: [block] });
        }
        break;
      }
    }
  }

  return { system: buildSystem(systems), messages: out };
}

/**
 * Decide which `system` wire shape to emit. No cache hint anywhere → joined
 * string (historical). At least one opts in → every entry becomes its own text
 * block so `cache_control` lands on the right boundary.
 */
function buildSystem(
  systems: { text: string; cache: CacheHint | undefined }[],
): WireSystem | undefined {
  if (systems.length === 0) return undefined;
  if (systems.every((s) => s.cache === undefined)) {
    const joined = systems.map((s) => s.text).join("\n\n");
    return joined === "" ? undefined : joined;
  }
  return systems.map((s) => {
    const block: SystemTextBlock = { type: "text", text: s.text };
    if (s.cache) block.cache_control = cacheControl(s.cache);
    return block;
  });
}

// ---------- Non-streaming response ----------

interface AnUsageRaw {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnResponseBlockRaw {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: JsonValue;
}

interface AnthropicResponseRaw {
  content?: AnResponseBlockRaw[];
  stop_reason?: string | null;
  usage?: AnUsageRaw;
}

function intoChatResponse(parsed: AnthropicResponseRaw): ChatResponse {
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const block of parsed.content ?? []) {
    if (block.type === "text") {
      text += block.text ?? "";
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? "",
        name: block.name ?? "",
        arguments: block.input ?? {},
      });
    }
    // Unknown block types are ignored.
  }

  const content = text === "" ? undefined : text;
  const finishReason = mapStopReason(parsed.stop_reason, toolCalls);
  const usage = parsed.usage ? flattenUsage(parsed.usage) : undefined;

  return {
    message: assistantMessage(content, toolCalls),
    finish_reason: finishReason,
    response_id: null,
    usage,
  };
}

/** Assemble an assistant message, omitting empty `content`/`tool_calls` to match serde `skip_serializing_if`. */
function assistantMessage(content: string | undefined, toolCalls: ToolCall[]): Message {
  const m: Extract<Message, { role: "assistant" }> = { role: "assistant" };
  if (content !== undefined) m.content = content;
  if (toolCalls.length > 0) m.tool_calls = toolCalls;
  return m;
}

/**
 * Flatten Anthropic's three prompt-side counters into the harness `Usage`
 * shape: `prompt_tokens = input + cache_creation + cache_read`, with the
 * hit-only count surfaced separately as `cached_prompt_tokens`. Returns
 * `undefined` when no counter was reported.
 */
function flattenUsage(u: AnUsageRaw): Usage | undefined {
  const any =
    u.input_tokens !== undefined ||
    u.output_tokens !== undefined ||
    u.cache_creation_input_tokens !== undefined ||
    u.cache_read_input_tokens !== undefined;
  if (!any) return undefined;

  const out: Usage = {};
  if (
    u.input_tokens !== undefined ||
    u.cache_creation_input_tokens !== undefined ||
    u.cache_read_input_tokens !== undefined
  ) {
    out.prompt_tokens =
      (u.input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0);
  }
  if (u.output_tokens !== undefined) out.completion_tokens = u.output_tokens;
  if (u.cache_read_input_tokens !== undefined) out.cached_prompt_tokens = u.cache_read_input_tokens;
  return out;
}

function mapStopReason(raw: string | null | undefined, toolCalls: ToolCall[]): FinishReason {
  switch (raw) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case null:
    case undefined:
      return toolCalls.length > 0 ? "tool_calls" : "stop";
    default:
      return { other: raw };
  }
}

// ---------- Streaming events + accumulator ----------

interface StreamEventRaw {
  type?: string;
  // message_start
  message?: { usage?: AnUsageRaw };
  // content_block_start / _delta / _stop
  index?: number;
  content_block?: { type?: string; text?: string; id?: string; name?: string; input?: JsonValue };
  delta?: {
    // block delta
    type?: string;
    text?: string;
    partial_json?: string;
    // message_delta
    stop_reason?: string | null;
  };
  // message_delta
  usage?: AnUsageRaw;
}

type BlockBuilder =
  | { kind: "pending" }
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; partialInput: string };

/**
 * Reassembles a streamed Anthropic response. `ingest` returns the chunks to
 * forward; `finalize` synthesises a terminal `finish` for an unterminated
 * stream (mirrors the Rust `if !acc.finished { yield acc.finalise() }`).
 */
export class StreamAccumulator {
  #blocks: BlockBuilder[] = [];
  #text = "";
  #toolCalls: ToolCall[] = [];
  #stopReason: string | null | undefined;
  #finished = false;
  // Cumulative token counts, merged from `message_start.message.usage` and the
  // rolling `message_delta.usage`, forwarded as one `usage` chunk on
  // `message_stop` — never per delta.
  #pendingUsage: AnUsageRaw = {};

  get finished(): boolean {
    return this.#finished;
  }

  ingest(ev: StreamEventRaw): LlmChunk[] {
    const out: LlmChunk[] = [];
    switch (ev.type) {
      case "message_start":
        if (ev.message?.usage) this.#mergeUsage(ev.message.usage);
        break;
      case "ping":
        break;
      case "content_block_start": {
        const index = ev.index ?? 0;
        while (this.#blocks.length <= index) this.#blocks.push({ kind: "pending" });
        const cb = ev.content_block;
        if (cb?.type === "text") {
          this.#blocks[index] = { kind: "text", text: cb.text ?? "" };
        } else if (cb?.type === "tool_use") {
          const id = cb.id ?? "";
          const name = cb.name ?? "";
          const partialInput = isEmptyInput(cb.input) ? "" : JSON.stringify(cb.input);
          out.push({ type: "tool_call_delta", index, id, name });
          this.#blocks[index] = { kind: "tool_use", id, name, partialInput };
        } else {
          this.#blocks[index] = { kind: "pending" };
        }
        break;
      }
      case "content_block_delta": {
        const index = ev.index ?? 0;
        const slot = this.#blocks[index];
        if (slot === undefined) {
          throw new ProviderError(`delta for unknown block ${index}`);
        }
        const delta = ev.delta;
        if (slot.kind === "text" && delta?.type === "text_delta" && delta.text) {
          slot.text += delta.text;
          out.push({ type: "content_delta", content: delta.text });
        } else if (
          slot.kind === "tool_use" &&
          delta?.type === "input_json_delta" &&
          delta.partial_json
        ) {
          slot.partialInput += delta.partial_json;
          out.push({ type: "tool_call_delta", index, arguments_fragment: delta.partial_json });
        }
        // Empty deltas / mismatched (slot, delta) pairs / forward-compatible
        // types fall through quietly rather than killing the stream.
        break;
      }
      case "content_block_stop": {
        const index = ev.index ?? 0;
        const slot = this.#blocks[index];
        if (slot !== undefined) {
          this.#blocks[index] = { kind: "pending" };
          if (slot.kind === "text") {
            if (slot.text !== "") this.#text += slot.text;
          } else if (slot.kind === "tool_use") {
            const arguments_ = this.#parseToolInput(slot.name, slot.partialInput);
            this.#toolCalls.push({ id: slot.id, name: slot.name, arguments: arguments_ });
          }
        }
        break;
      }
      case "message_delta":
        if (ev.delta?.stop_reason != null) this.#stopReason = ev.delta.stop_reason;
        if (ev.usage) this.#mergeUsage(ev.usage);
        break;
      case "message_stop": {
        const usage = this.#buildUsage();
        if (usage) out.push({ type: "usage", usage });
        out.push(this.#finalise());
        break;
      }
      default:
        // Unknown / future event types: ignore politely.
        break;
    }
    return out;
  }

  /** The terminal `finish` for a stream that closed without `message_stop`. */
  finalize(): LlmChunk | undefined {
    if (this.#finished) return undefined;
    return this.#finalise();
  }

  #parseToolInput(name: string, partialInput: string): JsonValue {
    if (partialInput.trim() === "") return {};
    try {
      return JSON.parse(partialInput) as JsonValue;
    } catch (e) {
      throw new ProviderError(
        `invalid tool arguments for ${name}: ${errorText(e)}; raw=${partialInput}`,
      );
    }
  }

  #mergeUsage(other: AnUsageRaw): void {
    if (other.input_tokens !== undefined) this.#pendingUsage.input_tokens = other.input_tokens;
    if (other.output_tokens !== undefined) this.#pendingUsage.output_tokens = other.output_tokens;
    if (other.cache_creation_input_tokens !== undefined) {
      this.#pendingUsage.cache_creation_input_tokens = other.cache_creation_input_tokens;
    }
    if (other.cache_read_input_tokens !== undefined) {
      this.#pendingUsage.cache_read_input_tokens = other.cache_read_input_tokens;
    }
  }

  #buildUsage(): Usage | undefined {
    return flattenUsage(this.#pendingUsage);
  }

  #finalise(): LlmChunk {
    this.#finished = true;

    const toolCalls = this.#toolCalls;
    this.#toolCalls = [];
    const finishReason = mapStopReason(this.#stopReason, toolCalls);
    const content = this.#text === "" ? undefined : this.#text;
    this.#text = "";

    return {
      type: "finish",
      message: assistantMessage(content, toolCalls),
      finish_reason: finishReason,
      response_id: null,
    };
  }
}

/** Anthropic seeds `tool_use` blocks with `{}` or null; treat both as "no input yet". */
function isEmptyInput(input: JsonValue | undefined): boolean {
  if (input === undefined || input === null) return true;
  if (typeof input === "object" && !Array.isArray(input)) {
    return Object.keys(input).length === 0;
  }
  return false;
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

      // Each block is `event: <name>\ndata: <json>\n\n`. We ignore the `event:`
      // header — the JSON body always carries a `type` field that identifies it.
      let pos: number;
      while ((pos = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, pos + 2);
        buf = buf.slice(pos + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice("data:".length).trim();
          if (data === "") continue;
          let parsed: StreamEventRaw;
          try {
            parsed = JSON.parse(data) as StreamEventRaw;
          } catch (e) {
            throw new ProviderError(`decode event: ${errorText(e)}; raw=${data}`);
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

  const finish = acc.finalize();
  if (finish) yield finish;
}
