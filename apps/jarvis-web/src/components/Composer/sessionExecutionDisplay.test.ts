import { describe, expect, it } from "vitest";
import {
  buildSessionExecutionDisplay,
  formatElapsed,
  pickPrimaryRequirement,
  type ConversationWorkContext,
} from "./sessionExecutionDisplay";
import type {
  Activity,
  Requirement,
  RequirementRun,
  VerificationResult,
} from "../../types/frames";

const NOW = Date.parse("2026-05-05T12:00:00Z");

function req(over: Partial<Requirement> = {}): Requirement {
  return {
    id: "req-12345678",
    project_id: "proj-1",
    title: "Optimize settings page i18n",
    description: null,
    status: "in_progress",
    conversation_ids: ["conv-a"],
    created_at: "2026-05-05T11:00:00Z",
    updated_at: "2026-05-05T11:30:00Z",
    ...over,
  };
}

function run(over: Partial<RequirementRun> = {}): RequirementRun {
  return {
    id: "run-1",
    requirement_id: "req-12345678",
    conversation_id: "conv-a",
    status: "running",
    summary: null,
    error: null,
    verification: null,
    started_at: "2026-05-05T11:58:23Z",
    finished_at: null,
    ...over,
  };
}

function verify(over: Partial<VerificationResult> = {}): VerificationResult {
  return { status: "passed", ...over };
}

function ctx(over: Partial<ConversationWorkContext>): ConversationWorkContext {
  return {
    conversationId: "conv-a",
    projectId: "proj-1",
    requirement: null,
    latestRun: null,
    recentActivities: [],
    ...over,
  };
}

describe("formatElapsed", () => {
  it("renders sub-minute as Ns", () => {
    expect(formatElapsed(45_000)).toBe("45s");
    expect(formatElapsed(0)).toBe("0s");
  });
  it("renders minutes with seconds zero-padded", () => {
    expect(formatElapsed(60_000)).toBe("1m00s");
    expect(formatElapsed(97_000)).toBe("1m37s");
  });
  it("renders hours and minutes only", () => {
    expect(formatElapsed(3_600_000)).toBe("1h00m");
    expect(formatElapsed(2 * 3_600_000 + 5 * 60_000 + 30_000)).toBe("2h05m");
  });
  it("clamps negative or NaN to 0s", () => {
    expect(formatElapsed(-100)).toBe("0s");
    expect(formatElapsed(NaN)).toBe("0s");
  });
});

describe("buildSessionExecutionDisplay", () => {
  it("returns null when no requirement is bound (Free chat)", () => {
    expect(buildSessionExecutionDisplay(ctx({}), NOW)).toBeNull();
  });

  it("backlog requirement with no run shows Ready", () => {
    const out = buildSessionExecutionDisplay(
      ctx({ requirement: req({ status: "backlog" }) }),
      NOW,
    );
    expect(out?.statusLabel).toBe("Ready · not started");
    expect(out?.tone).toBe("neutral");
  });

  it("pending run shows Queued", () => {
    const out = buildSessionExecutionDisplay(
      ctx({
        requirement: req(),
        latestRun: run({ status: "pending" }),
      }),
      NOW,
    );
    expect(out?.statusLabel).toBe("Queued");
    expect(out?.tone).toBe("neutral");
  });

  it("running run shows elapsed", () => {
    const out = buildSessionExecutionDisplay(
      ctx({
        requirement: req(),
        latestRun: run({ status: "running" }),
      }),
      NOW,
    );
    expect(out?.statusLabel).toBe("Running · 1m37s");
    expect(out?.tone).toBe("running");
  });

  it("completed + verification passed shows Passed", () => {
    const out = buildSessionExecutionDisplay(
      ctx({
        requirement: req(),
        latestRun: run({ status: "completed", verification: verify({ status: "passed" }) }),
      }),
      NOW,
    );
    expect(out?.statusLabel).toBe("Passed");
    expect(out?.tone).toBe("success");
    expect(out?.actionLabel).toBe("View record");
  });

  it("completed + verification failed surfaces the failing command", () => {
    const out = buildSessionExecutionDisplay(
      ctx({
        requirement: req(),
        latestRun: run({
          status: "completed",
          verification: verify({
            status: "failed",
            command_results: [
              { command: "cargo check", exit_code: 0, duration_ms: 120 },
              { command: "cargo clippy", exit_code: 101, duration_ms: 220 },
            ],
          }),
        }),
      }),
      NOW,
    );
    expect(out?.statusLabel).toBe("Failed");
    expect(out?.detailLabel).toBe("cargo clippy");
    expect(out?.tone).toBe("danger");
    expect(out?.actionLabel).toBe("View logs");
  });

  it("verification needs_review shows Needs review with warning tone", () => {
    const out = buildSessionExecutionDisplay(
      ctx({
        requirement: req(),
        latestRun: run({
          status: "completed",
          verification: verify({ status: "needs_review" }),
        }),
      }),
      NOW,
    );
    expect(out?.statusLabel).toBe("Needs review");
    expect(out?.tone).toBe("warning");
  });

  it("run failed surfaces error preview", () => {
    const out = buildSessionExecutionDisplay(
      ctx({
        requirement: req(),
        latestRun: run({ status: "failed", error: "compiler error: missing semi" }),
      }),
      NOW,
    );
    expect(out?.statusLabel).toBe("Failed");
    expect(out?.detailLabel).toContain("compiler error");
  });

  it("run cancelled surfaces Retry action", () => {
    const out = buildSessionExecutionDisplay(
      ctx({
        requirement: req(),
        latestRun: run({ status: "cancelled" }),
      }),
      NOW,
    );
    expect(out?.statusLabel).toBe("Cancelled");
    expect(out?.actionLabel).toBe("Retry");
  });

  it("requirement in review state takes precedence over the run row", () => {
    const out = buildSessionExecutionDisplay(
      ctx({
        requirement: req({ status: "review" }),
        latestRun: run({
          status: "completed",
          verification: verify({ status: "needs_review" }),
        }),
      }),
      NOW,
    );
    expect(out?.statusLabel).toBe("Review");
    expect(out?.detailLabel).toBe("Needs review");
  });

  it("requirement done shows Done with success tone", () => {
    const out = buildSessionExecutionDisplay(
      ctx({
        requirement: req({ status: "done" }),
        latestRun: run({
          status: "completed",
          verification: verify({ status: "passed" }),
        }),
      }),
      NOW,
    );
    expect(out?.statusLabel).toBe("Done");
    expect(out?.tone).toBe("success");
  });

  it("zh language returns the Chinese strings from the spec", () => {
    const out = buildSessionExecutionDisplay(
      ctx({
        requirement: req(),
        latestRun: run({ status: "running" }),
      }),
      NOW,
      "zh",
    );
    expect(out?.statusLabel).toBe("执行中 · 1m37s");
  });
});

describe("pickPrimaryRequirement", () => {
  const reqA = req({ id: "req-aaaa", updated_at: "2026-05-05T10:00:00Z" });
  const reqB = req({ id: "req-bbbb", updated_at: "2026-05-05T11:00:00Z" });
  const reqC = req({ id: "req-cccc", updated_at: "2026-05-05T11:00:00Z" });

  it("returns null on empty input", () => {
    expect(pickPrimaryRequirement([], {}, "conv-a")).toBeNull();
  });

  it("returns the only candidate trivially", () => {
    expect(pickPrimaryRequirement([reqA], {}, "conv-a")?.id).toBe("req-aaaa");
  });

  it("prefers a requirement with a live (running/pending) run", () => {
    const winner = pickPrimaryRequirement(
      [reqA, reqB],
      {
        "req-aaaa": [run({ requirement_id: "req-aaaa", status: "completed" })],
        "req-bbbb": [run({ requirement_id: "req-bbbb", status: "running" })],
      },
      "conv-a",
    );
    expect(winner?.id).toBe("req-bbbb");
  });

  it("falls back to newest updated_at when no live runs", () => {
    const winner = pickPrimaryRequirement([reqA, reqB], {}, "conv-a");
    expect(winner?.id).toBe("req-bbbb");
  });

  it("breaks updated_at ties by last conversation_ids index", () => {
    const winner = pickPrimaryRequirement(
      [
        { ...reqB, conversation_ids: ["conv-a"] },
        { ...reqC, conversation_ids: ["x", "conv-a", "y"] },
      ],
      {},
      "conv-a",
    );
    expect(winner?.id).toBe("req-cccc");
  });
});

// activities are rendered in the drawer; we only check that they
// pass through the context shape unchanged.
describe("ConversationWorkContext (passthrough)", () => {
  it("carries activities through verbatim", () => {
    const a: Activity = {
      id: "act-1",
      requirement_id: "req-12345678",
      kind: "run_started",
      actor: { type: "system" },
      body: { run_id: "run-1" },
      created_at: "2026-05-05T11:58:23Z",
    };
    const out = buildSessionExecutionDisplay(
      ctx({
        requirement: req(),
        latestRun: run(),
        recentActivities: [a],
      }),
      NOW,
    );
    expect(out).not.toBeNull();
  });
});
