// Google Gemini (`generativelanguage.googleapis.com`) provider. Ported from
// harness-llm/src/google.rs.
//
// Wire shape diverges from OpenAI in three load-bearing ways:
//
//   1. System prompts live in a top-level `systemInstruction.parts: [{text}]`,
//      separate from `contents` (all the System messages joined with "\n\n").
//   2. Roles are `user` / `model` (assistant → model; there is no `tool` role).
//      A model-side tool call is a `functionCall` part; a tool's reply travels
//      back as a `functionResponse` part inside a `user`-role message, the raw
//      text wrapped as `{ "result": "<text>" }`.
//   3. Tool calls carry NO id on the wire. We synthesise stable `gem_<index>`
//      ids on the way in so the harness's id-keyed routing keeps working, and
//      resolve the name from the prior assistant turn's tool-calls when sending
//      tool results back. Resolution is scoped to the *current turn* (the
//      synthesised ids restart at `gem_0` each turn) — issue #45 regression.
//
// Streaming uses `:streamGenerateContent?alt=sse`. Each SSE event is a complete
// `GenerateContentResponse` slice: text parts are deltas to concatenate;
// `functionCall` parts arrive WHOLE (Gemini does not fragment tool-call args).
// There is no in-band `[DONE]` / `message_stop` sentinel — the server simply
// closes the body, so the terminal `finish` is synthesised from accumulated
// state once the HTTP body closes (with any usage chunk emitted just before).
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

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export interface GoogleConfig {
  apiKey: string;
  /** Defaults to `https://generativelanguage.googleapis.com/v1beta`. */
  baseUrl?: string;
  /** Inject a `fetch` implementation (tests / proxies). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class GoogleProvider implements LlmProvider {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(cfg: GoogleConfig) {
    this.#apiKey = cfg.apiKey;
    this.#baseUrl = cfg.baseUrl ?? DEFAULT_BASE_URL;
    this.#fetch = cfg.fetchImpl ?? fetch;
  }

  async complete(req: ChatRequest): Promise<ChatResponse> {
    const body = buildGoogleRequest(req);
    const url = `${this.#baseUrl}/models/${req.model}:generateContent?key=${encodeURIComponent(this.#apiKey)}`;
    const resp = await this.#post(url, body);

    let text: string;
    try {
      text = await resp.text();
    } catch (e) {
      throw new ProviderError(`read body: ${errorText(e)}`);
    }
    if (!resp.ok) throw new ProviderError(`status ${resp.status}: ${text}`);

    let parsed: GoogleResponseRaw;
    try {
      parsed = JSON.parse(text) as GoogleResponseRaw;
    } catch (e) {
      throw new ProviderError(`decode: ${errorText(e)}; body=${text}`);
    }
    return intoChatResponse(parsed);
  }

  async completeStream(req: ChatRequest): Promise<AsyncIterable<LlmChunk>> {
    const body = buildGoogleRequest(req);
    const url = `${this.#baseUrl}/models/${req.model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.#apiKey)}`;
    const resp = await this.#post(url, body);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new ProviderError(`status ${resp.status}: ${text}`);
    }
    if (!resp.body) throw new ProviderError("stream response had no body");
    return sseChunks(resp.body, new StreamAccumulator());
  }

  async #post(url: string, body: unknown): Promise<Response> {
    try {
      return await this.#fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Mirror of the `?key=` query param; harmless when the key is also
          // on the URL, and lets proxies that strip the query authenticate.
          "x-goog-api-key": this.#apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new ProviderError(`transport: ${errorText(e)}`);
    }
  }
}

// ---------- Outbound request building ----------

// A `parts` entry is one of three untagged shapes. We build plain objects so
// `JSON.stringify` produces exactly the wire shape (no discriminator key).
type GePart =
  | { text: string }
  | { functionCall: { name: string; args: JsonValue } }
  | { functionResponse: { name: string; response: JsonValue } };

interface GeContent {
  role?: "user" | "model";
  parts: GePart[];
}

export interface GoogleRequestBody {
  contents: GeContent[];
  systemInstruction?: GeContent;
  tools?: { functionDeclarations: { name: string; description: string; parameters: JsonValue }[] }[];
  generationConfig?: { temperature?: number; maxOutputTokens?: number };
}

function isFunctionResponsePart(p: GePart): boolean {
  return "functionResponse" in p;
}

/**
 * Build the Gemini wire body from a harness `ChatRequest`. Mirrors
 * `GoogleRequest::from_request`: hoist systems to `systemInstruction`, walk
 * messages once mapping assistant → `model` (with `functionCall` parts) and
 * tool replies → `functionResponse` parts coalesced into a `user` message,
 * resolving the tool name per-turn from the preceding assistant tool-calls.
 */
export function buildGoogleRequest(r: ChatRequest): GoogleRequestBody {
  // Pass 1: gather all system text.
  let systemText = "";
  for (const m of r.messages) {
    if (m.role === "system") {
      if (systemText !== "") systemText += "\n\n";
      systemText += m.content;
    }
  }

  // Tool-call id → name resolution scoped to the *current* turn. Gemini matches
  // functionResponse ↔ functionCall by name (no ids on the wire), and our
  // synthesised `gem_<index>` ids restart at `gem_0` every turn, so a
  // conversation-wide map would let a later turn's `gem_0` shadow an earlier
  // one (issue #45). Rebuild from each assistant turn's tool-calls.
  let currentTurnIds = new Map<string, string>();

  const contents: GeContent[] = [];
  for (const m of r.messages) {
    switch (m.role) {
      case "system":
        break;
      case "user":
        contents.push({ role: "user", parts: [{ text: m.content }] });
        break;
      case "assistant": {
        // Fresh resolution scope: a colliding `gem_<index>` from an earlier
        // turn can never leak into this turn's tool replies.
        currentTurnIds = new Map<string, string>();
        const toolCalls = m.tool_calls ?? [];
        for (const tc of toolCalls) currentTurnIds.set(tc.id, tc.name);

        const parts: GePart[] = [];
        if (m.content != null && m.content !== "") parts.push({ text: m.content });
        for (const tc of toolCalls) {
          parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
        }
        // Empty model turn — Gemini rejects; emit "" to round-trip safely.
        if (parts.length === 0) parts.push({ text: "" });
        contents.push({ role: "model", parts });
        break;
      }
      case "tool": {
        const name = currentTurnIds.get(m.tool_call_id) ?? m.tool_call_id;
        const part: GePart = {
          functionResponse: { name, response: { result: m.content } },
        };
        // Fold consecutive tool replies into a single user message so the
        // model sees the natural grouping.
        const last = contents[contents.length - 1];
        if (last && last.role === "user" && last.parts.every(isFunctionResponsePart)) {
          last.parts.push(part);
        } else {
          contents.push({ role: "user", parts: [part] });
        }
        break;
      }
    }
  }

  const out: GoogleRequestBody = { contents };

  if (systemText !== "") {
    out.systemInstruction = { parts: [{ text: systemText }] };
  }

  const tools = r.tools ?? [];
  if (tools.length > 0) {
    out.tools = [{ functionDeclarations: tools.map(toFunctionDeclaration) }];
  }

  if (r.temperature !== undefined || r.max_tokens !== undefined) {
    const cfg: { temperature?: number; maxOutputTokens?: number } = {};
    if (r.temperature !== undefined) cfg.temperature = r.temperature;
    if (r.max_tokens !== undefined) cfg.maxOutputTokens = r.max_tokens;
    out.generationConfig = cfg;
  }

  return out;
}

function toFunctionDeclaration(t: ToolSpec): { name: string; description: string; parameters: JsonValue } {
  return { name: t.name, description: t.description, parameters: t.parameters };
}

// ---------- Inbound response types ----------

interface GoogleResponseRaw {
  candidates?: GeCandidateRaw[];
  usageMetadata?: GeUsageRaw;
}

interface GeCandidateRaw {
  content?: { parts?: GeResponsePartRaw[] };
  finishReason?: string | null;
}

// A response part is untagged: either a functionCall, a text part, or an
// unknown shape (forward-compatible — we just ignore anything else).
interface GeResponsePartRaw {
  text?: string;
  functionCall?: { name: string; args?: JsonValue };
}

interface GeUsageRaw {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

function usageIntoCore(u: GeUsageRaw): Usage {
  const out: Usage = {};
  if (u.promptTokenCount !== undefined) out.prompt_tokens = u.promptTokenCount;
  if (u.candidatesTokenCount !== undefined) out.completion_tokens = u.candidatesTokenCount;
  if (u.cachedContentTokenCount !== undefined) out.cached_prompt_tokens = u.cachedContentTokenCount;
  if (u.thoughtsTokenCount !== undefined) out.reasoning_tokens = u.thoughtsTokenCount;
  return out;
}

/** Assemble an assistant message, omitting empty `content`/`tool_calls` to match serde `skip_serializing_if`. */
function assistantMessage(content: string | undefined, toolCalls: ToolCall[]): Message {
  const m: Extract<Message, { role: "assistant" }> = { role: "assistant" };
  if (content !== undefined) m.content = content;
  if (toolCalls.length > 0) m.tool_calls = toolCalls;
  return m;
}

function intoChatResponse(parsed: GoogleResponseRaw): ChatResponse {
  const candidates = parsed.candidates ?? [];
  const candidate = candidates[candidates.length - 1];
  if (!candidate) throw new ProviderError("response had no candidates");

  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const part of candidate.content?.parts ?? []) {
    if (part.functionCall !== undefined) {
      toolCalls.push(synthToolCall(part.functionCall, toolCalls.length));
    } else if (part.text !== undefined) {
      text += part.text;
    }
    // Anything else (unknown part shapes) is ignored — forward-compatible.
  }

  const content = text === "" ? undefined : text;
  const finishReason = mapFinishReason(candidate.finishReason, toolCalls);
  const usage = parsed.usageMetadata ? usageIntoCore(parsed.usageMetadata) : undefined;

  return {
    message: assistantMessage(content, toolCalls),
    finish_reason: finishReason,
    response_id: null,
    usage,
  };
}

/** Synthesise a `gem_<index>` id; null/absent args normalise to `{}`. */
function synthToolCall(fc: { name: string; args?: JsonValue }, index: number): ToolCall {
  const args: JsonValue = fc.args === undefined || fc.args === null ? {} : fc.args;
  return { id: `gem_${index}`, name: fc.name, arguments: args };
}

function mapFinishReason(raw: string | null | undefined, toolCalls: ToolCall[]): FinishReason {
  switch (raw) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case null:
    case undefined:
      return toolCalls.length > 0 ? "tool_calls" : "stop";
    default:
      return { other: raw };
  }
}

// ---------- Streaming accumulator ----------

/**
 * Reassemble a Gemini SSE stream into harness `LlmChunk`s. Gemini ships full
 * `GenerateContentResponse` slices on each event, not delta envelopes: text
 * parts are incremental (concatenate), `functionCall` parts arrive whole (one
 * `tool_call_delta` carrying both id and name, no `arguments_fragment`). The
 * terminal `finish` is synthesised from accumulated state once the body closes
 * — Gemini has no in-band sentinel. `finalise` also emits the latest
 * `usageMetadata` snapshot as a single `usage` chunk just before `finish`.
 */
export class StreamAccumulator {
  #text = "";
  #toolCalls: ToolCall[] = [];
  #finishReason: string | null | undefined;
  #finished = false;
  #usage: GeUsageRaw | undefined;

  ingest(chunk: GoogleResponseRaw): LlmChunk[] {
    const out: LlmChunk[] = [];
    // Gemini sends rolling usage totals on every chunk; keep the freshest.
    if (chunk.usageMetadata) this.#usage = chunk.usageMetadata;

    for (const candidate of chunk.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        if (part.functionCall !== undefined) {
          const index = this.#toolCalls.length;
          const tc = synthToolCall(part.functionCall, index);
          out.push({ type: "tool_call_delta", index, id: tc.id, name: tc.name });
          this.#toolCalls.push(tc);
        } else if (part.text !== undefined && part.text !== "") {
          this.#text += part.text;
          out.push({ type: "content_delta", content: part.text });
        }
        // Unknown part shapes are dropped.
      }
      if (candidate.finishReason != null) this.#finishReason = candidate.finishReason;
    }
    return out;
  }

  /** Whether `finalise`/`flush` has already run (avoids a double finish). */
  get finished(): boolean {
    return this.#finished;
  }

  /**
   * The chunks buffered at stream close: an optional `usage` (latest snapshot)
   * followed by the terminal `finish`. Returns `[]` if already finalised.
   */
  flush(): LlmChunk[] {
    if (this.#finished) return [];
    return this.finalise();
  }

  /** Synthesise the terminal chunks: usage (if any) then finish. */
  finalise(): LlmChunk[] {
    this.#finished = true;
    const out: LlmChunk[] = [];
    if (this.#usage !== undefined) {
      out.push({ type: "usage", usage: usageIntoCore(this.#usage) });
      this.#usage = undefined;
    }
    const toolCalls = this.#toolCalls;
    this.#toolCalls = [];
    const finishReason = mapFinishReason(this.#finishReason, toolCalls);
    const content = this.#text === "" ? undefined : this.#text;
    this.#text = "";
    out.push({
      type: "finish",
      message: assistantMessage(content, toolCalls),
      finish_reason: finishReason,
      response_id: null,
    });
    return out;
  }
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
      buf += decoder.decode(value, { stream: true });

      let pos: number;
      while ((pos = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, pos + 2);
        buf = buf.slice(pos + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice("data:".length).trim();
          if (data === "") continue;
          let parsed: GoogleResponseRaw;
          try {
            parsed = JSON.parse(data) as GoogleResponseRaw;
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

  // Gemini has no `[DONE]` / `message_stop` sentinel; the server simply closes
  // the body. Synthesise the terminal chunks from accumulated state.
  for (const c of acc.flush()) yield c;
}
