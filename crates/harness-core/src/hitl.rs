//! Native human-in-the-loop channel.
//!
//! Tools sometimes need a human answer, not just a pre-flight approval
//! for a dangerous action. The agent loop installs an `mpsc::Sender` in
//! a [`tokio::task_local`] before each tool invocation; `ask.*` tools
//! publish a [`PendingHitl`] request through it and await the matching
//! [`HitlResponse`].
//!
//! Outside an agent invocation the channel is absent and requests return
//! an error. That keeps direct tool tests deterministic while allowing
//! interactive transports such as WebSocket to pause and resume a tool.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::error::BoxError;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Human interaction shape requested by a tool.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HitlRequest {
    pub id: String,
    #[serde(default)]
    pub transport: HitlTransport,
    pub kind: HitlKind,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<HitlOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_schema: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

impl HitlRequest {
    pub fn new(kind: HitlKind, title: impl Into<String>) -> Self {
        Self {
            id: next_id(),
            transport: HitlTransport::Text,
            kind,
            title: title.into(),
            body: None,
            options: Vec::new(),
            default_value: None,
            response_schema: None,
            metadata: None,
        }
    }
}

/// Transport/modality requested by an `ask.*` tool. Today the UI only
/// implements text, but keeping the field explicit makes voice/video
/// additions a protocol extension rather than a new event family.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum HitlTransport {
    #[default]
    Text,
    Voice,
    Video,
}

/// Coarse renderer hint for clients.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HitlKind {
    Confirm,
    Input,
    Choice,
    Review,
}

/// One selectable option for [`HitlKind::Choice`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HitlOption {
    pub value: String,
    pub label: String,
}

/// Human response to a pending request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HitlResponse {
    pub request_id: String,
    pub status: HitlStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl HitlResponse {
    pub fn denied(request_id: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            request_id: request_id.into(),
            status: HitlStatus::Denied,
            payload: None,
            reason: Some(reason.into()),
        }
    }
}

/// Status chosen by the human/client.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HitlStatus {
    Approved,
    Denied,
    Submitted,
    Cancelled,
    Expired,
}

/// Pending request plus the responder used to unblock the tool.
pub struct PendingHitl {
    pub request: HitlRequest,
    pub responder: oneshot::Sender<HitlResponse>,
}

tokio::task_local! {
    static HITL_TX: mpsc::Sender<PendingHitl>;
}

/// Ask the active transport for a human response.
pub async fn request(request: HitlRequest) -> Result<HitlResponse, BoxError> {
    let tx = HITL_TX
        .try_with(|tx| tx.clone())
        .map_err(|_| -> BoxError { "human interaction channel unavailable".into() })?;
    let request_id = request.id.clone();
    let (responder, rx) = oneshot::channel();
    tx.send(PendingHitl { request, responder })
        .await
        .map_err(|_| -> BoxError { "human interaction channel closed".into() })?;
    rx.await.map_err(|_| -> BoxError {
        format!("human interaction `{request_id}` was cancelled").into()
    })
}

/// Run `fut` with `tx` installed as the active HITL sender.
pub async fn with_hitl<F, R>(tx: mpsc::Sender<PendingHitl>, fut: F) -> R
where
    F: std::future::Future<Output = R>,
{
    HITL_TX.scope(tx, fut).await
}

fn next_id() -> String {
    let n = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    format!("hitl_{n}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn request_errors_without_channel() {
        let err = request(HitlRequest::new(HitlKind::Confirm, "Continue?"))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("channel unavailable"));
    }

    #[tokio::test]
    async fn request_round_trips() {
        let (tx, mut rx) = mpsc::channel(1);
        let fut = with_hitl(tx, async {
            request(HitlRequest::new(HitlKind::Input, "Name")).await
        });
        tokio::pin!(fut);

        let pending = tokio::select! {
            Some(p) = rx.recv() => p,
            res = &mut fut => panic!("completed early: {res:?}"),
        };
        assert_eq!(pending.request.title, "Name");
        pending
            .responder
            .send(HitlResponse {
                request_id: pending.request.id,
                status: HitlStatus::Submitted,
                payload: Some(serde_json::json!("Ada")),
                reason: None,
            })
            .unwrap();

        let response = fut.await.unwrap();
        assert_eq!(response.payload, Some(serde_json::json!("Ada")));
    }
}
