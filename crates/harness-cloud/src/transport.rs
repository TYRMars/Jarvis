use async_trait::async_trait;
use harness_core::BoxError;

use crate::Envelope;

/// Async transport between cloud control plane and edge nodes.
#[async_trait]
pub trait EdgeTransport: Send + Sync {
    /// Send an envelope to the peer.
    async fn send(&self, envelope: Envelope) -> Result<(), BoxError>;

    /// Receive the next envelope from the peer.
    async fn recv(&self) -> Result<Option<Envelope>, BoxError>;

    /// Close the transport gracefully.
    async fn close(&self) -> Result<(), BoxError>;
}
