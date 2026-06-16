// Server-Sent-Events serialisation of an AgentEvent stream.
//
// Streaming invariant (from harness-server): SSE and WS both just serialise
// `Agent.runStream` AgentEvents — the loop is never reimplemented per
// transport. Each `data:` line is exactly one AgentEvent JSON. The stream
// ends after the single terminal `done` / `error` event.
import type { FastifyReply } from "fastify";
import { errorText, type AgentEvent } from "@jarvis/core";

export async function streamSse(
  reply: FastifyReply,
  events: AsyncIterable<AgentEvent>,
  onTerminal?: (ev: AgentEvent) => Promise<void> | void,
): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  try {
    for await (const ev of events) {
      raw.write(`data: ${JSON.stringify(ev)}\n\n`);
      if (ev.type === "done" || ev.type === "error") {
        if (onTerminal) await onTerminal(ev);
        break;
      }
    }
  } catch (e) {
    raw.write(`data: ${JSON.stringify({ type: "error", message: errorText(e) })}\n\n`);
  } finally {
    raw.end();
  }
}
