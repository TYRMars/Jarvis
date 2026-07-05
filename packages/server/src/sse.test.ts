import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { streamSse } from "./sse.ts";
import type { AgentEvent } from "@jarvis/core";
import type { FastifyReply } from "fastify";

/**
 * A minimal fake `FastifyReply` whose `raw` is an EventEmitter so a test can
 * `emit("close")` to simulate a client disconnect. Records every SSE frame
 * written and whether the response was ended.
 */
function fakeReply(): { reply: FastifyReply; raw: EventEmitter & Record<string, unknown>; writes: string[] } {
  const writes: string[] = [];
  const raw = new EventEmitter() as EventEmitter & Record<string, unknown>;
  raw.writableEnded = false;
  raw.destroyed = false;
  raw.writeHead = () => raw;
  raw.write = (s: string) => {
    writes.push(s);
    return true;
  };
  raw.end = () => {
    raw.writableEnded = true;
  };
  const reply = { hijack() {}, raw } as unknown as FastifyReply;
  return { reply, raw, writes };
}

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("streamSse: writes each event then ends on the terminal `done`", async () => {
  const { reply, writes, raw } = fakeReply();
  const terminals: AgentEvent[] = [];
  const gen = (async function* (): AsyncGenerator<AgentEvent> {
    yield { type: "delta", content: "hi" } as AgentEvent;
    yield { type: "done", conversation: { messages: [] } } as unknown as AgentEvent;
  })();

  await streamSse(reply, gen, (ev) => {
    terminals.push(ev);
  });

  assert.equal(writes.length, 2);
  assert.match(writes[0]!, /"type":"delta"/);
  assert.match(writes[1]!, /"type":"done"/);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.type, "done");
  assert.equal(raw.writableEnded, true);
});

test("streamSse: client disconnect stops the run before it dispatches more tools", async () => {
  const { reply, raw, writes } = fakeReply();
  // Side effects the agent generator performs AFTER the disconnect point. In
  // the real loop these are gated tool calls (fs.write / shell.exec); here they
  // stand in for "work no one is watching". They must never run once the
  // client has dropped.
  const toolCalls: string[] = [];
  // A gate the generator blocks on for its second pull — left closed forever,
  // exactly as if no consumer ever pulls again after the disconnect.
  const gate = new Promise<void>(() => {});
  const gen = (async function* (): AsyncGenerator<AgentEvent> {
    yield { type: "delta", content: "first" } as AgentEvent; // pull 1
    await gate; // pull 2 parks here — the client drops while we're here
    toolCalls.push("orphaned-tool"); // must NOT execute
    yield { type: "delta", content: "second" } as AgentEvent;
  })();

  const p = streamSse(reply, gen);
  await tick(); // let the first event flow and the generator park on `gate`
  assert.equal(writes.length, 1, "only the pre-disconnect event was written");

  raw.emit("close"); // client drops mid-stream
  await p; // resolves promptly — the loop breaks rather than draining the run

  assert.equal(writes.length, 1, "no further events written after disconnect");
  assert.equal(toolCalls.length, 0, "no tools dispatched after the client left");
  assert.equal(raw.writableEnded, true, "response was ended");
});

test("streamSse: a socket already closed at start writes nothing", async () => {
  const { reply, raw, writes } = fakeReply();
  raw.destroyed = true; // gone before we begin
  let pulled = 0;
  const gen = (async function* (): AsyncGenerator<AgentEvent> {
    pulled++;
    yield { type: "delta", content: "never seen" } as AgentEvent;
  })();

  await streamSse(reply, gen);

  assert.equal(writes.length, 0, "nothing written to a dead socket");
  assert.equal(pulled, 0, "generator was never advanced");
});
