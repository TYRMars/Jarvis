//! REST routes for Jarvis-local observability summaries.
//!
//! These endpoints read the compact local facts store used by the Jarvis UI.
//! They do not query Jaeger / Tempo / other OTLP backends; those remain the
//! place for full trace drill-down.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::get,
    Router,
};
use harness_core::{
    EvalCaseResult, EvalFilter, EvalStore, ObservabilityFilter, ObservabilityStore,
    ObservedOutcome, ObservedRun, ObservedRunKind, RequirementRun, RequirementRunStatus,
    TimeWindow, VerificationStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::state::AppState;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/observability/dashboard", get(get_dashboard))
        .route("/v1/observability/runs", get(list_runs))
        .route("/v1/observability/tools", get(list_tool_summary))
        .route("/v1/observability/subagents", get(list_subagent_summary))
        .route("/v1/observability/direction", get(get_direction))
        .route(
            "/v1/observability/capability-score",
            get(get_capability_score),
        )
        .route("/v1/observability/exporter", get(get_exporter_status))
        .route("/v1/evals/summary", get(get_eval_summary))
        .route("/v1/evals/cases", get(list_eval_cases))
}

async fn get_exporter_status(State(state): State<AppState>) -> Response {
    let status = state.telemetry.clone().unwrap_or_default();
    Json(json!({
        "enabled": status.enabled,
        "endpoint": status.endpoint,
        "protocol": status.protocol,
        "service_name": if status.service_name.is_empty() {
            "jarvis".to_string()
        } else {
            status.service_name
        },
        "service_env": if status.service_env.is_empty() {
            "local".to_string()
        } else {
            status.service_env
        },
        "sample_ratio": status.sample_ratio,
    }))
    .into_response()
}

fn observability_store(state: &AppState) -> Option<Arc<dyn ObservabilityStore>> {
    state.observability.clone()
}

fn eval_store(state: &AppState) -> Option<Arc<dyn EvalStore>> {
    state.evals.clone()
}

fn unavailable(message: &str) -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({"error": message})),
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
struct DashboardQuery {
    #[serde(default = "default_window")]
    window: String,
}

fn default_window() -> String {
    "24h".into()
}

async fn get_dashboard(State(state): State<AppState>, Query(q): Query<DashboardQuery>) -> Response {
    let store = match observability_store(&state) {
        Some(store) => store,
        None => return unavailable("observability store not configured"),
    };
    match store
        .dashboard(TimeWindow {
            label: q.window,
            since: None,
            until: None,
        })
        .await
    {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
struct RunsQuery {
    kind: Option<ObservedRunKind>,
    name: Option<String>,
    outcome: Option<ObservedOutcome>,
    project_id: Option<String>,
    limit: Option<u32>,
}

async fn list_runs(State(state): State<AppState>, Query(q): Query<RunsQuery>) -> Response {
    let store = match observability_store(&state) {
        Some(store) => store,
        None => return unavailable("observability store not configured"),
    };
    let limit = q.limit.unwrap_or(50).min(500);
    match store
        .list_runs(ObservabilityFilter {
            kind: q.kind,
            name: q.name,
            outcome: q.outcome,
            project_id: q.project_id,
            limit: Some(limit),
        })
        .await
    {
        Ok(runs) => Json(json!({ "runs": runs })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
struct SummaryQuery {
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct DirectionQuery {
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct CapabilityScoreQuery {
    limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
struct HarnessDirectionComponent {
    key: String,
    label: String,
    score: u8,
    value: Option<f64>,
    detail: String,
}

#[derive(Debug, Clone, Serialize)]
struct HarnessDirectionRecommendation {
    key: String,
    priority: u8,
    tone: String,
    title: String,
    detail: String,
    metric: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct HarnessDirectionSnapshot {
    generated_at: String,
    score: u8,
    primary_focus: String,
    components: Vec<HarnessDirectionComponent>,
    recommendations: Vec<HarnessDirectionRecommendation>,
    sample: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
struct CapabilityDriver {
    key: String,
    label: String,
    value: Option<f64>,
    weight: f64,
    score: u8,
    detail: String,
}

#[derive(Debug, Clone, Serialize)]
struct CapabilityEvidence {
    kind: String,
    id: String,
    title: String,
    detail: String,
    metric: Option<String>,
    tone: String,
}

#[derive(Debug, Clone, Serialize)]
struct CapabilityDimensionScore {
    key: String,
    label: String,
    score: u8,
    confidence: f64,
    summary: String,
    drivers: Vec<CapabilityDriver>,
    evidence: Vec<CapabilityEvidence>,
}

#[derive(Debug, Clone, Serialize)]
struct CapabilityScoreSnapshot {
    generated_at: String,
    overall_score: u8,
    confidence: f64,
    sample_count: usize,
    dimensions: Vec<CapabilityDimensionScore>,
    rules: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
struct ObservedRunSummary {
    name: String,
    runs: usize,
    success: usize,
    errors: usize,
    unknown: usize,
    success_rate: Option<f64>,
    median_duration_ms: Option<u64>,
    p95_duration_ms: Option<u64>,
    avg_duration_ms: Option<f64>,
    avg_output_bytes: Option<f64>,
    avg_frames: Option<f64>,
    avg_tool_calls: Option<f64>,
}

#[derive(Debug, Default)]
struct SummaryBucket {
    runs: usize,
    success: usize,
    errors: usize,
    unknown: usize,
    durations: Vec<u64>,
    output_bytes_sum: f64,
    output_bytes_count: usize,
    frames_sum: f64,
    frames_count: usize,
    tool_calls_sum: f64,
    tool_calls_count: usize,
}

async fn list_tool_summary(
    State(state): State<AppState>,
    Query(q): Query<SummaryQuery>,
) -> Response {
    list_kind_summary(state, ObservedRunKind::Tool, "tools", q.limit)
        .await
        .into_response()
}

async fn list_subagent_summary(
    State(state): State<AppState>,
    Query(q): Query<SummaryQuery>,
) -> Response {
    list_kind_summary(state, ObservedRunKind::Subagent, "subagents", q.limit)
        .await
        .into_response()
}

async fn get_direction(State(state): State<AppState>, Query(q): Query<DirectionQuery>) -> Response {
    let store = match observability_store(&state) {
        Some(store) => store,
        None => return unavailable("observability store not configured"),
    };
    let scan_limit = q.limit.unwrap_or(2_000).min(10_000);
    let runs = match store
        .list_runs(ObservabilityFilter {
            limit: Some(scan_limit),
            ..ObservabilityFilter::default()
        })
        .await
    {
        Ok(runs) => runs,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": e.to_string()})),
            )
                .into_response();
        }
    };

    let eval_cases = match eval_store(&state) {
        Some(store) => match store
            .list_case_results(EvalFilter {
                limit: Some(scan_limit),
                ..EvalFilter::default()
            })
            .await
        {
            Ok(cases) => Some(cases),
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error": e.to_string()})),
                )
                    .into_response();
            }
        },
        None => None,
    };

    Json(direction_snapshot(&runs, eval_cases.as_deref())).into_response()
}

async fn get_capability_score(
    State(state): State<AppState>,
    Query(q): Query<CapabilityScoreQuery>,
) -> Response {
    let scan_limit = q.limit.unwrap_or(2_000).min(10_000);
    let obs_runs = match observability_store(&state) {
        Some(store) => match store
            .list_runs(ObservabilityFilter {
                limit: Some(scan_limit),
                ..ObservabilityFilter::default()
            })
            .await
        {
            Ok(rows) => rows,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error": e.to_string()})),
                )
                    .into_response();
            }
        },
        None => Vec::new(),
    };
    let eval_cases = match eval_store(&state) {
        Some(store) => match store
            .list_case_results(EvalFilter {
                limit: Some(scan_limit),
                ..EvalFilter::default()
            })
            .await
        {
            Ok(rows) => rows,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error": e.to_string()})),
                )
                    .into_response();
            }
        },
        None => Vec::new(),
    };
    let requirement_runs = match state.requirement_runs.as_ref() {
        Some(store) => match store.list_all(scan_limit).await {
            Ok(rows) => rows,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error": e.to_string()})),
                )
                    .into_response();
            }
        },
        None => Vec::new(),
    };

    if obs_runs.is_empty()
        && eval_cases.is_empty()
        && requirement_runs.is_empty()
        && observability_store(&state).is_none()
        && eval_store(&state).is_none()
        && state.requirement_runs.is_none()
    {
        return unavailable("capability scoring stores not configured");
    }

    Json(capability_score_snapshot(
        &obs_runs,
        &eval_cases,
        &requirement_runs,
    ))
    .into_response()
}

async fn list_kind_summary(
    state: AppState,
    kind: ObservedRunKind,
    key: &'static str,
    limit: Option<u32>,
) -> Response {
    let store = match observability_store(&state) {
        Some(store) => store,
        None => return unavailable("observability store not configured"),
    };
    let scan_limit = limit.unwrap_or(500).saturating_mul(20).min(10_000);
    match store
        .list_runs(ObservabilityFilter {
            kind: Some(kind),
            limit: Some(scan_limit),
            ..ObservabilityFilter::default()
        })
        .await
    {
        Ok(runs) => {
            let mut summaries = summarize_runs(&runs);
            summaries.sort_by(|a, b| {
                b.errors
                    .cmp(&a.errors)
                    .then_with(|| b.runs.cmp(&a.runs))
                    .then_with(|| a.name.cmp(&b.name))
            });
            summaries.truncate(limit.unwrap_or(50).min(500) as usize);
            Json(json!({ key: summaries })).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

fn summarize_runs(runs: &[ObservedRun]) -> Vec<ObservedRunSummary> {
    let mut buckets: BTreeMap<String, SummaryBucket> = BTreeMap::new();
    for run in runs {
        let bucket = buckets.entry(run.name.clone()).or_default();
        bucket.runs += 1;
        match run.outcome {
            ObservedOutcome::Success => bucket.success += 1,
            ObservedOutcome::Error | ObservedOutcome::Timeout | ObservedOutcome::Cancelled => {
                bucket.errors += 1;
            }
            ObservedOutcome::Unknown | ObservedOutcome::MaxIterations => bucket.unknown += 1,
        }
        if let Some(duration) = run.duration_ms {
            bucket.durations.push(duration);
        }
        if let Some(n) = number_attr(run, "output_bytes") {
            bucket.output_bytes_sum += n;
            bucket.output_bytes_count += 1;
        }
        if let Some(n) = number_attr(run, "frames") {
            bucket.frames_sum += n;
            bucket.frames_count += 1;
        }
        if let Some(n) = number_attr(run, "tool_calls") {
            bucket.tool_calls_sum += n;
            bucket.tool_calls_count += 1;
        }
    }
    buckets
        .into_iter()
        .map(|(name, mut bucket)| {
            bucket.durations.sort_unstable();
            let duration_sum: u64 = bucket.durations.iter().sum();
            ObservedRunSummary {
                name,
                runs: bucket.runs,
                success: bucket.success,
                errors: bucket.errors,
                unknown: bucket.unknown,
                success_rate: (bucket.runs > 0).then(|| bucket.success as f64 / bucket.runs as f64),
                median_duration_ms: percentile(&bucket.durations, 0.50),
                p95_duration_ms: percentile(&bucket.durations, 0.95),
                avg_duration_ms: (!bucket.durations.is_empty())
                    .then(|| duration_sum as f64 / bucket.durations.len() as f64),
                avg_output_bytes: average(bucket.output_bytes_sum, bucket.output_bytes_count),
                avg_frames: average(bucket.frames_sum, bucket.frames_count),
                avg_tool_calls: average(bucket.tool_calls_sum, bucket.tool_calls_count),
            }
        })
        .collect()
}

fn number_attr(run: &ObservedRun, key: &str) -> Option<f64> {
    run.attributes
        .get(key)
        .and_then(serde_json::Value::as_f64)
        .or_else(|| run.metrics.get(key).and_then(serde_json::Value::as_f64))
}

fn average(sum: f64, count: usize) -> Option<f64> {
    (count > 0).then(|| sum / count as f64)
}

fn percentile(values: &[u64], percentile: f64) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    let idx = ((values.len() as f64 - 1.0) * percentile).ceil() as usize;
    values.get(idx).copied()
}

fn direction_snapshot(
    runs: &[ObservedRun],
    eval_cases: Option<&[EvalCaseResult]>,
) -> HarnessDirectionSnapshot {
    let agent_runs = runs_by_kind(runs, ObservedRunKind::Agent);
    let tool_runs = runs_by_kind(runs, ObservedRunKind::Tool);
    let subagent_runs = runs_by_kind(runs, ObservedRunKind::Subagent);
    let agent_success_rate = success_rate(&agent_runs).or_else(|| success_rate(runs));
    let tool_success_rate = success_rate(&tool_runs);
    let subagent_success_rate = success_rate(&subagent_runs);
    let eval_rate = eval_cases.and_then(eval_success_rate);

    let agent_p95 =
        duration_percentile(&agent_runs, 0.95).or_else(|| duration_percentile(runs, 0.95));
    let subagent_p95 = duration_percentile(&subagent_runs, 0.95);
    let tool_errors = count_errors(&tool_runs);
    let subagent_errors = count_errors(&subagent_runs);

    let reliability = match (agent_success_rate, tool_success_rate) {
        (Some(agent), Some(tool)) => score_from_float((0.82 * agent + 0.18 * tool) * 100.0),
        (Some(agent), None) => score_from_float(agent * 100.0),
        (None, Some(tool)) => score_from_float(tool * 100.0),
        (None, None) if runs.is_empty() => 50,
        (None, None) => score_from_rate(success_rate(runs)).unwrap_or(50),
    };
    let verification = eval_cases
        .map(|cases| {
            let coverage = (cases.len() as f64 / 20.0).clamp(0.0, 1.0);
            let rate = eval_rate.unwrap_or(0.0);
            score_from_float((0.7 * rate + 0.3 * coverage) * 100.0)
        })
        .unwrap_or(35);
    let subagent_roi = if subagent_runs.is_empty() {
        50
    } else {
        let rate = subagent_success_rate.unwrap_or(0.0);
        let latency = latency_score(subagent_p95, 30_000, 180_000) as f64 / 100.0;
        let avg_calls = average_attr(&subagent_runs, "tool_calls").unwrap_or(0.0);
        let productive = (avg_calls / 4.0).clamp(0.0, 1.0);
        score_from_float((0.62 * rate + 0.24 * latency + 0.14 * productive) * 100.0)
    };
    let efficiency = latency_score(agent_p95, 20_000, 180_000);
    let observability = {
        let mut kinds = 0.0;
        if !agent_runs.is_empty() {
            kinds += 1.0;
        }
        if !tool_runs.is_empty() {
            kinds += 1.0;
        }
        if !subagent_runs.is_empty() {
            kinds += 1.0;
        }
        if eval_cases.is_some_and(|cases| !cases.is_empty()) {
            kinds += 1.0;
        }
        let depth = (runs.len() as f64 / 50.0).clamp(0.0, 1.0);
        score_from_float((0.45 + 0.35 * (kinds / 4.0) + 0.20 * depth) * 100.0)
    };

    let components = vec![
        component(
            "reliability",
            "Reliability",
            reliability,
            agent_success_rate,
            "Jarvis run-loop success and terminal-state hygiene",
        ),
        component(
            "verification",
            "Verification",
            verification,
            eval_rate,
            "Eval pass rate plus coverage depth",
        ),
        component(
            "subagent_roi",
            "SubAgent ROI",
            subagent_roi,
            subagent_success_rate,
            "Delegation success, latency, and useful tool-call density",
        ),
        component(
            "efficiency",
            "Efficiency",
            efficiency,
            agent_p95.map(|n| n as f64),
            "P95 latency pressure across observed runs",
        ),
        component(
            "observability",
            "Observability",
            observability,
            Some(runs.len() as f64),
            "Recorded signal breadth across agent, tool, SubAgent, and eval",
        ),
    ];

    let score = score_from_float(
        reliability as f64 * 0.30
            + verification as f64 * 0.25
            + subagent_roi as f64 * 0.20
            + efficiency as f64 * 0.15
            + observability as f64 * 0.10,
    );
    let primary_focus = components
        .iter()
        .min_by_key(|c| c.score)
        .map(|c| c.key.clone())
        .unwrap_or_else(|| "observability".into());

    let mut recommendations = Vec::new();
    if reliability < 75 && agent_success_rate.is_some() {
        recommendations.push(recommendation(
            "stabilize_run_loop",
            1,
            "danger",
            "Stabilize the run loop",
            "Agent success is below the operating threshold. Prioritize provider errors, terminal-state cleanup, and retry behavior before adding new capabilities.",
            agent_success_rate.map(|r| format!("run success {}%", (r * 100.0).round())),
        ));
    }
    if let Some(hotspot) = top_error_hotspot(&tool_runs) {
        recommendations.push(recommendation(
            "fix_tool_hotspot",
            2,
            "warn",
            "Fix the noisiest tool first",
            &format!(
                "`{}` contributes the largest current tool-error cluster. Improve schema validation, timeout policy, or error text for model recovery.",
                hotspot.0
            ),
            Some(format!("{} errors", hotspot.1)),
        ));
    } else if tool_errors > 0 {
        recommendations.push(recommendation(
            "reduce_tool_errors",
            2,
            "warn",
            "Reduce tool error pressure",
            "Tool failures are present but not concentrated in one tool. Review permission denials, malformed arguments, and recoverable error messages.",
            Some(format!("{tool_errors} tool errors")),
        ));
    }
    if verification < 70 {
        recommendations.push(recommendation(
            "expand_eval_coverage",
            3,
            "warn",
            "Expand eval coverage",
            "Direction decisions are weak without repeatable evals. Add cases for planning, tool use, file edits, SubAgent delegation, and recovery from tool errors.",
            eval_cases.map(|cases| format!("{} eval cases", cases.len())),
        ));
    }
    if !subagent_runs.is_empty() && subagent_roi < 75 {
        recommendations.push(recommendation(
            "tune_subagent_delegation",
            4,
            "warn",
            "Tune SubAgent delegation",
            "SubAgents are not yet paying for their overhead. Route them to complex work, add clearer completion criteria, or reduce delegation on short tasks.",
            Some(format!("{subagent_errors} subagent errors")),
        ));
    } else if subagent_runs.is_empty() {
        recommendations.push(recommendation(
            "exercise_subagent_path",
            4,
            "neutral",
            "Exercise the SubAgent path",
            "No SubAgent runs are recorded yet. Add a small delegation smoke eval so Claude Code / Codex style workers are visible in the harness score.",
            None,
        ));
    }
    if efficiency < 70 && agent_p95.is_some() {
        recommendations.push(recommendation(
            "cut_latency_pressure",
            5,
            "warn",
            "Reduce latency pressure",
            "Observed P95 latency is high. Check long-running tools, streaming stalls, retry fan-out, and unnecessary SubAgent hops.",
            agent_p95.map(|p95| format!("p95 {p95}ms")),
        ));
    }
    if observability < 75 {
        recommendations.push(recommendation(
            "fill_signal_gaps",
            6,
            "neutral",
            "Fill telemetry gaps",
            "The dashboard is missing breadth across agent, tool, SubAgent, or eval records. Keep JSON persistence on and add span summaries for trace drill-down.",
            Some(format!("{} observed runs", runs.len())),
        ));
    }
    if recommendations.is_empty() {
        recommendations.push(recommendation(
            "promote_release_gate",
            1,
            "ok",
            "Promote the harness gate",
            "Signals are stable enough to use eval baselines and score deltas as a pre-release gate.",
            Some(format!("direction score {score}")),
        ));
    }
    recommendations.sort_by_key(|r| r.priority);
    recommendations.truncate(5);

    HarnessDirectionSnapshot {
        generated_at: chrono::Utc::now().to_rfc3339(),
        score,
        primary_focus,
        components,
        recommendations,
        sample: json!({
            "runs": runs.len(),
            "agent_runs": agent_runs.len(),
            "tool_runs": tool_runs.len(),
            "subagent_runs": subagent_runs.len(),
            "eval_cases": eval_cases.map(|cases| cases.len()),
        }),
    }
}

fn capability_score_snapshot(
    obs_runs: &[ObservedRun],
    eval_cases: &[EvalCaseResult],
    requirement_runs: &[RequirementRun],
) -> CapabilityScoreSnapshot {
    let facts = CapabilityFacts::new(obs_runs, eval_cases, requirement_runs);
    let dimensions = vec![
        score_task_understanding(&facts),
        score_planning_execution(&facts),
        score_capability_invocation(&facts),
        score_task_delivery(&facts),
    ];
    let raw_overall =
        dimensions.iter().map(|d| d.score as f64).sum::<f64>() / dimensions.len() as f64;
    let delivery_score = dimensions
        .iter()
        .find(|d| d.key == "task_delivery")
        .map(|d| d.score)
        .unwrap_or(50);
    let mut overall_score = score_from_float(raw_overall);
    if delivery_score < 60 {
        overall_score = overall_score.min(69);
    }
    let confidence = average(
        dimensions.iter().map(|d| d.confidence).sum(),
        dimensions.len(),
    )
    .unwrap_or(0.0);

    CapabilityScoreSnapshot {
        generated_at: chrono::Utc::now().to_rfc3339(),
        overall_score,
        confidence,
        sample_count: facts.sample_count,
        dimensions,
        rules: json!({
            "scale": "0-100",
            "weights": {
                "task_understanding": 0.25,
                "planning_execution": 0.25,
                "capability_invocation": 0.25,
                "task_delivery": 0.25
            },
            "caps": [
                "if task_delivery < 60, overall_score <= 69",
                "confidence is reduced when eval, verification, observability, or requirement-run signals are missing"
            ]
        }),
    }
}

#[derive(Debug)]
struct CapabilityFacts<'a> {
    obs_runs: &'a [ObservedRun],
    eval_cases: &'a [EvalCaseResult],
    requirement_runs: &'a [RequirementRun],
    agent_runs: Vec<ObservedRun>,
    tool_runs: Vec<ObservedRun>,
    subagent_runs: Vec<ObservedRun>,
    terminal_runs: Vec<&'a RequirementRun>,
    completed_runs: usize,
    failed_runs: usize,
    cancelled_runs: usize,
    timeout_like: usize,
    max_iteration_like: usize,
    verified_runs: usize,
    verification_passed: usize,
    sample_count: usize,
}

impl<'a> CapabilityFacts<'a> {
    fn new(
        obs_runs: &'a [ObservedRun],
        eval_cases: &'a [EvalCaseResult],
        requirement_runs: &'a [RequirementRun],
    ) -> Self {
        let agent_runs = runs_by_kind(obs_runs, ObservedRunKind::Agent);
        let tool_runs = runs_by_kind(obs_runs, ObservedRunKind::Tool);
        let subagent_runs = runs_by_kind(obs_runs, ObservedRunKind::Subagent);
        let terminal_runs = requirement_runs
            .iter()
            .filter(|run| run.status.is_terminal())
            .collect::<Vec<_>>();
        let completed_runs = requirement_runs
            .iter()
            .filter(|run| run.status == RequirementRunStatus::Completed)
            .count();
        let failed_runs = requirement_runs
            .iter()
            .filter(|run| run.status == RequirementRunStatus::Failed)
            .count();
        let cancelled_runs = requirement_runs
            .iter()
            .filter(|run| run.status == RequirementRunStatus::Cancelled)
            .count();
        let timeout_like = requirement_runs
            .iter()
            .filter(|run| {
                run.error
                    .as_deref()
                    .is_some_and(|e| e.to_ascii_lowercase().contains("timed out"))
            })
            .count()
            + obs_runs
                .iter()
                .filter(|run| run.outcome == ObservedOutcome::Timeout)
                .count();
        let max_iteration_like = requirement_runs
            .iter()
            .filter(|run| {
                run.error
                    .as_deref()
                    .is_some_and(|e| e.to_ascii_lowercase().contains("max iterations"))
            })
            .count()
            + obs_runs
                .iter()
                .filter(|run| run.outcome == ObservedOutcome::MaxIterations)
                .count();
        let verified_runs = requirement_runs
            .iter()
            .filter(|run| run.verification.is_some())
            .count();
        let verification_passed = requirement_runs
            .iter()
            .filter(|run| {
                run.verification
                    .as_ref()
                    .is_some_and(|v| v.status == VerificationStatus::Passed)
            })
            .count();
        let sample_count = obs_runs.len() + eval_cases.len() + requirement_runs.len();

        Self {
            obs_runs,
            eval_cases,
            requirement_runs,
            agent_runs,
            tool_runs,
            subagent_runs,
            terminal_runs,
            completed_runs,
            failed_runs,
            cancelled_runs,
            timeout_like,
            max_iteration_like,
            verified_runs,
            verification_passed,
            sample_count,
        }
    }

    fn completion_rate(&self) -> Option<f64> {
        ratio(self.completed_runs, self.terminal_runs.len())
    }

    fn terminal_rate(&self) -> Option<f64> {
        ratio(self.terminal_runs.len(), self.requirement_runs.len())
    }

    fn verification_pass_rate(&self) -> Option<f64> {
        ratio(self.verification_passed, self.verified_runs)
    }

    fn verification_coverage(&self) -> Option<f64> {
        ratio(self.verified_runs, self.terminal_runs.len())
    }

    fn eval_pass_rate(&self) -> Option<f64> {
        eval_success_rate(self.eval_cases)
    }

    fn capability_eval_pass_rate(&self) -> Option<f64> {
        let rows = self
            .eval_cases
            .iter()
            .filter(|case| case.suite_kind == harness_core::EvalSuiteKind::Capability)
            .cloned()
            .collect::<Vec<_>>();
        eval_success_rate(&rows)
    }

    fn regression_eval_pass_rate(&self) -> Option<f64> {
        let rows = self
            .eval_cases
            .iter()
            .filter(|case| case.suite_kind == harness_core::EvalSuiteKind::Regression)
            .cloned()
            .collect::<Vec<_>>();
        eval_success_rate(&rows)
    }

    fn timeout_free_rate(&self) -> Option<f64> {
        ratio(
            self.terminal_runs
                .len()
                .saturating_sub(self.timeout_like + self.max_iteration_like),
            self.terminal_runs.len(),
        )
    }
}

fn score_task_understanding(facts: &CapabilityFacts<'_>) -> CapabilityDimensionScore {
    let capability_eval = facts
        .capability_eval_pass_rate()
        .or_else(|| facts.eval_pass_rate());
    let verification = facts.verification_pass_rate();
    let completion = facts.completion_rate();
    let misunderstanding_free = eval_failure_free_rate(
        facts.eval_cases,
        &["understanding", "instruction", "constraint", "acceptance"],
    );
    let drivers = vec![
        driver(
            "capability_eval_pass_rate",
            "Capability eval pass rate",
            capability_eval,
            0.40,
            "Repeatable eval cases that target task comprehension",
        ),
        driver(
            "verification_pass_rate",
            "Verification pass rate",
            verification,
            0.25,
            "Requirement runs whose verification checks passed",
        ),
        driver(
            "completion_rate",
            "Completion rate",
            completion,
            0.20,
            "Terminal requirement runs that reached completed",
        ),
        driver(
            "misunderstanding_free_rate",
            "No misunderstanding failure class",
            misunderstanding_free,
            0.15,
            "Eval cases not classified as instruction, constraint, or acceptance misses",
        ),
    ];
    dimension(
        "task_understanding",
        "Task understanding",
        "Whether Jarvis understood goal, constraints, and acceptance criteria",
        drivers,
        confidence_for(facts, 0.45, 0.25, 0.20, 0.10),
        evidence_for_understanding(facts),
    )
}

fn score_planning_execution(facts: &CapabilityFacts<'_>) -> CapabilityDimensionScore {
    let terminal = facts.terminal_rate();
    let completion = facts.completion_rate();
    let timeout_free = facts.timeout_free_rate();
    let agent_success = success_rate(&facts.agent_runs).or_else(|| success_rate(facts.obs_runs));
    let drivers = vec![
        driver(
            "terminal_rate",
            "Terminal-state rate",
            terminal,
            0.25,
            "Runs that leave pending/running and settle into a terminal state",
        ),
        driver(
            "completion_rate",
            "Execution completion rate",
            completion,
            0.30,
            "Terminal requirement runs that completed successfully",
        ),
        driver(
            "timeout_free_rate",
            "Timeout/max-iteration avoidance",
            timeout_free,
            0.25,
            "Runs that did not hit timeout or max-iteration boundaries",
        ),
        driver(
            "agent_success_rate",
            "Observed agent success",
            agent_success,
            0.20,
            "Observed Jarvis agent runs marked successful",
        ),
    ];
    dimension(
        "planning_execution",
        "Planning execution",
        "Whether Jarvis can decompose, sequence, and finish the work loop",
        drivers,
        confidence_for(facts, 0.15, 0.15, 0.55, 0.15),
        evidence_for_planning(facts),
    )
}

fn score_capability_invocation(facts: &CapabilityFacts<'_>) -> CapabilityDimensionScore {
    let tool_success = success_rate(&facts.tool_runs);
    let subagent_success = success_rate(&facts.subagent_runs);
    let agent_success = success_rate(&facts.agent_runs).or_else(|| success_rate(facts.obs_runs));
    let latency =
        latency_score(duration_percentile(facts.obs_runs, 0.95), 20_000, 180_000) as f64 / 100.0;
    let delegation_visibility = (!facts.subagent_runs.is_empty()).then_some(
        subagent_success.unwrap_or(0.0) * 0.70
            + latency_score(
                duration_percentile(&facts.subagent_runs, 0.95),
                30_000,
                180_000,
            ) as f64
                / 100.0
                * 0.30,
    );
    let drivers = vec![
        driver(
            "tool_success_rate",
            "Tool success rate",
            tool_success,
            0.35,
            "Observed tool calls that completed without error",
        ),
        driver(
            "subagent_success_rate",
            "SubAgent success rate",
            subagent_success,
            0.25,
            "Delegated worker runs that completed successfully",
        ),
        driver(
            "agent_recovery_rate",
            "Agent recovery proxy",
            agent_success,
            0.20,
            "Agent run success after using available capabilities",
        ),
        driver(
            "latency_efficiency",
            "Latency efficiency",
            Some(latency),
            0.10,
            "P95 latency converted into an efficiency score",
        ),
        driver(
            "delegation_visibility",
            "Delegation visibility",
            delegation_visibility,
            0.10,
            "Whether SubAgent paths are exercised and successful",
        ),
    ];
    dimension(
        "capability_invocation",
        "Capability invocation",
        "Whether Jarvis chooses tools and SubAgents effectively",
        drivers,
        confidence_for(facts, 0.45, 0.20, 0.10, 0.25),
        evidence_for_invocation(facts),
    )
}

fn score_task_delivery(facts: &CapabilityFacts<'_>) -> CapabilityDimensionScore {
    let completion = facts.completion_rate();
    let verification = facts.verification_pass_rate();
    let regression = facts
        .regression_eval_pass_rate()
        .or_else(|| facts.eval_pass_rate());
    let verification_coverage = facts.verification_coverage();
    let failure_free = ratio(
        facts
            .terminal_runs
            .len()
            .saturating_sub(facts.failed_runs + facts.cancelled_runs),
        facts.terminal_runs.len(),
    );
    let drivers = vec![
        driver(
            "completion_rate",
            "Completion rate",
            completion,
            0.35,
            "Terminal requirement runs that reached completed",
        ),
        driver(
            "verification_pass_rate",
            "Verification pass rate",
            verification,
            0.30,
            "Attached verification results that passed",
        ),
        driver(
            "regression_eval_pass_rate",
            "Regression eval pass rate",
            regression,
            0.20,
            "Regression suites that still pass",
        ),
        driver(
            "verification_coverage",
            "Verification coverage",
            verification_coverage,
            0.10,
            "Terminal runs with attached verification evidence",
        ),
        driver(
            "failure_free_rate",
            "Failure-free terminal rate",
            failure_free,
            0.05,
            "Terminal runs not marked failed or cancelled",
        ),
    ];
    dimension(
        "task_delivery",
        "Task delivery",
        "Whether Jarvis produces verifiable completed work",
        drivers,
        confidence_for(facts, 0.20, 0.25, 0.45, 0.10),
        evidence_for_delivery(facts),
    )
}

fn dimension(
    key: &str,
    label: &str,
    summary: &str,
    drivers: Vec<CapabilityDriver>,
    confidence: f64,
    evidence: Vec<CapabilityEvidence>,
) -> CapabilityDimensionScore {
    let score = weighted_driver_score(&drivers);
    CapabilityDimensionScore {
        key: key.into(),
        label: label.into(),
        score,
        confidence,
        summary: summary.into(),
        drivers,
        evidence,
    }
}

fn driver(
    key: &str,
    label: &str,
    value: Option<f64>,
    weight: f64,
    detail: &str,
) -> CapabilityDriver {
    let score = value
        .map(|v| score_from_float(v.clamp(0.0, 1.0) * 100.0))
        .unwrap_or(50);
    CapabilityDriver {
        key: key.into(),
        label: label.into(),
        value,
        weight,
        score,
        detail: detail.into(),
    }
}

fn weighted_driver_score(drivers: &[CapabilityDriver]) -> u8 {
    let weight_sum = drivers.iter().map(|d| d.weight).sum::<f64>();
    if weight_sum <= f64::EPSILON {
        return 50;
    }
    score_from_float(
        drivers
            .iter()
            .map(|d| d.score as f64 * d.weight)
            .sum::<f64>()
            / weight_sum,
    )
}

fn confidence_for(
    facts: &CapabilityFacts<'_>,
    obs_weight: f64,
    eval_weight: f64,
    run_weight: f64,
    verification_weight: f64,
) -> f64 {
    let sample_conf = ((facts.sample_count as f64 + 1.0).ln() / 31_f64.ln()).clamp(0.0, 1.0);
    let obs = (!facts.obs_runs.is_empty()) as u8 as f64;
    let eval = (!facts.eval_cases.is_empty()) as u8 as f64;
    let runs = (!facts.requirement_runs.is_empty()) as u8 as f64;
    let verification = (facts.verified_runs > 0) as u8 as f64;
    let coverage = obs * obs_weight
        + eval * eval_weight
        + runs * run_weight
        + verification * verification_weight;
    (sample_conf * coverage).clamp(0.0, 1.0)
}

fn eval_failure_free_rate(cases: &[EvalCaseResult], needles: &[&str]) -> Option<f64> {
    if cases.is_empty() {
        return None;
    }
    let matching = cases
        .iter()
        .filter(|case| {
            case.failure_class.as_ref().is_some_and(|class| {
                let key = json_key(class);
                needles.iter().any(|needle| key.contains(needle))
            })
        })
        .count();
    Some((cases.len().saturating_sub(matching)) as f64 / cases.len() as f64)
}

fn evidence_for_understanding(facts: &CapabilityFacts<'_>) -> Vec<CapabilityEvidence> {
    let mut rows = eval_failure_evidence(facts, 3);
    rows.extend(requirement_failure_evidence(facts, 2));
    rows.truncate(4);
    rows
}

fn evidence_for_planning(facts: &CapabilityFacts<'_>) -> Vec<CapabilityEvidence> {
    let mut rows = facts
        .requirement_runs
        .iter()
        .filter(|run| {
            run.error.as_deref().is_some_and(|e| {
                let lower = e.to_ascii_lowercase();
                lower.contains("timed out") || lower.contains("max iterations")
            })
        })
        .take(4)
        .map(requirement_run_evidence)
        .collect::<Vec<_>>();
    if rows.is_empty() {
        rows = requirement_failure_evidence(facts, 4);
    }
    rows
}

fn evidence_for_invocation(facts: &CapabilityFacts<'_>) -> Vec<CapabilityEvidence> {
    let mut rows = facts
        .tool_runs
        .iter()
        .filter(|run| is_bad_outcome(&run.outcome))
        .take(3)
        .map(observed_run_evidence)
        .collect::<Vec<_>>();
    rows.extend(
        facts
            .subagent_runs
            .iter()
            .filter(|run| is_bad_outcome(&run.outcome))
            .take(2)
            .map(observed_run_evidence),
    );
    rows
}

fn evidence_for_delivery(facts: &CapabilityFacts<'_>) -> Vec<CapabilityEvidence> {
    let mut rows = requirement_failure_evidence(facts, 4);
    rows.extend(eval_failure_evidence(facts, 2));
    rows.truncate(4);
    rows
}

fn requirement_failure_evidence(
    facts: &CapabilityFacts<'_>,
    limit: usize,
) -> Vec<CapabilityEvidence> {
    facts
        .requirement_runs
        .iter()
        .filter(|run| {
            matches!(
                run.status,
                RequirementRunStatus::Failed | RequirementRunStatus::Cancelled
            )
        })
        .take(limit)
        .map(requirement_run_evidence)
        .collect()
}

fn eval_failure_evidence(facts: &CapabilityFacts<'_>, limit: usize) -> Vec<CapabilityEvidence> {
    facts
        .eval_cases
        .iter()
        .filter(|case| case.outcome != ObservedOutcome::Success)
        .take(limit)
        .map(|case| CapabilityEvidence {
            kind: "eval_case".into(),
            id: case.id.clone(),
            title: case.scenario.clone(),
            detail: case
                .failure_class
                .as_ref()
                .map(json_key)
                .unwrap_or_else(|| json_key(&case.outcome)),
            metric: Some(format!("{} / {}", case.suite, json_key(&case.suite_kind))),
            tone: "danger".into(),
        })
        .collect()
}

fn requirement_run_evidence(run: &RequirementRun) -> CapabilityEvidence {
    CapabilityEvidence {
        kind: "requirement_run".into(),
        id: run.id.clone(),
        title: run
            .summary
            .clone()
            .unwrap_or_else(|| format!("requirement {}", short_id(&run.requirement_id))),
        detail: run.error.clone().unwrap_or_else(|| json_key(&run.status)),
        metric: Some(format!("status {}", json_key(&run.status))),
        tone: match run.status {
            RequirementRunStatus::Failed | RequirementRunStatus::Cancelled => "danger",
            RequirementRunStatus::Pending | RequirementRunStatus::Running => "warn",
            RequirementRunStatus::Completed => "ok",
        }
        .into(),
    }
}

fn observed_run_evidence(run: &ObservedRun) -> CapabilityEvidence {
    CapabilityEvidence {
        kind: json_key(&run.kind),
        id: run.id.clone(),
        title: run.name.clone(),
        detail: json_key(&run.outcome),
        metric: run.duration_ms.map(|ms| format!("{ms}ms")),
        tone: if is_bad_outcome(&run.outcome) {
            "danger"
        } else {
            "neutral"
        }
        .into(),
    }
}

fn is_bad_outcome(outcome: &ObservedOutcome) -> bool {
    matches!(
        outcome,
        ObservedOutcome::Error
            | ObservedOutcome::Timeout
            | ObservedOutcome::Cancelled
            | ObservedOutcome::MaxIterations
    )
}

fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

fn component(
    key: &str,
    label: &str,
    score: u8,
    value: Option<f64>,
    detail: &str,
) -> HarnessDirectionComponent {
    HarnessDirectionComponent {
        key: key.into(),
        label: label.into(),
        score,
        value,
        detail: detail.into(),
    }
}

fn recommendation(
    key: &str,
    priority: u8,
    tone: &str,
    title: &str,
    detail: &str,
    metric: Option<String>,
) -> HarnessDirectionRecommendation {
    HarnessDirectionRecommendation {
        key: key.into(),
        priority,
        tone: tone.into(),
        title: title.into(),
        detail: detail.into(),
        metric,
    }
}

fn runs_by_kind(runs: &[ObservedRun], kind: ObservedRunKind) -> Vec<ObservedRun> {
    runs.iter()
        .filter(|run| run.kind == kind)
        .cloned()
        .collect()
}

fn success_rate(runs: &[ObservedRun]) -> Option<f64> {
    if runs.is_empty() {
        return None;
    }
    Some(
        runs.iter()
            .filter(|run| run.outcome == ObservedOutcome::Success)
            .count() as f64
            / runs.len() as f64,
    )
}

fn eval_success_rate(cases: &[EvalCaseResult]) -> Option<f64> {
    if cases.is_empty() {
        return None;
    }
    Some(
        cases
            .iter()
            .filter(|case| case.outcome == ObservedOutcome::Success)
            .count() as f64
            / cases.len() as f64,
    )
}

fn count_errors(runs: &[ObservedRun]) -> usize {
    runs.iter()
        .filter(|run| {
            matches!(
                run.outcome,
                ObservedOutcome::Error | ObservedOutcome::Timeout | ObservedOutcome::Cancelled
            )
        })
        .count()
}

fn duration_percentile(runs: &[ObservedRun], pct: f64) -> Option<u64> {
    let mut durations = runs
        .iter()
        .filter_map(|run| run.duration_ms)
        .collect::<Vec<_>>();
    durations.sort_unstable();
    percentile(&durations, pct)
}

fn average_attr(runs: &[ObservedRun], key: &str) -> Option<f64> {
    let mut sum = 0.0;
    let mut count = 0;
    for run in runs {
        if let Some(n) = number_attr(run, key) {
            sum += n;
            count += 1;
        }
    }
    average(sum, count)
}

fn top_error_hotspot(runs: &[ObservedRun]) -> Option<(String, usize)> {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for run in runs {
        if matches!(
            run.outcome,
            ObservedOutcome::Error | ObservedOutcome::Timeout | ObservedOutcome::Cancelled
        ) {
            *counts.entry(run.name.clone()).or_default() += 1;
        }
    }
    counts
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(&a.0)))
}

fn score_from_rate(rate: Option<f64>) -> Option<u8> {
    rate.map(|r| score_from_float(r.clamp(0.0, 1.0) * 100.0))
}

fn latency_score(p95_ms: Option<u64>, good_ms: u64, poor_ms: u64) -> u8 {
    let Some(p95_ms) = p95_ms else {
        return 50;
    };
    if p95_ms <= good_ms {
        return 100;
    }
    if p95_ms >= poor_ms {
        return 0;
    }
    let span = (poor_ms - good_ms) as f64;
    let used = (p95_ms - good_ms) as f64;
    score_from_float((1.0 - used / span) * 100.0)
}

fn score_from_float(value: f64) -> u8 {
    value.clamp(0.0, 100.0).round() as u8
}

#[derive(Debug, Deserialize)]
struct EvalCasesQuery {
    suite: Option<String>,
    suite_kind: Option<harness_core::EvalSuiteKind>,
    case_id: Option<String>,
    outcome: Option<ObservedOutcome>,
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct EvalSummaryQuery {
    limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
struct EvalTrialReliability {
    task_groups: usize,
    pass_at_k: Option<f64>,
    pass_all: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
struct EvalSummarySnapshot {
    generated_at: String,
    total_cases: usize,
    passed_cases: usize,
    pass_rate: Option<f64>,
    capability_pass_rate: Option<f64>,
    regression_pass_rate: Option<f64>,
    trial_reliability: EvalTrialReliability,
    by_suite_kind: serde_json::Value,
    by_grader_kind: serde_json::Value,
    by_failure_class: serde_json::Value,
    transcript_cases: usize,
}

async fn get_eval_summary(
    State(state): State<AppState>,
    Query(q): Query<EvalSummaryQuery>,
) -> Response {
    let store = match eval_store(&state) {
        Some(store) => store,
        None => return unavailable("eval store not configured"),
    };
    let limit = q.limit.unwrap_or(2_000).min(10_000);
    match store
        .list_case_results(EvalFilter {
            limit: Some(limit),
            ..EvalFilter::default()
        })
        .await
    {
        Ok(cases) => Json(eval_summary(&cases)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

async fn list_eval_cases(
    State(state): State<AppState>,
    Query(q): Query<EvalCasesQuery>,
) -> Response {
    let store = match eval_store(&state) {
        Some(store) => store,
        None => return unavailable("eval store not configured"),
    };
    let limit = q.limit.unwrap_or(50).min(500);
    match store
        .list_case_results(EvalFilter {
            suite: q.suite,
            suite_kind: q.suite_kind,
            case_id: q.case_id,
            outcome: q.outcome,
            limit: Some(limit),
        })
        .await
    {
        Ok(cases) => Json(json!({ "cases": cases })).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

fn eval_summary(cases: &[EvalCaseResult]) -> EvalSummarySnapshot {
    let passed_cases = cases
        .iter()
        .filter(|case| case.outcome == ObservedOutcome::Success)
        .count();
    let capability = cases
        .iter()
        .filter(|case| case.suite_kind == harness_core::EvalSuiteKind::Capability)
        .cloned()
        .collect::<Vec<_>>();
    let regression = cases
        .iter()
        .filter(|case| case.suite_kind == harness_core::EvalSuiteKind::Regression)
        .cloned()
        .collect::<Vec<_>>();
    let transcript_cases = cases
        .iter()
        .filter(|case| case.transcript_artifact_id.is_some())
        .count();

    EvalSummarySnapshot {
        generated_at: chrono::Utc::now().to_rfc3339(),
        total_cases: cases.len(),
        passed_cases,
        pass_rate: ratio(passed_cases, cases.len()),
        capability_pass_rate: eval_success_rate(&capability),
        regression_pass_rate: eval_success_rate(&regression),
        trial_reliability: trial_reliability(cases),
        by_suite_kind: json!(count_by(cases, |case| json_key(&case.suite_kind))),
        by_grader_kind: json!(count_grader_kinds(cases)),
        by_failure_class: json!(count_failure_classes(cases)),
        transcript_cases,
    }
}

fn trial_reliability(cases: &[EvalCaseResult]) -> EvalTrialReliability {
    let mut groups: BTreeMap<(String, String), Vec<&EvalCaseResult>> = BTreeMap::new();
    for case in cases {
        groups
            .entry((case.suite.clone(), case.case_id.clone()))
            .or_default()
            .push(case);
    }
    let task_groups = groups.len();
    let any_pass = groups
        .values()
        .filter(|trials| {
            trials
                .iter()
                .any(|case| case.outcome == ObservedOutcome::Success)
        })
        .count();
    let all_pass = groups
        .values()
        .filter(|trials| {
            !trials.is_empty()
                && trials
                    .iter()
                    .all(|case| case.outcome == ObservedOutcome::Success)
        })
        .count();
    EvalTrialReliability {
        task_groups,
        pass_at_k: ratio(any_pass, task_groups),
        pass_all: ratio(all_pass, task_groups),
    }
}

fn ratio(numerator: usize, denominator: usize) -> Option<f64> {
    (denominator > 0).then(|| numerator as f64 / denominator as f64)
}

fn json_key<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".into())
}

fn count_grader_kinds(cases: &[EvalCaseResult]) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for case in cases {
        for grader in &case.grader_results {
            *counts.entry(json_key(&grader.kind)).or_default() += 1;
        }
    }
    counts
}

fn count_failure_classes(cases: &[EvalCaseResult]) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for case in cases {
        if let Some(class) = &case.failure_class {
            *counts.entry(json_key(class)).or_default() += 1;
        }
    }
    counts
}

fn count_by<T, F>(rows: &[T], mut f: F) -> BTreeMap<String, usize>
where
    F: FnMut(&T) -> String,
{
    let mut counts = BTreeMap::new();
    for row in rows {
        *counts.entry(f(row)).or_default() += 1;
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_kind(
        name: &str,
        kind: ObservedRunKind,
        outcome: ObservedOutcome,
        duration_ms: u64,
        attrs: serde_json::Value,
    ) -> ObservedRun {
        ObservedRun {
            id: format!("{name}-{duration_ms}"),
            trace_id: None,
            span_id: None,
            parent_run_id: None,
            kind,
            name: name.into(),
            started_at: "2026-05-08T00:00:00Z".into(),
            ended_at: Some("2026-05-08T00:00:01Z".into()),
            duration_ms: Some(duration_ms),
            outcome,
            conversation_id: None,
            project_id: None,
            workspace_hash: None,
            attributes: attrs,
            metrics: serde_json::json!({}),
            artifact_ids: Vec::new(),
        }
    }

    fn run(
        name: &str,
        outcome: ObservedOutcome,
        duration_ms: u64,
        attrs: serde_json::Value,
    ) -> ObservedRun {
        run_kind(name, ObservedRunKind::Tool, outcome, duration_ms, attrs)
    }

    fn eval_case(
        case_id: &str,
        suite_kind: harness_core::EvalSuiteKind,
        trial_index: u32,
        outcome: ObservedOutcome,
    ) -> EvalCaseResult {
        EvalCaseResult {
            id: format!("{case_id}-{trial_index}"),
            suite_run_id: "suite-run-1".into(),
            case_id: case_id.into(),
            suite: "coding-smoke".into(),
            suite_kind,
            scenario: "tool-use".into(),
            trial_index,
            trial_count: Some(2),
            outcome,
            trace_id: None,
            transcript_artifact_id: Some(format!("transcript-{case_id}-{trial_index}")),
            failure_class: None,
            grader_results: vec![harness_core::EvalGraderResult {
                id: format!("grader-{case_id}-{trial_index}"),
                kind: harness_core::EvalGraderKind::DeterministicTest,
                verdict: harness_core::EvalGraderVerdict::Pass,
                score: Some(1.0),
                explanation: None,
                attributes: serde_json::json!({}),
                artifact_ids: Vec::new(),
            }],
            scores: serde_json::json!({}),
            attributes: serde_json::json!({}),
            artifact_ids: Vec::new(),
        }
    }

    fn requirement_run(status: RequirementRunStatus, error: Option<&str>) -> RequirementRun {
        let mut run = RequirementRun::new("req-1", "conv-1");
        run.status = status;
        if status.is_terminal() {
            run.finished_at = Some("2026-05-08T00:00:02Z".into());
        }
        run.error = error.map(str::to_string);
        run
    }

    #[test]
    fn summarize_runs_groups_and_computes_rates() {
        let rows = vec![
            run(
                "fs.read",
                ObservedOutcome::Success,
                10,
                serde_json::json!({"output_bytes": 100}),
            ),
            run(
                "fs.read",
                ObservedOutcome::Error,
                30,
                serde_json::json!({"output_bytes": 300}),
            ),
            run(
                "shell.exec",
                ObservedOutcome::Success,
                20,
                serde_json::json!({}),
            ),
        ];
        let mut summary = summarize_runs(&rows);
        summary.sort_by(|a, b| a.name.cmp(&b.name));
        let fs = summary.iter().find(|s| s.name == "fs.read").unwrap();
        assert_eq!(fs.runs, 2);
        assert_eq!(fs.success, 1);
        assert_eq!(fs.errors, 1);
        assert_eq!(fs.success_rate, Some(0.5));
        assert_eq!(fs.median_duration_ms, Some(30));
        assert_eq!(fs.avg_output_bytes, Some(200.0));

        let shell = summary.iter().find(|s| s.name == "shell.exec").unwrap();
        assert_eq!(shell.runs, 1);
        assert_eq!(shell.success_rate, Some(1.0));
    }

    #[test]
    fn direction_snapshot_prioritizes_low_eval_coverage() {
        let rows = vec![
            run_kind(
                "jarvis.agent.run",
                ObservedRunKind::Agent,
                ObservedOutcome::Success,
                1_000,
                serde_json::json!({}),
            ),
            run_kind(
                "fs.read",
                ObservedRunKind::Tool,
                ObservedOutcome::Success,
                10,
                serde_json::json!({"output_bytes": 100}),
            ),
        ];
        let snapshot = direction_snapshot(&rows, Some(&[]));
        assert_eq!(snapshot.primary_focus, "verification");
        assert!(snapshot
            .recommendations
            .iter()
            .any(|rec| rec.key == "expand_eval_coverage"));
    }

    #[test]
    fn eval_summary_splits_suite_kind_and_trial_reliability() {
        let cases = vec![
            eval_case(
                "case-1",
                harness_core::EvalSuiteKind::Regression,
                0,
                ObservedOutcome::Success,
            ),
            eval_case(
                "case-1",
                harness_core::EvalSuiteKind::Regression,
                1,
                ObservedOutcome::Error,
            ),
            eval_case(
                "case-2",
                harness_core::EvalSuiteKind::Capability,
                0,
                ObservedOutcome::Error,
            ),
        ];
        let summary = eval_summary(&cases);
        assert_eq!(summary.total_cases, 3);
        assert_eq!(summary.regression_pass_rate, Some(0.5));
        assert_eq!(summary.capability_pass_rate, Some(0.0));
        assert_eq!(summary.trial_reliability.task_groups, 2);
        assert_eq!(summary.trial_reliability.pass_at_k, Some(0.5));
        assert_eq!(summary.trial_reliability.pass_all, Some(0.0));
        assert_eq!(summary.transcript_cases, 3);
        assert_eq!(
            summary
                .by_grader_kind
                .get("deterministic_test")
                .and_then(serde_json::Value::as_u64),
            Some(3)
        );
    }

    #[test]
    fn capability_score_caps_overall_when_delivery_is_weak() {
        let obs = vec![
            run_kind(
                "jarvis.agent.run",
                ObservedRunKind::Agent,
                ObservedOutcome::Timeout,
                300_000,
                serde_json::json!({}),
            ),
            run_kind(
                "fs.read",
                ObservedRunKind::Tool,
                ObservedOutcome::Success,
                20,
                serde_json::json!({"output_bytes": 100}),
            ),
        ];
        let evals = vec![eval_case(
            "case-1",
            harness_core::EvalSuiteKind::Regression,
            0,
            ObservedOutcome::Error,
        )];
        let runs = vec![
            requirement_run(
                RequirementRunStatus::Failed,
                Some("agent timed out after 300000ms"),
            ),
            requirement_run(
                RequirementRunStatus::Failed,
                Some("agent reached max iterations (30) without terminating"),
            ),
        ];
        let snapshot = capability_score_snapshot(&obs, &evals, &runs);
        assert!(snapshot.overall_score <= 69);
        let delivery = snapshot
            .dimensions
            .iter()
            .find(|d| d.key == "task_delivery")
            .unwrap();
        assert!(delivery.score < 60);
        let planning = snapshot
            .dimensions
            .iter()
            .find(|d| d.key == "planning_execution")
            .unwrap();
        assert!(planning
            .evidence
            .iter()
            .any(|e| e.detail.contains("timed out")));
    }
}
