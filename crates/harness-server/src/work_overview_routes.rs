//! REST routes for the Work-mode dashboard.
//!
//! Two endpoints, both pre-aggregating across the optional store
//! traits in [`AppState`]:
//!
//! - `GET /v1/work/overview?since=<rfc3339>&window_days=<u32>` — cheap
//!   roll-ups (KPI cards, status counts, throughput by day, project
//!   leaderboard, running runs, recent failures, blocked requirements).
//! - `GET /v1/work/quality?since=<rfc3339>&window_days=<u32>` — slower
//!   aggregations that walk verification payloads (top failing
//!   commands, verification pass rate by day).
//!
//! Both endpoints are tolerant of partial store availability: each
//! sub-aggregate that needs an unavailable store returns `null` and
//! its name is reported in `missing_stores`. Only the
//! [`RequirementRunStore`] is hard-required (it's the dashboard's
//! core data source); when it's missing the endpoint returns `503`.

use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
    routing::get,
    Router,
};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use harness_core::{
    Project, Requirement, RequirementRun, RequirementRunStatus, RequirementRunStore,
    RequirementStatus, VerificationStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::error;

use crate::state::AppState;

/// Default time window when neither `since` nor `window_days` is set.
const DEFAULT_WINDOW_DAYS: i64 = 7;

/// Cap on the upstream `RequirementRunStore::list_all` scan. Keeps the
/// dashboard cheap on installations with millions of runs; surfaced via
/// the response's `truncated` flag so the UI can warn.
const RUN_SCAN_LIMIT: u32 = 1000;

/// Cap on the cross-project blocked-requirements scan (number of
/// projects considered).
const BLOCKED_PROJECT_LIMIT: u32 = 20;

/// Per-requirement activity scan depth when looking for the latest
/// blocked/unblocked transition.
const ACTIVITY_PEEK: usize = 50;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/work/overview", get(get_overview))
        .route("/v1/work/quality", get(get_quality))
}

// --------------------------- Query parsing -------------------------------

#[derive(Debug, Deserialize)]
struct OverviewQuery {
    /// RFC-3339 lower bound for window-scoped aggregations. When
    /// absent, computed as `now - window_days`.
    #[serde(default)]
    since: Option<String>,
    /// Width of the window in days. Used both to derive `since` and
    /// to size the daily-bucket arrays so empty days still appear.
    /// Defaults to [`DEFAULT_WINDOW_DAYS`].
    #[serde(default)]
    window_days: Option<i64>,
}

struct ResolvedWindow {
    as_of: DateTime<Utc>,
    since: DateTime<Utc>,
    window_days: i64,
}

#[allow(clippy::result_large_err)]
fn resolve_window(q: &OverviewQuery) -> Result<ResolvedWindow, Response> {
    let as_of = Utc::now();
    let window_days = q
        .window_days
        .unwrap_or(DEFAULT_WINDOW_DAYS)
        .clamp(1, 365);
    let since = match q.since.as_deref() {
        Some(raw) => DateTime::parse_from_rfc3339(raw)
            .map(|dt| dt.with_timezone(&Utc))
            .map_err(|e| {
                (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": format!("invalid `since`: {e}") })),
                )
                    .into_response()
            })?,
        None => as_of - Duration::days(window_days),
    };
    Ok(ResolvedWindow {
        as_of,
        since,
        window_days,
    })
}

// --------------------------- Helpers -------------------------------------

#[allow(clippy::result_large_err)]
fn require_run_store(state: &AppState) -> Result<Arc<dyn RequirementRunStore>, Response> {
    state.requirement_runs.clone().ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "requirement run store not configured" })),
        )
            .into_response()
    })
}

fn internal_error(e: impl std::fmt::Display) -> Response {
    error!(error = %e, "work overview error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": e.to_string() })),
    )
        .into_response()
}

/// Parse an RFC-3339 timestamp. Returns `None` for unparseable input
/// — callers fold those rows back to "no contribution" rather than
/// failing the whole aggregate.
fn parse_ts(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

/// Normalise a verification command for top-failing-commands grouping.
/// `cargo test -p foo --lib` and `cargo test -p bar --features x` both
/// reduce to `cargo test`. Empty input yields `"<empty>"` so the
/// HashMap key stays well-formed.
fn normalise_command(cmd: &str) -> String {
    let mut tokens = cmd.split_whitespace();
    match (tokens.next(), tokens.next()) {
        (None, _) => "<empty>".to_string(),
        (Some(a), None) => a.to_string(),
        (Some(a), Some(b)) => format!("{a} {b}"),
    }
}

// --------------------------- Overview handler ----------------------------

async fn get_overview(State(state): State<AppState>, Query(q): Query<OverviewQuery>) -> Response {
    let window = match resolve_window(&q) {
        Ok(w) => w,
        Err(resp) => return resp,
    };
    let runs_store = match require_run_store(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };

    let mut missing_stores: Vec<&'static str> = Vec::new();

    // ---- pull all the data we'll need up-front --------------------------
    let runs = match runs_store.list_all(RUN_SCAN_LIMIT).await {
        Ok(r) => r,
        Err(e) => return internal_error(e),
    };
    let truncated = runs.len() as u32 >= RUN_SCAN_LIMIT;

    let projects: Option<Vec<Project>> = match state.projects.as_ref() {
        Some(s) => match s.list(false, 500).await {
            Ok(rows) => Some(rows),
            Err(e) => return internal_error(e),
        },
        None => {
            missing_stores.push("projects");
            None
        }
    };

    let requirements: Option<Vec<Requirement>> = match (state.requirements.as_ref(), &projects)
    {
        (Some(req_store), Some(projs)) => {
            let mut all = Vec::new();
            for p in projs {
                match req_store.list(&p.id).await {
                    Ok(mut rows) => all.append(&mut rows),
                    Err(e) => return internal_error(e),
                }
            }
            Some(all)
        }
        (Some(_), None) => {
            // We have a requirement store but no project store, so we
            // can't enumerate projects to scan. Skip rather than fail.
            missing_stores.push("requirements");
            None
        }
        (None, _) => {
            missing_stores.push("requirements");
            None
        }
    };

    // ---- requirement_status_counts --------------------------------------
    let requirement_status_counts = requirements.as_ref().map(|reqs| {
        let mut counts = StatusCounts::default();
        for r in reqs {
            counts.bump(r.status);
        }
        counts
    });

    // ---- index requirements + projects for joins ------------------------
    let req_index: HashMap<String, &Requirement> = requirements
        .as_ref()
        .map(|reqs| reqs.iter().map(|r| (r.id.clone(), r)).collect())
        .unwrap_or_default();
    let proj_index: HashMap<String, &Project> = projects
        .as_ref()
        .map(|ps| ps.iter().map(|p| (p.id.clone(), p)).collect())
        .unwrap_or_default();

    // ---- running_now ----------------------------------------------------
    let running_now: Vec<Value> = runs
        .iter()
        .filter(|r| r.status == RequirementRunStatus::Running)
        .map(|r| {
            let req = req_index.get(&r.requirement_id);
            let proj = req
                .and_then(|rq| proj_index.get(&rq.project_id))
                .copied();
            let started = parse_ts(&r.started_at);
            let duration_ms = started.map(|s| (window.as_of - s).num_milliseconds().max(0));
            json!({
                "id": r.id,
                "requirement_id": r.requirement_id,
                "requirement_title": req.map(|rq| rq.title.as_str()),
                "project_id": req.map(|rq| rq.project_id.as_str()),
                "project_name": proj.map(|p| p.name.as_str()),
                "started_at": r.started_at,
                "conversation_id": r.conversation_id,
                "duration_ms": duration_ms,
            })
        })
        .collect();

    // ---- window-scoped run rollups --------------------------------------
    let mut run_status_counts = WindowRunCounts::default();
    let mut throughput: HashMap<NaiveDate, ThroughputBucket> = HashMap::new();
    // Pre-seed daily buckets so empty days render zeros.
    seed_buckets(&mut throughput, window.since, window.as_of);

    let mut verification_passed = 0u64;
    let mut verification_total = 0u64;
    let mut recent_failures: Vec<&RequirementRun> = Vec::new();

    for run in &runs {
        let started = match parse_ts(&run.started_at) {
            Some(t) => t,
            None => continue,
        };
        if started < window.since || started > window.as_of {
            continue;
        }
        let date = started.date_naive();
        let bucket = throughput.entry(date).or_default();
        bucket.runs_started += 1;

        match run.status {
            RequirementRunStatus::Completed => {
                run_status_counts.completed += 1;
                bucket.runs_completed += 1;
                if let Some(v) = &run.verification {
                    verification_total += 1;
                    if v.status == VerificationStatus::Passed {
                        verification_passed += 1;
                    }
                }
            }
            RequirementRunStatus::Failed => {
                run_status_counts.failed += 1;
                bucket.runs_failed += 1;
                recent_failures.push(run);
            }
            RequirementRunStatus::Cancelled => {
                run_status_counts.cancelled += 1;
            }
            _ => {}
        }
    }

    // requirements_completed per day (in window) — derived from the
    // requirement's updated_at when status==Done. Best-effort.
    if let Some(reqs) = requirements.as_ref() {
        for r in reqs {
            if r.status != RequirementStatus::Done {
                continue;
            }
            let Some(updated) = parse_ts(&r.updated_at) else {
                continue;
            };
            if updated < window.since || updated > window.as_of {
                continue;
            }
            throughput
                .entry(updated.date_naive())
                .or_default()
                .requirements_completed += 1;
        }
    }

    let mut throughput_by_day: Vec<Value> = throughput
        .into_iter()
        .map(|(date, b)| {
            json!({
                "date": date.format("%Y-%m-%d").to_string(),
                "runs_started": b.runs_started,
                "runs_completed": b.runs_completed,
                "runs_failed": b.runs_failed,
                "requirements_completed": b.requirements_completed,
            })
        })
        .collect();
    throughput_by_day.sort_by(|a, b| a["date"].as_str().cmp(&b["date"].as_str()));

    // recent_failures, newest-first, top 10
    recent_failures.sort_by(|a, b| {
        let key = |r: &RequirementRun| r.finished_at.clone().unwrap_or_else(|| r.started_at.clone());
        key(b).cmp(&key(a))
    });
    let recent_failures: Vec<Value> = recent_failures
        .into_iter()
        .take(10)
        .map(|r| {
            let req = req_index.get(&r.requirement_id);
            let proj = req
                .and_then(|rq| proj_index.get(&rq.project_id))
                .copied();
            json!({
                "id": r.id,
                "requirement_id": r.requirement_id,
                "requirement_title": req.map(|rq| rq.title.as_str()),
                "project_id": req.map(|rq| rq.project_id.as_str()),
                "project_name": proj.map(|p| p.name.as_str()),
                "error": r.error,
                "finished_at": r.finished_at,
                "conversation_id": r.conversation_id,
            })
        })
        .collect();

    let verification_pass_rate = if verification_total > 0 {
        Some(verification_passed as f64 / verification_total as f64)
    } else {
        None
    };

    // ---- project leaderboard -------------------------------------------
    let project_leaderboard: Option<Vec<Value>> = projects.as_ref().map(|projs| {
        let mut tally: HashMap<&str, (u64, u64)> = HashMap::new(); // (runs, completed)
        for run in &runs {
            let Some(req) = req_index.get(&run.requirement_id) else {
                continue;
            };
            let Some(started) = parse_ts(&run.started_at) else {
                continue;
            };
            if started < window.since || started > window.as_of {
                continue;
            }
            let entry = tally.entry(req.project_id.as_str()).or_insert((0, 0));
            entry.0 += 1;
            if run.status == RequirementRunStatus::Completed {
                entry.1 += 1;
            }
        }
        let mut leaderboard: Vec<Value> = projs
            .iter()
            .filter_map(|p| {
                let (runs_in_window, completed) = tally.get(p.id.as_str()).copied()?;
                let completion_rate = if runs_in_window > 0 {
                    completed as f64 / runs_in_window as f64
                } else {
                    0.0
                };
                Some(json!({
                    "project_id": p.id,
                    "project_name": p.name,
                    "runs_in_window": runs_in_window,
                    "completion_rate": completion_rate,
                }))
            })
            .collect();
        leaderboard.sort_by(|a, b| {
            b["runs_in_window"]
                .as_u64()
                .unwrap_or(0)
                .cmp(&a["runs_in_window"].as_u64().unwrap_or(0))
        });
        leaderboard.truncate(5);
        leaderboard
    });

    // ---- blocked_requirements ------------------------------------------
    let (blocked_requirements, blocked_truncated) = match (
        state.activities.as_ref(),
        requirements.as_ref(),
        projects.as_ref(),
    ) {
        (Some(act_store), Some(reqs), Some(projs)) => {
            // Cap project scan to keep the cross-project N+1 bounded.
            let scanned_projects: Vec<&Project> =
                projs.iter().take(BLOCKED_PROJECT_LIMIT as usize).collect();
            let scanned_ids: std::collections::HashSet<&str> =
                scanned_projects.iter().map(|p| p.id.as_str()).collect();
            let truncated = projs.len() > scanned_projects.len();
            let mut blocked: Vec<Value> = Vec::new();
            for r in reqs.iter() {
                if !scanned_ids.contains(r.project_id.as_str()) {
                    continue;
                }
                let Ok(activities) = act_store.list_for_requirement(&r.id).await else {
                    continue;
                };
                // activities are newest-first; find the latest blocked
                // and check whether a later unblocked has happened.
                let mut latest_block: Option<(String, Value)> = None;
                let mut latest_unblock_ts: Option<String> = None;
                for a in activities.into_iter().take(ACTIVITY_PEEK) {
                    match a.kind {
                        harness_core::ActivityKind::Blocked if latest_block.is_none() => {
                            latest_block = Some((a.created_at.clone(), a.body.clone()));
                        }
                        harness_core::ActivityKind::Unblocked if latest_unblock_ts.is_none() => {
                            latest_unblock_ts = Some(a.created_at.clone());
                        }
                        _ => {}
                    }
                }
                if let Some((ts, body)) = latest_block {
                    let unblocked_after = latest_unblock_ts
                        .as_deref()
                        .map(|u| u > ts.as_str())
                        .unwrap_or(false);
                    if !unblocked_after {
                        let project_name = proj_index
                            .get(&r.project_id)
                            .map(|p| p.name.as_str());
                        let reason = body
                            .get("reason")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        blocked.push(json!({
                            "id": r.id,
                            "project_id": r.project_id,
                            "project_name": project_name,
                            "title": r.title,
                            "blocked_since": ts,
                            "reason": reason,
                        }));
                    }
                }
            }
            blocked.sort_by(|a, b| b["blocked_since"].as_str().cmp(&a["blocked_since"].as_str()));
            (Some(blocked), truncated)
        }
        _ => {
            if state.activities.is_none() {
                missing_stores.push("activities");
            }
            (None, false)
        }
    };

    let body = json!({
        "as_of": window.as_of.to_rfc3339(),
        "since": window.since.to_rfc3339(),
        "window_days": window.window_days,
        "missing_stores": missing_stores,
        "truncated": truncated,
        "blocked_truncated": blocked_truncated,
        "requirement_status_counts": requirement_status_counts,
        "running_now": running_now,
        "blocked_requirements": blocked_requirements,
        "run_status_counts": run_status_counts,
        "verification_pass_rate": verification_pass_rate,
        "recent_failures": recent_failures,
        "throughput_by_day": throughput_by_day,
        "project_leaderboard": project_leaderboard,
        // v1: cross-project actor breakdown needs an ActivityStore
        // index we don't have. Field stays present + null so clients
        // can render an "unavailable" state without conditional shape.
        "actor_breakdown": Value::Null,
    });

    Json(body).into_response()
}

// --------------------------- Quality handler -----------------------------

async fn get_quality(State(state): State<AppState>, Query(q): Query<OverviewQuery>) -> Response {
    let window = match resolve_window(&q) {
        Ok(w) => w,
        Err(resp) => return resp,
    };
    let runs_store = match require_run_store(&state) {
        Ok(r) => r,
        Err(resp) => return resp,
    };
    let runs = match runs_store.list_all(RUN_SCAN_LIMIT).await {
        Ok(r) => r,
        Err(e) => return internal_error(e),
    };
    let truncated = runs.len() as u32 >= RUN_SCAN_LIMIT;

    // Top failing commands across all in-window runs.
    let mut tally: HashMap<String, FailingCmd> = HashMap::new();
    let mut verification_buckets: HashMap<NaiveDate, VerificationBucket> = HashMap::new();
    seed_verification_buckets(&mut verification_buckets, window.since, window.as_of);

    for run in &runs {
        let Some(verification) = &run.verification else {
            continue;
        };
        let started = match parse_ts(&run.started_at) {
            Some(t) => t,
            None => continue,
        };
        if started < window.since || started > window.as_of {
            continue;
        }
        let date = started.date_naive();
        let bucket = verification_buckets.entry(date).or_default();
        match verification.status {
            VerificationStatus::Passed => bucket.passed += 1,
            VerificationStatus::Failed => bucket.failed += 1,
            VerificationStatus::NeedsReview => bucket.needs_review += 1,
            VerificationStatus::Skipped => {}
        }

        for cr in &verification.command_results {
            let failed = cr.exit_code.map(|c| c != 0).unwrap_or(true);
            if !failed {
                continue;
            }
            let key = normalise_command(&cr.command);
            let entry = tally.entry(key).or_default();
            entry.fail_count += 1;
            if entry.sample_stderr.is_empty() && !cr.stderr.is_empty() {
                let cap = cr.stderr.len().min(512);
                entry.sample_stderr = cr.stderr[..cap].to_string();
            }
            // last_seen tracked as max started_at (stringly RFC-3339
            // sorts correctly).
            if entry
                .last_seen
                .as_deref()
                .map(|prev| run.started_at.as_str() > prev)
                .unwrap_or(true)
            {
                entry.last_seen = Some(run.started_at.clone());
            }
        }
    }

    let mut top_failing_commands: Vec<Value> = tally
        .into_iter()
        .map(|(k, v)| {
            json!({
                "command_normalized": k,
                "fail_count": v.fail_count,
                "sample_stderr": v.sample_stderr,
                "last_seen": v.last_seen,
            })
        })
        .collect();
    top_failing_commands.sort_by(|a, b| {
        b["fail_count"]
            .as_u64()
            .unwrap_or(0)
            .cmp(&a["fail_count"].as_u64().unwrap_or(0))
    });
    top_failing_commands.truncate(15);

    let mut verification_pass_rate_by_day: Vec<Value> = verification_buckets
        .into_iter()
        .map(|(date, b)| {
            json!({
                "date": date.format("%Y-%m-%d").to_string(),
                "passed": b.passed,
                "failed": b.failed,
                "needs_review": b.needs_review,
            })
        })
        .collect();
    verification_pass_rate_by_day
        .sort_by(|a, b| a["date"].as_str().cmp(&b["date"].as_str()));

    Json(json!({
        "as_of": window.as_of.to_rfc3339(),
        "since": window.since.to_rfc3339(),
        "window_days": window.window_days,
        "truncated": truncated,
        "top_failing_commands": top_failing_commands,
        "verification_pass_rate_by_day": verification_pass_rate_by_day,
    }))
    .into_response()
}

// --------------------------- Local types ---------------------------------

#[derive(Debug, Default, Serialize)]
struct StatusCounts {
    backlog: u64,
    in_progress: u64,
    review: u64,
    done: u64,
}

impl StatusCounts {
    fn bump(&mut self, s: RequirementStatus) {
        match s {
            RequirementStatus::Backlog => self.backlog += 1,
            RequirementStatus::InProgress => self.in_progress += 1,
            RequirementStatus::Review => self.review += 1,
            RequirementStatus::Done => self.done += 1,
        }
    }
}

#[derive(Debug, Default, Serialize)]
struct WindowRunCounts {
    completed: u64,
    failed: u64,
    cancelled: u64,
}

#[derive(Debug, Default)]
struct ThroughputBucket {
    runs_started: u64,
    runs_completed: u64,
    runs_failed: u64,
    requirements_completed: u64,
}

#[derive(Debug, Default)]
struct VerificationBucket {
    passed: u64,
    failed: u64,
    needs_review: u64,
}

#[derive(Debug, Default)]
struct FailingCmd {
    fail_count: u64,
    sample_stderr: String,
    last_seen: Option<String>,
}

fn seed_buckets(
    map: &mut HashMap<NaiveDate, ThroughputBucket>,
    since: DateTime<Utc>,
    as_of: DateTime<Utc>,
) {
    let mut day = since.date_naive();
    let end = as_of.date_naive();
    while day <= end {
        map.entry(day).or_default();
        let Some(next) = day.succ_opt() else { break };
        day = next;
    }
}

fn seed_verification_buckets(
    map: &mut HashMap<NaiveDate, VerificationBucket>,
    since: DateTime<Utc>,
    as_of: DateTime<Utc>,
) {
    let mut day = since.date_naive();
    let end = as_of.date_naive();
    while day <= end {
        map.entry(day).or_default();
        let Some(next) = day.succ_opt() else { break };
        day = next;
    }
}

// --------------------------- Tests ---------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalise_command_handles_variants() {
        assert_eq!(normalise_command("cargo test -p foo --lib"), "cargo test");
        assert_eq!(normalise_command("cargo test"), "cargo test");
        assert_eq!(normalise_command("ls"), "ls");
        assert_eq!(normalise_command(""), "<empty>");
        assert_eq!(normalise_command("   "), "<empty>");
        assert_eq!(
            normalise_command("npm   run     build"),
            "npm run",
            "extra whitespace doesn't break grouping"
        );
    }

    #[test]
    fn status_counts_bump_each_variant() {
        let mut c = StatusCounts::default();
        c.bump(RequirementStatus::Backlog);
        c.bump(RequirementStatus::Backlog);
        c.bump(RequirementStatus::InProgress);
        c.bump(RequirementStatus::Review);
        c.bump(RequirementStatus::Done);
        assert_eq!(c.backlog, 2);
        assert_eq!(c.in_progress, 1);
        assert_eq!(c.review, 1);
        assert_eq!(c.done, 1);
    }

    #[test]
    fn parse_ts_returns_none_for_garbage() {
        assert!(parse_ts("not-a-timestamp").is_none());
        assert!(parse_ts("2026-04-30T01:23:45+00:00").is_some());
    }

    #[test]
    fn seed_buckets_fills_every_day_in_range() {
        let mut m = HashMap::new();
        let since = DateTime::parse_from_rfc3339("2026-04-26T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let as_of = DateTime::parse_from_rfc3339("2026-04-30T23:59:00Z")
            .unwrap()
            .with_timezone(&Utc);
        seed_buckets(&mut m, since, as_of);
        // 26, 27, 28, 29, 30 → 5 days
        assert_eq!(m.len(), 5);
    }

    #[test]
    fn resolve_window_uses_default_when_unset() {
        let q = OverviewQuery {
            since: None,
            window_days: None,
        };
        let w = resolve_window(&q).unwrap();
        assert_eq!(w.window_days, DEFAULT_WINDOW_DAYS);
        // since must be earlier than as_of
        assert!(w.since < w.as_of);
    }

    #[test]
    fn resolve_window_clamps_window_days() {
        let q = OverviewQuery {
            since: None,
            window_days: Some(0),
        };
        assert_eq!(resolve_window(&q).unwrap().window_days, 1);
        let q = OverviewQuery {
            since: None,
            window_days: Some(9999),
        };
        assert_eq!(resolve_window(&q).unwrap().window_days, 365);
    }

    #[test]
    fn resolve_window_rejects_bad_since() {
        let q = OverviewQuery {
            since: Some("not-a-date".into()),
            window_days: None,
        };
        assert!(resolve_window(&q).is_err());
    }
}
