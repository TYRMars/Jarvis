//! Channel value types + storage / dispatch traits.
//!
//! This crate is the shared vocabulary for messaging-channel work
//! across `harness-tools` (the `channel.send` agent tool),
//! `harness-store` (JSON / SQL persistence of channel rows), and
//! `harness-server` (HTTP routes + per-kind adapters). It owns:
//!
//! - **Value types** — [`OutboundMessage`] / [`SendOutcome`] /
//!   [`ChannelMessageFormat`] (outbound) plus [`ChannelInboundEvent`]
//!   / [`InboundRequest`] / [`AckPayload`] / [`DecodedInbound`] /
//!   [`ChannelInboundKind`] (inbound).
//! - **Config rows** — [`ChannelInstance`] /
//!   [`ChannelInstanceStatus`] / [`resolve_env_templates`] for the
//!   `${env:NAME}` template syntax used in operator-supplied
//!   credentials.
//! - **Binding rows** — [`ChannelBinding`], the `(channel, chat_id)
//!   → conversation_id` mapping that lets the inbound flow resume
//!   the right conversation.
//! - **Persistence traits** — [`ChannelInstanceStore`] /
//!   [`ChannelBindingStore`], implemented by `harness-store`.
//! - **Dispatcher trait** — [`ChannelDispatcher`], the seam between
//!   the tool (in `harness-tools`) and the actual sender (in
//!   `harness-server`).
//!
//! Intentionally **not** in `harness-core` — none of these types are
//! consumed by the agent loop itself. The agent loop sees a
//! `channel.send` `Tool` instance via the normal tool registry, and
//! everything else flows through transport (HTTP / WS) and adapter
//! layers that already sit outside the core. Keeping channels here
//! mirrors how `harness-mcp` owns its protocol types.
//!
//! ### Dependency direction
//!
//! ```text
//! harness-channel  (this crate — leaf, no harness-* deps)
//!         ↑       ↑       ↑       ↑
//! harness-tools  store  plugin  server
//! ```
//!
//! `harness-core` does not depend on this crate.

mod binding;
mod dispatcher;
mod inbound;
mod instance;
mod message;
mod store;

pub use binding::ChannelBinding;
pub use dispatcher::ChannelDispatcher;
pub use inbound::{
    AckPayload, ChannelInboundEvent, ChannelInboundKind, DecodedInbound, InboundRequest,
};
pub use instance::{resolve_env_templates, ChannelInstance, ChannelInstanceStatus};
pub use message::{ChannelMessageFormat, OutboundMessage, SendOutcome};
pub use store::{ChannelBindingStore, ChannelInstanceStore};
