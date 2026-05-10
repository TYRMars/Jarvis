# Channel adapter plugins (Feishu / DingTalk / WeCom / …)

**Status:** Proposed (Phase 1 in flight — manifest + binding store + proposal)
**Owner:** harness-server / harness-plugin
**Last updated:** 2026-05-09

## Why

Today Jarvis is reachable through the bundled web UI (`/v1/chat/ws`),
the `jarvis-cli` REPL, and `--mcp-serve`. None of those help when a
team wants the agent to live where the conversation already is —
inside Feishu / Lark, DingTalk, WeCom, or eventually Slack / Telegram
/ WhatsApp.

Adding each of those channels into the main binary would bloat
`apps/jarvis` with platform-specific transport code, OAuth flows,
signature verifiers, edit-rate-limit nuances, and credential layouts
that have nothing to do with the agent loop. Worse, every new channel
would force a rebuild + redeploy, which is at odds with the rest of
the plugin story (skills + MCP servers install at runtime via
`plugin.json` and never require recompiling Jarvis).

## Goal

A channel adapter is **a separate process spawned by the
`PluginManager`** that:

1. Talks to one external messaging platform (WeCom WS gateway, Feishu
   Long Connection, DingTalk Stream Mode, …).
2. Talks to Jarvis over the existing `/v1/chat/ws` protocol — **no
   new bespoke RPC** — augmented with a small `source` field on the
   `user` frame so the agent can see which platform / chat / sender
   produced the message.
3. Maps `(channel, channel_chat_id) → conversation_id` via a new
   `ChannelBindingStore`, so the same external chat keeps its memory
   across reconnects.
4. Subscribes to the broadcast tail (already shipped) for the bound
   conversation and forwards `AgentEvent`s back to the platform.

```
┌──────────────┐  external proto  ┌─────────────────────────┐  ws://localhost/v1/chat/ws  ┌─────────┐
│  WeCom / 飞书 │ ◄──────────────► │  jarvis-channel-<name>  │ ◄────────────────────────►  │ Jarvis  │
│   钉钉 / …    │                  │  (subprocess)           │  (existing WS protocol)    │ server  │
└──────────────┘                  └─────────────────────────┘                              └─────────┘
                                          ▲
                          spawned + supervised by PluginManager
```

## Non-goals (v1)

- Personal WeChat (no official API; not supported by anyone serious).
- Inbound media beyond text references (image / file attachments are
  shipped to the platform's local cache, but the agent only sees the
  path; multimodal goes to v2).
- Approval cards (clicking "approve" on a Feishu interactive card
  routes back into `Approver` — defer to a follow-up doc, run channel
  agents in `auto` mode without write/exec tools by default).
- Multi-tenant routing (one Jarvis instance = one set of plugins).

## Architecture

### Manifest extension (`plugin.json`)

Add a `channel_adapters` block alongside the existing
`mcp_servers` block. Same shape conventions: map keyed by adapter
name, value carries transport + env.

```json
{
  "name": "wecom-bot",
  "version": "0.1.0",
  "description": "WeCom AI Bot channel adapter",
  "channel_adapters": {
    "wecom": {
      "transport": {
        "type": "stdio",
        "command": "jarvis-channel-wecom",
        "args": []
      },
      "env": {
        "WECOM_BOT_ID": "${env:WECOM_BOT_ID}",
        "WECOM_SECRET": "${env:WECOM_SECRET}"
      },
      "auto_restart": true
    }
  }
}
```

`type: "stdio"` is the only transport in v1. The adapter process
inherits a Jarvis-issued bearer token via env (`JARVIS_CHANNEL_TOKEN`)
and uses it to authenticate against the local `/v1/chat/ws` endpoint.

### `ChannelBindingStore` (new in `harness-core`)

```rust
pub struct ChannelBinding {
    pub channel: String,            // adapter name, e.g. "wecom"
    pub channel_chat_id: String,    // platform-side chat / group / DM id
    pub conversation_id: String,    // Jarvis internal id
    pub created_at: String,         // RFC-3339
    pub updated_at: String,
    pub channel_user_id: Option<String>,
    pub display_name: Option<String>,
}

#[async_trait]
pub trait ChannelBindingStore: Send + Sync {
    async fn upsert(&self, b: &ChannelBinding) -> Result<(), BoxError>;
    async fn lookup(&self, channel: &str, chat_id: &str) -> Result<Option<ChannelBinding>, BoxError>;
    async fn list_for_channel(&self, channel: &str) -> Result<Vec<ChannelBinding>, BoxError>;
    async fn delete(&self, channel: &str, chat_id: &str) -> Result<bool, BoxError>;
    async fn delete_for_conversation(&self, conversation_id: &str) -> Result<usize, BoxError>;
}
```

Backends in v1: in-memory (tests), JSON-file (default, single
`channel_bindings.json` next to `workspaces.json`). SQL backends
follow the same opt-in cargo-feature pattern as
`ConversationStore`.

### WS protocol extension (`/v1/chat/ws`)

The `user` frame gains an **optional** `source` field so the agent
can see channel context:

```json
{
  "type": "user",
  "content": "...",
  "source": {
    "channel": "wecom",
    "chat_id": "wmABCDEF",
    "user_id": "zhangsan",
    "display_name": "张三",
    "is_group": true
  }
}
```

Backwards compatible — existing clients omit `source`, server
behaviour is unchanged. When present, the agent's per-turn system
injection includes a one-line "incoming via WeCom group … from 张三"
hint so behaviour can adapt. No other frame changes; the broadcast /
tail flow we just landed delivers `Delta` / `Done` to whoever is
subscribed (the adapter, in this case).

### Plugin manager lifecycle

`PluginManager` gains:

- `start_channel_adapters(state: &AppState)` — for each installed
  plugin's `channel_adapters` map, spawn the adapter as a subprocess.
  Track in `HashMap<(plugin_name, adapter_name), ChildHandle>`.
- Supervise: read stderr → tracing, exit code → exponential backoff
  restart (2 / 5 / 10 / 30 / 60 s, capped). Crash counter visible via
  `GET /v1/plugins/<name>/channels`.
- `stop_channel_adapters()` — graceful (`SIGTERM` → 5 s grace →
  `SIGKILL`) on Jarvis shutdown.
- Token issuance: each adapter gets a per-spawn `JARVIS_CHANNEL_TOKEN`
  env var, authorised against an in-memory token list. Token cleared
  on stop.

### `harness-channel-sdk` (new crate, Rust)

A thin SDK so adapter authors don't reimplement the WS handshake +
binding lookup + `source` plumbing. Trait shape (sketch):

```rust
#[async_trait]
pub trait ChannelAdapter: Send + 'static {
    fn name(&self) -> &str;
    async fn run(self, host: ChannelHost) -> Result<(), BoxError>;
}

pub struct ChannelHost {
    // Connect to /v1/chat/ws, manage bindings, replay tail, etc.
}

impl ChannelHost {
    pub async fn deliver_inbound(&self, ev: InboundMessage) -> Result<DeliveryHandle, ...>;
    pub async fn next_outbound(&self, handle: &DeliveryHandle) -> Result<Option<AgentEvent>, ...>;
}
```

Adapter authors implement `ChannelAdapter` plus the platform-specific
WS / HTTP loop. Python / Go SDKs can follow once the wire shape is
locked.

## Phased delivery

**Phase 1 (this PR / proposal land):**
- Proposal doc.
- `ChannelBindingStore` trait + memory + JSON-file impl.
- `plugin.json` `channel_adapters` field — parsed but **not yet
  executed**, mirroring how `slash_commands` / `hooks` were staged.

**Phase 2:**
- `PluginManager::start_channel_adapters()` spawn / supervise / stop.
- Token issuance + auth on `/v1/chat/ws`.
- WS `user.source` field.
- `harness-channel-sdk` crate (Rust trait + handshake helpers).

**Phase 3:**
- First real adapter: `apps/jarvis-channel-wecom` (WeCom WS gateway,
  hand-rolled protocol — no Rust SDK exists).
- Then Feishu (Long Connection — `open-lark` crate available),
  DingTalk (Stream Mode — hand-rolled).

**Phase 4 (deferred):**
- Approval cards for gated tools (per-platform interactive elements).
- Inbound media → multimodal pipeline.
- Per-channel BuiltinsConfig (which tools are available when source
  is X).

## Verification

Phase 1 is structural — no new behaviour is observable end-to-end.
Verification scope:

1. `cargo test -p harness-core --test channel_binding` — round-trip
   upsert / lookup / delete on memory backend.
2. `cargo test -p harness-store channel_binding::` — JSON-file
   backend persists across `open()` reopens.
3. `cargo test -p harness-plugin manifest::` — `channel_adapters`
   parse round-trips, defaults are silent, unknown transport types
   error out.
4. `cargo clippy --workspace --all-targets -- -D warnings`.
