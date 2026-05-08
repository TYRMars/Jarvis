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
    ObservedOutcome, ObservedRun, ObservedRunKind, TimeWindow,
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
        .route("/v1/evals/cases", get(list_eval_cases))
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
    case_id: Option<String>,
    outcome: Option<ObservedOutcome>,
    limit: Option<u32>,
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
}
