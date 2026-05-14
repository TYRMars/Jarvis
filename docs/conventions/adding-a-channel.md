# Adding a new channel kind

Checklist for landing a new outbound or inbound `ChannelAdapter`. Each item
maps to a real integration point in the codebase — skipping any of them
produces silent gaps (a kind that doesn't appear in the dropdown, a config
that the validator approves but the sender rejects, an inbound route that
405s, etc.).

This file deliberately mirrors Hermes's `gateway/platforms/ADDING_A_PLATFORM.md`
shape — flat checklist, code paths citable, no narrative. The "future
capabilities" appendix at the end lists the openclaw `ChannelPlugin` adapter
shapes Jarvis hasn't grown yet, so the next person knows where extra hooks
will plug in.

---

## 1. Adapter file

`crates/harness-server/src/channels_<kind>.rs`. Naming convention:
- One file per kind, even when two kinds share a parent platform
  (`channels_wecom.rs` for the group robot, `channels_wecom_app.rs` for
  the self-built app — they have different config + auth + wire shapes,
  don't share a struct).
- Adapter struct named `<Kind>Adapter` (e.g. `WeComWebhookAdapter`,
  `FeishuBotAdapter`, `DingTalkBotAdapter`).
- File header doc comment must cite the platform's wire-shape doc URL —
  every adapter we ship today has one. Saves the next person a Google.

## 2. Implement `ChannelAdapter`

From `crates/harness-server/src/channel_adapter.rs`. Required:

| Method | Purpose |
|---|---|
| `kind() -> &'static str` | Wire identifier (`"wecom_app"`). Matches `ChannelInstance.kind`. |
| `schema() -> Value` | JSON-Schema-shaped descriptor. Drives the Settings → 渠道 form. |
| `validate_config(&Value) -> Result<(), String>` | Field-level validation. Templated values (`${env:NAME}`) must validate without env lookups. |
| `async send(&Value, &OutboundMessage) -> SendOutcome` | Outbound. Outbound-only? Implement here and skip §6. |

Optional:

| Method | Purpose |
|---|---|
| `inbound_handler() -> Option<Arc<dyn ChannelInboundHandler>>` | Return `Some(...)` to opt the kind into inbound POST/GET routing. Default `None` is fine for outbound-only. |
| `test_supported() -> bool` | Default `true`. Override to `false` if the kind has no meaningful out-of-band probe. |

## 3. Config schema conventions

The `schema()` JSON shape is consumed by both the create-time validator
(server side) and the auto-generated form (frontend, `ChannelsSection.tsx`).

- Top-level must include `kind`, `label` (zh), `label_en`, `direction`
  (`outbound | inbound | bidirectional`), `description`, `schema`,
  `supports_formats`, `test_supported`. Inbound-capable kinds also include
  `callback_path: "/v1/channels/<id>/callback"` so the UI can render a
  copy-URL affordance.
- `schema.required` is a JSON-Schema array. Field rendering order:
  required fields first (in array order), then optional fields
  alphabetical. Don't rely on `properties` map order.
- Sensitive fields: include "secret", "key", or "password" in the
  property name; the form renders them as `<input type="password">`. Same
  fields should be `${env:…}`-friendly (the validator must accept
  templated values).
- For optional credentials (Feishu signing secret, WeCom AES key):
  document in the `description` whether leaving them empty is a valid
  config. Don't force them into `required`.

## 4. Register in the default registry

`crates/harness-server/src/channel_adapter.rs::ChannelAdapterRegistry::with_defaults()`:

```rust
r.register(Arc::new(crate::channels_<kind>::<Kind>Adapter));
```

Duplicate `kind()` strings panic the registry — that's intentional.

## 5. Module declaration

`crates/harness-server/src/lib.rs`:

```rust
mod channels_<kind>;
```

## 6. Inbound (skip if outbound-only)

If the kind opts into inbound (`inbound_handler()` returns `Some`),
implement `ChannelInboundHandler`:

| Method | Purpose |
|---|---|
| `verify(&InboundRequest, &Value) -> Result<(), String>` | Signature/HMAC/etc. Always run on every request, including GET handshakes. |
| `async handle_get(&InboundRequest, &Value) -> Result<AckPayload, String>` | Platform verification GET. Most return decrypted echostr verbatim. |
| `async handle_post(&InboundRequest, &Value) -> Result<DecodedInbound, String>` | Real inbound POST. Returns the decoded `ChannelInboundEvent` + the platform's ack body. |

The route layer (`channels_inbound_routes.rs`) takes care of:
- Loading the `ChannelInstance` and refusing if it's `Disabled`.
- Looking up the kind's adapter and 405'ing if `inbound_handler()` is `None`.
- Writing / refreshing the `ChannelBinding` and minting a fresh
  `Conversation` when the chat is unknown.
- Spawning the agent loop in the background after the platform ack
  goes out, then pushing the assistant's last text back through the
  adapter's `send` (with `to_user` overridden by the inbound
  `external_user_id` so the reply DMs the sender). Failures are
  logged at WARN and never propagate to the platform — the ack has
  already shipped.

Don't roll those concerns into the adapter — they're cross-cutting.
The reply push always uses the same `send()` method outbound traffic
uses, so any wire-shape oddities only need fixing in one place.

### 6b. OAuth2 (optional — kind-by-kind opt-in)

WeCom 自建应用 grows its own `/v1/channels/:id/oauth/{start,callback}`
pair on top of the inbound infrastructure (see
`crates/harness-server/src/channels_oauth_routes.rs`). This is the
"click here to verify your identity" flow described in the
end-user-immediate-login section of the proposal:

- `GET /v1/channels/:id/oauth/start[?ctx=...&next=...]` →
  302 to WeCom's `open.weixin.qq.com/connect/oauth2/authorize` URL.
  CSRF state is HMAC-SHA1 signed against the instance's `token` field
  (no server-side state store needed — fully horizontal).
- `GET /v1/channels/:id/oauth/callback?code=...&state=...` → verifies
  the state's signature + expiry + instance-id binding, fetches the
  app's `access_token` (reusing the same cache as outbound sends),
  exchanges `code` → `userid` via `cgi-bin/auth/getuserinfo`, and
  either redirects to the originator-supplied `next=` URL or renders
  a small "verified as X" HTML page.

Requirements to opt in:
- The kind's adapter returns `Some(...)` from
  `ChannelAdapter::oauth_capability()` (default `None` keeps every
  other kind opted out without code changes).
- Operator must set `JARVIS_PUBLIC_HOST=https://<your-domain>` so the
  redirect URI sent to the platform is reachable.
- Operator must add the public domain to the platform's "trusted
  domain" list (WeCom admin → 应用管理 → 你的自建应用 → 网页授权及JS-SDK).

Adding OAuth to a future kind:
1. In the kind's adapter module, implement
   [`ChannelOAuthCapability`](crates/harness-server/src/channel_adapter.rs)
   — four methods: `authorize_url`, `sign_state`, `verify_state`,
   `exchange_code`. The state-signing key choice is the
   implementation's call (WeCom reuses `config.token`).
2. Return `Some(Arc::new(YourKindOAuth))` from
   `oauth_capability()` on your `ChannelAdapter` impl.
3. The routes layer (`channels_oauth_routes.rs`) needs **no
   change** — it dispatches purely against the trait, so registering
   the new capability is all that's required.
4. Tests in the kind's module: URL shape, state round-trip,
   tampered-state rejection, expired-state rejection. The
   convention test `adapter_returns_oauth_capability` already
   asserts that registered OAuth kinds advertise the trait.

## 7. Tests (per-kind)

Minimum bar — every shipped adapter today hits these:

1. `validate_config` rejects missing required fields.
2. `validate_config` rejects insecure schemes (`http://`) without an
   `${env:…}` template.
3. `validate_config` accepts both literal HTTPS URLs and templated ones.
4. `send` rejects unresolved `${env:…}` templates with a stable
   `code: "<kind>:unresolved_template"`.
5. `send` rejects insecure URLs.
6. `schema()` advertises the format(s) you actually support.
7. (If signing) round-trip the signature: deterministic + sensitive
   to each input + different from sibling adapters' signatures (catches
   accidental copy-paste of Feishu's formula into DingTalk's, etc.).
8. (If markdown) `build_body` for markdown contains the markdown wrapper,
   not the text wrapper.
9. UTF-8 boundary truncation: a Chinese-character body just over the
   max-bytes cap truncates at a char boundary, not mid-codepoint.

For inbound kinds, also:

10. AES round-trip (synthetic key, verify decrypt extracts the embedded
    `corp_id` / equivalent receiver id).
11. Wrong-receiver rejection.
12. XML / payload decoder per supported message kind (text / image /
    voice / event-subscribe / unsupported).
13. `verify()` rejects missing query params + signature mismatches.
14. `handle_post()` returns the right `AckPayload` variant for the
    platform's protocol (Empty for ack-and-async, Xml for
    passive-reply).

## 8. Update the registry test

`channels_routes.rs::tests::default_registry_lists_all_shipped_kinds` —
add an `assert!(kinds.contains(&"<kind>"))` line. Catches the case
where someone adds an adapter file but forgets §4.

## 9. Frontend — usually no changes

The form is schema-driven. New kinds appear in the dropdown automatically.
You only need to touch the frontend when:

- The kind needs a Settings affordance the schema can't express (a
  custom button, a separate "verify" flow). Example: future setup-wizard
  kinds.
- The display logic needs a new `summariseConfig` branch in
  `ChannelsSection.tsx` (right now `wecom_webhook` has one for the
  webhook URL preview).

## 9b. CLI — also schema-driven, no changes

`jarvis channels add` walks the same `schema()` blob the web form
does. New kinds appear in the picker automatically; sensitive fields
(name contains `secret | key | password | token`) auto-route to a
`Password` prompt; inbound-capable kinds (anything carrying
`callback_path` in their schema) get the substituted callback URL
printed at the end. So if §3 is right, `apps/jarvis/src/channels_cli.rs`
needs no edit either.

## 10. Run the full gate

```bash
cargo test -p harness-server --lib -- channel    # all channel tests
cargo clippy --workspace --all-targets -- -D warnings
cargo build -p jarvis
```

Add the kind to the proposal doc's status line:
`docs/proposals/channel-plugins.md`.

---

## Future capabilities (not yet implemented)

When the next inbound-heavy kind lands, these openclaw-shaped extension
points are the natural seams:

| openclaw adapter | What it would buy us | When to grow Jarvis into it |
|---|---|---|
| `ChannelSetupWizard` | Interactive auth (OAuth, QR-code login). | When a kind requires login flow that doesn't fit a static form (e.g. WeCom OAuth for personal-grant tokens). |
| `ChannelPairingAdapter` | One-shot DM pairing ("send `#pair foo`"). | When binding-by-chat-id isn't enough (e.g. requirement-scoped bindings: this user's messages route to project X). |
| `ChannelSecurityAdapter` | Per-message authenticator (encrypted payload, allowlist). | When inbound payload sensitivity exceeds plain HTTPS — already partly there for AES kinds. |
| `ChannelThreadingAdapter` | "This message is a reply in thread T" metadata. | When the first thread-aware kind lands (Slack reply-in-thread, Feishu topic). |
| `ChannelApprovalCapability` | Per-channel approval routing. | When operators want approvals to land back in the chat the request came from. |
| `ChannelMessageActionAdapter` | Edit / unsend / react. | When agents need to edit their previous messages (e.g. update an alert when state changes). |
| `ChannelHeartbeatAdapter` | Long-connection liveness ping. | When the first WS-gateway kind lands. WeCom AI Bot WS is the canonical case. |
| `ChannelDirectoryAdapter` | Enumerate available chats. | Slack / Discord — they expose chat lists; webhook kinds don't. |
| `ChannelSecretsAdapter` | Resolver-backed secret store. | When `${env:…}` isn't enough — system keychain integration. |
| `ChannelAgentToolFactory` | Channel-owned tools (login, etc.). | When a kind needs the agent to perform platform-specific operations beyond send. |

Two value-type fields already reserved on the wire:

- `ChannelInboundEvent.thread_id: Option<String>` — populate when the
  first thread-aware platform lands; the binding store + reply-routing
  code already handles `None`.
- `ChannelBinding.channel_user_id: Option<String>` + `display_name` —
  reused by every adapter; don't reserve fresh fields, just populate
  these.

## See also

- `docs/proposals/channel-plugins.md` — original proposal + status
- `crates/harness-server/src/channel_adapter.rs` — trait surface
- `crates/harness-core/src/channel.rs` — value types
- Existing adapters as exemplars:
  - `channels_wecom.rs` (outbound webhook, single format)
  - `channels_feishu.rs` (outbound webhook, optional signing)
  - `channels_dingtalk.rs` (outbound webhook, query-string signing,
    structured mention object)
  - `channels_wecom_app.rs` (bidirectional, AES callback, token cache)
