# @jarvis/client

TypeScript SDK for the Jarvis agent runtime HTTP API. Zero runtime
dependencies — uses the platform `fetch` (Node ≥ 18, browsers, Deno, Bun).

The wire surface this client targets is the curated OpenAPI document the
server serves at `GET /v1/openapi.json`.

## Usage

```ts
import { JarvisClient } from "@jarvis/client";

const jarvis = new JarvisClient({ baseUrl: "http://127.0.0.1:7001" });

// meta
console.log(await jarvis.version()); // { name: "jarvis", version: "0.2.0" }

// chat — blocking
const { message } = await jarvis.chat.complete({
  messages: [{ role: "user", content: "hello" }],
});

// chat — streaming (one AgentEvent per SSE frame)
for await (const ev of jarvis.chat.stream({ messages: [{ role: "user", content: "hi" }] })) {
  if (ev.type === "delta") process.stdout.write(String(ev.content));
}

// persisted conversations
const { id } = await jarvis.conversations.create({ system: "be terse" });
await jarvis.conversations.postMessage(id, { content: "what changed today?" });

// work (projects + requirements kanban)
const project = await jarvis.work.projects.create({ name: "demo" });
await jarvis.work.requirements.create("demo", { title: "ship the SDK" });

// long-term memory
await jarvis.memory.list({ scope: "user", limit: 50 });
```

Errors are thrown as `JarvisApiError { status, body }`. Endpoints backed by
an unconfigured store reply `503`.

## Build

```bash
npm install
npm run build       # tsc → dist/
npm run typecheck
```
