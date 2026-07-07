// Generic OpenAI Responses-API provider. Ported from
// harness-llm/src/responses.rs.
//
// Speaks the Responses API wire shape: top-level `instructions` (system) +
// an `input` array of typed items (`message`, `function_call`,
// `function_call_output`) + typed SSE events finalising on `response.completed`.
//
// One implementation, two presets:
//   * ResponsesProvider.codex(auth)        — chatgpt.com/backend-api/codex/responses
//                                            (ChatGPT subscription OAuth).
//   * ResponsesProvider.openaiResponses(k) — api.openai.com/v1/responses (API key).
//
// Load-bearing differences from Chat Completions (the OpenAI provider):
//   1. `system` messages become top-level `instructions` (joined with "\n\n").
//   2. Tool calls are FIRST-CLASS items, not embedded: each Assistant tool_call
//      becomes a separate {type:"function_call",call_id,name,arguments} item in
//      the top-level `input` array; each Tool reply becomes a
//      {type:"function_call_output",call_id,output} item.
//   3. Streaming uses typed events; the `finish` chunk is synthesised on
//      `response.completed` (or on body close as a fallback).
//
// Tool names are sanitised to `^[a-zA-Z0-9_-]+$` on the way out (Codex/GPT-5
// reject `fs.read`) and restored via a per-request name map on the way in.
//
// The Codex backend (and most reasoning models on the public surface) reject
// `stream:false` outright, so `complete()` drives `completeStream()` and
// collapses the chunks into a `ChatResponse` — the wire stays stream-only.
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
import type { CodexAuth } from "./codex-auth.ts";
import { autoCacheKey } from "./cache-key.ts";

// ---------- Auth ----------

/**
 * How the provider obtains the bearer token. A discriminated union so future
 * endpoints (Azure AD, Bedrock, …) slot in as new variants without touching
 * the request loop.
 */
export type ResponsesAuth =
  | { kind: "api_key"; apiKey: string }
  | { kind: "chatgpt_oauth"; auth: CodexAuth };

/** What the request layer puts on the wire: bearer + optional account id. */
interface BearerSnapshot {
  token: string;
  accountId: string | null;
}

function snapshotAuth(auth: ResponsesAuth): BearerSnapshot {
  switch (auth.kind) {
    case "api_key":
      return { token: auth.apiKey, accountId: null };
    case "chatgpt_oauth":
      return { token: auth.auth.accessToken, accountId: auth.auth.accountId };
  }
}

/**
 * Run a refresh only if the in-memory token is still the one the caller saw —
 * concurrent 401s collapse into one network refresh and stale callers just
 * retry with the already-refreshed token. API-key auth can't refresh, so a 401
 * surfaces verbatim.
 */
async function refreshIfUnchanged(auth: ResponsesAuth, expectedToken: string): Promise<void> {
  switch (auth.kind) {
    case "api_key":
      throw new ProviderError("API-key auth cannot refresh; rotate the key");
    case "chatgpt_oauth": {
      if (auth.auth.accessToken !== expectedToken) return;
      try {
        await auth.auth.refresh();
      } catch (e) {
        throw new ProviderError(`oauth refresh: ${errorText(e)}`);
      }
    }
  }
}

// ---------- Config ----------

/**
 * Configuration for {@link ResponsesProvider}. Build via
 * {@link responsesCodexConfig} / {@link responsesOpenAiConfig} for the two
 * supported flavours, then spread overrides.
 */
export interface ResponsesConfig {
  auth: ResponsesAuth;
  /** e.g. `https://chatgpt.com/backend-api` or `https://api.openai.com/v1`. */
  baseUrl: string;
  /** e.g. `/codex/responses` or `/responses`. The URL is `baseUrl + path`. */
  path: string;
  /** Sent as the `originator` header (Codex-only). `null` for public OpenAI. */
  originator: string | null;
  /** `OpenAI-Beta` header value. Codex sends `responses=v1`. */
  openaiBeta: string | null;
  /**
   * `store` field on the request. Ships `false` so the provider keeps no
   * server-side state (we own it via the harness store). The Codex backend
   * rejects `store:true` outright.
   */
  store: boolean;
  /** `service_tier` — `"auto"` / `"priority"` / `"flex"`. `null` lets the server pick. */
  serviceTier: string | null;
  /** Ask for `reasoning.encrypted_content` to be returned (reasoning models). */
  includeEncryptedReasoning: boolean;
  /** Reasoning summary verbosity (`"auto"` / `"concise"` / `"detailed"`). */
  reasoningSummary: string | null;
  /** Reasoning effort tier (`"low"` / `"medium"` / `"high"` / `"xhigh"`). */
  reasoningEffort: string | null;
  /** Hint for token estimation (unused here; kept for parity). */
  defaultModel: string | null;
  /** Pin a `prompt_cache_key`; unset → auto-derive from (model, instructions, tools). */
  promptCacheKey: string | null;
  /**
   * Enable `previous_response_id` chaining. When on and the caller supplies a
   * `previous_response_id` (+ in-bounds `chain_origin`), only the post-anchor
   * delta is sent and `store` is forced true for that request. Default false
   * for both flavours.
   */
  chainResponses: boolean;
  /** Inject a `fetch` implementation (tests / proxies). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Codex flavour: ChatGPT subscription OAuth +
 * `chatgpt.com/backend-api/codex/responses`. `chainResponses` defaults to
 * `false` because the Codex backend rejects `store:true` (which chaining
 * forces).
 */
export function responsesCodexConfig(auth: CodexAuth, overrides: Partial<ResponsesConfig> = {}): ResponsesConfig {
  return {
    auth: { kind: "chatgpt_oauth", auth },
    baseUrl: "https://chatgpt.com/backend-api",
    path: "/codex/responses",
    originator: "jarvis",
    openaiBeta: "responses=v1",
    store: false,
    serviceTier: null,
    includeEncryptedReasoning: false,
    reasoningSummary: null,
    reasoningEffort: null,
    defaultModel: null,
    promptCacheKey: null,
    chainResponses: false,
    ...overrides,
  };
}

/**
 * Public OpenAI flavour: API key + `api.openai.com/v1/responses`. Suited to
 * reasoning models and any feature OpenAI ships only on the Responses surface.
 */
export function responsesOpenAiConfig(apiKey: string, overrides: Partial<ResponsesConfig> = {}): ResponsesConfig {
  return {
    auth: { kind: "api_key", apiKey },
    baseUrl: "https://api.openai.com/v1",
    path: "/responses",
    originator: null,
    openaiBeta: null,
    store: false,
    serviceTier: null,
    includeEncryptedReasoning: false,
    reasoningSummary: null,
    reasoningEffort: null,
    defaultModel: null,
    promptCacheKey: null,
    chainResponses: false,
    ...overrides,
  };
}

// ---------- Provider ----------

export class ResponsesProvider implements LlmProvider {
  readonly #cfg: ResponsesConfig;
  readonly #fetch: typeof fetch;

  constructor(cfg: ResponsesConfig) {
    this.#cfg = cfg;
    this.#fetch = cfg.fetchImpl ?? fetch;
  }

  /** Codex flavour convenience constructor. */
  static codex(auth: CodexAuth, overrides: Partial<ResponsesConfig> = {}): ResponsesProvider {
    return new ResponsesProvider(responsesCodexConfig(auth, overrides));
  }

  /** Public OpenAI Responses API convenience constructor. */
  static openaiResponses(apiKey: string, overrides: Partial<ResponsesConfig> = {}): ResponsesProvider {
    return new ResponsesProvider(responsesOpenAiConfig(apiKey, overrides));
  }

  endpoint(): string {
    return `${this.#cfg.baseUrl}${this.#cfg.path}`;
  }

  /**
   * Drive `completeStream` and collapse the chunks into a `ChatResponse`. The
   * wire is stream-only (the Codex backend rejects `stream:false`).
   */
  async complete(req: ChatRequest): Promise<ChatResponse> {
    const stream = await this.completeStream(req);
    let lastFinish: { message: Message; finishReason: FinishReason; responseId: string | null } | undefined;
    let lastUsage: Usage | undefined;
    for await (const chunk of stream) {
      switch (chunk.type) {
        case "content_delta":
        case "tool_call_delta":
          break;
        case "usage":
          // Responses normally ships exactly one Usage chunk per request
          // (right before finish); keep the latest in case a future protocol
          // revision sends incremental updates.
          lastUsage = chunk.usage;
          break;
        case "finish":
          lastFinish = {
            message: chunk.message,
            finishReason: chunk.finish_reason,
            responseId: chunk.response_id ?? null,
          };
          break;
      }
    }
    if (!lastFinish) {
      throw new ProviderError("responses stream ended without a Finish chunk");
    }
    return {
      message: lastFinish.message,
      finish_reason: lastFinish.finishReason,
      response_id: lastFinish.responseId,
      usage: lastUsage,
    };
  }

  async completeStream(req: ChatRequest): Promise<AsyncIterable<LlmChunk>> {
    const { request, nameMap } = buildResponsesRequest(req, this.#cfg, true);

    let resp: Response;
    let triedRefresh = false;
    for (;;) {
      const snapshot = snapshotAuth(this.#cfg.auth);
      try {
        resp = await this.#post(request, snapshot, true);
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        throw new ProviderError(`transport: ${errorText(e)}`);
      }
      if (resp.status === 401 && !triedRefresh) {
        triedRefresh = true;
        await refreshIfUnchanged(this.#cfg.auth, snapshot.token);
        continue;
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new ProviderError(`status ${resp.status}: ${text}`);
      }
      break;
    }

    if (!resp.body) throw new ProviderError("stream response had no body");
    return sseChunks(resp.body, new StreamAccumulator(nameMap));
  }

  async #post(body: unknown, snapshot: BearerSnapshot, stream: boolean): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${snapshot.token}`,
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
    };
    if (this.#cfg.openaiBeta !== null) headers["OpenAI-Beta"] = this.#cfg.openaiBeta;
    if (this.#cfg.originator !== null) headers["originator"] = this.#cfg.originator;
    if (snapshot.accountId !== null) headers["ChatGPT-Account-ID"] = snapshot.accountId;
    return this.#fetch(this.endpoint(), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }
}

// ---------- Tool-name sanitisation ----------

/**
 * Map any character that isn't `[A-Za-z0-9_-]` to `_`. Idempotent for names
 * that already match. The Responses API rejects dotted names like `fs.read`.
 */
export function sanitizeToolName(name: string): string {
  let out = "";
  for (const c of name) {
    out += /[a-zA-Z0-9_-]/.test(c) ? c : "_";
  }
  return out;
}

function restoreToolName(map: Map<string, string>, sanitized: string): string {
  return map.get(sanitized) ?? sanitized;
}

// ---------- Outbound request building ----------

export interface ResponsesOutbound {
  request: Record<string, unknown>;
  /** sanitized → original tool-name map, for restoring on response/stream. */
  nameMap: Map<string, string>;
}

/**
 * Build the wire request body + the name map. Mirrors
 * `ResponsesRequest::from_chat_request`. Empty `tools` / `service_tier` /
 * `include` / `reasoning` / chain fields are omitted to match serde's
 * `skip_serializing_if`.
 */
export function buildResponsesRequest(r: ChatRequest, cfg: ResponsesConfig, stream: boolean): ResponsesOutbound {
  const tools = r.tools ?? [];
  const nameMap = new Map<string, string>();
  for (const t of tools) nameMap.set(sanitizeToolName(t.name), t.name);

  // Chain is active iff: config opts in, caller supplied previous_response_id,
  // AND chain_origin is in bounds (paranoia guard against stale history).
  const chainOrigin = r.chain_origin ?? null;
  const prevId = r.previous_response_id ?? null;
  const chainingActive =
    cfg.chainResponses && prevId !== null && chainOrigin !== null && chainOrigin <= r.messages.length;

  const messages = chainingActive
    ? // Retain System messages (they ride every turn via instructions / the
      // prefix cache) and drop non-system messages before the chain anchor.
      r.messages.filter((m, i) => m.role === "system" || i >= chainOrigin)
    : r.messages;

  const { instructions, input } = convertMessages(messages);

  const include: string[] = [];
  // When chaining, the server already has the prior encrypted reasoning in its
  // cached state — echoing it back is wasteful and can trigger a 400.
  if (cfg.includeEncryptedReasoning && !chainingActive) {
    include.push("reasoning.encrypted_content");
  }

  // Emit `reasoning` when EITHER summary or effort is configured.
  let reasoning: { summary?: string; effort?: string } | undefined;
  if (cfg.reasoningSummary !== null || cfg.reasoningEffort !== null) {
    reasoning = {};
    if (cfg.reasoningSummary !== null) reasoning.summary = cfg.reasoningSummary;
    if (cfg.reasoningEffort !== null) reasoning.effort = cfg.reasoningEffort;
  }

  const wireTools = tools.map(toWireTool);

  // Auto-derive a stable prompt_cache_key from the post-sanitise wire shape.
  // Config override wins.
  const cacheKey = cfg.promptCacheKey ?? autoCacheKey(r.model, instructions ?? "", JSON.stringify(wireTools));

  // store=true is required for the server to keep the chain alive; override the
  // config-level setting for chained requests only.
  const store = chainingActive ? true : cfg.store;

  // Honour the caller's parallel_tool_calls preference; legacy default false.
  const parallelToolCalls = r.parallel_tool_calls ?? false;

  const request: Record<string, unknown> = { model: r.model };
  if (instructions !== null) request.instructions = instructions;
  request.input = input;
  if (wireTools.length > 0) request.tools = wireTools;
  request.tool_choice = "auto";
  request.parallel_tool_calls = parallelToolCalls;
  request.store = store;
  request.stream = stream;
  if (cfg.serviceTier !== null) request.service_tier = cfg.serviceTier;
  if (include.length > 0) request.include = include;
  if (reasoning !== undefined) request.reasoning = reasoning;
  request.prompt_cache_key = cacheKey;
  if (chainingActive && prevId !== null) request.previous_response_id = prevId;

  return { request, nameMap };
}

function toWireTool(t: ToolSpec): Record<string, unknown> {
  return {
    type: "function",
    name: sanitizeToolName(t.name),
    description: t.description,
    parameters: t.parameters,
  };
}

type InputItem =
  | { type: "message"; role: "user" | "assistant"; content: MessagePart[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

type MessagePart = { type: "input_text"; text: string } | { type: "output_text"; text: string };

/**
 * Pull all System messages into top-level `instructions` (joined with "\n\n")
 * and rewrite the rest into Responses-API `input` items. Each Assistant
 * tool_call becomes a separate `function_call` item; each Tool reply becomes a
 * `function_call_output` item. Empty assistant text is dropped.
 */
function convertMessages(messages: Message[]): { instructions: string | null; input: InputItem[] } {
  let systems = "";
  const input: InputItem[] = [];

  for (const m of messages) {
    switch (m.role) {
      case "system":
        if (systems !== "") systems += "\n\n";
        systems += m.content;
        break;
      case "user":
        input.push({ type: "message", role: "user", content: [{ type: "input_text", text: m.content }] });
        break;
      case "assistant": {
        if (m.content != null && m.content !== "") {
          input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: m.content }] });
        }
        for (const tc of m.tool_calls ?? []) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            // Historical assistant function calls must also use sanitised names.
            name: sanitizeToolName(tc.name),
            arguments: JSON.stringify(tc.arguments),
          });
        }
        break;
      }
      case "tool":
        input.push({ type: "function_call_output", call_id: m.tool_call_id, output: m.content });
        break;
    }
  }

  return { instructions: systems === "" ? null : systems, input };
}

// ---------- Response decoding (shared by stream + decoder tests) ----------

interface RespUsageRaw {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

function respUsageIntoCore(u: RespUsageRaw): Usage {
  const out: Usage = {};
  if (u.input_tokens !== undefined) out.prompt_tokens = u.input_tokens;
  if (u.output_tokens !== undefined) out.completion_tokens = u.output_tokens;
  const cached = u.input_tokens_details?.cached_tokens;
  if (cached !== undefined) out.cached_prompt_tokens = cached;
  const reasoning = u.output_tokens_details?.reasoning_tokens;
  if (reasoning !== undefined) out.reasoning_tokens = reasoning;
  return out;
}

interface OutputItemRaw {
  type?: string;
  content?: { type?: string; text?: string }[];
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface ResponsesResponseBodyRaw {
  id?: string | null;
  output?: OutputItemRaw[];
  status?: string | null;
  incomplete_details?: { reason?: string | null } | null;
  usage?: RespUsageRaw | null;
  error?: { code?: string | null; message?: string | null } | null;
}

/**
 * Pure decoder for a complete `response` body (as it rides on
 * `response.completed`). Exposed for unit tests; the production path runs the
 * accumulator instead.
 */
export function intoChatResponse(body: ResponsesResponseBodyRaw, nameMap: Map<string, string>): ChatResponse {
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const item of body.output ?? []) {
    switch (item.type) {
      case "message":
        for (const part of item.content ?? []) {
          if (part.type === "output_text" && part.text !== undefined) text += part.text;
        }
        break;
      case "function_call": {
        const original = restoreToolName(nameMap, item.name ?? "");
        toolCalls.push({
          id: item.call_id ?? "",
          name: original,
          arguments: parseFunctionArgs(original, item.arguments ?? ""),
        });
        break;
      }
      // "reasoning" and any unknown item type are ignored (forward-compat).
      default:
        break;
    }
  }
  const content = text === "" ? undefined : text;
  const finishReason = mapFinishReason(body.status ?? null, body.incomplete_details ?? null, toolCalls);
  const usage = body.usage ? respUsageIntoCore(body.usage) : undefined;
  return {
    message: assistantMessage(content, toolCalls),
    finish_reason: finishReason,
    response_id: body.id ?? null,
    usage,
  };
}

/** Assemble an assistant message, omitting empty `content`/`tool_calls` (serde `skip_serializing_if`). */
function assistantMessage(content: string | undefined, toolCalls: ToolCall[]): Message {
  const m: Extract<Message, { role: "assistant" }> = { role: "assistant" };
  if (content !== undefined) m.content = content;
  if (toolCalls.length > 0) m.tool_calls = toolCalls;
  return m;
}

function parseFunctionArgs(name: string, raw: string): JsonValue {
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as JsonValue;
  } catch (e) {
    throw new ProviderError(`invalid tool arguments for ${name}: ${errorText(e)}; raw=${raw}`);
  }
}

function mapFinishReason(
  status: string | null,
  incomplete: { reason?: string | null } | null,
  toolCalls: ToolCall[],
): FinishReason {
  if (status === "incomplete") {
    const reason = incomplete?.reason ?? null;
    if (reason === "max_output_tokens") return "length";
    if (reason !== null) return { other: reason };
    return { other: "incomplete" };
  }
  if (toolCalls.length > 0) return "tool_calls";
  if (status === "completed" || status === null) return "stop";
  return { other: status };
}

// ---------- Streaming events + accumulator ----------

interface StreamEventRaw {
  type?: string;
  output_index?: number;
  item?: OutputItemRaw;
  delta?: string;
  response?: ResponsesResponseBodyRaw;
}

/**
 * Reassembles a streamed Responses completion. `ingest` returns the chunks to
 * forward (the terminal `finish` is emitted inline on `response.completed`);
 * `flush` synthesises a `finish` if the body closed without one.
 */
export class StreamAccumulator {
  #text = "";
  #toolCalls: ToolCall[] = [];
  #status: string | null = null;
  #incompleteReason: string | null = null;
  #finished = false;
  #responseId: string | null = null;
  readonly #nameMap: Map<string, string>;

  constructor(nameMap: Map<string, string> = new Map()) {
    this.#nameMap = nameMap;
  }

  ingest(ev: StreamEventRaw): LlmChunk[] {
    const out: LlmChunk[] = [];
    switch (ev.type) {
      case "response.output_item.added": {
        const item = ev.item;
        if (item?.type === "function_call") {
          const original = restoreToolName(this.#nameMap, item.name ?? "");
          out.push({
            type: "tool_call_delta",
            index: ev.output_index ?? 0,
            id: item.call_id ?? "",
            name: original,
          });
        }
        break;
      }
      case "response.output_text.delta": {
        const delta = ev.delta ?? "";
        if (delta !== "") {
          this.#text += delta;
          out.push({ type: "content_delta", content: delta });
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const delta = ev.delta ?? "";
        if (delta !== "") {
          out.push({ type: "tool_call_delta", index: ev.output_index ?? 0, arguments_fragment: delta });
        }
        break;
      }
      case "response.output_item.done": {
        const item = ev.item;
        if (item?.type === "function_call") {
          const original = restoreToolName(this.#nameMap, item.name ?? "");
          this.#toolCalls.push({
            id: item.call_id ?? "",
            name: original,
            arguments: parseFunctionArgs(original, item.arguments ?? ""),
          });
        }
        break;
      }
      case "response.completed": {
        const response = ev.response ?? {};
        if (response.status != null) this.#status = response.status;
        if (response.incomplete_details?.reason != null) {
          this.#incompleteReason = response.incomplete_details.reason;
        }
        if (response.id != null) this.#responseId = response.id;
        if (response.usage) out.push({ type: "usage", usage: respUsageIntoCore(response.usage) });
        out.push(this.finalise());
        break;
      }
      case "response.failed": {
        // A mid-stream failure must surface as an error, never finalise as a
        // silent empty `stop`. Mirror the blocking path's ProviderError.
        const err = ev.response?.error;
        const detail = err?.message ?? err?.code ?? ev.response?.status ?? "unknown error";
        this.#finished = true; // suppress the body-close finalise() fallback
        throw new ProviderError(`responses stream failed: ${detail}`);
      }
      // response.created / .in_progress / .content_part.* / .output_text.done /
      // .function_call_arguments.done / any unknown event → dropped.
      default:
        break;
    }
    return out;
  }

  /** True once a terminal `finish` has been produced. */
  get finished(): boolean {
    return this.#finished;
  }

  finalise(): LlmChunk {
    this.#finished = true;
    const toolCalls = this.#toolCalls;
    this.#toolCalls = [];
    const incomplete = this.#incompleteReason !== null ? { reason: this.#incompleteReason } : null;
    this.#incompleteReason = null;
    const finishReason = mapFinishReason(this.#status, incomplete, toolCalls);
    const content = this.#text === "" ? undefined : this.#text;
    this.#text = "";
    const responseId = this.#responseId;
    this.#responseId = null;
    return {
      type: "finish",
      message: assistantMessage(content, toolCalls),
      finish_reason: finishReason,
      response_id: responseId,
    };
  }
}

// ---------- SSE consumption ----------

async function* sseChunks(body: ReadableStream<Uint8Array>, acc: StreamAccumulator): AsyncGenerator<LlmChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Normalise CRLF so `\r\n\r\n` frames split and `data:` lines match even
      // through a CRLF-normalising proxy/intermediary (#383).
      buf = buf.replace(/\r\n/g, "\n");

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

  if (!acc.finished) yield acc.finalise();
}
