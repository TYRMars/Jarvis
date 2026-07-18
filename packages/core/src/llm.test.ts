import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultCompleteStream, type ChatRequest, type ChatResponse, type LlmChunk } from "./llm.ts";
import { assistantText } from "./message.ts";

function req(): ChatRequest {
  return { model: "m", messages: [] };
}

async function collect(iter: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

test("defaultCompleteStream emits a usage chunk (before finish) when complete() reports usage", async () => {
  const resp: ChatResponse = {
    message: assistantText("hi"),
    finish_reason: "stop",
    usage: { prompt_tokens: 7, completion_tokens: 3 },
  };
  const provider = { complete: async (_r: ChatRequest): Promise<ChatResponse> => resp };

  const chunks = await collect(defaultCompleteStream(provider, req()));

  const usageIdx = chunks.findIndex((c) => c.type === "usage");
  const finishIdx = chunks.findIndex((c) => c.type === "finish");
  assert.notEqual(usageIdx, -1, "a usage chunk must be emitted");
  assert.ok(usageIdx < finishIdx, "usage must precede finish");
  const usage = chunks[usageIdx];
  assert.equal(usage.type === "usage" && usage.usage.prompt_tokens, 7);
  assert.equal(usage.type === "usage" && usage.usage.completion_tokens, 3);
});

test("defaultCompleteStream omits the usage chunk when complete() reports none", async () => {
  const resp: ChatResponse = { message: assistantText("hi"), finish_reason: "stop" };
  const provider = { complete: async (_r: ChatRequest): Promise<ChatResponse> => resp };

  const chunks = await collect(defaultCompleteStream(provider, req()));

  assert.equal(
    chunks.some((c) => c.type === "usage"),
    false,
  );
  assert.equal(chunks.at(-1)?.type, "finish");
});
