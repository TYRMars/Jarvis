// Internal subagent — wraps a fresh agent loop with a restricted system
// prompt + tool subset and translates its AgentEvent stream into
// SubAgentEvent frames the outer loop relays to UIs. Ported from
// harness-subagents/src/internal.rs.
//
// Used by `read_doc`, `review`, and the path-A `codex` built-ins.
//
// Injectable seam: the Rust runner builds a `harness_core::Agent` directly
// from a provider + AgentConfig. Here we take a `createAgent` factory so the
// caller (composition root) owns provider/tool/config construction — the same
// seam the server package uses (`AutoModeDeps.createAgent`). The factory
// returns anything with `runStream(conversation) -> AsyncIterable<AgentEvent>`
// (the @jarvis/core Agent satisfies this).
//
// The runner does NOT itself install a `withSubagent` scope — the outer agent
// loop already did when it set up the wrapping tool invocation, so
// `emitSubagent` from inside this runner reaches the outer channel directly.
import {
  conversationWithSystem,
  userMessage,
  lastAssistantText,
  type AgentEvent,
  type Conversation,
  type JsonValue,
} from "@jarvis/core";
import {
  emitSubagent,
  type Artifact,
  type SubAgent,
  type SubAgentInput,
  type SubAgentOutput,
} from "./subagent.ts";

/**
 * The slice of `@jarvis/core`'s `Agent` the internal runner depends on. A
 * factory returning this is the injectable seam; production wires the real
 * `Agent`, tests pass a canned stub.
 */
export interface SubAgentRunner {
  runStream(conversation: Conversation): AsyncIterable<AgentEvent>;
}

/** Options handed to the `createAgent` factory for one inner run. */
export interface CreateAgentOptions {
  /** Inner LLM model id (already resolved — never the literal "default"). */
  model: string;
  /** Hard ceiling on inner agent iterations. */
  maxIterations: number;
  /** Sandbox root the inner tools resolve under. */
  sessionWorkspace: string;
}

/** Builds an inner agent for one subagent invocation. */
export type CreateAgent = (opts: CreateAgentOptions) => SubAgentRunner;

/**
 * Configuration for an InternalSubAgent. Built by the per-kind factories
 * (`docReader.build`, `reviewer.build`, `codex.build`) and passed straight
 * through to the constructor.
 */
export interface InternalSubAgentConfig {
  /** Tool-name suffix — exposed as `subagent.<name>`. Unique in the registry. */
  name: string;
  /** One-line description for the main agent's tool catalogue. */
  description: string;
  /**
   * System prompt installed on the inner conversation. Constrains the
   * subagent's role + allowed tools + output shape.
   */
  systemPrompt: string;
  /**
   * Inner LLM model id. `undefined` falls back to "default" on the wire — the
   * composition root should always pass a concrete model (see the
   * runaway-loop regression note in internal.test.ts).
   */
  model?: string;
  /** Hard ceiling on inner agent iterations. */
  maxIterations: number;
  /**
   * Factory that builds the inner agent (provider + tools + config). The
   * registry handed to the inner agent MUST NOT contain any `subagent.*`
   * tools — recursion is forbidden in v1.0.
   */
  createAgent: CreateAgent;
  /**
   * Whether the wrapping `subagent.<name>` tool needs approval. true for
   * workspace-mutating subagents (codex / claude_code); false for read-only.
   */
  requiresApproval: boolean;
}

/**
 * Generic internal subagent runner. Per-kind constructors live in the per-kind
 * modules (`doc-reader.ts`, `reviewer.ts`, `codex.ts`) and just pre-fill the
 * config.
 */
export class InternalSubAgent implements SubAgent {
  readonly #config: InternalSubAgentConfig;

  constructor(config: InternalSubAgentConfig) {
    this.#config = config;
  }

  get name(): string {
    return this.#config.name;
  }

  get description(): string {
    return this.#config.description;
  }

  inputSchema(): JsonValue {
    return {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Natural-language task. The subagent's system prompt constrains how it interprets and answers.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    };
  }

  requiresApproval(): boolean {
    return this.#config.requiresApproval;
  }

  async invoke(input: SubAgentInput): Promise<SubAgentOutput> {
    const id = crypto.randomUUID();
    const push = (event: Parameters<typeof emitSubagent>[0]["event"]): void => {
      emitSubagent({ subagent_id: id, subagent_name: this.#config.name, event });
    };

    const startEvent: { kind: "started"; task: string; model?: string } = {
      kind: "started",
      task: input.task,
    };
    if (this.#config.model !== undefined) startEvent.model = this.#config.model;
    push(startEvent);

    // Inner conversation: system prompt + the user's task; nothing else.
    const conversation: Conversation = conversationWithSystem(this.#config.systemPrompt);
    conversation.messages.push(userMessage(input.task));

    const model = this.#config.model ?? "default";
    const agent = this.#config.createAgent({
      model,
      maxIterations: this.#config.maxIterations,
      sessionWorkspace: input.workspace_root,
    });

    let finalMessage = "";
    let errorMessage: string | undefined;

    for await (const ev of agent.runStream(conversation)) {
      if (ev.type === "delta") {
        if (ev.content.length > 0) push({ kind: "delta", text: ev.content });
      } else if (ev.type === "tool_start") {
        push({ kind: "tool_start", name: ev.name, arguments: ev.arguments });
      } else if (ev.type === "tool_end") {
        push({ kind: "tool_end", name: ev.name, output: ev.content });
      } else if (ev.type === "usage") {
        const { type: _type, model: usageModel, ...usage } = ev;
        push({ kind: "usage", model: usageModel, ...usage });
      } else if (ev.type === "error") {
        errorMessage = ev.message;
        break;
      } else if (ev.type === "done") {
        finalMessage = lastAssistantText(ev.conversation) ?? "";
        break;
      }
      // Pass through nothing else — inner approval prompts / plan updates /
      // nested subagent events stay private to the inner loop.
    }

    if (errorMessage !== undefined) {
      push({ kind: "error", message: errorMessage });
      throw new Error(`subagent error: ${errorMessage}`);
    }

    push({ kind: "done", final_message: finalMessage });

    const artifacts = extractArtifacts();
    const out: SubAgentOutput = { message: finalMessage };
    if (artifacts.length > 0) out.artifacts = artifacts;
    return out;
  }
}

/**
 * Per-kind artifact extraction is a future enhancement (Rust v1.0 returns
 * none; the final message is the load-bearing output).
 */
function extractArtifacts(): Artifact[] {
  return [];
}
