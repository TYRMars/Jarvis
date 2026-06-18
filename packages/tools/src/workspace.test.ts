import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkspaceContextTool } from "./workspace.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-workspace-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function gitAvailable(): boolean {
  try {
    return spawnSync("git", ["--version"]).status === 0;
  } catch {
    return false;
  }
}

function git(dir: string, args: string[]): void {
  const out = spawnSync("git", ["-C", dir, ...args]);
  assert.equal(out.status, 0, `git ${args.join(" ")} failed`);
}

async function initRepo(dir: string): Promise<void> {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@e.com"]);
  git(dir, ["config", "user.name", "T"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(dir, "README.md"), "hi\n");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
}

async function run(dir: string): Promise<Record<string, unknown>> {
  const tool = new WorkspaceContextTool({ root: dir });
  return JSON.parse(await tool.invoke({})) as Record<string, unknown>;
}

test("non-git workspace returns vcs none", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "Cargo.toml"), "[workspace]\n");
    const out = await run(dir);
    assert.equal(out.vcs, "none");
    assert.ok(Array.isArray(out.manifest));
    assert.ok((out.manifest as string[]).includes("Cargo.toml"));
    // vcs == "none" omits branch / head / dirty.
    assert.equal("branch" in out, false);
    assert.equal("head" in out, false);
    assert.equal("dirty" in out, false);
  });
});

test("git repo reports branch / head / dirty", async () => {
  if (!gitAvailable()) return;
  await withTempDir(async (dir) => {
    await initRepo(dir);
    // Untracked file so dirty == true.
    await writeFile(path.join(dir, "scratch.txt"), "hi\n");
    const out = await run(dir);
    assert.equal(out.vcs, "git");
    assert.equal(out.branch, "main");
    assert.equal(out.dirty, true);
    assert.equal(typeof out.head, "string");
    assert.ok((out.instructions as string[]).includes("README.md"));
  });
});

test("finds manifest one level deep in a container dir", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, "crates", "foo"), { recursive: true });
    await writeFile(path.join(dir, "crates", "foo", "Cargo.toml"), "[package]\n");
    const out = await run(dir);
    const manifests = out.manifest as string[];
    assert.ok(
      manifests.some((m) => m.includes("Cargo.toml")),
      `got: ${JSON.stringify(manifests)}`,
    );
    // Path uses forward slashes regardless of platform.
    assert.ok(manifests.some((m) => m === "crates/foo/Cargo.toml"), `got: ${JSON.stringify(manifests)}`);
  });
});

test("top-level listing skips dotfiles and is sorted", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, "apps"));
    await mkdir(path.join(dir, ".hidden"));
    await writeFile(path.join(dir, "Cargo.toml"), "");
    const out = await run(dir);
    const top = out.tools_root_top_level as string[];
    assert.ok(top.includes("apps"));
    assert.ok(top.includes("Cargo.toml"));
    assert.equal(top.some((s) => s.startsWith(".")), false);
    // Sorted ascending.
    assert.deepEqual([...top].sort(), top);
  });
});

test("instructions list ordering is most-agent-specific-first", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "CLAUDE.md"), "claude\n");
    await writeFile(path.join(dir, "AGENTS.md"), "agents\n");
    const out = await run(dir);
    const ins = out.instructions as string[];
    const agentsIdx = ins.indexOf("AGENTS.md");
    const claudeIdx = ins.indexOf("CLAUDE.md");
    assert.ok(agentsIdx >= 0 && claudeIdx >= 0);
    assert.ok(agentsIdx < claudeIdx, `got: ${JSON.stringify(ins)}`);
  });
});

test("output key order matches the Rust snapshot shape", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "Cargo.toml"), "[workspace]\n");
    const tool = new WorkspaceContextTool({ root: dir });
    const json = await tool.invoke({});
    const keys = Object.keys(JSON.parse(json) as Record<string, unknown>);
    assert.deepEqual(keys, ["root", "vcs", "instructions", "manifest", "tools_root_top_level"]);
  });
});
