import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import {
  MemoryEvalStore,
  MemoryObservabilityStore,
  type EvalCaseResult,
  type EvalSuiteKind,
  type ObservedOutcome,
  type ObservedRun,
  type ObservedRunKind,
} from "@jarvis/observability";
import { MemoryRequirementRunStore } from "@jarvis/store";
import {
  newRequirementRun,
  type RequirementRun,
  type RequirementRunStatus,
  type VerificationResult,
} from "@jarvis/project";
import { registerObservabilityRoutes } from "./observability-routes.ts";
import type { AppState } from "./state.ts";

// ---------- fixtures ----------

const NO_AGENT = (): never => {
  throw new Error("agent not used in these route tests");
};

function emptyState(overrides: Partial<AppState> = {}): AppState {
  return { createAgent: NO_AGENT, ...overrides };
}

async function buildApp(state: AppState) {
  const app = Fastify();
  registerObservabilityRoutes(app, state);
  await app.ready();
  return app;
}

let seq = 0;
function run(
  name: string,
  kind: ObservedRunKind,
  outcome: ObservedOutcome,
  durationMs: number,
  attributes: Record<string, unknown> = {},
): ObservedRun {
  seq += 1;
  return {
    id: `${name}-${seq}`,
    kind,
    name,
    started_at: `2026-05-08T00:00:0${seq % 10}Z`,
    ended_at: "2026-05-08T00:00:10Z",
    duration_ms: durationMs,
    outcome,
    attributes: attributes as ObservedRun["attributes"],
    metrics: null,
  };
}

function evalCase(
  caseId: string,
  suiteKind: EvalSuiteKind,
  trialIndex: number,
  outcome: ObservedOutcome,
): EvalCaseResult {
  return {
    id: `${caseId}-${trialIndex}`,
    suite_run_id: "suite-run-1",
    case_id: caseId,
    suite: "coding-smoke",
    suite_kind: suiteKind,
    scenario: "tool-use",
    trial_index: trialIndex,
    trial_count: 2,
    outcome,
    transcript_artifact_id: `transcript-${caseId}-${trialIndex}`,
    grader_results: [
      {
        id: `grader-${caseId}-${trialIndex}`,
        kind: "deterministic_test",
        verdict: "pass",
        score: 1.0,
        attributes: null,
      },
    ],
    scores: null,
    attributes: null,
  };
}

function requirementRun(
  status: RequirementRunStatus,
  error?: string,
  verification?: VerificationResult,
): RequirementRun {
  const r = newRequirementRun("req-1", "conv-1");
  r.status = status;
  if (status === "completed" || status === "failed" || status === "cancelled") {
    r.finished_at = "2026-05-08T00:00:02Z";
  }
  if (error !== undefined) r.error = error;
  if (verification !== undefined) r.verification = verification;
  return r;
}

// ---------- exporter (always 200, default shape) ----------

test("exporter returns the default OTLP status shape", async () => {
  const app = await buildApp(emptyState());
  const res = await app.inject({ method: "GET", url: "/v1/observability/exporter" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    enabled: false,
    endpoint: "",
    protocol: "",
    service_name: "jarvis",
    service_env: "local",
    sample_ratio: 0,
  });
  await app.close();
});

// ---------- 503 when stores absent ----------

test("observability/eval routes 503 when their stores are absent", async () => {
  const app = await buildApp(emptyState());
  const obsRoutes = [
    "/v1/observability/dashboard",
    "/v1/observability/runs",
    "/v1/observability/tools",
    "/v1/observability/subagents",
    "/v1/observability/direction",
  ];
  for (const url of obsRoutes) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 503, url);
    assert.match(res.json().error as string, /observability store not configured/);
  }

  for (const url of ["/v1/evals/summary", "/v1/evals/cases"]) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 503, url);
    assert.match(res.json().error as string, /eval store not configured/);
  }

  const cap = await app.inject({ method: "GET", url: "/v1/observability/capability-score" });
  assert.equal(cap.statusCode, 503);
  assert.match(cap.json().error as string, /capability scoring stores not configured/);

  const health = await app.inject({ method: "GET", url: "/v1/observability/health" });
  assert.equal(health.statusCode, 503);
  assert.match(health.json().error as string, /nothing to summarise/);

  await app.close();
});

// ---------- dashboard ----------

test("dashboard aggregates total / success / failure and honours window", async () => {
  const obs = new MemoryObservabilityStore();
  await obs.appendRun(run("fs.read", "tool", "success", 10));
  await obs.appendRun(run("fs.read", "tool", "error", 30));
  await obs.appendRun(run("jarvis.agent.run", "agent", "success", 1000));
  const app = await buildApp(emptyState({ observability: obs }));

  const res = await app.inject({
    method: "GET",
    url: "/v1/observability/dashboard?window=7d",
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    window: { label: string };
    total_runs: number;
    successful_runs: number;
    failed_runs: number;
    by_kind: Record<string, number>;
  };
  assert.equal(body.window.label, "7d");
  assert.equal(body.total_runs, 3);
  assert.equal(body.successful_runs, 2);
  assert.equal(body.failed_runs, 1);
  // by_kind keys are the PascalCase Debug repr.
  assert.equal(body.by_kind.Tool, 2);
  assert.equal(body.by_kind.Agent, 1);
  await app.close();
});

test("dashboard defaults the window label to 24h", async () => {
  const obs = new MemoryObservabilityStore();
  const app = await buildApp(emptyState({ observability: obs }));
  const res = await app.inject({ method: "GET", url: "/v1/observability/dashboard" });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as { window: { label: string } }).window.label, "24h");
  await app.close();
});

// ---------- runs (filtering + limit) ----------

test("runs returns matching rows and applies kind/outcome filters", async () => {
  const obs = new MemoryObservabilityStore();
  await obs.appendRun(run("fs.read", "tool", "success", 10));
  await obs.appendRun(run("shell.exec", "tool", "error", 50));
  await obs.appendRun(run("jarvis.agent.run", "agent", "success", 900));
  const app = await buildApp(emptyState({ observability: obs }));

  const all = await app.inject({ method: "GET", url: "/v1/observability/runs" });
  assert.equal(all.statusCode, 200);
  assert.equal((all.json() as { runs: ObservedRun[] }).runs.length, 3);

  const tools = await app.inject({ method: "GET", url: "/v1/observability/runs?kind=tool" });
  assert.equal((tools.json() as { runs: ObservedRun[] }).runs.length, 2);

  const errors = await app.inject({
    method: "GET",
    url: "/v1/observability/runs?outcome=error",
  });
  const errRows = (errors.json() as { runs: ObservedRun[] }).runs;
  assert.equal(errRows.length, 1);
  assert.equal(errRows[0]?.name, "shell.exec");
  await app.close();
});

// ---------- tools / subagents summary ----------

test("tools summary groups by name and computes rates / averages", async () => {
  const obs = new MemoryObservabilityStore();
  await obs.appendRun(run("fs.read", "tool", "success", 10, { output_bytes: 100 }));
  await obs.appendRun(run("fs.read", "tool", "error", 30, { output_bytes: 300 }));
  await obs.appendRun(run("shell.exec", "tool", "success", 20));
  const app = await buildApp(emptyState({ observability: obs }));

  const res = await app.inject({ method: "GET", url: "/v1/observability/tools" });
  assert.equal(res.statusCode, 200);
  const tools = (res.json() as { tools: Array<Record<string, unknown>> }).tools;
  const fs = tools.find((t) => t.name === "fs.read") as Record<string, unknown>;
  assert.equal(fs.runs, 2);
  assert.equal(fs.success, 1);
  assert.equal(fs.errors, 1);
  assert.equal(fs.success_rate, 0.5);
  assert.equal(fs.median_duration_ms, 30);
  assert.equal(fs.avg_output_bytes, 200);
  // Sort: fs.read (1 error) before shell.exec (0 errors).
  assert.equal(tools[0]?.name, "fs.read");
  await app.close();
});

test("subagents summary uses the subagents key", async () => {
  const obs = new MemoryObservabilityStore();
  await obs.appendRun(run("claude_code", "subagent", "success", 5000));
  const app = await buildApp(emptyState({ observability: obs }));
  const res = await app.inject({ method: "GET", url: "/v1/observability/subagents" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { subagents: Array<{ name: string }> };
  assert.equal(body.subagents.length, 1);
  assert.equal(body.subagents[0]?.name, "claude_code");
  await app.close();
});

// ---------- direction ----------

test("direction prioritizes low eval coverage and recommends expanding evals", async () => {
  const obs = new MemoryObservabilityStore();
  await obs.appendRun(run("jarvis.agent.run", "agent", "success", 1000));
  await obs.appendRun(run("fs.read", "tool", "success", 10, { output_bytes: 100 }));
  const evals = new MemoryEvalStore(); // present but empty → 0 coverage
  const app = await buildApp(emptyState({ observability: obs, evals }));

  const res = await app.inject({ method: "GET", url: "/v1/observability/direction" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    primary_focus: string;
    recommendations: Array<{ key: string }>;
    sample: { eval_cases: number | null };
  };
  assert.equal(body.primary_focus, "verification");
  assert.ok(body.recommendations.some((r) => r.key === "expand_eval_coverage"));
  assert.equal(body.sample.eval_cases, 0);
  await app.close();
});

test("direction works with no eval store (eval_cases sample is null)", async () => {
  const obs = new MemoryObservabilityStore();
  await obs.appendRun(run("jarvis.agent.run", "agent", "success", 1000));
  const app = await buildApp(emptyState({ observability: obs }));
  const res = await app.inject({ method: "GET", url: "/v1/observability/direction" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { sample: { eval_cases: number | null } };
  assert.equal(body.sample.eval_cases, null);
  await app.close();
});

// ---------- capability-score ----------

test("capability-score caps overall when delivery is weak", async () => {
  const obs = new MemoryObservabilityStore();
  await obs.appendRun(run("jarvis.agent.run", "agent", "timeout", 300_000));
  await obs.appendRun(run("fs.read", "tool", "success", 20, { output_bytes: 100 }));
  const evals = new MemoryEvalStore();
  await evals.saveCaseResult(evalCase("case-1", "regression", 0, "error"));
  const runs = new MemoryRequirementRunStore();
  await runs.upsert(requirementRun("failed", "agent timed out after 300000ms"));
  await runs.upsert(
    requirementRun("failed", "agent reached max iterations (30) without terminating"),
  );

  const app = await buildApp(
    emptyState({ observability: obs, evals, requirementRuns: runs }),
  );
  const res = await app.inject({
    method: "GET",
    url: "/v1/observability/capability-score",
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    overall_score: number;
    dimensions: Array<{ key: string; score: number; evidence: Array<{ detail: string }> }>;
  };
  assert.ok(body.overall_score <= 69);
  const delivery = body.dimensions.find((d) => d.key === "task_delivery");
  assert.ok(delivery !== undefined && delivery.score < 60);
  const planning = body.dimensions.find((d) => d.key === "planning_execution");
  assert.ok(planning?.evidence.some((e) => e.detail.includes("timed out")));
  await app.close();
});

// ---------- eval summary + cases ----------

test("evals summary splits suite kind and computes trial reliability", async () => {
  const evals = new MemoryEvalStore();
  await evals.saveCaseResult(evalCase("case-1", "regression", 0, "success"));
  await evals.saveCaseResult(evalCase("case-1", "regression", 1, "error"));
  await evals.saveCaseResult(evalCase("case-2", "capability", 0, "error"));
  const app = await buildApp(emptyState({ evals }));

  const res = await app.inject({ method: "GET", url: "/v1/evals/summary" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    total_cases: number;
    regression_pass_rate: number;
    capability_pass_rate: number;
    trial_reliability: { task_groups: number; pass_at_k: number; pass_all: number };
    transcript_cases: number;
    by_grader_kind: Record<string, number>;
  };
  assert.equal(body.total_cases, 3);
  assert.equal(body.regression_pass_rate, 0.5);
  assert.equal(body.capability_pass_rate, 0.0);
  assert.equal(body.trial_reliability.task_groups, 2);
  assert.equal(body.trial_reliability.pass_at_k, 0.5);
  assert.equal(body.trial_reliability.pass_all, 0.0);
  assert.equal(body.transcript_cases, 3);
  assert.equal(body.by_grader_kind.deterministic_test, 3);
  await app.close();
});

test("evals cases honours suite_kind + outcome filters", async () => {
  const evals = new MemoryEvalStore();
  await evals.saveCaseResult(evalCase("case-1", "regression", 0, "success"));
  await evals.saveCaseResult(evalCase("case-2", "capability", 0, "error"));
  const app = await buildApp(emptyState({ evals }));

  const all = await app.inject({ method: "GET", url: "/v1/evals/cases" });
  assert.equal((all.json() as { cases: EvalCaseResult[] }).cases.length, 2);

  const reg = await app.inject({
    method: "GET",
    url: "/v1/evals/cases?suite_kind=regression",
  });
  const regCases = (reg.json() as { cases: EvalCaseResult[] }).cases;
  assert.equal(regCases.length, 1);
  assert.equal(regCases[0]?.case_id, "case-1");

  const errs = await app.inject({ method: "GET", url: "/v1/evals/cases?outcome=error" });
  assert.equal((errs.json() as { cases: EvalCaseResult[] }).cases.length, 1);
  await app.close();
});

// ---------- health (REST mirror of harness.health) ----------

test("health summarises requirement-run signals", async () => {
  const runs = new MemoryRequirementRunStore();
  const good = requirementRun("completed", undefined, {
    status: "passed",
    command_results: [],
  });
  await runs.upsert(good);
  const failed = requirementRun("failed", "agent timed out after 300000ms");
  await runs.upsert(failed);

  const app = await buildApp(emptyState({ requirementRuns: runs }));
  const res = await app.inject({
    method: "GET",
    url: "/v1/observability/health?limit=20&include_evidence=true",
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    tool: string;
    overall_score: number;
    sources: { requirement_runs: { rows: number; configured: boolean } };
    signals: { failed_requirement_runs: number };
    actions: unknown[];
    evidence: unknown[];
  };
  assert.equal(body.tool, "harness.health");
  assert.equal(body.sources.requirement_runs.rows, 2);
  assert.equal(body.sources.requirement_runs.configured, true);
  assert.equal(body.signals.failed_requirement_runs, 1);
  assert.ok(body.overall_score <= 69);
  assert.ok(body.actions.length > 0);
  assert.ok(body.evidence.length > 0);
  await app.close();
});

test("health reports unconfigured sources and omits evidence when disabled", async () => {
  const obs = new MemoryObservabilityStore();
  await obs.appendRun(run("fs.read", "tool", "success", 10));
  const app = await buildApp(emptyState({ observability: obs }));
  const res = await app.inject({
    method: "GET",
    url: "/v1/observability/health?include_evidence=false",
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    sources: {
      observability: { configured: boolean; rows: number };
      evals: { configured: boolean };
      requirement_runs: { configured: boolean };
    };
    evidence: unknown[];
  };
  assert.equal(body.sources.observability.configured, true);
  assert.equal(body.sources.observability.rows, 1);
  assert.equal(body.sources.evals.configured, false);
  assert.equal(body.sources.requirement_runs.configured, false);
  assert.equal(body.evidence.length, 0);
  await app.close();
});
