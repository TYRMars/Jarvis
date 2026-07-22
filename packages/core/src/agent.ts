// The harness agent loop. Ported from harness-core/src/agent.rs (the
// load-bearing subset). Two entry points, same loop:
//
//   run(conversation)        -> blocking; returns RunOutcome
//   runStream(conversation)  -> async generator of AgentEvent
//
// Invariants preserved from the Rust implementation:
//   * Before the first LLM call the configured systemPrompt is prepended iff
//     there's no in-sync leading System message (see ensureSystemPrompt).
//   * Tool errors are caught and surfaced as text (`tool error: <e>`); an
//     approver Deny surfaces `tool denied: <reason>`. Neither aborts the loop.
//   * run() throws MaxIterationsError when the loop never terminates.
//   * runStream() yields exactly one terminal `done` (carrying the full
//     Conversation) or one `error`, and nothing after it.
//   * runStream() yields `approval_request` BEFORE awaiting the approver so an
//     interactive transport has a chance to decide; `tool_start`/`tool_end`
//     always wrap the call (even on the deny path).
//
// Deferred to later phases (documented in nodejs-rewrite-tasklist.zh-CN.md):
// parallel tool dispatch, tool_filter (Plan Mode), session workspace, HITL,
// memory-compaction / subagent / fallback / mode events, Responses chaining.
import type { Conversation } from "./conversation.ts";
import { systemMessage, toolResult, type Message, type ToolCall } from "./message.ts";
import {
  addUsage,
  emptyUsage,
  type ChatRequest,
  type FinishReason,
  type LlmChunk,
  type LlmProvider,
  type Usage,
} from "./llm.ts";
import { ToolRegistry, toolCategory, toolRequiresApproval, type Tool } from "./tool.ts";
import type { Approver, ApprovalDecision, ApprovalRequest } from "./approval.ts";
import type { Memory } from "./memory.ts";
import { withPlan, type PlanItem } from "./plan.ts";
import { withProgress, type ToolProgress } from "./progress.ts";
import { errorText, MaxIterationsError, MemoryError } from "./error.ts";
import type { JsonValue } from "./json.ts";

export interface AgentConfig {
  model: string;
  systemPrompt?: string;
  tools: ToolRegistry;
  maxIterations: number;
  temperature?: number;
  memory?: Memory;
  approver?: Approver;
  /** Replace a stale leading System message on resume. Default: true. */
  refreshSystemPromptOnResume: boolean;
}

export function defaultAgentConfig(model: string): AgentConfig {
  return {
    model,
    tools: new ToolRegistry(),
    maxIterations: 10,
    refreshSystemPromptOnResume: true,
  };
}

/** What ended a run. */
export type RunOutcome =
  | { kind: "stopped"; iterations: number }
  | { kind: "length_limited"; iterations: number };

/** An event emitted during runStream. Transports serialise these directly. */
export type AgentEvent =
  | { type: "delta"; content: string }
  | { type: "assistant_message"; message: Message; finish_reason: FinishReason }
  | { type: "approval_request"; id: string; name: string; arguments: JsonValue }
  | { type: "approval_decision"; id: string; name: string; decision: ApprovalDecision }
  | { type: "tool_start"; id: string; name: string; arguments: JsonValue }
  | { type: "tool_progress"; id: string; name: string; stream: string; chunk: string }
  | { type: "tool_end"; id: string; name: string; content: string }
  | { type: "plan_update"; items: PlanItem[] }
  | ({ type: "usage"; model: string } & Usage)
  | { type: "done"; outcome: RunOutcome; conversation: Conversation }
  | { type: "error"; message: string };

export class Agent {
  readonly llm: LlmProvider;
  readonly config: AgentConfig;

  constructor(llm: LlmProvider, config: AgentConfig) {
    this.llm = llm;
    this.config = config;
  }

  /** Blocking run. Throws MaxIterationsError if the loop never terminates. */
  async run(conversation: Conversation): Promise<RunOutcome> {
    const [outcome] = await this.runWithUsage(conversation);
    return outcome;
  }

  /** Like `run` but also returns aggregated provider-reported usage. */
  async runWithUsage(conversation: Conversation): Promise<[RunOutcome, Usage]> {
    ensureSystemPrompt(conversation, this.config.systemPrompt, this.config.refreshSystemPromptOnResume);
    const totalUsage = emptyUsage();

    for (let iter = 1; iter <= this.config.maxIterations; iter++) {
      const req = await this.buildRequest(conversation);
      const resp = await this.llm.complete(req);
      conversation.messages.push(resp.message);
      if (resp.usage) addUsage(totalUsage, resp.usage);
      if (resp.response_id) {
        conversation.last_response_id = resp.response_id;
        conversation.last_response_chain_origin = conversation.messages.length;
      }

      const message = resp.message;
      if (isToolCallTurn(message, resp.finish_reason)) {
        for (const call of message.tool_calls) {
          const approval = await maybeRequestApproval(this.config.tools, this.config.approver, call);
          const output = await runOne(this.config.tools, call, approval?.[1]);
          conversation.messages.push(toolResult(call.id, output));
        }
        continue;
      }

      const outcome: RunOutcome =
        resp.finish_reason === "length"
          ? { kind: "length_limited", iterations: iter }
          : { kind: "stopped", iterations: iter };
      return [outcome, totalUsage];
    }

    throw new MaxIterationsError(this.config.maxIterations);
  }

  /** Streaming run. Yields exactly one terminal `done` or `error`. */
  async *runStream(conversation: Conversation): AsyncGenerator<AgentEvent> {
    ensureSystemPrompt(conversation, this.config.systemPrompt, this.config.refreshSystemPromptOnResume);

    for (let iter = 1; iter <= this.config.maxIterations; iter++) {
      let req: ChatRequest;
      try {
        req = await this.buildRequest(conversation);
      } catch (e) {
        yield { type: "error", message: errorText(e) };
        return;
      }

      let stream: AsyncIterable<LlmChunk>;
      try {
        stream = await this.llm.completeStream(req);
      } catch (e) {
        yield { type: "error", message: errorText(e) };
        return;
      }

      let finish: { message: Message; finish_reason: FinishReason; response_id?: string | null } | undefined;
      try {
        for await (const chunk of stream) {
          if (chunk.type === "content_delta") {
            yield { type: "delta", content: chunk.content };
          } else if (chunk.type === "usage") {
            // Prefer the model the request actually ran on (set by wrappers that
            // rewrite the model mid-flight, e.g. RoutingProvider) so usage is
            // attributed and priced against the right model — falling back to
            // the static request model for plain providers.
            yield { type: "usage", model: chunk.model ?? this.config.model, ...chunk.usage };
          } else if (chunk.type === "finish") {
            finish = {
              message: chunk.message,
              finish_reason: chunk.finish_reason,
              response_id: chunk.response_id,
            };
            break;
          }
          // tool_call_delta: tool calls are surfaced via `finish`, not streamed.
        }
      } catch (e) {
        yield { type: "error", message: errorText(e) };
        return;
      }

      if (!finish) {
        yield { type: "error", message: "llm stream ended without a Finish chunk" };
        return;
      }

      conversation.messages.push(finish.message);
      if (finish.response_id) {
        conversation.last_response_id = finish.response_id;
        conversation.last_response_chain_origin = conversation.messages.length;
      }
      yield { type: "assistant_message", message: finish.message, finish_reason: finish.finish_reason };

      const message = finish.message;
      if (isToolCallTurn(message, finish.finish_reason)) {
        for (const call of message.tool_calls) {
          // Resolve the approval decision, emitting the request BEFORE awaiting
          // the approver so an interactive transport can respond in time.
          let decision: ApprovalDecision | undefined;
          const tool = this.config.tools.resolve(call.name);
          if (this.config.approver && tool && toolRequiresApproval(tool)) {
            const request: ApprovalRequest = {
              tool_call_id: call.id,
              tool_name: call.name,
              arguments: call.arguments,
              category: toolCategory(tool),
            };
            yield { type: "approval_request", id: call.id, name: call.name, arguments: call.arguments };
            try {
              decision = await this.config.approver.approve(request);
            } catch (e) {
              decision = { decision: "deny", reason: `approver failed: ${errorText(e)}` };
            }
            yield { type: "approval_decision", id: call.id, name: call.name, decision };
          }

          yield { type: "tool_start", id: call.id, name: call.name, arguments: call.arguments };

          // Stream plan/progress emitted during invoke, live, then tool_end.
          const queue = new EventQueue<AgentEvent>();
          const planSink = (items: PlanItem[]): void => queue.push({ type: "plan_update", items });
          const progressSink = (p: ToolProgress): void =>
            queue.push({ type: "tool_progress", id: call.id, name: call.name, stream: p.stream, chunk: p.chunk });

          const invoked = withPlan(planSink, () =>
            withProgress(progressSink, () => runOne(this.config.tools, call, decision)),
          ).finally(() => queue.close());

          for await (const ev of queue.drain()) yield ev;
          const content = await invoked;

          yield { type: "tool_end", id: call.id, name: call.name, content };
          conversation.messages.push(toolResult(call.id, content));
        }
        continue;
      }

      const outcome: RunOutcome =
        finish.finish_reason === "length"
          ? { kind: "length_limited", iterations: iter }
          : { kind: "stopped", iterations: iter };
      yield { type: "done", outcome, conversation };
      return;
    }

    yield {
      type: "error",
      message: `agent reached max iterations (${this.config.maxIterations}) without terminating`,
    };
  }

  /** Assemble the next ChatRequest (compacting via memory unless chained). */
  async buildRequest(conv: Conversation): Promise<ChatRequest> {
    const chained = conv.last_response_id != null && conv.last_response_chain_origin != null;
    let messages: Message[];
    if (this.config.memory && !chained) {
      try {
        messages = await this.config.memory.compact(conv.messages);
      } catch (e) {
        throw new MemoryError(errorText(e));
      }
    } else {
      messages = [...conv.messages];
    }

    const req: ChatRequest = { model: this.config.model, messages };
    const tools = this.config.tools.specs();
    if (tools.length > 0) req.tools = tools;
    if (this.config.temperature !== undefined) req.temperature = this.config.temperature;
    if (conv.last_response_id != null) req.previous_response_id = conv.last_response_id;
    if (conv.last_response_chain_origin != null) req.chain_origin = conv.last_response_chain_origin;
    return req;
  }
}

type ToolCallMessage = Extract<Message, { role: "assistant" }> & { tool_calls: ToolCall[] };

function isToolCallTurn(message: Message, finishReason: FinishReason): message is ToolCallMessage {
  return (
    message.role === "assistant" &&
    finishReason === "tool_calls" &&
    Array.isArray(message.tool_calls) &&
    message.tool_calls.length > 0
  );
}

/**
 * Prepend / refresh the system prompt. Mirrors Rust's ensure_system_prompt:
 *   - no prompt configured           → nothing
 *   - leading System in sync         → nothing
 *   - leading System stale + refresh → replace it
 *   - leading System stale, !refresh → leave it
 *   - no leading System              → insert at index 0
 */
export function ensureSystemPrompt(
  conv: Conversation,
  prompt: string | undefined,
  refresh: boolean,
): void {
  if (prompt === undefined) return;
  const first = conv.messages[0];
  if (first && first.role === "system") {
    if (first.content === prompt) return;
    if (refresh) conv.messages[0] = systemMessage(prompt);
    return;
  }
  conv.messages.unshift(systemMessage(prompt));
}

/**
 * Ask the configured approver about `call` iff an approver is set and the
 * tool's `requiresApproval` is true. Returns `[request, decision]` when a
 * round-trip happened, else undefined. An approver throw becomes a Deny.
 */
async function maybeRequestApproval(
  tools: ToolRegistry,
  approver: Approver | undefined,
  call: ToolCall,
): Promise<[ApprovalRequest, ApprovalDecision] | undefined> {
  if (!approver) return undefined;
  const tool = tools.resolve(call.name);
  if (!tool) return undefined;
  if (!toolRequiresApproval(tool)) return undefined;

  const request: ApprovalRequest = {
    tool_call_id: call.id,
    tool_name: call.name,
    arguments: call.arguments,
    category: toolCategory(tool),
  };
  let decision: ApprovalDecision;
  try {
    decision = await approver.approve(request);
  } catch (e) {
    decision = { decision: "deny", reason: `approver failed: ${errorText(e)}` };
  }
  return [request, decision];
}

/**
 * Invoke `call` if `decision` permits, else surface the deny reason as text.
 * Tool errors (and tool-not-found) are caught and surfaced as text too, so
 * the model can read them and adapt.
 */
async function runOne(
  tools: ToolRegistry,
  call: ToolCall,
  decision: ApprovalDecision | undefined,
): Promise<string> {
  if (decision && decision.decision === "deny") {
    return `tool denied: ${decision.reason ?? "no reason given"}`;
  }
  const tool: Tool | undefined = tools.resolve(call.name);
  if (!tool) return `tool error: tool not found: ${call.name}`;
  try {
    return await tool.invoke(call.arguments);
  } catch (e) {
    return `tool error: ${errorText(e)}`;
  }
}

/**
 * A tiny single-consumer async queue used to relay tool-emitted plan/progress
 * events live while `invoke` runs. `drain()` yields buffered items as they
 * arrive and returns once `close()` is called (after invoke settles).
 */
class EventQueue<T> {
  #items: T[] = [];
  #wake: (() => void) | null = null;
  #closed = false;

  push(item: T): void {
    this.#items.push(item);
    this.#signal();
  }

  close(): void {
    this.#closed = true;
    this.#signal();
  }

  #signal(): void {
    const wake = this.#wake;
    if (wake) {
      this.#wake = null;
      wake();
    }
  }

  async *drain(): AsyncGenerator<T> {
    for (;;) {
      while (this.#items.length > 0) {
        yield this.#items.shift() as T;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}
