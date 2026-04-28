// Tests for the verb-based step summariser. The shape of these
// strings is the user-visible description of what an agent step
// did — drives the Claude Code-style coalesced row. Lock the
// canonical phrases so a careless tweak doesn't surprise the user.

import { describe, expect, it } from "vitest";
import type { ToolBlockEntry } from "../../store/appStore";
import { aggregateStepStatus, describeStep } from "./toolStepSummary";

function block(over: Partial<ToolBlockEntry>): ToolBlockEntry {
  return {
    id: over.id ?? "t",
    name: over.name ?? "fs.read",
    args: over.args ?? {},
    status: over.status ?? "ok",
    output: over.output ?? null,
    progress: over.progress ?? "",
    decisionSource: null,
  };
}

describe("describeStep", () => {
  it("inlines target + line-count for a single fs.read", () => {
    expect(
      describeStep([block({ name: "fs.read", args: { path: "README.md" }, output: "a\nb\nc" })]),
    ).toBe("Read README.md (3 lines)");
  });

  it("singularises 'line' for a one-line file", () => {
    expect(
      describeStep([block({ name: "fs.read", args: { path: "x" }, output: "only" })]),
    ).toBe("Read x (1 line)");
  });

  it("pluralises N reads with a count", () => {
    expect(
      describeStep([
        block({ id: "1", name: "fs.read", args: { path: "a" }, output: "x" }),
        block({ id: "2", name: "fs.read", args: { path: "b" }, output: "y" }),
        block({ id: "3", name: "fs.read", args: { path: "c" }, output: "z" }),
      ]),
    ).toBe("Read 3 files");
  });

  it("uses mass-noun form for workspace.context (no article)", () => {
    expect(
      describeStep([block({ name: "workspace.context", args: {}, output: "{}" })]),
    ).toBe("Inspected workspace");
  });

  it("inlines a short shell command verbatim", () => {
    expect(
      describeStep([
        block({ name: "shell.exec", args: { command: "cargo test" }, output: "" }),
      ]),
    ).toBe("Ran cargo test");
  });

  it("truncates a long shell command at ~30 chars", () => {
    expect(
      describeStep([
        block({
          name: "shell.exec",
          args: { command: "this is a very long command that exceeds the cap" },
          output: "",
        }),
      ]),
    ).toMatch(/^Ran this is a very long command/);
  });

  it("shows +N −M stat for a single git.diff", () => {
    const diff =
      "diff --git a/foo b/foo\n--- a/foo\n+++ b/foo\n+a\n+b\n-c\n";
    expect(
      describeStep([block({ name: "git.diff", args: {}, output: diff })]),
    ).toBe("Inspected diff (+2 −1)");
  });

  it("shows match count for a single code.grep", () => {
    expect(
      describeStep([
        block({
          name: "code.grep",
          args: { pattern: "TODO" },
          output: "src/a.rs:1: TODO\nsrc/b.rs:2: TODO\n",
        }),
      ]),
    ).toBe("Searched `TODO` (2 matches)");
  });

  it("joins multiple verb groups with commas (Claude Code pattern)", () => {
    // First phrase keeps its capitalised verb; second-onwards
    // get lowercased so the whole row reads as one sentence.
    expect(
      describeStep([
        block({ id: "1", name: "fs.edit", args: { path: "src/foo.rs" }, output: "" }),
        block({ id: "2", name: "shell.exec", args: { command: "cargo test" }, output: "" }),
        block({ id: "3", name: "shell.exec", args: { command: "npm test" }, output: "" }),
        block({ id: "4", name: "shell.exec", args: { command: "ls" }, output: "" }),
      ]),
    ).toBe("Edited src/foo.rs, ran 3 commands");
  });

  it("appends '(N failed)' when some calls errored", () => {
    expect(
      describeStep([
        block({ id: "1", name: "fs.read", args: { path: "a" }, output: "x", status: "ok" }),
        block({ id: "2", name: "fs.read", args: { path: "b" }, status: "error", output: "boom" }),
      ]),
    ).toBe("Read 2 files (1 failed)");
  });

  it("shows running indicator when nothing has settled", () => {
    expect(
      describeStep([
        block({ id: "1", name: "fs.read", status: "running" }),
        block({ id: "2", name: "shell.exec", status: "running" }),
      ]),
    ).toBe("Running 2 tools (shell.exec)…");
  });

  it("returns empty string for an empty step", () => {
    expect(describeStep([])).toBe("");
  });

  it("falls back to 'Used <name>' for unknown tool names", () => {
    expect(describeStep([block({ name: "custom.mcp.tool", args: {}, output: "" })])).toBe(
      "Used custom.mcp.tool",
    );
  });
});

describe("aggregateStepStatus", () => {
  it("returns 'empty' for no blocks", () => {
    expect(aggregateStepStatus([])).toBe("empty");
  });

  it("returns 'running' if any block is running", () => {
    expect(
      aggregateStepStatus([
        block({ status: "ok" }),
        block({ status: "running" }),
      ]),
    ).toBe("running");
  });

  it("error wins over denied + ok", () => {
    expect(
      aggregateStepStatus([
        block({ status: "ok" }),
        block({ status: "denied" }),
        block({ status: "error" }),
      ]),
    ).toBe("error");
  });

  it("denied when only ok + denied", () => {
    expect(
      aggregateStepStatus([
        block({ status: "ok" }),
        block({ status: "denied" }),
      ]),
    ).toBe("denied");
  });

  it("ok when everything succeeded", () => {
    expect(
      aggregateStepStatus([
        block({ status: "ok" }),
        block({ status: "ok" }),
      ]),
    ).toBe("ok");
  });
});
