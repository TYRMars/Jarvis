//! `harness.health` — read-only harness health snapshot for MCP clients.
//!
//! This tool exposes the same local facts used by the Jarvis dashboard in a
//! compact JSON shape that external agents can consume through MCP. It is
//! intentionally read-only: Claude Code, Codex, or Jarvis itself can inspect
//! current reliability / eval / delivery signals and choose an optimisation
//! direction without mutating project state.

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use harness_core::{BoxError, Tool, ToolCategory};
use harness_observability::{EvalCaseResult, EvalFilter, EvalStore, EvalSuiteKind, ObservabilityFilter, ObservabilityStore, ObservedOutcome, ObservedRun, ObservedRunKind};
use harness_project::{
    RequirementRun, RequirementRunStatus, RequirementRunStore, VerificationStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const DEFAULT_LIMIT: u32 = 2_000;
const MAX_LIMIT: u32 = 10_000;

pub struct HarnessHealthTool {
    observability: Option<Arc<dyn ObservabilityStore>>,
    evals: Option<Arc<dyn EvalStore>>,
    requirement_runs: Option<Arc<dyn RequirementRunStore>>,
}

impl HarnessHealthTool {
    pub fn new(
        observability: Option<Arc<dyn ObservabilityStore>>,
        evals: Option<Arc<dyn EvalStore>>,
        requirement_runs: Option<Arc<dyn RequirementRunStore>>,
    ) -> Self {
        Self {
            observability,
            evals,
            requirement_runs,
        }
    }
}

#[derive(Debug, Deserialize)]
struct HarnessHealthArgs {
    #[serde(default)]
    limit: Option<u32>,
    #[serde(default)]
    include_evidence: Option<bool>,
}

#[derive(Debug, Serialize)]
struct SourceStatus {
    configured: bool,
    rows: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct DriverScore {
    key: &'static str,
    label: &'static str,
    value: Option<f64>,
    weight: f64,
    score: u8,
    detail: &'static str,
}

#[derive(Debug, Serialize)]
struct DimensionScore {
    key: &'static str,
    label: &'static str,
    score: u8,
    confidence: f64,
    summary: &'static str,
    drivers: Vec<DriverScore>,
}

#[derive(Debug, Serialize)]
struct Evidence {
    kind: &'static str,
    id: String,
    title: String,
    detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    metric: Option<String>,
    tone: &'static str,
}

#[async_trait]
impl Tool for HarnessHealthTool {
    fn name(&self) -> &str {
        "harness.health"
    }

    fn category(&self) -> ToolCategory {
        ToolCategory::Read
    }

    fn description(&self) -> &str {
        "Return Jarvis harness health as JSON for MCP clients. Includes \
         capability scores, signal confidence, observed tool/SubAgent health, \
         recent failure evidence, and concrete optimisation actions. Read-only."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_LIMIT,
                    "description": "Maximum rows to read per local store. Defaults to 2000."
                },
                "include_evidence": {
                    "type": "boolean",
                    "description": "Include recent failed eval/run/tool examples. Defaults to true."
                }
            },
            "additionalProperties": false
        })
    }

    fn cacheable(&self) -> bool {
        false
    }

    async fn invoke(&self, args: Value) -> Result<String, BoxError> {
        let args: HarnessHealthArgs = serde_json::from_value(args).unwrap_or(HarnessHealthArgs {
            limit: None,
            include_evidence: None,
        });
        let limit = args.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
        let include_evidence = args.include_evidence.unwrap_or(true);

        let (obs_runs, observability_source) =
            load_observed_runs(self.observability.as_ref(), limit).await;
        let (eval_cases, eval_source) = load_eval_cases(self.evals.as_ref(), limit).await;
        let (requirement_runs, requirement_run_source) =
            load_requirement_runs(self.requirement_runs.as_ref(), limit).await;

        let facts = Facts::new(&obs_runs, &eval_cases, &requirement_runs);
        let dimensions = vec![
            score_task_understanding(&facts),
            score_planning_execution(&facts),
            score_capability_invocation(&facts),
            score_task_delivery(&facts),
        ];
        let mut overall_score = score_from_float(
            dimensions.iter().map(|d| d.score as f64).sum::<f64>() / dimensions.len() as f64,
        );
        if let Some(delivery) = dimensions.iter().find(|d| d.key == "task_delivery") {
            if delivery.score < 60 {
                overall_score = overall_score.min(69);
            }
        }
        let confidence = average(
            dimensions.iter().map(|d| d.confidence).sum(),
            dimensions.len(),
        )
        .unwrap_or(0.0);
        let actions = recommended_actions(&facts, &dimensions);
        let evidence = include_evidence.then(|| evidence_rows(&facts));

        let payload = json!({
            "tool": "harness.health",
            "generated_at": chrono::Utc::now().to_rfc3339(),
            "overall_score": overall_score,
            "confidence": confidence,
            "sample_count": facts.sample_count,
            "primary_focus": dimensions
                .iter()
                .min_by_key(|d| d.score)
                .map(|d| d.key)
                .unwrap_or("observability"),
            "dimensions": dimensions,
            "signals": signal_summary(&facts),
            "actions": actions,
            "evidence": evidence.unwrap_or_default(),
            "sources": {
                "observability": observability_source,
                "evals": eval_source,
                "requirement_runs": requirement_run_source
            },
            "rules": {
                "scale": "0-100",
                "overall": "average(task_understanding, planning_execution, capability_invocation, task_delivery); capped at 69 when task_delivery < 60",
                "confidence": "ln(sample_count + 1) / ln(31) multiplied by available signal coverage",
                "dimension_weights": {
                    "task_understanding": {
                        "capability_eval_pass_rate": 0.40,
                        "verification_pass_rate": 0.25,
                        "completion_rate": 0.20,
                        "misunderstanding_free_rate": 0.15
                    },
                    "planning_execution": {
                        "terminal_rate": 0.25,
                        "completion_rate": 0.30,
                        "timeout_free_rate": 0.25,
                        "agent_success_rate": 0.20
                    },
                    "capability_invocation": {
                        "tool_success_rate": 0.35,
                        "subagent_success_rate": 0.25,
                        "agent_recovery_rate": 0.20,
                        "latency_efficiency": 0.10,
                        "delegation_visibility": 0.10
                    },
                    "task_delivery": {
                        "completion_rate": 0.35,
                        "verification_pass_rate": 0.30,
                        "regression_eval_pass_rate": 0.20,
                        "verification_coverage": 0.10,
                        "failure_free_rate": 0.05
                    }
                }
            }
        });

        serde_json::to_string_pretty(&payload)
            .map_err(|e| -> BoxError { format!("serialize harness health: {e}").into() })
    }
}

async fn load_observed_runs(
    store: Option<&Arc<dyn ObservabilityStore>>,
    limit: u32,
) -> (Vec<ObservedRun>, SourceStatus) {
    let Some(store) = store else {
        return (Vec::new(), source(false, 0, None));
    };
    match store
        .list_runs(ObservabilityFilter {
            limit: Some(limit),
            ..ObservabilityFilter::default()
        })
        .await
    {
        Ok(rows) => {
            let len = rows.len();
            (rows, source(true, len, None))
        }
        Err(e) => (Vec::new(), source(true, 0, Some(e.to_string()))),
    }
}

async fn load_eval_cases(
    store: Option<&Arc<dyn EvalStore>>,
    limit: u32,
) -> (Vec<EvalCaseResult>, SourceStatus) {
    let Some(store) = store else {
        return (Vec::new(), source(false, 0, None));
    };
    match store
        .list_case_results(EvalFilter {
            limit: Some(limit),
            ..EvalFilter::default()
        })
        .await
    {
        Ok(rows) => {
            let len = rows.len();
            (rows, source(true, len, None))
        }
        Err(e) => (Vec::new(), source(true, 0, Some(e.to_string()))),
    }
}

async fn load_requirement_runs(
    store: Option<&Arc<dyn RequirementRunStore>>,
    limit: u32,
) -> (Vec<RequirementRun>, SourceStatus) {
    let Some(store) = store else {
        return (Vec::new(), source(false, 0, None));
    };
    match store.list_all(limit).await {
        Ok(rows) => {
            let len = rows.len();
            (rows, source(true, len, None))
        }
        Err(e) => (Vec::new(), source(true, 0, Some(e.to_string()))),
    }
}

fn source(configured: bool, rows: usize, error: Option<String>) -> SourceStatus {
    SourceStatus {
        configured,
        rows,
        error,
    }
}

struct Facts<'a> {
    obs_runs: &'a [ObservedRun],
    eval_cases: &'a [EvalCaseResult],
    requirement_runs: &'a [RequirementRun],
    agent_runs: Vec<&'a ObservedRun>,
    tool_runs: Vec<&'a ObservedRun>,
    subagent_runs: Vec<&'a ObservedRun>,
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

impl<'a> Facts<'a> {
    fn new(
        obs_runs: &'a [ObservedRun],
        eval_cases: &'a [EvalCaseResult],
        requirement_runs: &'a [RequirementRun],
    ) -> Self {
        let agent_runs = obs_runs
            .iter()
            .filter(|run| run.kind == ObservedRunKind::Agent)
            .collect::<Vec<_>>();
        let tool_runs = obs_runs
            .iter()
            .filter(|run| run.kind == ObservedRunKind::Tool)
            .collect::<Vec<_>>();
        let subagent_runs = obs_runs
            .iter()
            .filter(|run| run.kind == ObservedRunKind::Subagent)
            .collect::<Vec<_>>();
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
            .filter(|run| text_contains(run.error.as_deref(), "timed out"))
            .count()
            + obs_runs
                .iter()
                .filter(|run| run.outcome == ObservedOutcome::Timeout)
                .count();
        let max_iteration_like = requirement_runs
            .iter()
            .filter(|run| text_contains(run.error.as_deref(), "max iterations"))
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
        eval_success_rate_by_kind(self.eval_cases, EvalSuiteKind::Capability)
            .or_else(|| self.eval_pass_rate())
    }

    fn regression_eval_pass_rate(&self) -> Option<f64> {
        eval_success_rate_by_kind(self.eval_cases, EvalSuiteKind::Regression)
            .or_else(|| self.eval_pass_rate())
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

fn score_task_understanding(facts: &Facts<'_>) -> DimensionScore {
    dimension(
        "task_understanding",
        "Task understanding",
        "Goal, constraints, and acceptance criteria comprehension",
        vec![
            driver(
                "capability_eval_pass_rate",
                "Capability eval pass rate",
                facts.capability_eval_pass_rate(),
                0.40,
                "Repeatable eval cases targeting task comprehension",
            ),
            driver(
                "verification_pass_rate",
                "Verification pass rate",
                facts.verification_pass_rate(),
                0.25,
                "Requirement runs whose verification checks passed",
            ),
            driver(
                "completion_rate",
                "Completion rate",
                facts.completion_rate(),
                0.20,
                "Terminal requirement runs that reached completed",
            ),
            driver(
                "misunderstanding_free_rate",
                "Misunderstanding-free rate",
                eval_failure_free_rate(
                    facts.eval_cases,
                    &["understanding", "instruction", "constraint", "acceptance"],
                ),
                0.15,
                "Eval cases not classified as instruction, constraint, or acceptance misses",
            ),
        ],
        confidence_for(facts, 0.45, 0.25, 0.20, 0.10),
    )
}

fn score_planning_execution(facts: &Facts<'_>) -> DimensionScore {
    let agent_success =
        success_rate(&facts.agent_runs).or_else(|| success_rate_slice(facts.obs_runs));
    dimension(
        "planning_execution",
        "Planning execution",
        "Decomposition, sequencing, and terminal-state discipline",
        vec![
            driver(
                "terminal_rate",
                "Terminal-state rate",
                facts.terminal_rate(),
                0.25,
                "Runs that leave pending/running and settle into a terminal state",
            ),
            driver(
                "completion_rate",
                "Execution completion rate",
                facts.completion_rate(),
                0.30,
                "Terminal requirement runs that completed successfully",
            ),
            driver(
                "timeout_free_rate",
                "Timeout/max-iteration avoidance",
                facts.timeout_free_rate(),
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
        ],
        confidence_for(facts, 0.15, 0.15, 0.55, 0.15),
    )
}

fn score_capability_invocation(facts: &Facts<'_>) -> DimensionScore {
    let latency_efficiency = Some(
        latency_score(duration_percentile(facts.obs_runs, 0.95), 20_000, 180_000) as f64 / 100.0,
    );
    let subagent_success = success_rate(&facts.subagent_runs);
    let delegation_visibility = (!facts.subagent_runs.is_empty()).then_some(
        subagent_success.unwrap_or(0.0) * 0.70
            + (latency_score(
                duration_percentile_refs(&facts.subagent_runs, 0.95),
                30_000,
                180_000,
            ) as f64
                / 100.0)
                * 0.30,
    );
    dimension(
        "capability_invocation",
        "Capability invocation",
        "Tool and SubAgent selection effectiveness",
        vec![
            driver(
                "tool_success_rate",
                "Tool success rate",
                success_rate(&facts.tool_runs),
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
                success_rate(&facts.agent_runs).or_else(|| success_rate_slice(facts.obs_runs)),
                0.20,
                "Agent run success after using available capabilities",
            ),
            driver(
                "latency_efficiency",
                "Latency efficiency",
                latency_efficiency,
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
        ],
        confidence_for(facts, 0.45, 0.20, 0.10, 0.25),
    )
}

fn score_task_delivery(facts: &Facts<'_>) -> DimensionScore {
    let failure_free = ratio(
        facts
            .terminal_runs
            .len()
            .saturating_sub(facts.failed_runs + facts.cancelled_runs),
        facts.terminal_runs.len(),
    );
    dimension(
        "task_delivery",
        "Task delivery",
        "Verifiable completed work production",
        vec![
            driver(
                "completion_rate",
                "Completion rate",
                facts.completion_rate(),
                0.35,
                "Terminal requirement runs that reached completed",
            ),
            driver(
                "verification_pass_rate",
                "Verification pass rate",
                facts.verification_pass_rate(),
                0.30,
                "Attached verification results that passed",
            ),
            driver(
                "regression_eval_pass_rate",
                "Regression eval pass rate",
                facts.regression_eval_pass_rate(),
                0.20,
                "Regression suites that still pass",
            ),
            driver(
                "verification_coverage",
                "Verification coverage",
                facts.verification_coverage(),
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
        ],
        confidence_for(facts, 0.20, 0.25, 0.45, 0.10),
    )
}

fn dimension(
    key: &'static str,
    label: &'static str,
    summary: &'static str,
    drivers: Vec<DriverScore>,
    confidence: f64,
) -> DimensionScore {
    DimensionScore {
        key,
        label,
        score: weighted_driver_score(&drivers),
        confidence,
        summary,
        drivers,
    }
}

fn driver(
    key: &'static str,
    label: &'static str,
    value: Option<f64>,
    weight: f64,
    detail: &'static str,
) -> DriverScore {
    let score = value
        .map(|v| score_from_float(v.clamp(0.0, 1.0) * 100.0))
        .unwrap_or(50);
    DriverScore {
        key,
        label,
        value,
        weight,
        score,
        detail,
    }
}

fn weighted_driver_score(drivers: &[DriverScore]) -> u8 {
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
    facts: &Facts<'_>,
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

fn recommended_actions(facts: &Facts<'_>, dimensions: &[DimensionScore]) -> Vec<Value> {
    let mut actions = Vec::new();
    let score = |key: &str| {
        dimensions
            .iter()
            .find(|d| d.key == key)
            .map(|d| d.score)
            .unwrap_or(50)
    };

    if score("task_delivery") < 70 {
        actions.push(json!({
            "key": "stabilize_delivery_gate",
            "priority": 1,
            "tone": "danger",
            "title": "优先稳定交付闭环",
            "why": "交付分低时，新增能力会放大不确定性。先让 run 能完成、验证能通过、失败能归因。",
            "metric": format!("completed {}/terminal {}", facts.completed_runs, facts.terminal_runs.len()),
            "next_steps": [
                "为失败最多的 RequirementRun 补明确验收条件",
                "把 verification failed/timeout 的错误文本归类",
                "新增 regression eval 覆盖已修复失败"
            ]
        }));
    }
    if score("planning_execution") < 70 {
        actions.push(json!({
            "key": "reduce_timeout_and_iteration_failures",
            "priority": 2,
            "tone": "warn",
            "title": "收敛规划执行失败",
            "why": "timeout/max-iteration 通常说明拆解粒度、停止条件或工具等待策略不稳定。",
            "metric": format!("timeout_like {}, max_iteration_like {}", facts.timeout_like, facts.max_iteration_like),
            "next_steps": [
                "把长任务拆成可验证的子 Requirement",
                "为自动调度增加 max-iteration 前的中间保存点",
                "审计耗时最高的 agent/tool/subagent span"
            ]
        }));
    }
    if score("capability_invocation") < 75 {
        actions.push(json!({
            "key": "tune_tools_and_subagents",
            "priority": 3,
            "tone": "warn",
            "title": "优化工具与 SubAgent 调用",
            "why": "工具和 SubAgent 是 harness 放大能力的主要路径，失败率或不可见会直接影响方向判断。",
            "metric": format!("tools {}, subagents {}", facts.tool_runs.len(), facts.subagent_runs.len()),
            "next_steps": [
                "修复错误最多的 tool schema/timeout/recoverable error text",
                "为 Claude Code/Codex delegation 加 smoke eval",
                "记录每次 SubAgent 的输入目标、退出原因和产物证据"
            ]
        }));
    }
    if score("task_understanding") < 70 {
        actions.push(json!({
            "key": "sharpen_task_acceptance",
            "priority": 4,
            "tone": "warn",
            "title": "强化任务理解与验收表达",
            "why": "理解力不足时，后续规划和工具调用即使成功也可能交付错目标。",
            "metric": format!("capability eval cases {}", facts.eval_cases.len()),
            "next_steps": [
                "新增 ambiguous/constraint/acceptance 类 capability eval",
                "把用户需求拆成 objective、constraints、acceptance 三段记录",
                "用真实失败案例生成最小复现 eval"
            ]
        }));
    }
    if facts.sample_count < 30 || facts.eval_cases.is_empty() || facts.subagent_runs.is_empty() {
        actions.push(json!({
            "key": "fill_signal_gaps",
            "priority": 5,
            "tone": "neutral",
            "title": "补齐观测样本",
            "why": "样本不足会让优化方向偏向个案；至少需要 run、tool、SubAgent、eval 四类信号。",
            "metric": format!("sample_count {}", facts.sample_count),
            "next_steps": [
                "保持 JARVIS_OBSERVABILITY_STORE_URL 与 JARVIS_EVAL_STORE_URL 开启",
                "跑一组覆盖自动调度、工具调用、SubAgent 委派的真实案例",
                "把最近失败 run 转成 eval baseline"
            ]
        }));
    }
    actions.sort_by_key(|row| row["priority"].as_u64().unwrap_or(99));
    actions.truncate(5);
    actions
}

fn signal_summary(facts: &Facts<'_>) -> Value {
    json!({
        "observed_runs": facts.obs_runs.len(),
        "agent_runs": facts.agent_runs.len(),
        "tool_runs": facts.tool_runs.len(),
        "subagent_runs": facts.subagent_runs.len(),
        "eval_cases": facts.eval_cases.len(),
        "requirement_runs": facts.requirement_runs.len(),
        "terminal_requirement_runs": facts.terminal_runs.len(),
        "completed_requirement_runs": facts.completed_runs,
        "failed_requirement_runs": facts.failed_runs,
        "cancelled_requirement_runs": facts.cancelled_runs,
        "verified_requirement_runs": facts.verified_runs,
        "verification_passed": facts.verification_passed,
        "agent_success_rate": success_rate(&facts.agent_runs),
        "tool_success_rate": success_rate(&facts.tool_runs),
        "subagent_success_rate": success_rate(&facts.subagent_runs),
        "eval_pass_rate": facts.eval_pass_rate(),
        "completion_rate": facts.completion_rate(),
        "verification_pass_rate": facts.verification_pass_rate(),
        "p95_latency_ms": duration_percentile(facts.obs_runs, 0.95),
        "error_hotspots": error_hotspots(facts.obs_runs, 5)
    })
}

fn evidence_rows(facts: &Facts<'_>) -> Vec<Evidence> {
    let mut out = Vec::new();
    out.extend(
        facts
            .requirement_runs
            .iter()
            .filter(|run| {
                matches!(
                    run.status,
                    RequirementRunStatus::Failed | RequirementRunStatus::Cancelled
                )
            })
            .take(5)
            .map(requirement_evidence),
    );
    out.extend(
        facts
            .eval_cases
            .iter()
            .filter(|case| case.outcome != ObservedOutcome::Success)
            .take(5)
            .map(eval_evidence),
    );
    out.extend(
        facts
            .obs_runs
            .iter()
            .filter(|run| is_bad_outcome(&run.outcome))
            .take(5)
            .map(observed_evidence),
    );
    out.truncate(12);
    out
}

fn requirement_evidence(run: &RequirementRun) -> Evidence {
    Evidence {
        kind: "requirement_run",
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
        },
    }
}

fn eval_evidence(case: &EvalCaseResult) -> Evidence {
    Evidence {
        kind: "eval_case",
        id: case.id.clone(),
        title: case.scenario.clone(),
        detail: case
            .failure_class
            .as_ref()
            .map(json_key)
            .unwrap_or_else(|| json_key(&case.outcome)),
        metric: Some(format!("{} / {}", case.suite, json_key(&case.suite_kind))),
        tone: "danger",
    }
}

fn observed_evidence(run: &ObservedRun) -> Evidence {
    Evidence {
        kind: match run.kind {
            ObservedRunKind::Agent => "agent_run",
            ObservedRunKind::Subagent => "subagent_run",
            ObservedRunKind::Eval => "eval_run",
            ObservedRunKind::Tool => "tool_run",
            ObservedRunKind::Provider => "provider_run",
            ObservedRunKind::Other => "observed_run",
        },
        id: run.id.clone(),
        title: run.name.clone(),
        detail: json_key(&run.outcome),
        metric: run.duration_ms.map(|ms| format!("{ms}ms")),
        tone: "danger",
    }
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

fn success_rate(runs: &[&ObservedRun]) -> Option<f64> {
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

fn success_rate_slice(runs: &[ObservedRun]) -> Option<f64> {
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

fn eval_success_rate_by_kind(cases: &[EvalCaseResult], kind: EvalSuiteKind) -> Option<f64> {
    let mut total = 0;
    let mut passed = 0;
    for case in cases.iter().filter(|case| case.suite_kind == kind) {
        total += 1;
        if case.outcome == ObservedOutcome::Success {
            passed += 1;
        }
    }
    ratio(passed, total)
}

fn duration_percentile(runs: &[ObservedRun], pct: f64) -> Option<u64> {
    let mut durations = runs
        .iter()
        .filter_map(|run| run.duration_ms)
        .collect::<Vec<_>>();
    durations.sort_unstable();
    percentile(&durations, pct)
}

fn duration_percentile_refs(runs: &[&ObservedRun], pct: f64) -> Option<u64> {
    let mut durations = runs
        .iter()
        .filter_map(|run| run.duration_ms)
        .collect::<Vec<_>>();
    durations.sort_unstable();
    percentile(&durations, pct)
}

fn percentile(values: &[u64], pct: f64) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    let idx = ((values.len() - 1) as f64 * pct.clamp(0.0, 1.0)).ceil() as usize;
    values.get(idx).copied()
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

fn error_hotspots(runs: &[ObservedRun], limit: usize) -> Vec<Value> {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for run in runs.iter().filter(|run| is_bad_outcome(&run.outcome)) {
        *counts.entry(run.name.clone()).or_default() += 1;
    }
    let mut rows = counts.into_iter().collect::<Vec<_>>();
    rows.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    rows.into_iter()
        .take(limit)
        .map(|(name, errors)| json!({ "name": name, "errors": errors }))
        .collect()
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

fn text_contains(text: Option<&str>, needle: &str) -> bool {
    text.is_some_and(|value| value.to_ascii_lowercase().contains(needle))
}

fn ratio(numerator: usize, denominator: usize) -> Option<f64> {
    (denominator > 0).then(|| numerator as f64 / denominator as f64)
}

fn average(sum: f64, count: usize) -> Option<f64> {
    (count > 0).then(|| sum / count as f64)
}

fn score_from_float(value: f64) -> u8 {
    value.clamp(0.0, 100.0).round() as u8
}

fn json_key<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".into())
}

fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use harness_project::{RequirementRun, VerificationResult};
    use harness_store::MemoryRequirementRunStore;

    #[tokio::test]
    async fn harness_health_reports_requirement_run_signals() {
        let runs = Arc::new(MemoryRequirementRunStore::new());
        let mut good = RequirementRun::new("req-good", "conv-good");
        good.status = RequirementRunStatus::Completed;
        good.verification = Some(VerificationResult {
            status: VerificationStatus::Passed,
            command_results: Vec::new(),
            diff_summary: None,
            notes: None,
        });
        runs.upsert(&good).await.unwrap();
        let mut failed = RequirementRun::new("req-bad", "conv-bad");
        failed.status = RequirementRunStatus::Failed;
        failed.error = Some("agent timed out after 300000ms".into());
        runs.upsert(&failed).await.unwrap();

        let tool = HarnessHealthTool::new(None, None, Some(runs));
        let raw = tool
            .invoke(json!({ "limit": 20, "include_evidence": true }))
            .await
            .unwrap();
        let payload: Value = serde_json::from_str(&raw).unwrap();

        assert_eq!(payload["tool"], "harness.health");
        assert_eq!(payload["sources"]["requirement_runs"]["rows"], 2);
        assert_eq!(payload["signals"]["failed_requirement_runs"], 1);
        assert!(payload["overall_score"].as_u64().unwrap() <= 69);
        assert!(!payload["actions"].as_array().unwrap().is_empty());
        assert!(!payload["evidence"].as_array().unwrap().is_empty());
    }
}
