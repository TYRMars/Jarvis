//! Test-only subagent that echoes its task back as a sequence of
//! frames + a final message. Used by integration tests to verify the
//! frame-relay path (subagent → task-local channel → main `Agent`
//! loop → `AgentEvent::SubAgentEvent`) without spinning up an LLM.

use crate::{
    emit_subagent, Artifact, SubAgent, SubAgentEvent, SubAgentFrame, SubAgentInput,
    SubAgentOutput,
};
use async_trait::async_trait;
use harness_core::BoxError;
use serde_json::json;

/// Predictable subagent for tests. Emits `Started`, three `Delta`s
/// that spell out the task one chunk at a time, then `Done`.
pub struct EchoSubAgent {
    name: String,
}

impl EchoSubAgent {
    pub fn new(name: impl Into<String>) -> Self {
        Self { name: name.into() }
    }
}

#[async_trait]
impl SubAgent for EchoSubAgent {
    fn name(&self) -> &str {
        &self.name
    }
    fn description(&self) -> &str {
        "Test-only subagent that echoes its task back. Not registered in production."
    }
    fn input_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "task": { "type": "string" }
            },
            "required": ["task"]
        })
    }

    async fn invoke(&self, input: SubAgentInput) -> Result<SubAgentOutput, BoxError> {
        let id = uuid::Uuid::new_v4().to_string();
        emit_subagent(SubAgentFrame {
            subagent_id: id.clone(),
            subagent_name: self.name.clone(),
            event: SubAgentEvent::Started {
                task: input.task.clone(),
                model: None,
            },
        });
        // Three Delta chunks — split the task into thirds (or whole
        // string if it's short). Tests assert on the resulting
        // sequence of frames.
        let chunks: Vec<&str> = if input.task.len() < 3 {
            vec![input.task.as_str()]
        } else {
            let third = input.task.len() / 3;
            vec![
                &input.task[..third],
                &input.task[third..third * 2],
                &input.task[third * 2..],
            ]
        };
        for c in chunks {
            emit_subagent(SubAgentFrame {
                subagent_id: id.clone(),
                subagent_name: self.name.clone(),
                event: SubAgentEvent::Delta { text: c.to_string() },
            });
        }
        let final_message = format!("echoed: {}", input.task);
        emit_subagent(SubAgentFrame {
            subagent_id: id,
            subagent_name: self.name.clone(),
            event: SubAgentEvent::Done {
                final_message: final_message.clone(),
            },
        });
        Ok(SubAgentOutput {
            message: final_message,
            artifacts: vec![Artifact::DocSummary {
                summary: input.task,
                quotes: Vec::new(),
            }],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tokio::sync::mpsc;

    #[tokio::test]
    async fn echo_emits_started_deltas_done_in_order() {
        let (tx, mut rx) = mpsc::unbounded_channel::<SubAgentFrame>();
        let sub = EchoSubAgent::new("echo");
        let out = with_subagent_scope(tx, async {
            sub.invoke(SubAgentInput {
                task: "verify the kanban renders".into(),
                workspace_root: PathBuf::from("/tmp"),
                context: None,
                caller_chain: Vec::new(),
            })
            .await
            .unwrap()
        })
        .await;
        assert_eq!(out.message, "echoed: verify the kanban renders");

        // Drain the channel.
        let mut frames = Vec::new();
        while let Ok(f) = rx.try_recv() {
            frames.push(f);
        }
        // Started + 3 Delta + Done = 5 frames.
        assert_eq!(frames.len(), 5, "got {frames:?}");
        assert!(matches!(frames[0].event, SubAgentEvent::Started { .. }));
        assert!(matches!(frames[1].event, SubAgentEvent::Delta { .. }));
        assert!(matches!(frames[2].event, SubAgentEvent::Delta { .. }));
        assert!(matches!(frames[3].event, SubAgentEvent::Delta { .. }));
        assert!(matches!(frames[4].event, SubAgentEvent::Done { .. }));
        // All frames share the same subagent_id.
        let id0 = &frames[0].subagent_id;
        for f in &frames {
            assert_eq!(&f.subagent_id, id0);
            assert_eq!(f.subagent_name, "echo");
        }
    }

    /// Tiny helper to scope a sender over an async block — sugar for
    /// the harness-core `with_subagent` re-export. Tests want a value
    /// out of the future, so we wrap.
    async fn with_subagent_scope<F, R>(
        tx: mpsc::UnboundedSender<SubAgentFrame>,
        fut: F,
    ) -> R
    where
        F: std::future::Future<Output = R>,
    {
        crate::with_subagent(tx, fut).await
    }
}
