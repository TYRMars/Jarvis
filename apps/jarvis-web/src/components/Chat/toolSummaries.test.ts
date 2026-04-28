// Per-tool parser tests + top-level invariants for the
// `toolSummaries` module. Each parser gets:
//   • happy path with realistic fixture data
//   • empty / null output → null (no chip rendered)
//   • malformed JSON / unexpected shape → null (no throw)
//   • interesting boundary case
//
// Plus top-level guards: unknown tool, oversize output, parser
// throw, and the SUMMARISABLE / APPROVAL_GATED disjointness rule.

import { describe, expect, it } from "vitest";
import {
  APPROVAL_GATED_TOOLS,
  SUMMARISABLE_TOOLS,
  summarise,
  summariseChecks,
  summariseFsList,
  summariseFsRead,
  summariseGitDiff,
  summariseGitLog,
  summariseGitShow,
  summariseGitStatus,
  summariseGrep,
  summarisePlan,
  summariseWorkspaceContext,
} from "./toolSummaries";

describe("summariseWorkspaceContext", () => {
  it("renders vcs · branch · dirty for a typical git workspace", () => {
    const out = JSON.stringify({ vcs: "git", branch: "main", dirty: true });
    expect(summariseWorkspaceContext(out)).toBe("git · ⎇ main · dirty");
  });

  it("marks clean when dirty is false", () => {
    const out = JSON.stringify({ vcs: "git", branch: "main", dirty: false });
    expect(summariseWorkspaceContext(out)).toBe("git · ⎇ main · clean");
  });

  it("hides vcs chip when there is no version control", () => {
    const out = JSON.stringify({ vcs: "none" });
    expect(summariseWorkspaceContext(out)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(summariseWorkspaceContext("not json")).toBeNull();
  });

  it("returns null for empty output", () => {
    expect(summariseWorkspaceContext("")).toBeNull();
    expect(summariseWorkspaceContext(null)).toBeNull();
  });
});

describe("summariseGitStatus", () => {
  it("counts modified / untracked / added entries by leading code", () => {
    const out = [
      "## main...origin/main",
      " M crates/foo.rs",
      " M crates/bar.rs",
      "?? new.txt",
      "A  added.txt",
    ].join("\n");
    // Order in output is M, A, D, R, ?, so we get M:2 A:1 ?:1.
    expect(summariseGitStatus(out)).toBe("M:2 A:1 ?:1");
  });

  it("returns 'clean' when only the branch header is present", () => {
    expect(summariseGitStatus("## main...origin/main")).toBe("clean");
  });

  it("returns null when the output is the not-a-repo sentinel", () => {
    expect(summariseGitStatus("(not a git repository)")).toBeNull();
  });

  it("returns null for empty output", () => {
    expect(summariseGitStatus("")).toBeNull();
  });
});

describe("summariseGitDiff", () => {
  it("counts +/- lines across files, skipping +++/--- headers", () => {
    const diff = [
      "diff --git a/foo.rs b/foo.rs",
      "--- a/foo.rs",
      "+++ b/foo.rs",
      "@@ -1,3 +1,4 @@",
      "-old line",
      "+new line one",
      "+new line two",
      "diff --git a/bar.rs b/bar.rs",
      "--- a/bar.rs",
      "+++ b/bar.rs",
      "@@ -10,1 +10,1 @@",
      "-removed",
      "+added",
    ].join("\n");
    // 3 added (`+new line one`, `+new line two`, `+added`),
    // 2 removed (`-old line`, `-removed`), 2 files.
    expect(summariseGitDiff(diff)).toBe("+3 −2 across 2 files");
  });

  it("singularises 'file' when only one file changed", () => {
    const diff = [
      "diff --git a/foo.rs b/foo.rs",
      "--- a/foo.rs",
      "+++ b/foo.rs",
      "+a",
    ].join("\n");
    expect(summariseGitDiff(diff)).toBe("+1 −0 across 1 file");
  });

  it("mirrors the (no changes) sentinel from the tool", () => {
    expect(summariseGitDiff("(no changes)")).toBe("no changes");
  });

  it("returns null for empty output", () => {
    expect(summariseGitDiff("")).toBeNull();
  });

  it("falls back to +++ b/ headers when diff --git preamble is absent", () => {
    const diff = ["--- a/foo", "+++ b/foo", "+x"].join("\n");
    expect(summariseGitDiff(diff)).toBe("+1 −0 across 1 file");
  });
});

describe("summariseGitLog", () => {
  it("counts short-format commit lines", () => {
    const out = [
      "abc1234 first commit subject",
      "def5678 second one",
      "9abcdef third",
    ].join("\n");
    expect(summariseGitLog(out)).toBe("3 commits");
  });

  it("singularises when there's only one commit", () => {
    expect(summariseGitLog("abc1234 only one")).toBe("1 commit");
  });

  it("returns null for empty output", () => {
    expect(summariseGitLog("")).toBeNull();
  });

  it("returns null when no lines look like commits", () => {
    expect(summariseGitLog("garbage\nnot a commit")).toBeNull();
  });
});

describe("summariseGitShow", () => {
  it("returns short SHA + file count when a diff is included", () => {
    const out = [
      "commit abc1234567890",
      "Author: x <x@y>",
      "",
      "Subject",
      "",
      "diff --git a/foo b/foo",
      "diff --git a/bar b/bar",
    ].join("\n");
    expect(summariseGitShow(out)).toBe("abc1234 · 2 files");
  });

  it("returns just the SHA when there's no diff", () => {
    const out = "commit abc1234567890\nAuthor: x\n";
    expect(summariseGitShow(out)).toBe("abc1234");
  });

  it("returns null when there is no commit header", () => {
    expect(summariseGitShow("not a show output")).toBeNull();
  });
});

describe("summariseFsRead", () => {
  it("renders path and line count when both available", () => {
    expect(summariseFsRead({ path: "src/foo.rs" }, "a\nb\nc")).toBe(
      "src/foo.rs (3 lines)",
    );
  });

  it("singularises 'line'", () => {
    expect(summariseFsRead({ path: "x" }, "only")).toBe("x (1 line)");
  });

  it("falls back to line-count only when path is absent", () => {
    expect(summariseFsRead({}, "a\nb")).toBe("2 lines");
  });

  it("counts zero lines for an empty file", () => {
    expect(summariseFsRead({ path: "empty" }, "")).toBe("empty (0 lines)");
  });

  it("returns null when output is null", () => {
    expect(summariseFsRead({ path: "x" }, null)).toBeNull();
  });
});

describe("summariseFsList", () => {
  it("counts entries from the JSON array", () => {
    const out = JSON.stringify([
      { name: "a", kind: "file" },
      { name: "b", kind: "dir" },
      { name: "c", kind: "file" },
    ]);
    expect(summariseFsList(out)).toBe("3 entries");
  });

  it("singularises", () => {
    expect(summariseFsList(JSON.stringify([{ name: "a", kind: "file" }]))).toBe(
      "1 entry",
    );
  });

  it("returns null for non-array JSON", () => {
    expect(summariseFsList(JSON.stringify({ not: "array" }))).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(summariseFsList("not json")).toBeNull();
  });
});

describe("summariseGrep", () => {
  it("counts matches and unique paths", () => {
    const out = [
      "src/foo.rs:10: fn main() {",
      "src/foo.rs:42: let x = 1;",
      "src/bar.rs:7: hello",
    ].join("\n");
    expect(summariseGrep(out)).toBe("3 matches in 2 files");
  });

  it("singularises both 'match' and 'file'", () => {
    expect(summariseGrep("a.rs:1: x")).toBe("1 match in 1 file");
  });

  it("returns null when no matches", () => {
    expect(summariseGrep("")).toBeNull();
  });

  it("ignores the [... truncated ...] footer line", () => {
    const out = [
      "a.rs:1: x",
      "[... truncated at 64 KiB ...]",
    ].join("\n");
    expect(summariseGrep(out)).toBe("1 match in 1 file");
  });
});

describe("summariseChecks", () => {
  it("counts suggestion entries", () => {
    const out = JSON.stringify({
      suggestions: [
        { manifest: "Cargo.toml", kind: "test", command: "cargo test", why: "" },
        { manifest: "Cargo.toml", kind: "lint", command: "cargo clippy", why: "" },
      ],
    });
    expect(summariseChecks(out)).toBe("2 suggestions");
  });

  it("returns 'no checks' when the array is empty", () => {
    expect(summariseChecks(JSON.stringify({ suggestions: [] }))).toBe("no checks");
  });

  it("returns null for malformed JSON", () => {
    expect(summariseChecks("nope")).toBeNull();
  });

  it("returns null when suggestions is missing or wrong shape", () => {
    expect(summariseChecks(JSON.stringify({}))).toBeNull();
    expect(summariseChecks(JSON.stringify({ suggestions: "not array" }))).toBeNull();
  });
});

describe("summarisePlan", () => {
  it("counts items and completed items from args", () => {
    const args = {
      items: [
        { id: "1", title: "a", status: "completed" },
        { id: "2", title: "b", status: "in_progress" },
        { id: "3", title: "c", status: "pending" },
        { id: "4", title: "d", status: "completed" },
      ],
    };
    expect(summarisePlan(args, "ok")).toBe("4 steps · 2 done");
  });

  it("singularises step", () => {
    expect(summarisePlan({ items: [{ id: "1", title: "a", status: "completed" }] }, "ok")).toBe(
      "1 step · 1 done",
    );
  });

  it("falls back to 'plan updated' when args has no items array", () => {
    expect(summarisePlan({}, "ok")).toBe("plan updated");
  });

  it("returns null when args is missing", () => {
    expect(summarisePlan(null, "ok")).toBeNull();
  });
});

describe("summarise top-level dispatch", () => {
  it("returns null for an unknown tool name", () => {
    expect(summarise("custom.mcp.tool", {}, "anything")).toBeNull();
  });

  it("returns null for approval-gated tools (they're never in the summarisable set)", () => {
    expect(summarise("fs.edit", { path: "x" }, "ok")).toBeNull();
    expect(summarise("shell.exec", { command: "ls" }, "ok")).toBeNull();
  });

  it("does not throw on a malformed input that bypasses parser guards", () => {
    // Pass an `args` object that the plan parser will iterate over as
    // `items`, but each item.status access would throw if the parser
    // didn't guard typeof. The outer try/catch catches anything.
    const evilArgs = {
      get items() {
        throw new Error("boom");
      },
    };
    expect(summarise("plan.update", evilArgs, "ok")).toBeNull();
  });

  it("returns null when output exceeds the 256 KiB safety cap", () => {
    const huge = "x".repeat(256 * 1024 + 1);
    expect(summarise("code.grep", {}, huge)).toBeNull();
  });
});

describe("invariants", () => {
  it("SUMMARISABLE_TOOLS and APPROVAL_GATED_TOOLS must be disjoint", () => {
    // Otherwise a tool would be both default-open AND have a
    // collapsed-state teaser, which makes no sense.
    const intersection = [...SUMMARISABLE_TOOLS].filter((t) =>
      APPROVAL_GATED_TOOLS.has(t),
    );
    expect(intersection).toEqual([]);
  });

  it("approval-gated set covers exactly the four mutating built-ins", () => {
    expect([...APPROVAL_GATED_TOOLS].sort()).toEqual([
      "fs.edit",
      "fs.patch",
      "fs.write",
      "shell.exec",
    ]);
  });
});
