// Tests for the read-only git tool group. Ported from the read-only `tests`
// in crates/harness-tools/src/git.rs. Deterministic, no network: each test
// `git init`s a fresh temp repo under os.tmpdir(). Skips cleanly if `git`
// isn't on PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@jarvis/core";
import { GitStatusTool, GitDiffTool, GitLogTool, GitShowTool, gitTools } from "./git.ts";

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_GIT = gitAvailable();

/** Create a temp dir, run `fn` against it, then clean up. */
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-git-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Init a repo with a committed README.md (writes the file first). */
async function withRepo(fn: (dir: string) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
    execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", dir, "config", "user.name", "Test User"], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "config", "commit.gpgsign", "false"], { stdio: "ignore" });
    await writeFile(join(dir, "README.md"), "hello\n");
    execFileSync("git", ["-C", dir, "add", "README.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "initial"], { stdio: "ignore" });
    await fn(dir);
  });
}

test("status shows clean then dirty", { skip: !HAS_GIT }, async () => {
  await withRepo(async (dir) => {
    const tool = new GitStatusTool({ root: dir });
    const clean = await tool.invoke({});
    assert.ok(clean.includes("## main"), `got: ${clean}`);

    await writeFile(join(dir, "new.txt"), "hi\n");
    const dirty = await tool.invoke({});
    assert.ok(dirty.includes("new.txt"), `got: ${dirty}`);
  });
});

test("diff default returns no changes for clean tree", { skip: !HAS_GIT }, async () => {
  await withRepo(async (dir) => {
    const tool = new GitDiffTool({ root: dir });
    const out = await tool.invoke({});
    assert.ok(out.includes("no changes"), `got: ${out}`);
  });
});

test("diff unstaged shows worktree changes", { skip: !HAS_GIT }, async () => {
  await withRepo(async (dir) => {
    await writeFile(join(dir, "README.md"), "hello world\n");
    const tool = new GitDiffTool({ root: dir });
    const out = await tool.invoke({});
    assert.ok(out.includes("hello world"), `got: ${out}`);
    assert.ok(out.includes("README.md"), `got: ${out}`);
  });
});

test("diff staged shows index diff", { skip: !HAS_GIT }, async () => {
  await withRepo(async (dir) => {
    await writeFile(join(dir, "README.md"), "staged change\n");
    execFileSync("git", ["-C", dir, "add", "README.md"], { stdio: "ignore" });
    const tool = new GitDiffTool({ root: dir });
    // Unstaged is now clean; only --cached should show the change.
    assert.ok((await tool.invoke({})).includes("no changes"));
    const staged = await tool.invoke({ staged: true });
    assert.ok(staged.includes("staged change"), `got: ${staged}`);
  });
});

test("diff rejects dash arg", { skip: !HAS_GIT }, async () => {
  await withRepo(async (dir) => {
    const tool = new GitDiffTool({ root: dir });
    await assert.rejects(
      () => tool.invoke({ from: "--exec=evil" }),
      /must not start with `-`/,
    );
  });
});

test("diff staged and from are mutually exclusive", { skip: !HAS_GIT }, async () => {
  await withRepo(async (dir) => {
    const tool = new GitDiffTool({ root: dir });
    await assert.rejects(
      () => tool.invoke({ staged: true, from: "HEAD" }),
      /mutually exclusive/,
    );
  });
});

test("diff to requires from", { skip: !HAS_GIT }, async () => {
  await withRepo(async (dir) => {
    const tool = new GitDiffTool({ root: dir });
    await assert.rejects(() => tool.invoke({ to: "HEAD" }), /`to` requires `from`/);
  });
});

test("log short format returns one line", { skip: !HAS_GIT }, async () => {
  await withRepo(async (dir) => {
    const tool = new GitLogTool({ root: dir });
    const out = await tool.invoke({ limit: 5 });
    assert.ok(out.includes("initial"), `got: ${out}`);
    assert.equal(out.split("\n").length, 1, `got: ${out}`);
  });
});

test("log full format includes author and date", { skip: !HAS_GIT }, async () => {
  await withRepo(async (dir) => {
    const tool = new GitLogTool({ root: dir });
    const out = await tool.invoke({ format: "full" });
    assert.ok(out.includes("test@example.com"), `got: ${out}`);
    assert.ok(out.includes("initial"), `got: ${out}`);
  });
});

test("log rejects unknown format", { skip: !HAS_GIT }, async () => {
  await withRepo(async (dir) => {
    const tool = new GitLogTool({ root: dir });
    await assert.rejects(() => tool.invoke({ format: "csv" }), /unknown `format`: csv/);
  });
});

test("log rejects dash revision", { skip: !HAS_GIT }, async () => {
  await withRepo(async (dir) => {
    const tool = new GitLogTool({ root: dir });
    await assert.rejects(() => tool.invoke({ revision: "-n9999" }), /must not start with `-`/);
  });
});

test("show metadata only omits patch", { skip: !HAS_GIT }, async () => {
  await withRepo(async (dir) => {
    const tool = new GitShowTool({ root: dir });
    const out = await tool.invoke({ revision: "HEAD", metadata_only: true });
    assert.ok(out.includes("initial"), `got: ${out}`);
    assert.ok(!out.includes("+hello"), `metadata_only leaked patch: ${out}`);
  });
});

test("show without metadata_only includes patch", { skip: !HAS_GIT }, async () => {
  await withRepo(async (dir) => {
    const tool = new GitShowTool({ root: dir });
    const out = await tool.invoke({ revision: "HEAD" });
    assert.ok(out.includes("+hello"), `got: ${out}`);
  });
});

test("show requires revision", { skip: !HAS_GIT }, async () => {
  await withRepo(async (dir) => {
    const tool = new GitShowTool({ root: dir });
    await assert.rejects(() => tool.invoke({}), /missing `revision` argument/);
  });
});

test("not a repo returns soft message", { skip: !HAS_GIT }, async () => {
  await withTempDir(async (dir) => {
    const tool = new GitStatusTool({ root: dir });
    const out = await tool.invoke({});
    assert.ok(out.includes("not a git repository"), `got: ${out}`);
  });
});

test("gitTools factory builds the four read-only tools", { skip: !HAS_GIT }, async () => {
  await withRepo(async (dir) => {
    const [status, diff, log, show] = gitTools(dir);
    assert.equal(status.name, "git.status");
    assert.equal(diff.name, "git.diff");
    assert.equal(log.name, "git.log");
    assert.equal(show.name, "git.show");
    const all: Tool[] = [status, diff, log, show];
    for (const t of all) {
      assert.equal(t.category, "read");
      assert.equal(t.cacheable, true);
      assert.equal(t.requiresApproval ?? false, false);
    }
    // And they actually work against the shared root.
    assert.ok((await status.invoke({})).includes("## main"));
    assert.ok((await log.invoke({})).includes("initial"));
  });
});

test("output is truncated at the byte cap", { skip: !HAS_GIT }, async () => {
  await withRepo(async (dir) => {
    // Many commits → a long `git log` that exceeds a tiny cap.
    for (let i = 0; i < 40; i++) {
      await writeFile(join(dir, `f${i}.txt`), `${i}\n`);
      execFileSync("git", ["-C", dir, "add", `f${i}.txt`], { stdio: "ignore" });
      execFileSync("git", ["-C", dir, "commit", "-q", "-m", `commit number ${i}`], {
        stdio: "ignore",
      });
    }
    const tool = new GitLogTool({ root: dir, maxBytes: 64 });
    const out = await tool.invoke({ limit: 200 });
    assert.ok(out.includes("[... truncated at 64 bytes ...]"), `got: ${out}`);
  });
});
