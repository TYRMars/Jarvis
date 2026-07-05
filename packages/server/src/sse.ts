// Server-Sent-Events serialisation of an AgentEvent stream.
//
// Streaming invariant (from harness-server): SSE and WS both just serialise
// `Agent.runStream` AgentEvents — the loop is never reimplemented per
// transport. Each `data:` line is exactly one AgentEvent JSON. The stream
// ends after the single terminal `done` / `error` event.
//
// Client-disconnect detection: the HTTP socket's `close` event races against
// each generator pull. When the client drops mid-stream we stop pulling from
// the agent generator (and `return()` it) so its loop suspends and dispatches
// no further tools — mirroring the WS abort path in chat-routes.ts. This is
// cooperative, not a hard cancel: an already in-flight LLM/tool call still
// finishes server-side (Node has no task-abort primitive) and its result is
// discarded, but nothing after it runs. Without this an orphaned run would
// keep executing gated tools (fs.write / shell.exec) against the workspace
// with no consumer.
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

  // Built ONCE (not per event) so we register a single `close` listener. If the
  // socket is already gone by the time we start, resolve immediately.
  let clientGone = false;
  const closedP = new Promise<"closed">((resolve) => {
    const markGone = (): void => {
      clientGone = true;
      resolve("closed");
    };
    if (raw.writableEnded || raw.destroyed) markGone();
    else raw.on("close", markGone);
  });

  const it = events[Symbol.asyncIterator]();
  try {
    for (;;) {
      // Short-circuit before advancing the generator if the client is already
      // gone (socket dead at start, or closed during the previous write).
      if (clientGone) break;
      const next = it.next();
      const raced = await Promise.race([next, closedP]);
      if (raced === "closed") {
        // Client dropped: abandon the in-flight pull (swallow any late
        // rejection so it doesn't surface as an unhandled rejection) and stop.
        next.catch(() => {});
        break;
      }
      if (raced.done) break;
      const ev = raced.value;
      raw.write(`data: ${JSON.stringify(ev)}\n\n`);
      if (ev.type === "done" || ev.type === "error") {
        if (onTerminal) await onTerminal(ev);
        break;
      }
    }
  } catch (e) {
    // A dead socket write throws asynchronously; don't try to report an error
    // frame back over a connection the client already closed.
    if (!clientGone && !raw.writableEnded) {
      raw.write(`data: ${JSON.stringify({ type: "error", message: errorText(e) })}\n\n`);
    }
  } finally {
    // Let the generator run its cleanup (finally blocks) and terminate rather
    // than leaving it suspended at a yield. Fire-and-forget; a late rejection
    // from an abandoned in-flight step is expected and ignored.
    it.return?.(undefined as never)?.catch(() => {});
    if (!raw.writableEnded) raw.end();
  }
}
