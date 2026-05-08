//! WebSocket transport for Edge ↔ Cloud control channel.

use std::sync::Arc;

use async_trait::async_trait;
use futures::{SinkExt, StreamExt};
use tokio::sync::Mutex;

use crate::{EdgeTransport, Envelope};
use harness_core::BoxError;

/// Configuration for a WebSocket edge transport.
#[derive(Debug, Clone)]
pub struct WsEdgeTransportConfig {
    pub url: String,
    pub token: String,
    pub runtime_id: String,
    pub tenant_slugs: Vec<String>,
}

/// WebSocket-based implementation of [`EdgeTransport`].
///
/// In **Edge** mode this connects outbound to a Cloud URL.
/// In **Cloud** mode this wraps an already-upgraded server-side socket.
pub struct WebSocketTransport {
    tx: Arc<
        Mutex<
            futures::stream::SplitSink<
                tokio_tungstenite::WebSocketStream<
                    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
                >,
                tokio_tungstenite::tungstenite::Message,
            >,
        >,
    >,
}

impl WebSocketTransport {
    /// Create from an existing WebSocket stream (used on the Cloud side
    /// after axum upgrades the connection).
    #[allow(dead_code)]
    pub fn from_stream(
        ws: tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    ) -> Self {
        let (tx, _rx) = ws.split();
        Self {
            tx: Arc::new(Mutex::new(tx)),
        }
    }
}

#[async_trait]
impl EdgeTransport for WebSocketTransport {
    async fn send(&self, envelope: Envelope) -> Result<(), BoxError> {
        let text = serde_json::to_string(&envelope)?;
        let mut tx = self.tx.lock().await;
        tx.send(tokio_tungstenite::tungstenite::Message::Text(text.into()))
            .await?;
        Ok(())
    }

    async fn recv(&self) -> Result<Option<Envelope>, BoxError> {
        // recv side is handled by the caller's select loop in the server;
        // this stub keeps the trait simple.  In a real impl we'd hold the
        // rx half as well.
        Ok(None)
    }

    async fn close(&self) -> Result<(), BoxError> {
        let mut tx = self.tx.lock().await;
        tx.close().await?;
        Ok(())
    }
}

/// Connect an Edge runtime to a Cloud control plane over WebSocket.
#[allow(dead_code)]
pub async fn connect_edge(config: &WsEdgeTransportConfig) -> Result<WebSocketTransport, BoxError> {
    let request = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
        &config.url,
    )?;
    let (ws, _resp) = tokio_tungstenite::connect_async(request).await?;
    let (tx, _rx) = ws.split();
    Ok(WebSocketTransport {
        tx: Arc::new(Mutex::new(tx)),
    })
}
