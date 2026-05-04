// Static UI prototype for the subagent visualisation. Shows both
// surfaces side-by-side with mocked frame data so the team can see
// the design before any backend is wired in. Reachable at
// `/demo/subagent` — not linked from the main nav, intentional, this
// is a preview-only route.
//
// Three runs are simulated:
//   1. `subagent.review` — done (passed). Full timeline visible.
//   2. `subagent.read_doc` — done (passed). Smaller timeline.
//   3. `subagent.claude_code` — running, streaming frames every
//      ~700ms so the user can watch the inline card update live.
//
// Once the real WS event stream lands the same components consume
// real frames; this page just won't be reachable.

import { useEffect, useMemo, useState } from "react";
import { t } from "../../utils/i18n";
import { SubAgentCard } from "./SubAgentCard";
import { SubAgentRail } from "./SubAgentRail";
import {
  applyFrame,
  emptyRun,
  type SubAgentFrame,
  type SubAgentRun,
} from "./types";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

// ---- Static "completed" runs ----------------------------------------

const NOW = Date.now();

const REVIEW_RUN: SubAgentRun = {
  id: "demo-review-1",
  name: "review",
  task: "Verify the kanban renders all four columns and persists drag-drop.",
  model: "claude-sonnet-4-6",
  startedAt: NOW - 25_000,
  endedAt: NOW - 13_000,
  status: "done",
  finalMessage: "Pass. Verification plan satisfied; 0 regressions.",
  timeline: [
    {
      kind: "tool",
      name: "fs.read",
      args: { path: "apps/jarvis-web/src/components/Projects/ProjectBoard.tsx" },
      output: "12kb",
      tStart: NOW - 24_000,
      tEnd: NOW - 22_500,
    },
    {
      kind: "tool",
      name: "code.grep",
      args: { pattern: "RequirementStatus", path: "apps/jarvis-web/src" },
      output: "9 matches across 3 files",
      tStart: NOW - 22_000,
      tEnd: NOW - 20_500,
    },
    { kind: "status", message: "Running cargo test for harness-core...", t: NOW - 20_000 },
    {
      kind: "tool",
      name: "shell.exec",
      args: { command: "cargo test -p harness-core" },
      output: "test result: ok. 167 passed; 0 failed",
      tStart: NOW - 19_500,
      tEnd: NOW - 14_500,
    },
    {
      kind: "tool",
      name: "requirement.review_verdict",
      args: { verdict: "pass", commentary: "All four kanban columns render; drag-drop persists." },
      output: "verdict recorded",
      tStart: NOW - 14_000,
      tEnd: NOW - 13_000,
    },
  ],
};

const READ_DOC_RUN: SubAgentRun = {
  id: "demo-read-1",
  name: "read_doc",
  task: "Find the description of `verification_plan` in the work-orchestration proposal.",
  model: "claude-haiku-4-5",
  startedAt: NOW - 90_000,
  endedAt: NOW - 84_000,
  status: "done",
  finalMessage:
    "verification_plan: optional VerificationPlan template auto mode fires after each RequirementRun. " +
    "See docs/proposals/work-orchestration.zh-CN.md:Phase 6.",
  timeline: [
    {
      kind: "tool",
      name: "code.grep",
      args: { pattern: "verification_plan", path: "docs/proposals" },
      output: "4 matches in work-orchestration.zh-CN.md",
      tStart: NOW - 89_000,
      tEnd: NOW - 87_500,
    },
    {
      kind: "tool",
      name: "fs.read",
      args: { path: "docs/proposals/work-orchestration.zh-CN.md", limit: 200 },
      output: "...",
      tStart: NOW - 87_000,
      tEnd: NOW - 84_500,
    },
  ],
};

// ---- Live mock for the running run ---------------------------------

/// A scripted sequence of frames played out over time so the user
/// can watch the inline card animate. Each frame is delayed from
/// the start of the demo by `at` ms.
const CLAUDE_CODE_SCRIPT: { at: number; frame: SubAgentFrame }[] = [
  {
    at: 0,
    frame: {
      subagent_id: "demo-cc-1",
      subagent_name: "claude_code",
      event: {
        kind: "started",
        task: "Refactor fs.patch's multi-file split logic into a standalone function with unit tests.",
        model: "claude-sonnet-4-6",
      },
    },
  },
  {
    at: 600,
    frame: {
      subagent_id: "demo-cc-1",
      subagent_name: "claude_code",
      event: { kind: "status", message: "Loading workspace context..." },
    },
  },
  {
    at: 1200,
    frame: {
      subagent_id: "demo-cc-1",
      subagent_name: "claude_code",
      event: {
        kind: "tool_start",
        name: "fs.read",
        arguments: { path: "crates/harness-tools/src/fs/patch.rs" },
      },
    },
  },
  {
    at: 2200,
    frame: {
      subagent_id: "demo-cc-1",
      subagent_name: "claude_code",
      event: { kind: "tool_end", name: "fs.read", output: "248 lines" },
    },
  },
  {
    at: 2700,
    frame: {
      subagent_id: "demo-cc-1",
      subagent_name: "claude_code",
      event: {
        kind: "tool_start",
        name: "code.grep",
        arguments: { pattern: "split_multi_file", path: "crates/harness-tools" },
      },
    },
  },
  {
    at: 3500,
    frame: {
      subagent_id: "demo-cc-1",
      subagent_name: "claude_code",
      event: { kind: "tool_end", name: "code.grep", output: "0 matches" },
    },
  },
  {
    at: 4000,
    frame: {
      subagent_id: "demo-cc-1",
      subagent_name: "claude_code",
      event: {
        kind: "delta",
        text: "Plan: extract the diff-block splitter into a `split_diff_blocks(input: &str) -> Vec<DiffBlock>` function. ",
      },
    },
  },
  {
    at: 4400,
    frame: {
      subagent_id: "demo-cc-1",
      subagent_name: "claude_code",
      event: {
        kind: "delta",
        text: "Then add 3 tests: single-file diff, multi-file diff, malformed header.",
      },
    },
  },
  {
    at: 5400,
    frame: {
      subagent_id: "demo-cc-1",
      subagent_name: "claude_code",
      event: {
        kind: "tool_start",
        name: "fs.edit",
        arguments: { path: "crates/harness-tools/src/fs/patch.rs", lines: "+47" },
      },
    },
  },
];

// ---- Component ------------------------------------------------------

export function SubAgentDemoPage() {
  const [liveRun, setLiveRun] = useState<SubAgentRun>(() =>
    emptyRun("demo-cc-1", "claude_code"),
  );

  // Replay the script. Re-runs whenever the user clicks "restart".
  const [replayKey, setReplayKey] = useState(0);
  useEffect(() => {
    setLiveRun(emptyRun("demo-cc-1", "claude_code"));
    const timeouts: number[] = [];
    for (const step of CLAUDE_CODE_SCRIPT) {
      const id = window.setTimeout(() => {
        setLiveRun((r) => applyFrame(r, step.frame, Date.now()));
      }, step.at);
      timeouts.push(id);
    }
    return () => {
      timeouts.forEach((id) => window.clearTimeout(id));
    };
  }, [replayKey]);

  const allRuns = useMemo<SubAgentRun[]>(
    () => [REVIEW_RUN, READ_DOC_RUN, liveRun],
    [liveRun],
  );

  return (
    <main id="subagent-demo" className="subagent-demo-page">
      <header className="subagent-demo-head">
        <h1>{tx("subagentDemoTitle", "SubAgent UI preview")}</h1>
        <p className="text-soft">
          {tx(
            "subagentDemoSubtitle",
            "Static prototype rendered with mocked frames — once the backend lands, the same components consume real WS events.",
          )}
        </p>
        <div className="subagent-demo-actions">
          <button
            type="button"
            className="settings-btn"
            onClick={() => setReplayKey((k) => k + 1)}
          >
            {tx("subagentDemoReplay", "Replay live run")}
          </button>
        </div>
      </header>

      <div className="subagent-demo-grid">
        <section className="subagent-demo-stream">
          <h2>{tx("subagentDemoStreamTitle", "Inline cards (in main agent stream)")}</h2>
          <p className="subagent-demo-mock-msg">
            {tx(
              "subagentDemoUserMsg",
              "User: refactor fs.patch's split logic and verify with tests.",
            )}
          </p>
          <p className="subagent-demo-assistant-msg">
            {tx(
              "subagentDemoAssistantMsg",
              "Assistant: I'll delegate to a coding subagent. While that runs I'll have the reviewer check the kanban work in parallel.",
            )}
          </p>

          <SubAgentCard run={liveRun} />
          <SubAgentCard run={REVIEW_RUN} />
          <SubAgentCard run={READ_DOC_RUN} />

          <p className="subagent-demo-assistant-msg">
            {tx(
              "subagentDemoFinalMsg",
              "Assistant: review passed; the docs reader confirmed the existing helper. Coding subagent is still running — I'll show you the diff once it returns.",
            )}
          </p>
        </section>

        <section className="subagent-demo-rail">
          <h2>{tx("subagentDemoRailTitle", "Side-panel (workspace rail)")}</h2>
          <SubAgentRail runs={allRuns} />
        </section>
      </div>
    </main>
  );
}
