// Unit tests for the `requirement.*` tool family. Ported from the
// `#[cfg(test)] mod tests` block in crates/harness-tools/src/requirement.rs.
//
// Uses MemoryRequirementStore / MemoryActivityStore from @jarvis/store as
// fixtures. Activity insertion order is captured via a subscription collector
// (the Memory store's `listForRequirement` sorts newest-first by timestamp,
// which is ambiguous for same-millisecond rows — the event stream preserves
// arrival order deterministically).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Tool } from "@jarvis/core";
import type { Activity, ActivityEvent } from "@jarvis/project";
import { newRequirement } from "@jarvis/project";
import { MemoryActivityStore, MemoryRequirementStore } from "@jarvis/store";

import {
  RequirementBlockTool,
  RequirementCompleteTool,
  RequirementCreateTool,
  RequirementDeleteTool,
  RequirementListTool,
  RequirementReviewVerdictTool,
  RequirementStartTool,
  RequirementUpdateTool,
} from "./requirement-tools.ts";

// ---------- fixtures ----------

/**
 * Collects appended Activity rows in arrival order (the Rust `snapshot()`
 * returns insertion order; the Memory store's `listForRequirement` sorts
 * newest-first which is unstable within a single tool call).
 */
class ActivityCollector {
  readonly rows: Activity[] = [];
  constructor(store: MemoryActivityStore) {
    store.subscribe((ev: ActivityEvent) => {
      const { type: _t, ...activity } = ev;
      void _t;
      this.rows.push(activity as Activity);
    });
  }
}

function fixtures(): {
  rs: MemoryRequirementStore;
  acts: MemoryActivityStore;
  timeline: ActivityCollector;
} {
  const rs = new MemoryRequirementStore();
  const acts = new MemoryActivityStore();
  const timeline = new ActivityCollector(acts);
  return { rs, acts, timeline };
}

async function seed(
  store: MemoryRequirementStore,
  projectId: string,
  title: string,
): Promise<{ id: string }> {
  const r = newRequirement(projectId, title);
  await store.upsert(r);
  return { id: r.id };
}

function parse(out: string): Record<string, unknown> {
  return JSON.parse(out) as Record<string, unknown>;
}

// ---------- requirement.list ----------

test("list returns only matching project", async () => {
  const { rs } = fixtures();
  await seed(rs, "p-a", "alpha");
  await seed(rs, "p-a", "beta");
  await seed(rs, "p-b", "gamma");
  const tool = new RequirementListTool(rs);
  const out = parse(await tool.invoke({ project_id: "p-a" }));
  assert.equal(out["count"], 2);
  const items = out["items"] as Array<{ title: string }>;
  const titles = items.map((i) => i.title);
  assert.ok(titles.includes("alpha"));
  assert.ok(titles.includes("beta"));
  assert.ok(!titles.includes("gamma"));
});

test("list filters by status", async () => {
  const { rs, acts } = fixtures();
  const r1 = await seed(rs, "p", "open");
  await seed(rs, "p", "still-open");
  const start = new RequirementStartTool(rs, acts);
  await start.invoke({ id: r1.id });

  const list = new RequirementListTool(rs);
  const inProg = parse(await list.invoke({ project_id: "p", status: "in_progress" }));
  assert.equal(inProg["count"], 1);
  assert.equal((inProg["items"] as Array<{ title: string }>)[0].title, "open");

  const backlog = parse(await list.invoke({ project_id: "p", status: "backlog" }));
  assert.equal(backlog["count"], 1);
  assert.equal((backlog["items"] as Array<{ title: string }>)[0].title, "still-open");
});

test("list rejects blank project_id", async () => {
  const { rs } = fixtures();
  const tool = new RequirementListTool(rs);
  await assert.rejects(() => tool.invoke({ project_id: "   " }), /blank/);
});

test("list rejects unknown status", async () => {
  const { rs } = fixtures();
  const tool = new RequirementListTool(rs);
  await assert.rejects(() => tool.invoke({ project_id: "p", status: "zomg" }), /unknown status/);
});

test("list clamps a negative limit to >=1 instead of dropping the last row", async () => {
  const { rs } = fixtures();
  await seed(rs, "p", "one");
  await seed(rs, "p", "two");
  await seed(rs, "p", "three");
  const tool = new RequirementListTool(rs);
  // Schema declares `minimum: 1`; a negative limit must not reach
  // `slice(0, -1)` (which would silently drop the last row).
  const out = parse(await tool.invoke({ project_id: "p", limit: -1 }));
  assert.equal(out["count"], 1);
  assert.equal((out["items"] as Array<{ title: string }>).length, 1);
});

test("list clamps a zero limit to >=1", async () => {
  const { rs } = fixtures();
  await seed(rs, "p", "one");
  await seed(rs, "p", "two");
  const tool = new RequirementListTool(rs);
  const out = parse(await tool.invoke({ project_id: "p", limit: 0 }));
  assert.equal(out["count"], 1);
});

// ---------- requirement.start ----------

test("start flips backlog to in_progress and records activity", async () => {
  const { rs, acts, timeline } = fixtures();
  const r = await seed(rs, "p", "build it");
  const start = new RequirementStartTool(rs, acts);
  const out = parse(await start.invoke({ id: r.id }));
  assert.equal(out["status"], "in_progress");

  assert.equal(timeline.rows.length, 1);
  assert.equal(timeline.rows[0].kind, "status_change");
  const body = timeline.rows[0].body as Record<string, unknown>;
  assert.equal(body["from"], "backlog");
  assert.equal(body["to"], "in_progress");
  // Tool-driven mutations record actor as Agent with placeholder.
  assert.deepEqual(timeline.rows[0].actor, { type: "agent", profile_id: "tool" });
});

test("start with note records comment", async () => {
  const { rs, acts, timeline } = fixtures();
  const r = await seed(rs, "p", "x");
  const start = new RequirementStartTool(rs, acts);
  await start.invoke({ id: r.id, note: "picking this up" });
  // status_change + comment.
  assert.equal(timeline.rows.length, 2);
  assert.ok(
    timeline.rows.some(
      (a) => a.kind === "comment" && (a.body as Record<string, unknown>)["text"] === "picking this up",
    ),
  );
});

test("start idempotent when already in_progress", async () => {
  const { rs, acts, timeline } = fixtures();
  const r = await seed(rs, "p", "x");
  const start = new RequirementStartTool(rs, acts);
  await start.invoke({ id: r.id });
  const before = timeline.rows.length;
  await start.invoke({ id: r.id });
  assert.equal(timeline.rows.length, before);
});

test("start errors on done", async () => {
  const { rs, acts } = fixtures();
  const r = newRequirement("p", "x");
  r.status = "done";
  await rs.upsert(r);
  const start = new RequirementStartTool(rs, acts);
  await assert.rejects(() => start.invoke({ id: r.id }), /already `done`/);
});

test("start errors on unknown id", async () => {
  const { rs, acts } = fixtures();
  const start = new RequirementStartTool(rs, acts);
  await assert.rejects(() => start.invoke({ id: "no-such" }), /not found/);
});

// ---------- requirement.block ----------

test("block records activity without status change", async () => {
  const { rs, acts, timeline } = fixtures();
  const r = await seed(rs, "p", "x");
  const block = new RequirementBlockTool(rs, acts);
  const out = parse(await block.invoke({ id: r.id, reason: "missing design spec" }));
  assert.equal(out["blocked"], true);
  assert.equal(out["reason"], "missing design spec");

  // Status untouched on disk.
  const after = await rs.get(r.id);
  assert.equal(after?.status, "backlog");

  assert.equal(timeline.rows.length, 1);
  assert.equal(timeline.rows[0].kind, "blocked");
  assert.equal((timeline.rows[0].body as Record<string, unknown>)["reason"], "missing design spec");
});

test("block rejects blank reason", async () => {
  const { rs, acts } = fixtures();
  const r = await seed(rs, "p", "x");
  const block = new RequirementBlockTool(rs, acts);
  await assert.rejects(() => block.invoke({ id: r.id, reason: "  " }), /blank/);
});

// ---------- requirement.complete ----------

test("complete flips to review by default", async () => {
  const { rs, acts, timeline } = fixtures();
  const r = await seed(rs, "p", "x");
  const complete = new RequirementCompleteTool(rs, acts);
  const out = parse(await complete.invoke({ id: r.id, summary: "done with X and Y" }));
  assert.equal(out["status"], "review");

  // status_change + completion comment.
  assert.equal(timeline.rows.length, 2);
  assert.ok(
    timeline.rows.some(
      (a) => a.kind === "status_change" && (a.body as Record<string, unknown>)["to"] === "review",
    ),
  );
  assert.ok(
    timeline.rows.some(
      (a) =>
        a.kind === "comment" &&
        (a.body as Record<string, unknown>)["kind"] === "completion_summary",
    ),
  );
});

test("complete never writes done even with auto_complete arg", async () => {
  // Even if a caller smuggles in an `auto_complete: true` field, the tool
  // ignores it and still flips to Review. Final acceptance is structurally
  // human-only.
  const { rs, acts, timeline } = fixtures();
  const r = await seed(rs, "p", "x");
  const complete = new RequirementCompleteTool(rs, acts);
  const out = parse(
    await complete.invoke({ id: r.id, summary: "verification passed", auto_complete: true }),
  );
  assert.equal(out["status"], "review");
  assert.ok(
    !timeline.rows.some(
      (a) => a.kind === "status_change" && (a.body as Record<string, unknown>)["to"] === "done",
    ),
  );
});

test("complete errors on done", async () => {
  const { rs, acts } = fixtures();
  const r = newRequirement("p", "x");
  r.status = "done";
  await rs.upsert(r);
  const complete = new RequirementCompleteTool(rs, acts);
  await assert.rejects(() => complete.invoke({ id: r.id, summary: "x" }), /already `done`/);
});

test("complete skips status change if already in target", async () => {
  const { rs, acts, timeline } = fixtures();
  const r = newRequirement("p", "x");
  r.status = "review";
  await rs.upsert(r);
  const complete = new RequirementCompleteTool(rs, acts);
  await complete.invoke({ id: r.id, summary: "rework finished" });
  // Only the completion comment; no status_change because already in Review.
  assert.equal(timeline.rows.length, 1);
  assert.equal(timeline.rows[0].kind, "comment");
});

// ---------- requirement.review_verdict ----------

test("review_verdict pass flips review to done", async () => {
  const { rs, acts, timeline } = fixtures();
  const r = newRequirement("p", "x");
  r.status = "review";
  await rs.upsert(r);
  const verdict = new RequirementReviewVerdictTool(rs, acts);
  const out = parse(
    await verdict.invoke({ id: r.id, verdict: "pass", commentary: "looks good", evidence: ["ran tests"] }),
  );
  assert.equal(out["status"], "done");

  assert.equal(timeline.rows.length, 2);
  assert.ok(
    timeline.rows.some(
      (a) =>
        a.kind === "status_change" &&
        (a.body as Record<string, unknown>)["from"] === "review" &&
        (a.body as Record<string, unknown>)["to"] === "done",
    ),
  );
  const comment = timeline.rows.find((a) => a.kind === "comment");
  assert.ok(comment);
  const body = comment.body as Record<string, unknown>;
  assert.equal(body["kind"], "review_passed");
  assert.deepEqual(body["evidence"], ["ran tests"]);
});

test("review_verdict fail bounces review back to in_progress", async () => {
  const { rs, acts, timeline } = fixtures();
  const r = newRequirement("p", "x");
  r.status = "review";
  await rs.upsert(r);
  const verdict = new RequirementReviewVerdictTool(rs, acts);
  const out = parse(await verdict.invoke({ id: r.id, verdict: "fail", commentary: "tests fail" }));
  assert.equal(out["status"], "in_progress");
  const comment = timeline.rows.find((a) => a.kind === "comment");
  assert.equal((comment?.body as Record<string, unknown>)["kind"], "review_failed");
});

test("review_verdict errors when not in review", async () => {
  const { rs, acts } = fixtures();
  const r = await seed(rs, "p", "x"); // backlog
  const verdict = new RequirementReviewVerdictTool(rs, acts);
  await assert.rejects(
    () => verdict.invoke({ id: r.id, verdict: "pass", commentary: "ok" }),
    /not `review`/,
  );
});

test("review_verdict rejects blank commentary and bad verdict", async () => {
  const { rs, acts } = fixtures();
  const r = newRequirement("p", "x");
  r.status = "review";
  await rs.upsert(r);
  const verdict = new RequirementReviewVerdictTool(rs, acts);
  await assert.rejects(() => verdict.invoke({ id: r.id, verdict: "pass", commentary: "  " }), /blank/);
  await assert.rejects(
    () => verdict.invoke({ id: r.id, verdict: "maybe", commentary: "ok" }),
    /bad verdict/,
  );
});

// ---------- approval gating ----------

test("only delete requires approval", () => {
  const { rs, acts } = fixtures();
  const gated = (t: Tool): boolean => t.requiresApproval ?? false;
  assert.equal(gated(new RequirementListTool(rs)), false);
  assert.equal(gated(new RequirementStartTool(rs, acts)), false);
  assert.equal(gated(new RequirementBlockTool(rs, acts)), false);
  assert.equal(gated(new RequirementCompleteTool(rs, acts)), false);
  assert.equal(gated(new RequirementCreateTool(rs, acts)), false);
  assert.equal(gated(new RequirementUpdateTool(rs, acts)), false);
  assert.equal(gated(new RequirementDeleteTool(rs)), true);
});

// ---------- create / update / delete ----------

test("create defaults to proposed_by_agent and backlog", async () => {
  const { rs, acts, timeline } = fixtures();
  const create = new RequirementCreateTool(rs, acts);
  const out = parse(
    await create.invoke({
      project_id: "p1",
      title: "Add avatar upload",
      description: "Multipart POST /api/avatar",
    }),
  );
  assert.equal(out["title"], "Add avatar upload");
  assert.equal(out["status"], "backlog");
  assert.equal(out["triage_state"], "proposed_by_agent");
  assert.equal(out["project_id"], "p1");
  assert.equal(out["description"], "Multipart POST /api/avatar");

  assert.equal(timeline.rows.length, 1);
  assert.equal(timeline.rows[0].kind, "comment");
  const body = timeline.rows[0].body as Record<string, unknown>;
  assert.equal(body["kind"], "created");
  assert.equal(body["triage_state"], "proposed_by_agent");
});

test("create with explicit approved overrides default (stripped on wire)", async () => {
  const { rs, acts } = fixtures();
  const create = new RequirementCreateTool(rs, acts);
  const out = parse(
    await create.invoke({ project_id: "p", title: "user-confirmed task", triage_state: "approved" }),
  );
  // Default `approved` is skipped on the wire (requirementToWire strips it),
  // so absence == approved.
  assert.equal("triage_state" in out, false);
});

test("create persists verification_plan and depends_on", async () => {
  const { rs, acts } = fixtures();
  const create = new RequirementCreateTool(rs, acts);
  const out = parse(
    await create.invoke({
      project_id: "p",
      title: "x",
      verification_plan: { commands: ["cargo test -p foo"], require_tests: true },
      depends_on: ["dep-1", "dep-2", "  "],
      todos: [
        {
          title: "Run workspace CI",
          kind: "ci",
          command: "cargo test --workspace",
          created_by: "workflow",
        },
      ],
    }),
  );
  const id = out["id"] as string;
  const stored = await rs.get(id);
  assert.ok(stored);
  assert.deepEqual(stored.depends_on, ["dep-1", "dep-2"]);
  assert.ok(stored.verification_plan);
  assert.equal(stored.verification_plan.require_tests, true);
  assert.equal(stored.todos?.length, 1);
  assert.equal(stored.todos?.[0].kind, "ci");
  assert.equal(stored.todos?.[0].command, "cargo test --workspace");
  assert.equal(stored.todos?.[0].created_by, "workflow");
});

test("create rejects blank title or project", async () => {
  const { rs, acts } = fixtures();
  const create = new RequirementCreateTool(rs, acts);
  await assert.rejects(() => create.invoke({ project_id: "p", title: "  " }), /title/);
});

test("create rejects unknown triage_state", async () => {
  const { rs, acts } = fixtures();
  const create = new RequirementCreateTool(rs, acts);
  await assert.rejects(
    () => create.invoke({ project_id: "p", title: "x", triage_state: "zomg" }),
    /unknown triage_state/,
  );
});

test("update changes title and records triage_change", async () => {
  const { rs, acts, timeline } = fixtures();
  const create = new RequirementCreateTool(rs, acts);
  const created = parse(await create.invoke({ project_id: "p", title: "draft" }));
  const id = created["id"] as string;
  const baseline = timeline.rows.length;

  const update = new RequirementUpdateTool(rs, acts);
  const out = parse(await update.invoke({ id, title: "final title", triage_state: "approved" }));
  assert.equal(out["title"], "final title");

  const extra = timeline.rows.length - baseline;
  assert.equal(extra, 1, "expected exactly one triage_change activity");
  const tail = timeline.rows[baseline];
  const body = tail.body as Record<string, unknown>;
  assert.equal(body["kind"], "triage_change");
  assert.equal(body["from"], "proposed_by_agent");
  assert.equal(body["to"], "approved");
});

test("update rejects self-dependency", async () => {
  const { rs, acts } = fixtures();
  const r = await seed(rs, "p", "x");
  const update = new RequirementUpdateTool(rs, acts);
  await assert.rejects(
    () => update.invoke({ id: r.id, depends_on: [r.id, "other"] }),
    /self-dependency/,
  );
  // Store must be untouched — the bad edit never persisted.
  const stored = await rs.get(r.id);
  assert.ok(stored);
  assert.deepEqual(stored.depends_on ?? [], []);
});

test("update no-op when nothing changes", async () => {
  const { rs, acts } = fixtures();
  const r = await seed(rs, "p", "x");
  // First update eagerly populates the execution-checklist boilerplate
  // (ensureExecutionChecklist returns true), so capture the baseline after
  // that first call has settled.
  const update = new RequirementUpdateTool(rs, acts);
  await update.invoke({ id: r.id });
  const baseline = (await rs.get(r.id))?.updated_at;
  await new Promise((resolve) => setTimeout(resolve, 5));

  await update.invoke({ id: r.id });
  const after = await rs.get(r.id);
  assert.equal(after?.updated_at, baseline, "no-op should not touch updated_at once checklist is set");
});

test("update clears description with empty string", async () => {
  const { rs, acts } = fixtures();
  const r = newRequirement("p", "x");
  r.description = "longform";
  await rs.upsert(r);
  const update = new RequirementUpdateTool(rs, acts);
  await update.invoke({ id: r.id, description: "" });
  const after = await rs.get(r.id);
  assert.equal(after?.description, undefined);
});

test("delete removes row", async () => {
  const { rs } = fixtures();
  const r = await seed(rs, "p", "x");
  const del = new RequirementDeleteTool(rs);
  const out = parse(await del.invoke({ id: r.id }));
  assert.equal(out["deleted"], true);
  assert.equal(await rs.get(r.id), undefined);
});
