// Test-only subagent that echoes its task back as a sequence of frames + a
// final message. Used by tests to verify the frame-relay path
// (subagent -> sink -> outer loop) without spinning up an LLM. Ported from
// harness-subagents/src/echo.rs.
import { emitSubagent, type SubAgent, type SubAgentInput, type SubAgentOutput } from "./subagent.ts";
import type { JsonValue } from "@jarvis/core";

/**
 * Predictable subagent for tests. Emits `started`, three `delta`s that spell
 * out the task one chunk at a time, then `done`.
 */
export class EchoSubAgent implements SubAgent {
  readonly name: string;
  readonly description =
    "Test-only subagent that echoes its task back. Not registered in production.";

  constructor(name: string) {
    this.name = name;
  }

  inputSchema(): JsonValue {
    return {
      type: "object",
      properties: { task: { type: "string" } },
      required: ["task"],
    };
  }

  async invoke(input: SubAgentInput): Promise<SubAgentOutput> {
    const id = crypto.randomUUID();
    emitSubagent({
      subagent_id: id,
      subagent_name: this.name,
      event: { kind: "started", task: input.task },
    });

    // Split the task into thirds by character (or whole string if short),
    // matching the Rust byte-third chunking closely enough for the
    // frame-sequence assertions.
    const t = input.task;
    const chunks =
      t.length < 3
        ? [t]
        : [t.slice(0, Math.floor(t.length / 3)), t.slice(Math.floor(t.length / 3), Math.floor(t.length / 3) * 2), t.slice(Math.floor(t.length / 3) * 2)];
    for (const c of chunks) {
      emitSubagent({
        subagent_id: id,
        subagent_name: this.name,
        event: { kind: "delta", text: c },
      });
    }

    const finalMessage = `echoed: ${input.task}`;
    emitSubagent({
      subagent_id: id,
      subagent_name: this.name,
      event: { kind: "done", final_message: finalMessage },
    });

    return {
      message: finalMessage,
      artifacts: [{ kind: "doc_summary", summary: input.task, quotes: [] }],
    };
  }
}
