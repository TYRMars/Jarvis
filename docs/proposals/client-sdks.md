# Client SDKs (TypeScript + Python)

**Status:** Proposed
**Touches:** new `clients/typescript/` and `clients/python/`
directories at the repo root; `harness-server` adds an OpenAPI doc
endpoint to enable schema-driven type generation; minor `serde`
attribute additions to keep wire shapes stable.

## Motivation

The HTTP/WS surface is the integration point for everyone who isn't
a Rust caller — application backends, IDE plugins, browser-based
tools, automation. Hand-rolled clients reinvent the protocol every
time and drift. Two thin SDKs (TS + Python) are the minimum: they
cover ~95% of integrators and exercise the whole API surface as
end-to-end tests.

Goals:

- **Faithful to the wire.** SDK types match server JSON 1:1; no
  surprise renames, no helper layers that hide the
  `{type:"approve",...}` envelope.
- **Streaming first.** Both SSE and WebSocket are first-class. SSE
  yields an `AsyncIterator` / Python `async for`; WS exposes typed
  send/recv with a session helper.
- **Fully typed.** Generated from a single source of truth so the
  trait surface drift is impossible.
- **Small.** Each SDK ≤ ~1500 LOC. No fancy retry / circuit-breaker /
  caching layers in v0 — that's the integrator's job.

## Single source of truth

The hand-aligned approach is brittle (we've already seen drift
between docs and routes during normal development). Two reasonable
ways to derive the SDKs:

### Option A — emit OpenAPI from the server (recommended)

Add `utoipa` (or `aide`) to `harness-server`. Annotate handlers and
shared types. Expose `GET /openapi.json` (gated behind a feature flag
in production builds — default-on, since it's harmless).

Pros:
- One source: the Rust types.
- Type generation is a build-time `npm run gen` / `pip run gen`.
- Future routes get covered automatically.

Cons:
- `utoipa` macros add noise to handlers.
- WS / SSE can't be fully described in OpenAPI 3.x — those need
  hand-written wrappers either way.

### Option B — hand-written `protocol/protocol.json` schema

A single JSON file in the repo root describing every wire type
(`Message`, `Conversation`, `AgentEvent`, `WsClientMessage`, …).
Server derives Rust types via `schemars` + a build script that
asserts the runtime types match.

Pros:
- No runtime dep on `utoipa`.
- Single readable artifact reviewers can diff.

Cons:
- Manual upkeep; nothing prevents drift unless the build script
  catches it.

**Decision:** Option A for the HTTP CRUD endpoints (it's the obvious
fit). Option B-style hand-written enums for `AgentEvent` and the WS
client/server messages — they're small and OpenAPI doesn't model
them well anyway.

## TypeScript SDK shape

Package: `@jarvis/client` (or scoped to your org name).

```ts
import { JarvisClient } from "@jarvis/client";

const client = new JarvisClient({ baseUrl: "http://localhost:7001" });

// --- one-shot completion (blocking) ---
const result = await client.chat.complete({
  messages: [{ role: "user", content: "hi" }],
});
console.log(result.message.content);

// --- streaming completion (SSE) ---
for await (const event of client.chat.stream({
  messages: [{ role: "user", content: "count to 3" }],
})) {
  if (event.type === "delta") process.stdout.write(event.content);
}

// --- persisted conversation CRUD ---
const { id } = await client.conversations.create({ system: "you are jarvis" });
await client.conversations.append(id, { content: "summarise the readme" });
const history = await client.conversations.get(id);

// --- WebSocket session with interactive approval ---
const session = client.ws.connect();
await session.resume(id);                          // or session.new()
session.send({ type: "user", content: "rewrite README" });
for await (const event of session.events()) {
  if (event.type === "approval_request") {
    const ok = confirm(`approve ${event.name}?`);
    session.send(ok
      ? { type: "approve", tool_call_id: event.id }
      : { type: "deny",    tool_call_id: event.id });
  }
}
```

Implementation:
- `fetch` for HTTP, native `WebSocket` (browser) / `ws` (node).
- SSE: `ReadableStream` + a tiny line-buffered parser (~30 LOC).
- Types from generated OpenAPI + hand-written WS / SSE event union.
- `tsup` for ESM + CJS dual build, no bundling (consumers bundle).
- Zero runtime deps except `ws` for node.

Layout:
```
clients/typescript/
  src/
    index.ts          # JarvisClient root
    chat.ts           # complete + stream
    conversations.ts  # CRUD + append + stream
    ws.ts             # WS session helper
    events.ts         # AgentEvent / WsClientMessage union types
    sse.ts            # parser
  test/
  package.json
  tsconfig.json
```

## Python SDK shape

Package: `jarvis-client` on PyPI.

```python
from jarvis_client import JarvisClient

async with JarvisClient(base_url="http://localhost:7001") as client:
    # one-shot
    result = await client.chat.complete(
        messages=[{"role": "user", "content": "hi"}]
    )

    # streaming SSE
    async for event in client.chat.stream(
        messages=[{"role": "user", "content": "count"}]
    ):
        if event.type == "delta":
            print(event.content, end="")

    # CRUD
    convo = await client.conversations.create(system="you are jarvis")
    await client.conversations.append(convo.id, content="hello")

    # WS interactive
    async with client.ws.session() as ws:
        await ws.resume(convo.id)
        await ws.send_user("rewrite README")
        async for event in ws.events():
            if event.type == "approval_request":
                ok = input(f"approve {event.name}? ").lower() == "y"
                await (ws.approve(event.id) if ok else ws.deny(event.id))
```

Implementation:
- `httpx.AsyncClient` for HTTP.
- `httpx-sse` (or 50 LOC of parser) for SSE.
- `websockets` for WS.
- Types via `pydantic` v2 models generated from OpenAPI
  (`datamodel-code-generator`).
- `pyproject.toml` with `hatch` build, py3.10+ (for `match` ergonomics
  in the event handler).

Layout:
```
clients/python/
  src/jarvis_client/
    __init__.py
    client.py
    chat.py
    conversations.py
    ws.py
    events.py
    sse.py
  tests/
  pyproject.toml
```

## Versioning + release

Both SDKs version-lock against the server using semver-on-the-wire:
the server reports its protocol version via `GET /v1/version` (added
in this proposal), e.g. `{"server":"jarvis 0.4.0","protocol":"1"}`.
SDK majors track protocol majors. Client warns on protocol mismatch.

CI:
- New workflow `clients-ci`: starts the jarvis server with
  `MemoryConversationStore` + a mock LLM provider (a tiny in-process
  one that returns canned responses), runs the SDK test suites against
  it. Catches drift on every PR.

## Implementation cuts

1. **Server: OpenAPI emission.** Add `utoipa` macros to handlers in
   `harness-server`; expose `GET /openapi.json`. ~200 LOC of
   annotations. Tests: snapshot the spec, fail on drift.
2. **Server: `GET /v1/version`.** Trivial.
3. **TypeScript SDK skeleton.** `JarvisClient` with HTTP CRUD only.
   Generated types from OpenAPI. Publish `0.0.1`. ~400 LOC.
4. **TS SDK SSE.** `chat.stream` / `conversations.appendStream`.
   ~150 LOC.
5. **TS SDK WS.** Session helper + typed events. ~250 LOC.
6. **Python SDK skeleton.** Mirrors TS layout. CRUD + types. ~400 LOC.
7. **Python SDK SSE.** ~100 LOC.
8. **Python SDK WS.** ~200 LOC.
9. **Mock LLM for CI.** Add `MockLlmProvider` to harness-llm under a
   `mock` cargo feature: returns canned responses keyed on request
   shape. Reusable for any test. ~150 LOC.
10. **Cross-language CI workflow.**

Each step is an independently shippable PR.

## Risks / open questions

- **OpenAPI macro friction.** `utoipa` annotations clutter handlers.
  If it's too noisy, fall back to Option B (hand-written schema) for
  the troublesome shapes. Either way the cost is bounded.
- **Generated-code review burden.** Generated TS types and Python
  models check in or build-time only? **Recommendation:** check in,
  with a CI guard that re-runs the generator and `git diff --exit-code`
  fails the build on drift. Reviewers then see the actual diff in
  PRs that change the spec.
- **`AgentEvent` discriminated union in TS.** TypeScript handles
  `{type: "delta" | "tool_start" | ...}` cleanly via discriminated
  unions. Python via `Literal`-tagged Pydantic models. Both are
  ergonomic but only since recent versions.
- **License headers / publishing.** Decide MIT vs Apache-2.0 (matches
  the workspace's license setting), set up trusted-publishing to npm
  / PyPI before the first release.

## Out of scope

- Other languages (Go, Java, …). Add later if there's demand.
- High-level helpers like "chat with retries", "rate limiter", "audit
  log adapter". These belong in user code.
- Auth helpers (Bearer / API-key middleware). When the server gets
  auth, the SDKs grow a `Authorization` header config; until then,
  empty.
