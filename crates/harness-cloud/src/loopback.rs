use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use harness_core::BoxError;
use tokio::sync::{mpsc, Mutex};

use crate::{EdgeTransport, Envelope};

/// An in-process loopback transport backed by two unbounded mpsc channels.
///
/// Created via [`loopback_transport()`] which returns a connected `(server, runtime)` pair.
/// Messages sent on the server are received by the runtime, and vice-versa.
#[derive(Clone)]
pub struct LoopbackTransport {
    tx: mpsc::UnboundedSender<Envelope>,
    rx: Arc<Mutex<Option<mpsc::UnboundedReceiver<Envelope>>>>,
    closed: Arc<AtomicBool>,
}

#[async_trait]
impl EdgeTransport for LoopbackTransport {
    async fn send(&self, envelope: Envelope) -> Result<(), BoxError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("transport closed".into());
        }
        self.tx.send(envelope).map_err(|_| "send failed".into())
    }

    async fn recv(&self) -> Result<Option<Envelope>, BoxError> {
        let mut rx = self.rx.lock().await;
        if self.closed.load(Ordering::SeqCst) {
            return Ok(None);
        }
        match rx.as_mut() {
            Some(r) => Ok(r.recv().await),
            None => Ok(None),
        }
    }

    async fn close(&self) -> Result<(), BoxError> {
        self.closed.store(true, Ordering::SeqCst);
        let mut rx = self.rx.lock().await;
        *rx = None;
        Ok(())
    }
}

/// Create a pair of connected loopback transports.
///
/// The first element is the **server** side; the second is the **runtime** side.
pub fn loopback_transport() -> (LoopbackTransport, LoopbackTransport) {
    let (server_to_runtime_tx, server_to_runtime_rx) = mpsc::unbounded_channel::<Envelope>();
    let (runtime_to_server_tx, runtime_to_server_rx) = mpsc::unbounded_channel::<Envelope>();

    let server = LoopbackTransport {
        tx: server_to_runtime_tx,
        rx: Arc::new(Mutex::new(Some(runtime_to_server_rx))),
        closed: Arc::new(AtomicBool::new(false)),
    };

    let runtime = LoopbackTransport {
        tx: runtime_to_server_tx,
        rx: Arc::new(Mutex::new(Some(server_to_runtime_rx))),
        closed: Arc::new(AtomicBool::new(false)),
    };

    (server, runtime)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{EdgeCapabilities, EdgeToolSpec, ToolRisk};
    use crate::protocol::{
        RuntimeHeartbeat, RuntimeLoadStatus, RuntimeRegister, TaskCancel, TaskClaim, TaskComplete,
        TaskDispatch, TaskFail, TaskProgress, TaskProgressEvent,
    };
    use crate::{Envelope, Payload};
    use harness_core::{Conversation, PlanItem, PlanStatus};

    #[tokio::test]
    async fn loopback_dispatch_progress_complete_e2e() {
        let (server, runtime) = loopback_transport();

        // Server dispatches a task
        let dispatch = Envelope::from_payload(
            "acme",
            "r-1",
            Payload::TaskDispatch(TaskDispatch {
                task_id: "t-1".into(),
                requirement_run_id: "rr-1".into(),
                conversation_id: "c-1".into(),
                work_dir: Some("/tmp".into()),
                session_id: None,
            }),
        );
        server.send(dispatch).await.unwrap();

        // Runtime receives the dispatch
        let env = runtime.recv().await.unwrap().expect("expected dispatch");
        let payload = env.payload().unwrap();
        assert!(matches!(payload, Payload::TaskDispatch(_)));

        // Runtime streams progress back
        let progress = Envelope::from_payload(
            "acme",
            "r-1",
            Payload::TaskProgress(TaskProgress {
                task_id: "t-1".into(),
                event: TaskProgressEvent::Delta {
                    content: "working...".into(),
                },
            }),
        );
        runtime.send(progress).await.unwrap();

        // Server receives progress
        let env = server.recv().await.unwrap().expect("expected progress");
        let payload = env.payload().unwrap();
        assert!(matches!(payload, Payload::TaskProgress(_)));

        // Runtime completes the task
        let complete = Envelope::from_payload(
            "acme",
            "r-1",
            Payload::TaskComplete(TaskComplete {
                task_id: "t-1".into(),
                conversation: Conversation::with_system("done"),
                result: serde_json::json!({"ok": true}),
            }),
        );
        runtime.send(complete).await.unwrap();

        // Server receives complete
        let env = server.recv().await.unwrap().expect("expected complete");
        let payload = env.payload().unwrap();
        assert!(matches!(payload, Payload::TaskComplete(_)));

        // Graceful close on both sides
        server.close().await.unwrap();
        runtime.close().await.unwrap();

        // After close, recv returns None
        assert!(server.recv().await.unwrap().is_none());
        assert!(runtime.recv().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn loopback_bidirectional_register_and_heartbeat() {
        let (server, runtime) = loopback_transport();

        let register = Envelope::from_payload(
            "acme",
            "r-1",
            Payload::RuntimeRegister(RuntimeRegister {
                runtime_id: "r-1".into(),
                version: "0.1.0".into(),
                token: "tok".into(),
                capabilities: EdgeCapabilities {
                    tools: vec![EdgeToolSpec {
                        name: "echo".into(),
                        description: "echo".into(),
                        parameters: serde_json::json!({}),
                        risk: ToolRisk::ReadOnly,
                    }],
                    supports_approval: true,
                    supports_streaming: true,
                },
                tenant_slugs: vec!["acme".into()],
            }),
        );
        runtime.send(register).await.unwrap();

        let env = server.recv().await.unwrap().expect("expected register");
        let payload = env.payload().unwrap();
        assert!(matches!(payload, Payload::RuntimeRegister(_)));

        let heartbeat = Envelope::from_payload(
            "acme",
            "r-1",
            Payload::RuntimeHeartbeat(RuntimeHeartbeat {
                runtime_id: "r-1".into(),
                status: RuntimeLoadStatus::Idle,
                running_tasks: 0,
                idle: true,
            }),
        );
        runtime.send(heartbeat).await.unwrap();

        let env = server.recv().await.unwrap().expect("expected heartbeat");
        let payload = env.payload().unwrap();
        assert!(matches!(payload, Payload::RuntimeHeartbeat(_)));

        // Server cancels a task
        let cancel = Envelope::from_payload(
            "acme",
            "r-1",
            Payload::TaskCancel(TaskCancel {
                task_id: "t-1".into(),
            }),
        );
        server.send(cancel).await.unwrap();

        let env = runtime.recv().await.unwrap().expect("expected cancel");
        let payload = env.payload().unwrap();
        assert!(matches!(payload, Payload::TaskCancel(_)));

        // Runtime claims a task
        let claim = Envelope::from_payload(
            "acme",
            "r-1",
            Payload::TaskClaim(TaskClaim {
                task_id: "t-1".into(),
                runtime_id: "r-1".into(),
            }),
        );
        runtime.send(claim).await.unwrap();

        let env = server.recv().await.unwrap().expect("expected claim");
        let payload = env.payload().unwrap();
        assert!(matches!(payload, Payload::TaskClaim(_)));

        // Runtime fails a task
        let fail = Envelope::from_payload(
            "acme",
            "r-1",
            Payload::TaskFail(TaskFail {
                task_id: "t-1".into(),
                error: "oom".into(),
            }),
        );
        runtime.send(fail).await.unwrap();

        let env = server.recv().await.unwrap().expect("expected fail");
        let payload = env.payload().unwrap();
        assert!(matches!(payload, Payload::TaskFail(_)));
    }

    #[tokio::test]
    async fn loopback_forward_compat_unknown_type() {
        let (server, runtime) = loopback_transport();

        let env = Envelope::new(
            "runtime.future_event",
            "acme",
            "r-1",
            serde_json::json!({"foo": 42}),
        );
        server.send(env).await.unwrap();

        let received = runtime.recv().await.unwrap().expect("expected envelope");
        assert_eq!(received.ty, "runtime.future_event");
        let payload = received.payload().unwrap();
        assert!(matches!(payload, Payload::Unknown(v) if v["foo"] == 42));
    }

    #[tokio::test]
    async fn loopback_send_after_close_fails() {
        let (server, _runtime) = loopback_transport();
        server.close().await.unwrap();

        let env = Envelope::new("task.dispatch", "acme", "r-1", serde_json::json!({}));
        let err = server.send(env).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn loopback_progress_with_plan_update_round_trip() {
        let (server, runtime) = loopback_transport();

        let progress = Envelope::from_payload(
            "acme",
            "r-1",
            Payload::TaskProgress(TaskProgress {
                task_id: "t-2".into(),
                event: TaskProgressEvent::PlanUpdate {
                    items: vec![PlanItem {
                        id: "step-1".into(),
                        title: "Do thing".into(),
                        status: PlanStatus::InProgress,
                        note: None,
                    }],
                },
            }),
        );
        runtime.send(progress).await.unwrap();

        let env = server.recv().await.unwrap().expect("expected progress");
        let parsed = env.payload().unwrap();
        assert!(matches!(
            parsed,
            Payload::TaskProgress(TaskProgress {
                event: TaskProgressEvent::PlanUpdate { .. },
                ..
            })
        ));
    }
}
