import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultCompleteStream, type ChatRequest, type ChatResponse, type LlmChunk } from "./llm.ts";
import { assistantText } from "./message.ts";

async function collect(it: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  for await (const chunk of it) out.push(chunk);
  return out;
}

const req: ChatRequest = { model: "test", messages: [] };

test("defaultCompleteStream: emits a usage chunk before finish when complete() reports usage", async () => {
  const resp: ChatResponse = {
    message: assistantText("hi"),
    finish_reason: "stop",
    usage: { prompt_tokens: 12, completion_tokens: 3 },
  };
  const chunks = await collect(defaultCompleteStream({ complete: async () => resp }, req));
  assert.equal(chunks[0]?.type, "usage");
  assert.equal(chunks[1]?.type, "finish");
  assert.deepEqual(
    (chunks[0] as Extract<LlmChunk, { type: "usage" }>).usage,
    { prompt_tokens: 12, completion_tokens: 3 },
  );
});

test("defaultCompleteStream: no usage chunk when complete() omits usage", async () => {
  const resp: ChatResponse = { message: assistantText("hi"), finish_reason: "stop" };
  const chunks = await collect(defaultCompleteStream({ complete: async () => resp }, req));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.type, "finish");
});
