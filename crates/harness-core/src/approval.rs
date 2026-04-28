//! Approval hook for sensitive tool invocations.
//!
//! The agent loop consults an [`Approver`] before invoking any tool
//! whose `Tool::requires_approval` returns `true` (today: `fs.write`,
//! `fs.edit`, `shell.exec`). Implementations decide synchronously
//! ([`AlwaysApprove`] / [`AlwaysDeny`]) or asynchronously through a
//! channel ([`ChannelApprover`]) so a transport layer can ask a remote
//! UI mid-stream and feed the answer back.
//!
//! When no approver is configured on `AgentConfig`, the loop runs every
//! tool unconditionally — that's the historical behaviour and stays the
//! default so existing wiring keeps working. Once an approver is set, a
//! `Deny` outcome short-circuits the call: the tool is **not** invoked,
//! and the deny reason is surfaced back to the model as the tool's
//! synthetic output (`"tool denied: <reason>"`) so the model can adapt
//! and choose another path.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::error::BoxError;
use crate::permission::HitSource;
use crate::tool::ToolCategory;

/// What the agent shows to the approver. Mirrors the on-the-wire shape
/// emitted as `AgentEvent::ApprovalRequest` so transports can
/// re-serialise without translation.
///
/// `category` is the tool's `ToolCategory` — the rule engine's
/// mode-default mapping uses it so [`crate::permission::RuleApprover`]
/// can compute "auto-allow if mode is `accept-edits` and category is
/// `Write`" without re-fetching the tool object. The wire shape
/// serialises it as a snake_case string; transports that don't care
/// can ignore the field.
#[derive(Debug, Clone, Serialize)]
pub struct ApprovalRequest {
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments: Value,
    /// Side-effect category of the tool being requested. Defaults to
    /// `Write` for backward compatibility with hand-built `ApprovalRequest`
    /// values in tests; the agent loop fills this in correctly from
    /// `Tool::category()`.
    #[serde(default = "default_category")]
    pub category: ToolCategory,
}

// Wired via `#[serde(default = "...")]` above; the compiler can't see
// that path so it warns about dead code. Silence the warning rather
// than work around it — this `default_category` deliberately exists
// for the serde derive's benefit.
#[allow(dead_code)]
fn default_category() -> ToolCategory {
    ToolCategory::Write
}

/// The approver's verdict. Includes an optional human-readable reason
/// surfaced to the model (and clients) on deny.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum ApprovalDecision {
    Approve,
    Deny {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
}

impl ApprovalDecision {
    pub fn deny(reason: impl Into<String>) -> Self {
        Self::Deny {
            reason: Some(reason.into()),
        }
    }
}

/// Decide whether a tool invocation should proceed.
#[async_trait]
pub trait Approver: Send + Sync {
    async fn approve(&self, request: ApprovalRequest) -> Result<ApprovalDecision, BoxError>;

    /// Like [`Self::approve`] but also returns where the decision came
    /// from. Default impl calls `approve` and tags the source as
    /// [`HitSource::UserPrompt`] — the right answer for any approver
    /// that's just a UI prompt or a fixed-policy stub. Rule-driven
    /// approvers ([`crate::permission::RuleApprover`]) override to
    /// surface the actual rule / mode-default that fired, so
    /// transports can render "auto-allowed by user-scope rule" in the
    /// audit timeline.
    async fn approve_with_source(
        &self,
        request: ApprovalRequest,
    ) -> Result<(ApprovalDecision, HitSource), BoxError> {
        let d = self.approve(request).await?;
        Ok((d, HitSource::UserPrompt))
    }
}

/// Always say yes. Useful as an explicit no-op when wiring the trait to
/// preserve historical behaviour.
pub struct AlwaysApprove;

#[async_trait]
impl Approver for AlwaysApprove {
    async fn approve(&self, _request: ApprovalRequest) -> Result<ApprovalDecision, BoxError> {
        Ok(ApprovalDecision::Approve)
    }
}

/// Always deny. Handy in tests and for "panic-button" deployments that
/// want every sensitive call rejected until a real approver is wired in.
pub struct AlwaysDeny;

#[async_trait]
impl Approver for AlwaysDeny {
    async fn approve(&self, _request: ApprovalRequest) -> Result<ApprovalDecision, BoxError> {
        Ok(ApprovalDecision::deny("default deny policy"))
    }
}

/// One pending approval, surfaced through a `ChannelApprover` so a
/// consumer (CLI prompt, WebSocket frame, GUI dialog, …) can decide and
/// reply via the embedded `responder`.
pub struct PendingApproval {
    pub request: ApprovalRequest,
    /// Send the decision back to the agent. If dropped without sending,
    /// the agent treats it as `Err` (approver unavailable) and surfaces
    /// the failure as a tool error so the model can adapt.
    pub responder: oneshot::Sender<ApprovalDecision>,
}

/// Approver that fan-outs each request through a `tokio::mpsc` channel
/// and waits on a `oneshot` reply. Transport-agnostic — the consumer
/// loop decides how to translate `PendingApproval` into a UI prompt.
pub struct ChannelApprover {
    tx: mpsc::Sender<PendingApproval>,
}

impl ChannelApprover {
    /// Construct an approver and the matching receiver. The receiver is
    /// what the transport / CLI loop drains.
    pub fn new(buffer: usize) -> (Self, mpsc::Receiver<PendingApproval>) {
        let (tx, rx) = mpsc::channel(buffer);
        (Self { tx }, rx)
    }

    /// Wrap an existing sender. Useful when the caller already has a
    /// channel they want to multiplex.
    pub fn from_sender(tx: mpsc::Sender<PendingApproval>) -> Self {
        Self { tx }
    }
}

#[async_trait]
impl Approver for ChannelApprover {
    async fn approve(&self, request: ApprovalRequest) -> Result<ApprovalDecision, BoxError> {
        let (responder, rx) = oneshot::channel();
        let pending = PendingApproval { request, responder };
        self.tx
            .send(pending)
            .await
            .map_err(|_| -> BoxError { "approval channel closed".into() })?;
        rx.await
            .map_err(|_| -> BoxError { "approval responder dropped".into() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn req() -> ApprovalRequest {
        ApprovalRequest {
            tool_call_id: "call_1".into(),
            tool_name: "fs.write".into(),
            arguments: json!({"path":"a.txt"}),
            category: ToolCategory::Write,
        }
    }

    #[tokio::test]
    async fn always_approve_returns_approve() {
        let d = AlwaysApprove.approve(req()).await.unwrap();
        assert!(matches!(d, ApprovalDecision::Approve));
    }

    #[tokio::test]
    async fn always_deny_returns_deny_with_reason() {
        let d = AlwaysDeny.approve(req()).await.unwrap();
        match d {
            ApprovalDecision::Deny { reason } => {
                assert!(reason.unwrap().contains("default deny"));
            }
            _ => panic!("expected deny"),
        }
    }

    #[tokio::test]
    async fn channel_approver_round_trips() {
        let (approver, mut rx) = ChannelApprover::new(4);
        let handle = tokio::spawn(async move { approver.approve(req()).await });

        let pending = rx.recv().await.unwrap();
        assert_eq!(pending.request.tool_name, "fs.write");
        pending.responder.send(ApprovalDecision::Approve).unwrap();

        let decision = handle.await.unwrap().unwrap();
        assert!(matches!(decision, ApprovalDecision::Approve));
    }

    #[tokio::test]
    async fn channel_approver_errors_when_responder_dropped() {
        let (approver, mut rx) = ChannelApprover::new(4);
        let handle = tokio::spawn(async move { approver.approve(req()).await });

        let pending = rx.recv().await.unwrap();
        drop(pending); // never send a decision

        let err = handle.await.unwrap().unwrap_err();
        assert!(err.to_string().contains("responder dropped"));
    }

    #[tokio::test]
    async fn channel_approver_errors_when_receiver_dropped() {
        let (approver, rx) = ChannelApprover::new(4);
        drop(rx);
        let err = approver.approve(req()).await.unwrap_err();
        assert!(err.to_string().contains("channel closed"));
    }
}
