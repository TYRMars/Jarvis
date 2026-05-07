use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Messages sent by the Edge runtime to the Cloud control plane.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuntimeMessage {
    Register(RuntimeRegister),
    Heartbeat(RuntimeHeartbeat),
}

/// Messages sent by the Cloud control plane to the Edge runtime.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TaskMessage {
    Dispatch(TaskDispatch),
    Cancel(TaskCancel),
}

/// Edge → Cloud: initial handshake announcing a runtime.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeRegister {
    pub runtime_id: String,
    pub version: String,
    pub token: String,
    pub capabilities: crate::EdgeCapabilities,
    pub tenant_slugs: Vec<String>,
}

/// Edge → Cloud: periodic heartbeat + load report.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeHeartbeat {
    pub runtime_id: String,
    pub status: RuntimeLoadStatus,
    pub running_tasks: usize,
    pub idle: bool,
}

/// Load status reported by a runtime.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeLoadStatus {
    Idle,
    Running,
    Busy,
    Offline,
}

/// Cloud → Edge: dispatch a unit of work.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskDispatch {
    pub task_id: String,
    pub requirement_run_id: String,
    pub conversation_id: String,
    pub work_dir: Option<String>,
    pub session_id: Option<String>,
}

/// Cloud → Edge: cancel an in-flight task.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskCancel {
    pub task_id: String,
}

/// Edge → Cloud: claim a dispatched task (idempotent dedup).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskClaim {
    pub task_id: String,
    pub runtime_id: String,
}

/// Edge → Cloud: stream progress for a task.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskProgress {
    pub task_id: String,
    pub event: TaskProgressEvent,
}

/// Individual progress event inside a task stream.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TaskProgressEvent {
    Delta { content: String },
    ToolStart { tool_call_id: String, name: String },
    ToolEnd { tool_call_id: String, output: String },
    PlanUpdate { items: Vec<harness_core::PlanItem> },
    ApprovalRequest { tool_call_id: String, name: String },
}

/// Edge → Cloud: task finished successfully.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskComplete {
    pub task_id: String,
    pub conversation: harness_core::Conversation,
    pub result: Value,
}

/// Edge → Cloud: task failed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskFail {
    pub task_id: String,
    pub error: String,
}

/// A command sent from Cloud to Edge for remote execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeCommand {
    pub command_id: String,
    pub kind: EdgeCommandKind,
    pub payload: Value,
}

/// Kinds of edge commands.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeCommandKind {
    InvokeTool,
    ReloadConfig,
    Shutdown,
}

/// Result returned from an Edge command.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeCommandResult {
    pub command_id: String,
    pub ok: bool,
    pub output: Option<String>,
    pub error: Option<String>,
}
