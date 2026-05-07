use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::protocol::{
    RuntimeHeartbeat, RuntimeRegister, TaskCancel, TaskClaim, TaskComplete, TaskDispatch,
    TaskFail, TaskProgress,
};

/// Common envelope for all cloud / edge messages.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub v: u32,
    #[serde(rename = "type")]
    pub ty: String,
    pub id: String,
    pub ts: String,
    pub tenant_slug: String,
    pub runtime_id: String,
    pub payload: Value,
}

/// Typed payload variants for all known cloud / edge message types.
///
/// Unknown or future types round-trip through [`Payload::Unknown`] so
/// the runtime can forward them without panicking.
#[derive(Debug, Clone)]
pub enum Payload {
    RuntimeRegister(RuntimeRegister),
    RuntimeHeartbeat(RuntimeHeartbeat),
    TaskDispatch(TaskDispatch),
    TaskClaim(TaskClaim),
    TaskProgress(TaskProgress),
    TaskComplete(TaskComplete),
    TaskFail(TaskFail),
    TaskCancel(TaskCancel),
    /// Catch-all for forward compatibility — holds the raw JSON payload
    /// when the envelope `type` is not recognised.
    Unknown(Value),
}

impl Envelope {
    pub fn new(ty: impl Into<String>, tenant_slug: impl Into<String>, runtime_id: impl Into<String>, payload: Value) -> Self {
        Self {
            v: 1,
            ty: ty.into(),
            id: uuid::Uuid::new_v4().to_string(),
            ts: chrono::Utc::now().to_rfc3339(),
            tenant_slug: tenant_slug.into(),
            runtime_id: runtime_id.into(),
            payload,
        }
    }

    /// Build an envelope from a typed [`Payload`].
    pub fn from_payload(
        tenant_slug: impl Into<String>,
        runtime_id: impl Into<String>,
        payload: Payload,
    ) -> Self {
        let (ty, value) = payload.into_type_value();
        Self::new(ty, tenant_slug, runtime_id, value)
    }

    /// Parse the envelope into a typed [`Payload`].
    ///
    /// Returns [`Payload::Unknown`] when the `type` field is not one of the
    /// eight known variants, preserving forward compatibility.
    pub fn payload(&self) -> Result<Payload, serde_json::Error> {
        Ok(match self.ty.as_str() {
            "runtime.register" => {
                Payload::RuntimeRegister(serde_json::from_value(self.payload.clone())?)
            }
            "runtime.heartbeat" => {
                Payload::RuntimeHeartbeat(serde_json::from_value(self.payload.clone())?)
            }
            "task.dispatch" => {
                Payload::TaskDispatch(serde_json::from_value(self.payload.clone())?)
            }
            "task.claim" => Payload::TaskClaim(serde_json::from_value(self.payload.clone())?),
            "task.progress" => {
                Payload::TaskProgress(serde_json::from_value(self.payload.clone())?)
            }
            "task.complete" => {
                Payload::TaskComplete(serde_json::from_value(self.payload.clone())?)
            }
            "task.fail" => Payload::TaskFail(serde_json::from_value(self.payload.clone())?),
            "task.cancel" => {
                Payload::TaskCancel(serde_json::from_value(self.payload.clone())?)
            }
            _ => Payload::Unknown(self.payload.clone()),
        })
    }
}

impl Payload {
    /// Wire type name used in the envelope `type` field.
    pub fn type_name(&self) -> &'static str {
        match self {
            Payload::RuntimeRegister(_) => "runtime.register",
            Payload::RuntimeHeartbeat(_) => "runtime.heartbeat",
            Payload::TaskDispatch(_) => "task.dispatch",
            Payload::TaskClaim(_) => "task.claim",
            Payload::TaskProgress(_) => "task.progress",
            Payload::TaskComplete(_) => "task.complete",
            Payload::TaskFail(_) => "task.fail",
            Payload::TaskCancel(_) => "task.cancel",
            Payload::Unknown(_) => "unknown",
        }
    }

    fn into_type_value(self) -> (&'static str, Value) {
        let ty = self.type_name();
        let value = match self {
            Payload::RuntimeRegister(v) => serde_json::to_value(v).unwrap(),
            Payload::RuntimeHeartbeat(v) => serde_json::to_value(v).unwrap(),
            Payload::TaskDispatch(v) => serde_json::to_value(v).unwrap(),
            Payload::TaskClaim(v) => serde_json::to_value(v).unwrap(),
            Payload::TaskProgress(v) => serde_json::to_value(v).unwrap(),
            Payload::TaskComplete(v) => serde_json::to_value(v).unwrap(),
            Payload::TaskFail(v) => serde_json::to_value(v).unwrap(),
            Payload::TaskCancel(v) => serde_json::to_value(v).unwrap(),
            Payload::Unknown(v) => v,
        };
        (ty, value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{EdgeCapabilities, EdgeToolSpec, ToolRisk};
    use crate::protocol::{
        RuntimeLoadStatus, TaskProgressEvent,
    };
    use harness_core::{Conversation, PlanItem, PlanStatus};

    fn sample_register() -> RuntimeRegister {
        RuntimeRegister {
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
        }
    }

    fn sample_heartbeat() -> RuntimeHeartbeat {
        RuntimeHeartbeat {
            runtime_id: "r-1".into(),
            status: RuntimeLoadStatus::Idle,
            running_tasks: 0,
            idle: true,
        }
    }

    fn sample_dispatch() -> TaskDispatch {
        TaskDispatch {
            task_id: "t-1".into(),
            requirement_run_id: "rr-1".into(),
            conversation_id: "c-1".into(),
            work_dir: Some("/tmp".into()),
            session_id: None,
        }
    }

    fn sample_claim() -> TaskClaim {
        TaskClaim {
            task_id: "t-1".into(),
            runtime_id: "r-1".into(),
        }
    }

    fn sample_progress() -> TaskProgress {
        TaskProgress {
            task_id: "t-1".into(),
            event: TaskProgressEvent::Delta {
                content: "hello".into(),
            },
        }
    }

    fn sample_complete() -> TaskComplete {
        TaskComplete {
            task_id: "t-1".into(),
            conversation: Conversation::with_system("be helpful"),
            result: serde_json::json!({"ok": true}),
        }
    }

    fn sample_fail() -> TaskFail {
        TaskFail {
            task_id: "t-1".into(),
            error: "oom".into(),
        }
    }

    fn sample_cancel() -> TaskCancel {
        TaskCancel {
            task_id: "t-1".into(),
        }
    }

    #[test]
    fn runtime_register_round_trip() {
        let p = Payload::RuntimeRegister(sample_register());
        let env = Envelope::from_payload("acme", "r-1", p.clone());
        let parsed = env.payload().unwrap();
        assert!(matches!(parsed, Payload::RuntimeRegister(_)));
        assert_eq!(env.ty, "runtime.register");
    }

    #[test]
    fn runtime_heartbeat_round_trip() {
        let p = Payload::RuntimeHeartbeat(sample_heartbeat());
        let env = Envelope::from_payload("acme", "r-1", p.clone());
        let parsed = env.payload().unwrap();
        assert!(matches!(parsed, Payload::RuntimeHeartbeat(_)));
        assert_eq!(env.ty, "runtime.heartbeat");
    }

    #[test]
    fn task_dispatch_round_trip() {
        let p = Payload::TaskDispatch(sample_dispatch());
        let env = Envelope::from_payload("acme", "r-1", p.clone());
        let parsed = env.payload().unwrap();
        assert!(matches!(parsed, Payload::TaskDispatch(_)));
        assert_eq!(env.ty, "task.dispatch");
    }

    #[test]
    fn task_claim_round_trip() {
        let p = Payload::TaskClaim(sample_claim());
        let env = Envelope::from_payload("acme", "r-1", p.clone());
        let parsed = env.payload().unwrap();
        assert!(matches!(parsed, Payload::TaskClaim(_)));
        assert_eq!(env.ty, "task.claim");
    }

    #[test]
    fn task_progress_round_trip() {
        let p = Payload::TaskProgress(sample_progress());
        let env = Envelope::from_payload("acme", "r-1", p.clone());
        let parsed = env.payload().unwrap();
        assert!(matches!(parsed, Payload::TaskProgress(_)));
        assert_eq!(env.ty, "task.progress");
    }

    #[test]
    fn task_complete_round_trip() {
        let p = Payload::TaskComplete(sample_complete());
        let env = Envelope::from_payload("acme", "r-1", p.clone());
        let parsed = env.payload().unwrap();
        assert!(matches!(parsed, Payload::TaskComplete(_)));
        assert_eq!(env.ty, "task.complete");
    }

    #[test]
    fn task_fail_round_trip() {
        let p = Payload::TaskFail(sample_fail());
        let env = Envelope::from_payload("acme", "r-1", p.clone());
        let parsed = env.payload().unwrap();
        assert!(matches!(parsed, Payload::TaskFail(_)));
        assert_eq!(env.ty, "task.fail");
    }

    #[test]
    fn task_cancel_round_trip() {
        let p = Payload::TaskCancel(sample_cancel());
        let env = Envelope::from_payload("acme", "r-1", p.clone());
        let parsed = env.payload().unwrap();
        assert!(matches!(parsed, Payload::TaskCancel(_)));
        assert_eq!(env.ty, "task.cancel");
    }

    #[test]
    fn unknown_type_becomes_unknown_payload() {
        let env = Envelope::new(
            "runtime.future_event",
            "acme",
            "r-1",
            serde_json::json!({"foo": 42}),
        );
        let parsed = env.payload().unwrap();
        assert!(matches!(parsed, Payload::Unknown(v) if v["foo"] == 42));
    }

    #[test]
    fn unknown_fields_inside_payload_are_ignored() {
        // Forward-compat: a future server sends extra fields in a known payload.
        let env = Envelope::new(
            "runtime.heartbeat",
            "acme",
            "r-1",
            serde_json::json!({
                "runtime_id": "r-1",
                "status": "idle",
                "running_tasks": 0,
                "idle": true,
                "future_metric": 123,
            }),
        );
        let parsed = env.payload().unwrap();
        assert!(matches!(parsed, Payload::RuntimeHeartbeat(_)));
    }

    #[test]
    fn envelope_json_round_trip() {
        let p = Payload::TaskDispatch(sample_dispatch());
        let env = Envelope::from_payload("acme", "r-1", p);
        let json = serde_json::to_string(&env).unwrap();
        let env2: Envelope = serde_json::from_str(&json).unwrap();
        assert_eq!(env2.ty, "task.dispatch");
        assert_eq!(env2.tenant_slug, "acme");
        assert_eq!(env2.runtime_id, "r-1");
    }

    #[test]
    fn progress_with_plan_update_round_trip() {
        let p = Payload::TaskProgress(TaskProgress {
            task_id: "t-2".into(),
            event: TaskProgressEvent::PlanUpdate {
                items: vec![PlanItem {
                    id: "step-1".into(),
                    title: "Do thing".into(),
                    status: PlanStatus::InProgress,
                    note: None,
                }],
            },
        });
        let env = Envelope::from_payload("acme", "r-1", p);
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
