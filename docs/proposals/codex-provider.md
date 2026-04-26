# Codex provider (ChatGPT OAuth + Responses API)

**Status:** Adopted (initial implementation landed in
`crates/harness-llm/src/codex.rs` + `codex_auth.rs`. Path A
(`~/.codex/auth.json`) and Path C (static `CODEX_ACCESS_TOKEN`)
both wired; refresh-on-401 with concurrent-refresh coalescing.
Streaming + tool use end-to-end. Reasoning surface and Path B
PKCE flow remain proposed.)
**Touches:** new module `crates/harness-llm/src/codex.rs`, optional
new crate `crates/harness-codex-auth/` (OAuth flow + token store),
`apps/jarvis` provider switch.

## What this is — and what it isn't

OpenClaw, the OpenAI Codex CLI, and a handful of other clients all
share the same trick: bill calls to a ChatGPT Plus / Pro
**subscription** instead of a metered API key by talking to a
**different endpoint with a different auth scheme**, while the
**request body shape is the OpenAI Responses API**. So a "Codex
provider" is three things glued together:

1. **OAuth** with `auth.openai.com` (PKCE) instead of an API key.
2. **`https://chatgpt.com/backend-api/codex/responses`** instead of
   `https://api.openai.com/v1/responses`. (The non-`/codex/` path
   `/backend-api/responses` was an earlier alias that has since been
   removed; tokens issued by ChatGPT OAuth do **not** carry the
   `api.responses.write` scope, so they'd 401 on the public API.)
3. The standard **Responses API** body (`instructions`, `input`,
   `tools`, `stream`, `store`, `parallel_tool_calls`, `reasoning`,
   `prompt_cache_key`, `include: ["reasoning.encrypted_content"]`)
   plus a small set of **identity headers** (`OpenAI-Beta`,
   `ChatGPT-Account-ID`, a few `x-codex-*` telemetry tags) that tell
   the backend the request is coming from a Codex-class client.

It is **semi-official** — the endpoint isn't documented for third
parties, and it has changed before. We should treat it as a useful
escape hatch (subscription users want to reuse their existing
billing) but not as a long-term-stable contract.

### Caveats up front

- **ToS surface area.** OpenAI tolerates this pattern in the wild
  (the Codex CLI + ChatGPT subscription is the official supported
  path; clones piggy-back) but it is not contractually a public API.
  Document this clearly anywhere we ship it; don't surprise users.
- **Don't log tokens.** The access token is a short-lived JWT but
  the refresh token grants ~indefinite access. `tracing` filters and
  redacted Debug impls.
- **No usage metering.** ChatGPT subscriptions are flat-rate at the
  account level; the response body's `usage` block is informational,
  not billing.

## Reference: what OpenAI's own Codex CLI does

Drawn from
[`openai/codex`](https://github.com/openai/codex/tree/main/codex-rs).

**OAuth flow** (`codex-rs/login/src/server.rs`):

```text
issuer        = https://auth.openai.com
authorize     = {issuer}/oauth/authorize       (with PKCE, S256)
token         = {issuer}/oauth/token
scopes        = openid profile email offline_access
                api.connectors.read api.connectors.invoke
redirect_uri  = http://localhost:1455/auth/callback
loopback path = /auth/callback
```

A loopback HTTP server listens on `127.0.0.1:1455`, opens the
browser, intercepts the callback, exchanges the code for tokens via
PKCE, and writes them to `$CODEX_HOME/auth.json` (default
`~/.codex/auth.json`):

```json
{
  "id_token":      "...",
  "access_token":  "...",
  "refresh_token": "...",
  "account_id":    "..."
}
```

`account_id` is the ChatGPT workspace id and is sent as a separate
header on every request.

**Auth headers** (`codex-rs/model-provider/src/bearer_auth_provider.rs`,
quoted verbatim):

```rust
fn add_auth_headers(&self, headers: &mut HeaderMap) {
    if let Some(token) = self.token.as_ref() { /* … */
        headers.insert(AUTHORIZATION, format!("Bearer {token}").parse()?);
    }
    if let Some(account_id) = self.account_id.as_ref() {
        headers.insert("ChatGPT-Account-ID", account_id.parse()?);
    }
    if self.is_fedramp_account {
        headers.insert("X-OpenAI-Fedramp", "true".parse()?);
    }
}
```

**Other headers set on Codex-mode requests** (`codex-rs/core/src/client.rs`):

| Header | Notes |
|---|---|
| `OpenAI-Beta` | `responses_websockets=2026-02-06` (or the WS variant when negotiating WebSocket transport) |
| `x-codex-installation-id` | Stable per-machine UUID |
| `x-codex-window-id` | Per-process / per-window UUID |
| `x-codex-parent-thread-id` | If running inside a parent agent run |
| `x-openai-subagent` | Subagent role tag |
| `x-codex-beta-features` | Bitmask string |
| `x-codex-turn-state` / `x-codex-turn-metadata` | Conversation state for cache hits |
| `x-client-request-id` | Per-request idempotency / tracing |
| `x-responsesapi-include-timing-metrics` | `true` |

For Jarvis's first cut **only `Authorization`, `ChatGPT-Account-ID`,
and `OpenAI-Beta`** are load-bearing; the rest are telemetry and the
backend tolerates their absence (omitting them is also kinder
politically — we're not pretending to be Codex CLI). We'll send a
single `originator: jarvis` header so OpenAI can identify the
client cleanly if they want to.

**Body shape** (verified against Simon Willison's reverse-engineering
of `gpt-5-codex-mini`):

```json
{
  "model": "gpt-5-codex-mini",
  "instructions": "...system prompt...",
  "input": [
    { "type": "message", "role": "user",
      "content": [{ "type": "input_text", "text": "..." }] },
    { "type": "function_call", "call_id": "fc_…", "name": "fs.read",
      "arguments": "{\"path\":\"README.md\"}" },
    { "type": "function_call_output", "call_id": "fc_…",
      "output": "..." }
  ],
  "tools": [
    { "type": "function", "name": "fs.read",
      "description": "...", "parameters": { /* JSON schema */ } }
  ],
  "tool_choice": "auto",
  "parallel_tool_calls": false,
  "reasoning": { "summary": "auto" },
  "store": false,
  "stream": true,
  "include": ["reasoning.encrypted_content"],
  "prompt_cache_key": "<stable uuid per session>"
}
```

Compare to OpenClaw's notes (`docs/concepts/model-providers.md`):
> Provider plugin boundary stays the same; the OpenAI plugin owns
> both `openai/*` (API-key) and `openai-codex/*` (OAuth) — they're
> two **auth surfaces** sharing one wire format.

That's the model we should adopt: same `LlmProvider` impl shape as
the existing OpenAI provider (or rather, the planned Responses-API
provider — see [prompt-caching.md](prompt-caching.md) and the
earlier discussion that surfaced the Responses API), parameterised
on auth + base URL.

## Design

### Crate layout

Two new files, no new crates if we can help it:

```
crates/harness-llm/src/
  codex.rs                # CodexProvider (Responses API + ChatGPT OAuth)
  codex_responses_wire.rs # Shared with a future plain Responses provider
                          # (move out of codex.rs if/when we add the
                          # api.openai.com/v1/responses path)
```

A separate `harness-codex-auth` crate is **only** worth it if we want
to keep the OAuth machinery testable in isolation. For v0 the OAuth
helper lives next to the provider (`codex.rs::oauth`) and is small
(< 400 LOC).

### `LlmProvider` impl

Follows the Anthropic / Google pattern: `complete` via blocking POST,
`complete_stream` via SSE.

```rust
pub struct CodexConfig {
    pub access_token: String,         // Bearer
    pub account_id: Option<String>,   // ChatGPT-Account-ID
    pub base_url: String,             // default https://chatgpt.com/backend-api
    pub originator: String,           // default "jarvis"
    pub send_reasoning_summary: bool, // default true
    pub include_encrypted_reasoning: bool, // default true (prompt-caching wins)
}

pub struct CodexProvider {
    cfg: CodexConfig,
    http: reqwest::Client,
    /// Refreshes the bearer token when it expires. `None` means the
    /// caller is supplying a static token (tests, scripts).
    refresher: Option<Arc<dyn TokenRefresher>>,
}

#[async_trait]
impl LlmProvider for CodexProvider {
    async fn complete(&self, req: ChatRequest) -> Result<ChatResponse> { … }
    async fn complete_stream(&self, req: ChatRequest) -> Result<LlmStream> { … }
}
```

Endpoint composition:

```rust
fn endpoint(&self) -> String {
    format!("{}/codex/responses", self.cfg.base_url)
}
```

Auth header chain (lifted from
`bearer_auth_provider.rs`, trimmed to what we need):

```rust
let mut req = self.http.post(self.endpoint())
    .header(reqwest::header::AUTHORIZATION,
            format!("Bearer {}", self.cfg.access_token))
    .header("OpenAI-Beta", "responses=v1")
    .header("originator", &self.cfg.originator)
    .header(reqwest::header::CONTENT_TYPE, "application/json")
    .header(reqwest::header::ACCEPT, if stream { "text/event-stream" }
                                     else { "application/json" });
if let Some(id) = &self.cfg.account_id {
    req = req.header("ChatGPT-Account-ID", id);
}
```

### `Conversation` ↔ Responses API conversion

Same shape as the planned generic Responses API provider:

| `harness-core` `Message` | Responses API item |
|---|---|
| `System { content }` | top-level `instructions` (multiple joined with `\n\n`) |
| `User { content }` | `{ type:"message", role:"user", content:[{ type:"input_text", text }] }` |
| `Assistant { content: Some(t), tool_calls: [] }` | `{ type:"message", role:"assistant", content:[{ type:"output_text", text:t }] }` |
| `Assistant { content, tool_calls }` (calls present) | one optional `message` item + one `function_call` item per call (`call_id` = `tool_call.id`, `arguments` = stringified JSON) |
| `Tool { tool_call_id, content }` | `{ type:"function_call_output", call_id:tool_call_id, output:content }` |

`tool_call_id` round-trips cleanly because the Responses API uses
the same opaque-string semantics OpenAI Chat Completions uses — no
synthesis needed (unlike Gemini).

`tools` is a list of `{ type:"function", name, description,
parameters }`, matching how `Tool::specs()` already serializes.

### Streaming SSE event types

Responses API streams a typed event sequence. For the harness we
care about:

- `response.created` — ignore (just session start).
- `response.output_item.added` — when a `function_call` item starts,
  capture `call_id` and `name`; emit `LlmChunk::ToolCallDelta { id,
  name }`.
- `response.output_text.delta` — `delta` field is a text fragment;
  emit `LlmChunk::ContentDelta`.
- `response.function_call_arguments.delta` — `delta` is a JSON
  fragment; emit `LlmChunk::ToolCallDelta { arguments_fragment }`.
- `response.output_item.done` — finalise that item.
- `response.completed` — emit terminal `LlmChunk::Finish`. The
  `response.status` ("completed" / "incomplete") and
  `response.incomplete_details.reason` ("max_output_tokens" /
  "content_filter") map to `FinishReason`.

The accumulator pattern from `anthropic.rs` translates almost
directly: index slots per content block, finalise on the close
event, emit a single `Finish` at `response.completed`.

### OAuth flow (in the binary)

`apps/jarvis` is the only place that knows the user's environment.
Three approaches, in order of complexity:

#### Path A — reuse `~/.codex/auth.json` (recommended for v0)

If the user has the OpenAI Codex CLI installed and has logged in,
the tokens are already on disk in a known format. Read them; refresh
when expired; ship.

```rust
// apps/jarvis/src/main.rs
"codex" => {
    let path = std::env::var("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().unwrap().join(".codex"));
    let auth = codex_auth::load(&path.join("auth.json"))?;
    let cfg = CodexConfig {
        access_token: auth.access_token,
        account_id:   auth.account_id,
        base_url:     std::env::var("CODEX_BASE_URL")
            .unwrap_or_else(|_| "https://chatgpt.com/backend-api".into()),
        ..CodexConfig::default()
    };
    (Arc::new(CodexProvider::new(cfg, Some(refresher))), model)
}
```

Pros: zero OAuth code to write; we get refresh "for free" by
shelling out to `codex login --refresh` (or by reusing the same
PKCE refresh-token POST).
Cons: requires Codex CLI present; if their on-disk format ever
changes we break.

The refresh-token POST is well-defined though — same `auth.openai.com/oauth/token` endpoint with `grant_type=refresh_token` — so we
can update `~/.codex/auth.json` ourselves without invoking the CLI.

#### Path B — implement the full PKCE + loopback flow ourselves

A self-contained `harness-codex-auth` crate that reproduces
`codex-rs/login/`. ~400 LOC + tests. Useful when:

- We don't want a dependency on Codex CLI being installed.
- We want to support headless / device-code flow (just `codex-rs`'s
  `device_code_auth.rs`-equivalent).
- We want to ship the token store somewhere other than
  `~/.codex/`.

Skip until A demonstrates value.

#### Path C — let the user supply a token directly

Escape hatch for tests / scripts:

```bash
CODEX_ACCESS_TOKEN=eyJ...   # extracted however
CODEX_ACCOUNT_ID=workspace_…
JARVIS_PROVIDER=codex
```

Free; no refresh; will 401 every ~hour. Useful for prototyping the
wire layer without wiring auth.

### Token refresh

Access tokens are short-lived JWTs (~1 hour). If a request returns
401, refresh via:

```
POST {issuer}/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
client_id={CLIENT_ID}
refresh_token={refresh_token}
```

→ new `access_token` (and possibly rotated `refresh_token`). Persist
back to disk if we own the store (Path A or B). Retry the original
request once.

The `client_id` Codex CLI uses is in `codex-rs/login/src/lib.rs` —
it's a public constant, but I'd avoid quoting it here so we don't
silently lock ourselves to "pretend to be Codex CLI". In Path B we
register **our own** OAuth client with OpenAI, give it the same
scopes, and use that. In Path A we read the CLI's tokens and use
the CLI's `client_id` only inside the refresh call (we're not
masquerading — we're refreshing the existing session).

## Implementation cuts

Each is an independent PR.

1. **Wire types.** Add `Conversation → ResponsesApiRequest` and
   `ResponsesApiResponse → ChatResponse` conversions in
   `codex.rs::wire`. Standalone unit tests (no network). ~250 LOC.
2. **Non-streaming `complete`.** Plumb POST through `reqwest`;
   accept a static `CodexConfig` (Path C). ~120 LOC.
3. **Streaming `complete_stream`.** Typed-event SSE accumulator.
   Tests against canned event fixtures. ~200 LOC.
4. **Path-A token loader + refresher.** Read `~/.codex/auth.json`;
   refresh on 401 by hitting `auth.openai.com/oauth/token` with the
   stored refresh_token. ~150 LOC.
5. **`apps/jarvis` switch.** `JARVIS_PROVIDER=codex` + env var
   plumbing. ~30 LOC.
6. *(Optional, later)* **Path B PKCE loopback flow.** Only if Path A
   isn't enough.
7. *(Optional, later)* **Reasoning summary surface.** Plumb
   `response.reasoning_summary.delta` events into a new
   `AgentEvent::ReasoningDelta` variant if we want the UI to show
   "thinking…" content. Affects every transport — separate proposal.

## Risks / open questions

- **Endpoint stability.** `/backend-api/responses` already moved to
  `/backend-api/codex/responses`. If it moves again, we update one
  const. Cosmetic risk, not architectural.
- **Token-format drift.** Path A reads `~/.codex/auth.json`. If
  OpenAI changes the on-disk shape, our reader breaks. Mitigation:
  parse permissively, fail with a clear "refresh by running `codex
  login`" message rather than panicking.
- **Rate / concurrency limits.** Subscription accounts have unstated
  per-account rate limits. The provider should surface a clean
  `Error::Provider("rate limited; <reason>")` rather than retrying
  blindly — `Agent::run` doesn't retry, so a single 429 surfaces as
  a tool-loop iteration error and the model can react.
- **`reasoning.encrypted_content`.** Including this in `include`
  enables prompt caching across turns (Codex CLI does this) but the
  encrypted payload only round-trips through the same model family.
  Don't surface it to other providers' caches.
- **`prompt_cache_key`.** Should be stable per *conversation*, not
  per request. Pass through from the harness — easiest is a UUID
  per `Conversation` if we want this; for v0 we can omit and pay
  the cache miss.
- **Concurrent refresh.** Two requests both 401 at once. Wrap the
  refresher in an `tokio::sync::Mutex`; coalesce.
- **Surface the "this is unofficial" disclaimer.** Clear `info!` log
  on startup naming the endpoint and saying "subject to OpenAI's
  ChatGPT terms of service."

## Out of scope

- Any "make Jarvis itself a Codex CLI replacement" angle — that's
  the [cli.md](cli.md) proposal, not this one.
- WebSocket transport (Codex CLI uses SSE-over-HTTP and WebSockets;
  the WS path is a perf optimisation, not a correctness one. Add
  later if SSE turns out to be a bottleneck).
- Reasoning content streaming (separate proposal — touches every
  transport).
- Codex's `app-server` protocol (different beast — that's the
  remote-control protocol Codex CLI exposes for editor plugins).

## Sources

The findings above were verified against:

- [openai/codex `codex-rs/login/src/server.rs`](https://github.com/openai/codex/blob/main/codex-rs/login/src/server.rs)
  — OAuth issuer, scopes, callback path, token store.
- [openai/codex `codex-rs/model-provider/src/bearer_auth_provider.rs`](https://github.com/openai/codex/blob/main/codex-rs/model-provider/src/bearer_auth_provider.rs)
  — Bearer + `ChatGPT-Account-ID` header construction.
- [openai/codex `codex-rs/core/src/client.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs)
  — `OpenAI-Beta` value, telemetry headers, `stream_responses_api`.
- [OpenClaw `docs/concepts/model-providers.md`](https://github.com/openclaw/openclaw/blob/main/docs/concepts/model-providers.md)
  — provider-plugin boundary; `openai-codex/<model>` ref scheme;
  `chatgpt.com/backend-api` routing.
- [OpenClaw PR #32065](https://github.com/openclaw/openclaw/pull/32065)
  — built-in `openai-codex` auth flow, refresh/access/expires
  storage shape.
- [Simon Willison, "Reverse engineering Codex CLI to get
  GPT-5-Codex-Mini to draw me a pelican" (Nov 2025)](https://simonwillison.net/2025/Nov/9/gpt-5-codex-mini/)
  — verified Responses API body shape against a real captured
  request.
