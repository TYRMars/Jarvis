// Hint-table contract tests for the WorkOverview Issues panel.
//
// The producer side of these strings is in
// `crates/harness-server/src/auto_mode.rs:1297-1298`. If those error
// formats ever change, these tests should fail loudly so the hint
// regexes get updated together.

import { describe, it, expect } from "vitest";
import { aggregateIssues } from "./issueAggregator";
import type { RecentFailureRow } from "./workOverview";

function failure(error: string, overrides: Partial<RecentFailureRow> = {}): RecentFailureRow {
  return {
    id: "run-test",
    requirement_id: "req-test",
    requirement_title: "test req",
    project_id: null,
    project_name: null,
    error,
    finished_at: "2026-05-07T12:00:00Z",
    conversation_id: "conv-test",
    ...overrides,
  };
}

function hintFor(error: string): string | undefined {
  const issues = aggregateIssues({
    failures: [failure(error)],
    orphans: [],
    stuck: [],
  });
  expect(issues).toHaveLength(1);
  return issues[0].hint;
}

describe("issueAggregator: timeout hint disambiguation", () => {
  it("auto-mode wall-clock timeout points to JARVIS_WORK_RUN_TIMEOUT_MS", () => {
    const hint = hintFor("agent timed out after 300000ms");
    expect(hint).toContain("JARVIS_WORK_RUN_TIMEOUT_MS");
    expect(hint).toContain("budget");
    expect(hint).not.toContain("upstream provider");
  });

  it("upstream reqwest timeout points to provider status, not the env var", () => {
    const hint = hintFor(
      "agent error: provider error: error sending request: operation timed out",
    );
    expect(hint).toContain("upstream provider");
    expect(hint).toContain("JARVIS_PROVIDER");
    expect(hint).not.toContain("JARVIS_WORK_RUN_TIMEOUT_MS budget");
  });

  it("HTTP 504 falls into the upstream catch-all", () => {
    const hint = hintFor("agent error: provider error: 504 Gateway Timeout");
    expect(hint).toContain("upstream provider");
  });

  it("anchored own-timeout pattern does not match if context is appended", () => {
    // Documents the anchor decision: if someone ever loosens the
    // auto_mode wording (e.g. appends a reason), this test will start
    // returning the catch-all hint — at which point both producer and
    // pattern 1 should be updated together.
    const hint = hintFor("agent timed out after 5000ms while processing X");
    expect(hint).toContain("upstream provider");
  });

  it("two failures in one batch each get their own hint", () => {
    const issues = aggregateIssues({
      failures: [
        failure("agent timed out after 5000ms"),
        failure("agent error: provider error: read timed out", { id: "run-2" }),
      ],
      orphans: [],
      stuck: [],
    });
    expect(issues).toHaveLength(2);
    const hints = issues.map((i) => i.hint ?? "");
    // Use substrings unique to each hint — `budget` only appears in
    // the own-timeout hint, `upstream provider` only in the catch-all.
    expect(hints.some((h) => h.includes("budget"))).toBe(true);
    expect(hints.some((h) => h.includes("upstream provider"))).toBe(true);
  });
});

describe("issueAggregator: existing hints still resolve", () => {
  // Round-trip sanity check that the HINTS table contract didn't
  // shift — picks one entry that predates this change.
  it("401 / unauthorized routes to `jarvis login`", () => {
    const hint = hintFor("agent error: provider error: 401 unauthorized");
    expect(hint).toContain("jarvis login");
  });
});
