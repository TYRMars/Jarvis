//! Local observability and eval persistence contracts.
//!
//! OpenTelemetry remains the transport for full traces, but Jarvis also keeps
//! a compact local fact store for product dashboards, eval history, and
//! baseline comparisons. The value types here intentionally store flexible JSON
//! attribute bags so evolving OTel / GenAI field names do not force a schema
//! migration for every small addition.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::BoxError;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ObservedRunKind {
    Agent,
    Subagent,
    Eval,
    Tool,
    Provider,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ObservedOutcome {
    Success,
    Error,
    Timeout,
    Cancelled,
    MaxIterations,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ObservedRun {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<String>,
    pub kind: ObservedRunKind,
    pub name: String,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    pub outcome: ObservedOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_hash: Option<String>,
    #[serde(default)]
    pub attributes: Value,
    #[serde(default)]
    pub metrics: Value,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifact_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ObservedSpanSummary {
    pub id: String,
    pub trace_id: String,
    pub span_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_span_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub name: String,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    pub outcome: ObservedOutcome,
    #[serde(default)]
    pub attributes: Value,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifact_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MetricKind {
    Counter,
    Gauge,
    Histogram,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MetricPoint {
    pub id: String,
    pub name: String,
    pub kind: MetricKind,
    pub timestamp: String,
    pub value: f64,
    #[serde(default)]
    pub attributes: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TimeWindow {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
}

impl TimeWindow {
    pub fn last_24h() -> Self {
        Self {
            label: "24h".into(),
            since: None,
            until: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObservabilityFilter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ObservedRunKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<ObservedOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DashboardSnapshot {
    pub window: TimeWindow,
    pub generated_at: String,
    pub total_runs: usize,
    pub successful_runs: usize,
    pub failed_runs: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_success_rate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub p95_latency_ms: Option<u64>,
    #[serde(default)]
    pub by_kind: Value,
    #[serde(default)]
    pub by_name: Value,
}

#[async_trait]
pub trait ObservabilityStore: Send + Sync {
    async fn append_run(&self, run: &ObservedRun) -> Result<(), BoxError>;

    async fn append_span_summary(&self, span: &ObservedSpanSummary) -> Result<(), BoxError>;

    async fn append_metric_point(&self, point: &MetricPoint) -> Result<(), BoxError>;

    async fn list_runs(&self, filter: ObservabilityFilter) -> Result<Vec<ObservedRun>, BoxError>;

    async fn dashboard(&self, window: TimeWindow) -> Result<DashboardSnapshot, BoxError>;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EvalSuiteRun {
    pub id: String,
    pub suite: String,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    pub outcome: ObservedOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_id: Option<String>,
    #[serde(default)]
    pub attributes: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EvalCaseResult {
    pub id: String,
    pub suite_run_id: String,
    pub case_id: String,
    pub suite: String,
    pub scenario: String,
    pub outcome: ObservedOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    #[serde(default)]
    pub scores: Value,
    #[serde(default)]
    pub attributes: Value,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifact_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EvalBaseline {
    pub id: String,
    pub suite: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default)]
    pub summary: Value,
    #[serde(default)]
    pub cases: Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct EvalFilter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suite: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub case_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<ObservedOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[async_trait]
pub trait EvalStore: Send + Sync {
    async fn save_suite_run(&self, run: &EvalSuiteRun) -> Result<(), BoxError>;

    async fn save_case_result(&self, result: &EvalCaseResult) -> Result<(), BoxError>;

    async fn save_baseline(&self, baseline: &EvalBaseline) -> Result<(), BoxError>;

    async fn load_baseline(&self, id: &str) -> Result<Option<EvalBaseline>, BoxError>;

    async fn list_case_results(&self, filter: EvalFilter) -> Result<Vec<EvalCaseResult>, BoxError>;
}
