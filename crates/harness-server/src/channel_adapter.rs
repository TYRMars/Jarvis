//! Channel adapter abstraction.
//!
//! Each `kind` (`wecom_webhook`, future `wechat_mp` / `feishu_bot` /
//! `dingtalk_bot` / …) implements [`ChannelAdapter`]. The
//! [`ChannelAdapterRegistry`] owns one instance per kind and is
//! consulted by:
//! - `channels_routes.rs` for `validate_config` / `schema()` / send
//!   on the test endpoint
//! - the `channel.send` agent tool, via a [`ChannelDispatcher`]
//!   wrapper that combines the registry with the
//!   [`ChannelInstanceStore`]
//!
//! Lessons grafted in from
//! [Hermes's `gateway/platforms/base.py`]
//! (https://github.com/...): normalise the outbound shape
//! (`OutboundMessage` in harness-core), normalise the result
//! (`SendOutcome`), keep the `kind`-dispatch in one place so a
//! second/third adapter doesn't grow N copies of the same `match`
//! statement (which is exactly where v1 was heading before this
//! refactor).
//!
//! Only outbound is modelled here. Inbound (`MessageEvent`-style
//! handlers, `ChannelBinding` lookup at message-arrival time) is
//! deferred to whenever the first inbound kind lands (M3: WeChat MP
//! passive reply).

use async_trait::async_trait;
use harness_channel::{
    resolve_env_templates, AckPayload, ChannelDispatcher, ChannelInstanceStatus,
    ChannelInstanceStore, DecodedInbound, InboundRequest, OutboundMessage, SendOutcome,
};
use serde_json::Value;
use std::sync::Arc;

/// One channel kind. Each adapter is stateless — config arrives via
/// the resolved JSON blob on every send, so a single registry-wide
/// instance handles every configured `ChannelInstance` of that kind
/// (matching the `BasePlatformAdapter` shape in Hermes, except we
/// take credentials per-call rather than per-process).
#[async_trait]
pub trait ChannelAdapter: Send + Sync {
    /// Wire identifier (`"wecom_webhook"`). Stable; matches
    /// `ChannelInstance.kind` and the discriminator clients use to
    /// pick a config form.
    fn kind(&self) -> &'static str;

    /// JSON-Schema-shaped config descriptor. Drives the Settings →
    /// 渠道 form so adding a kind on the backend auto-surfaces in
    /// the UI without a frontend change.
    fn schema(&self) -> Value;

    /// True when the kind supports the test-message endpoint. Some
    /// future kinds (a pure inbound webhook receiver) may not, but
    /// every outbound kind should.
    fn test_supported(&self) -> bool {
        true
    }

    /// Validate a config blob. Returns a 1-line operator-readable
    /// message on the offending field. Templated values
    /// (`${env:NAME}`) must validate without env var lookups
    /// because instances may be created hours before the env var
    /// is set.
    fn validate_config(&self, config: &Value) -> Result<(), String>;

    /// Send a message via the (already env-resolved) config blob.
    ///
    /// Adapters that find an unresolved `${env:…}` template at this
    /// point return `Failed { retryable: false }` with a clear
    /// "set ${env:…} before retrying" message — this happens when
    /// the operator forgot to export the env var the row references.
    async fn send(&self, resolved_config: &Value, msg: &OutboundMessage) -> SendOutcome;

    /// Optional inbound handler. Outbound-only kinds (today's WeCom
    /// group bot / Feishu bot / DingTalk bot) return `None`. Kinds
    /// that receive callbacks return a handler that the inbound
    /// router uses to verify signatures + decode the platform's
    /// HTTP request body into a [`ChannelInboundEvent`].
    ///
    /// Default `None` means the existing 3 outbound adapters need
    /// zero changes; the trait surface only widens for kinds that
    /// opt in.
    fn inbound_handler(&self) -> Option<Arc<dyn ChannelInboundHandler>> {
        None
    }

    /// Optional terminal-user identity OAuth capability. Kinds that
    /// support a "click this link to verify your identity" flow
    /// return `Some(...)` with the protocol-specific URL builder,
    /// state signer, and code-exchange routine packaged as a single
    /// trait object.
    ///
    /// The route layer ([`crate::channels_oauth_routes`]) dispatches
    /// purely against this method — no more `if kind == "wecom_app"`
    /// — so adding Slack / Feishu / 钉钉 OAuth is "implement the
    /// trait, return `Some` here, the routes pick it up".
    fn oauth_capability(&self) -> Option<Arc<dyn ChannelOAuthCapability>> {
        None
    }
}

/// Decoded identity returned by a successful OAuth `code → identity`
/// exchange. The shape is intentionally tiny — every kind we ship
/// today only surfaces a stable user id — and richer per-platform
/// payloads ride in `extras` so the trait stays stable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OAuthIdentity {
    /// Platform-scoped stable id of the authenticated user. Matches
    /// what an inbound `ChannelInboundEvent.external_user_id` would
    /// carry for the same person, so the binding store can join.
    pub external_user_id: String,
    /// Optional best-effort display name when the scope permits it
    /// (e.g. WeCom `snsapi_privateinfo` returns the user's姓名).
    /// `snsapi_base` returns `None`.
    pub display_name: Option<String>,
    /// Platform-specific extras (Slack team_id, WeCom user_ticket,
    /// Feishu union_id, …). Stays as an opaque `Value` so the trait
    /// surface doesn't grow per-kind fields.
    pub extras: Value,
}

/// Terminal-user identity OAuth flow for a channel kind.
///
/// Captures three operations the route layer needs:
/// 1. **Build the authorize URL** the user clicks / scans.
/// 2. **Sign + verify the CSRF state token** so the callback can
///    distinguish its own redirects from forged ones. Implementation
///    owns the signing key choice (e.g. WeCom uses
///    `config.token`); the routes just shuttle the opaque
///    `state` string between sign and verify.
/// 3. **Exchange the platform-supplied `code` for an identity**.
///
/// Stateless across requests — implementations live in a unit
/// struct and read all secrets out of `resolved_config` each call.
#[async_trait]
pub trait ChannelOAuthCapability: Send + Sync {
    /// Build the platform's `authorize` URL. `redirect_uri` is the
    /// public callback URL (`https://<host>/v1/channels/<id>/oauth/callback`);
    /// `state` is the already-signed CSRF token from
    /// [`Self::sign_state`]. The route layer assembles both and
    /// hands them in here; the kind implementation knows how its
    /// platform formats query / hash params (e.g. WeCom requires
    /// the `#wechat_redirect` fragment).
    fn authorize_url(
        &self,
        resolved_config: &Value,
        redirect_uri: &str,
        state: &str,
    ) -> Result<String, String>;

    /// Sign a fresh CSRF state token. `ctx` is an opaque
    /// route-layer-supplied string (packed `ctx|next` from the
    /// `/oauth/start` query) that round-trips through
    /// [`Self::verify_state`] unchanged.
    fn sign_state(
        &self,
        resolved_config: &Value,
        instance_id: &str,
        ttl_secs: u64,
        ctx: Option<&str>,
        now_unix: u64,
    ) -> Result<String, String>;

    /// Verify a state token and return the opaque `ctx` it was
    /// signed with. The implementation enforces:
    /// - signature validity (constant-time compare)
    /// - that `instance_id` inside the token matches `expected_instance`
    /// - that `exp` hasn't passed
    fn verify_state(
        &self,
        resolved_config: &Value,
        state: &str,
        expected_instance: &str,
        now_unix: u64,
    ) -> Result<Option<String>, String>;

    /// Exchange the platform-returned `code` for an
    /// [`OAuthIdentity`]. Most platforms need to fetch their own
    /// access_token first (WeCom: `cgi-bin/gettoken`; Feishu:
    /// `auth/v3/app_access_token`); implementations are free to
    /// cache that internally.
    async fn exchange_code(
        &self,
        resolved_config: &Value,
        code: &str,
    ) -> Result<OAuthIdentity, String>;
}

/// Per-kind inbound logic. Stateless across requests — the handler
/// is fetched fresh for each callback POST. Verification +
/// GET-handshake + POST-decode are split because most platforms
/// have different shapes for each (WeCom GET returns an echostr,
/// POST returns either an ack or a passive-reply XML).
#[async_trait]
pub trait ChannelInboundHandler: Send + Sync {
    /// Verify the request authenticates against the configured
    /// secrets. Returns the operator-readable failure reason on
    /// rejection (the route handler turns it into an HTTP 401).
    /// `resolved_config` is the env-resolved blob — same shape the
    /// adapter's `send` receives.
    fn verify(&self, req: &InboundRequest, resolved_config: &Value) -> Result<(), String>;

    /// Handle the platform's verification GET. Most platforms ship
    /// an `echostr` query param the server has to decrypt + return
    /// verbatim. Adapters that don't have a GET handshake (Feishu,
    /// for example) return [`AckPayload::Empty`] unconditionally.
    async fn handle_get(
        &self,
        req: &InboundRequest,
        resolved_config: &Value,
    ) -> Result<AckPayload, String>;

    /// Handle a real inbound POST. Returns the decoded event + the
    /// platform-specific ack body. WeCom uses ack-and-async (return
    /// `AckPayload::Empty`, push the agent's reply later via
    /// `cgi-bin/message/send`); WeChat MP would use
    /// `AckPayload::Xml` for the synchronous passive-reply path.
    async fn handle_post(
        &self,
        req: &InboundRequest,
        resolved_config: &Value,
    ) -> Result<DecodedInbound, String>;
}

/// Registry of all kinds wired into this binary. Built once at
/// startup via [`Self::with_defaults`] (or extended by binaries
/// that ship custom kinds) and shared via `AppState`.
///
/// Lookup is a linear scan over a `Vec` — the kind count is
/// bounded by reality (≤ 20 ever, almost certainly), and a Vec
/// keeps the schema-listing endpoint's output deterministic
/// without needing an `IndexMap`.
pub struct ChannelAdapterRegistry {
    adapters: Vec<Arc<dyn ChannelAdapter>>,
}

impl ChannelAdapterRegistry {
    /// Empty registry. Useful for tests that want to register
    /// stub adapters.
    pub fn empty() -> Self {
        Self {
            adapters: Vec::new(),
        }
    }

    /// Production registry, with every kind that ships in this
    /// binary today. Add new kinds here as they land.
    pub fn with_defaults() -> Self {
        let mut r = Self::empty();
        r.register(Arc::new(crate::channels_wecom::WeComWebhookAdapter));
        r.register(Arc::new(crate::channels_feishu::FeishuBotAdapter));
        r.register(Arc::new(crate::channels_dingtalk::DingTalkBotAdapter));
        r.register(Arc::new(crate::channels_wecom_app::WeComAppAdapter));
        r
    }

    pub fn register(&mut self, adapter: Arc<dyn ChannelAdapter>) {
        // Reject duplicates loudly — silently overwriting a kind
        // would mask a real bug.
        let kind = adapter.kind();
        assert!(
            !self.adapters.iter().any(|a| a.kind() == kind),
            "duplicate channel adapter for kind '{kind}'"
        );
        self.adapters.push(adapter);
    }

    /// Look up by kind. `None` ⇒ unknown kind; routes / dispatcher
    /// surface this as a 400.
    pub fn get(&self, kind: &str) -> Option<Arc<dyn ChannelAdapter>> {
        self.adapters.iter().find(|a| a.kind() == kind).cloned()
    }

    /// Iterate for the `/v1/channels/kinds` listing endpoint.
    pub fn iter(&self) -> impl Iterator<Item = &Arc<dyn ChannelAdapter>> {
        self.adapters.iter()
    }
}

impl Default for ChannelAdapterRegistry {
    fn default() -> Self {
        Self::with_defaults()
    }
}

/// Concrete [`ChannelDispatcher`] that combines the instance store
/// (looks up by id) with the adapter registry (dispatches by kind).
///
/// Both `Arc`s; cheap to clone, safe to share across the agent loop
/// + every WS turn.
pub struct ChannelDispatcherImpl {
    pub store: Arc<dyn ChannelInstanceStore>,
    pub registry: Arc<ChannelAdapterRegistry>,
}

#[async_trait]
impl ChannelDispatcher for ChannelDispatcherImpl {
    async fn send_by_id(&self, instance_id: &str, msg: &OutboundMessage) -> SendOutcome {
        // Step 1: load the instance.
        let inst = match self.store.get(instance_id).await {
            Ok(Some(i)) => i,
            Ok(None) => {
                return SendOutcome::fail(format!(
                    "channel instance '{instance_id}' not found"
                ))
            }
            Err(e) => {
                return SendOutcome::fail_retryable(format!(
                    "channel store error: {e}"
                ))
            }
        };
        // Step 2: status gate. Disabled / Unconfigured rows refuse
        // sends — operators expect the explicit pause to actually
        // pause traffic.
        match inst.status {
            ChannelInstanceStatus::Disabled => {
                return SendOutcome::fail(format!(
                    "channel instance '{}' is paused — re-enable in Settings → Channels",
                    inst.display_name
                ));
            }
            ChannelInstanceStatus::Unconfigured => {
                return SendOutcome::fail(format!(
                    "channel instance '{}' is not configured — fix the config in Settings → Channels",
                    inst.display_name
                ));
            }
            ChannelInstanceStatus::Enabled => {}
        }
        // Step 3: dispatch via the registry.
        let Some(adapter) = self.registry.get(&inst.kind) else {
            return SendOutcome::fail(format!(
                "channel kind '{}' not registered in this binary",
                inst.kind
            ));
        };
        // Step 4: env-resolve the config and hand off.
        let resolved = resolve_env_templates(&inst.config);
        adapter.send(&resolved, msg).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_channel::{ChannelInstance, ChannelInstanceStatus};
    use serde_json::json;
    use std::sync::Mutex;

    /// Stub adapter that records every call so tests can assert on
    /// the exact (config, message) pair the dispatcher passed.
    struct RecordingAdapter {
        seen: Mutex<Vec<(Value, OutboundMessage)>>,
        outcome: SendOutcome,
    }

    impl RecordingAdapter {
        fn new(outcome: SendOutcome) -> Arc<Self> {
            Arc::new(Self {
                seen: Mutex::new(Vec::new()),
                outcome,
            })
        }
    }

    #[async_trait]
    impl ChannelAdapter for RecordingAdapter {
        fn kind(&self) -> &'static str {
            "stub_kind"
        }
        fn schema(&self) -> Value {
            json!({"type": "object"})
        }
        fn validate_config(&self, _: &Value) -> Result<(), String> {
            Ok(())
        }
        async fn send(&self, resolved_config: &Value, msg: &OutboundMessage) -> SendOutcome {
            self.seen
                .lock()
                .unwrap()
                .push((resolved_config.clone(), msg.clone()));
            self.outcome.clone()
        }
    }

    async fn store_with(inst: ChannelInstance) -> Arc<dyn ChannelInstanceStore> {
        let s: Arc<dyn ChannelInstanceStore> =
            Arc::new(harness_store::MemoryChannelInstanceStore::new());
        s.upsert(&inst).await.unwrap();
        s
    }

    #[tokio::test]
    async fn dispatcher_routes_to_registered_adapter() {
        let stub = RecordingAdapter::new(SendOutcome::sent());
        let mut reg = ChannelAdapterRegistry::empty();
        reg.register(stub.clone());

        let mut inst = ChannelInstance::new("stub_kind", "test", json!({"k": "v"}));
        inst.status = ChannelInstanceStatus::Enabled;

        let dispatcher = ChannelDispatcherImpl {
            store: store_with(inst.clone()).await,
            registry: Arc::new(reg),
        };
        let result = dispatcher
            .send_by_id(&inst.id, &OutboundMessage::text("hello"))
            .await;
        assert!(result.is_sent());
        let calls = stub.seen.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].1.text, "hello");
    }

    #[tokio::test]
    async fn dispatcher_refuses_disabled_instance() {
        let stub = RecordingAdapter::new(SendOutcome::sent());
        let mut reg = ChannelAdapterRegistry::empty();
        reg.register(stub.clone());

        let mut inst = ChannelInstance::new("stub_kind", "paused", json!({}));
        inst.status = ChannelInstanceStatus::Disabled;

        let dispatcher = ChannelDispatcherImpl {
            store: store_with(inst.clone()).await,
            registry: Arc::new(reg),
        };
        let r = dispatcher
            .send_by_id(&inst.id, &OutboundMessage::text("hi"))
            .await;
        match r {
            SendOutcome::Failed { message, .. } => {
                assert!(message.contains("paused"), "msg was: {message}");
            }
            _ => panic!("expected Failed"),
        }
        // Adapter must not have been called.
        assert!(stub.seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn dispatcher_404s_unknown_instance() {
        let stub = RecordingAdapter::new(SendOutcome::sent());
        let mut reg = ChannelAdapterRegistry::empty();
        reg.register(stub);
        let dispatcher = ChannelDispatcherImpl {
            store: Arc::new(harness_store::MemoryChannelInstanceStore::new()),
            registry: Arc::new(reg),
        };
        let r = dispatcher
            .send_by_id("ghost-id", &OutboundMessage::text("hi"))
            .await;
        match r {
            SendOutcome::Failed { message, .. } => {
                assert!(message.contains("not found"));
            }
            _ => panic!("expected Failed"),
        }
    }

    #[tokio::test]
    async fn dispatcher_resolves_env_templates_before_send() {
        std::env::set_var("CHANNEL_DISPATCH_TEST_ENV", "resolved-value");
        let stub = RecordingAdapter::new(SendOutcome::sent());
        let mut reg = ChannelAdapterRegistry::empty();
        reg.register(stub.clone());
        let mut inst = ChannelInstance::new(
            "stub_kind",
            "templated",
            json!({"key": "${env:CHANNEL_DISPATCH_TEST_ENV}"}),
        );
        inst.status = ChannelInstanceStatus::Enabled;
        let dispatcher = ChannelDispatcherImpl {
            store: store_with(inst.clone()).await,
            registry: Arc::new(reg),
        };
        let _ = dispatcher
            .send_by_id(&inst.id, &OutboundMessage::text("hi"))
            .await;
        // Adapter should have seen the resolved value, not the
        // template literal.
        let calls = stub.seen.lock().unwrap();
        assert_eq!(calls[0].0["key"].as_str().unwrap(), "resolved-value");
        std::env::remove_var("CHANNEL_DISPATCH_TEST_ENV");
    }

    #[test]
    #[should_panic(expected = "duplicate channel adapter")]
    fn registry_rejects_duplicate_kinds() {
        let a = RecordingAdapter::new(SendOutcome::sent());
        let b = RecordingAdapter::new(SendOutcome::sent());
        let mut reg = ChannelAdapterRegistry::empty();
        reg.register(a);
        reg.register(b); // panics
    }
}
