//! High-level dispatcher trait — the seam between `harness-tools`'s
//! `channel.send` and `harness-server`'s adapter registry.

use async_trait::async_trait;

use crate::message::{OutboundMessage, SendOutcome};

/// High-level dispatcher used by the `channel.send` agent tool.
///
/// Hides:
/// - looking up a `ChannelInstance` by its UUID
/// - finding the kind-specific adapter
/// - resolving `${env:…}` templates in the config
/// - calling the adapter's `send` and surfacing the outcome
///
/// Implemented by harness-server (where the
/// [`ChannelInstanceStore`](crate::ChannelInstanceStore) and the
/// adapter registry live). harness-tools never sees the trait's
/// implementation type, so the tool stays portable across binaries
/// that wire up different adapters.
#[async_trait]
pub trait ChannelDispatcher: Send + Sync {
    /// Send `msg` via the channel instance with id `instance_id`.
    /// Returns `Failed` if the instance doesn't exist, is disabled,
    /// or has unconfigured / broken config — the tool surfaces all
    /// of these as a single "failed: <reason>" line.
    async fn send_by_id(&self, instance_id: &str, msg: &OutboundMessage) -> SendOutcome;
}
