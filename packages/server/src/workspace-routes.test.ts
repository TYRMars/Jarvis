// Tests for the read-only workspace inspection routes. Ported (the read-only
// subset) from the `tests` modules in workspace_files.rs / workspace_find.rs /
// workspace_diff.rs.
//
// Deterministic, no network. The diff tests `git init` a fresh temp repo and
// skip cleanly when `git` isn't on PATH (mirrors diagnostics-routes.test.ts).
// Filesystem tests stage files in a tempdir and assert sandboxing.
import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerWorkspaceRoutes } from "./workspace-routes.ts";
import type { AppState } from "./state.ts";

// ---------- fixtures ----------

const noAgent = (): never => {
  throw new Error("agent not used in these route tests");
};

function makeState(workspaceRoot?: string): AppState {
  const base: AppState = { createAgent: noAgent };
  if (workspaceRoot !== undefined) base.workspaceRoot = workspaceRoot;
  return base;
}

async function buildApp(state: AppState) {
  const app = Fastify();
  registerWorkspaceRoutes(app, state);
  await app.ready();
  return app;
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  // realpath so the canonicalisation inside resolveWorkspace matches on macOS
  // (where /var → /private/var).
  const dir = await realpath(await mkdtemp(join(tmpdir(), "jarvis-ws-")));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const HAS_GIT = gitAvailable();

function git(dir: string, args: string[]): void {
  execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
}

function initRepo(dir: string): void {
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  git(dir, ["config", "user.name", "test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
}

// ====================================================================
// 503 when no workspace root is configured
// ====================================================================

test("every workspace route 503s when no root configured", async () => {
  const app = await buildApp(makeState());
  const urls = [
    "/v1/workspace/list",
    "/v1/workspace/read?path=foo.txt",
    "/v1/workspace/diff",
    "/v1/workspace/diff/file?path=foo.txt",
  ];
  for (const url of urls) {
    const res = await app.inject({ method: "GET", url });
    assert.equal(res.statusCode, 503, url);
    assert.match((res.json() as { error: string }).error, /workspace root not configured/, url);
  }
  // `find` does NOT need a workspace root — it always answers (empty list when
  // nothing matches), so it is excluded from the 503 set.
  const find = await app.inject({ method: "GET", url: "/v1/workspace/find?name=nonexistent-xyz-123" });
  assert.equal(find.statusCode, 200);
  assert.deepEqual(find.json(), { candidates: [] });
  await app.close();
});

// ====================================================================
// GET /v1/workspace/list
// ====================================================================

test("list returns entries, dirs-first, .git hidden at root", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".git"));
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "Cargo.toml"), "x");
    await writeFile(join(dir, "README.md"), "hello\nworld\n");
    const app = await buildApp(makeState(dir));
    const res = await app.inject({ method: "GET", url: "/v1/workspace/list" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      root: string;
      dir: string;
      parent: string | null;
      entries: { name: string; kind: string; size?: number }[];
      truncated: boolean;
    };
    assert.equal(body.dir, "");
    assert.equal(body.parent, null);
    assert.equal(body.truncated, false);
    const names = body.entries.map((e) => e.name);
    assert.ok(!names.includes(".git"), ".git must be hidden at root");
    // src (dir) sorts before the files.
    assert.equal(body.entries[0]?.name, "src");
    assert.equal(body.entries[0]?.kind, "dir");
    const readme = body.entries.find((e) => e.name === "README.md");
    assert.equal(readme?.kind, "file");
    assert.equal(readme?.size, "hello\nworld\n".length);
    await app.close();
  });
});

test("list of a subdir reports parent; .git visible below root", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "a", "b"), { recursive: true });
    await writeFile(join(dir, "a", "f.txt"), "x");
    const app = await buildApp(makeState(dir));
    const res = await app.inject({ method: "GET", url: "/v1/workspace/list?dir=a" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { dir: string; parent: string | null; entries: { name: string }[] };
    assert.equal(body.dir, "a");
    assert.equal(body.parent, "");
    assert.deepEqual(
      body.entries.map((e) => e.name).sort(),
      ["b", "f.txt"],
    );
    await app.close();
  });
});

test("list rejects traversal and absolute dir", async () => {
  await withTempDir(async (dir) => {
    const app = await buildApp(makeState(dir));
    for (const bad of ["dir=../escape", "dir=/etc", "dir=a/../../b"]) {
      const res = await app.inject({ method: "GET", url: `/v1/workspace/list?${bad}` });
      assert.equal(res.statusCode, 400, bad);
    }
    await app.close();
  });
});

test("list 500s on a missing subdir", async () => {
  await withTempDir(async (dir) => {
    const app = await buildApp(makeState(dir));
    const res = await app.inject({ method: "GET", url: "/v1/workspace/list?dir=ghost" });
    assert.equal(res.statusCode, 500);
    await app.close();
  });
});

// ====================================================================
// GET /v1/workspace/read
// ====================================================================

test("read returns file content + size", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "hello.txt"), "abc\ndef\n");
    const app = await buildApp(makeState(dir));
    const res = await app.inject({ method: "GET", url: "/v1/workspace/read?path=hello.txt" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { path: string; size: number; binary: boolean; truncated: boolean; content: string };
    assert.equal(body.path, "hello.txt");
    assert.equal(body.size, 8);
    assert.equal(body.binary, false);
    assert.equal(body.truncated, false);
    assert.equal(body.content, "abc\ndef\n");
    await app.close();
  });
});

test("read flags binary files (NUL sniff) with empty content", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    const app = await buildApp(makeState(dir));
    const res = await app.inject({ method: "GET", url: "/v1/workspace/read?path=logo.png" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { binary: boolean; content: string; size: number };
    assert.equal(body.binary, true);
    assert.equal(body.content, "");
    assert.equal(body.size, 5);
    await app.close();
  });
});

test("read 400s on empty path, dir target, and traversal", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "sub"));
    const app = await buildApp(makeState(dir));
    const empty = await app.inject({ method: "GET", url: "/v1/workspace/read?path=" });
    assert.equal(empty.statusCode, 400);
    const isDir = await app.inject({ method: "GET", url: "/v1/workspace/read?path=sub" });
    assert.equal(isDir.statusCode, 400);
    assert.match((isDir.json() as { error: string }).error, /directory/);
    const trav = await app.inject({ method: "GET", url: "/v1/workspace/read?path=../escape" });
    assert.equal(trav.statusCode, 400);
    await app.close();
  });
});

test("read 500s on a missing file", async () => {
  await withTempDir(async (dir) => {
    const app = await buildApp(makeState(dir));
    const res = await app.inject({ method: "GET", url: "/v1/workspace/read?path=ghost.txt" });
    assert.equal(res.statusCode, 500);
    await app.close();
  });
});

// ====================================================================
// ?root override
// ====================================================================

test("root override resolves a per-request workspace", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "x.txt"), "y");
    // No pinned root on AppState; the override carries the request.
    const app = await buildApp(makeState());
    const res = await app.inject({
      method: "GET",
      url: `/v1/workspace/read?root=${encodeURIComponent(dir)}&path=x.txt`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { content: string }).content, "y");
    await app.close();
  });
});

test("root override rejects relative / nonexistent / non-dir", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "file.txt"), "y");
    const app = await buildApp(makeState());
    const rel = await app.inject({ method: "GET", url: "/v1/workspace/list?root=relative/path" });
    assert.equal(rel.statusCode, 400);
    assert.match((rel.json() as { error: string }).error, /absolute/);
    const missing = await app.inject({
      method: "GET",
      url: `/v1/workspace/list?root=${encodeURIComponent(join(dir, "ghost"))}`,
    });
    assert.equal(missing.statusCode, 400);
    const notDir = await app.inject({
      method: "GET",
      url: `/v1/workspace/list?root=${encodeURIComponent(join(dir, "file.txt"))}`,
    });
    assert.equal(notDir.statusCode, 400);
    assert.match((notDir.json() as { error: string }).error, /not a directory/);
    await app.close();
  });
});

// ====================================================================
// GET /v1/workspace/find
// ====================================================================

test("find validates the name param", async () => {
  const app = await buildApp(makeState());
  const empty = await app.inject({ method: "GET", url: "/v1/workspace/find?name=" });
  assert.equal(empty.statusCode, 400);
  assert.match((empty.json() as { error: string }).error, /required/);
  for (const bad of ["foo/bar", "foo%5Cbar", "..", "."]) {
    const res = await app.inject({ method: "GET", url: `/v1/workspace/find?name=${bad}` });
    assert.equal(res.statusCode, 400, bad);
    assert.match((res.json() as { error: string }).error, /basename/, bad);
  }
  await app.close();
});

test("find returns empty for an unknown basename", async () => {
  const app = await buildApp(makeState());
  const res = await app.inject({
    method: "GET",
    url: "/v1/workspace/find?name=ghost-folder-that-does-not-exist-zzz",
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { candidates: [] });
  await app.close();
});

// ====================================================================
// GET /v1/workspace/diff  +  /diff/file   (need git)
// ====================================================================

test(
  "diff reports branch/base/ahead/behind/files for a real repo",
  { skip: HAS_GIT ? false : "git not on PATH" },
  async () => {
    await withTempDir(async (dir) => {
      initRepo(dir);
      await writeFile(join(dir, "a.txt"), "one\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "-m", "base on main"]);
      // Branch off main, add a commit ahead.
      git(dir, ["checkout", "-q", "-b", "feat/x"]);
      await writeFile(join(dir, "b.txt"), "two\nthree\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "-m", "add b"]);

      const app = await buildApp(makeState(dir));
      const res = await app.inject({ method: "GET", url: "/v1/workspace/diff?base=main" });
      assert.equal(res.statusCode, 200);
      const body = res.json() as {
        branch: string;
        base: string;
        base_exists: boolean;
        ahead: number;
        behind: number;
        stat: { added: number; removed: number; files: number };
        files: { path: string; status: string; added: number }[];
        uncommitted: { files: number; entries: { path: string; status: string }[] };
      };
      assert.equal(body.branch, "feat/x");
      assert.equal(body.base, "main");
      assert.equal(body.base_exists, true);
      assert.equal(body.ahead, 1);
      assert.equal(body.behind, 0);
      assert.equal(body.files.length, 1);
      assert.equal(body.files[0]?.path, "b.txt");
      assert.equal(body.files[0]?.status, "A");
      assert.equal(body.files[0]?.added, 2);
      assert.equal(body.stat.files, 1);
      assert.equal(body.uncommitted.files, 0);
      await app.close();
    });
  },
);

test(
  "diff reports base_exists:false for a missing base ref",
  { skip: HAS_GIT ? false : "git not on PATH" },
  async () => {
    await withTempDir(async (dir) => {
      initRepo(dir);
      await writeFile(join(dir, "a.txt"), "x\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "-m", "seed"]);
      const app = await buildApp(makeState(dir));
      const res = await app.inject({ method: "GET", url: "/v1/workspace/diff?base=does-not-exist" });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { base_exists: boolean; files: unknown[]; ahead: number };
      assert.equal(body.base_exists, false);
      assert.deepEqual(body.files, []);
      assert.equal(body.ahead, 0);
      await app.close();
    });
  },
);

test(
  "diff surfaces untracked files in the uncommitted block",
  { skip: HAS_GIT ? false : "git not on PATH" },
  async () => {
    await withTempDir(async (dir) => {
      initRepo(dir);
      await writeFile(join(dir, "tracked.txt"), "x\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "-m", "seed"]);
      await writeFile(join(dir, "untracked.txt"), "l1\nl2\nl3\n");
      const app = await buildApp(makeState(dir));
      const res = await app.inject({ method: "GET", url: "/v1/workspace/diff?base=main" });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { uncommitted: { entries: { path: string; status: string; added: number }[] } };
      const u = body.uncommitted.entries.find((e) => e.path === "untracked.txt");
      assert.ok(u, "untracked.txt should appear in the uncommitted block");
      assert.equal(u?.status, "?");
      assert.equal(u?.added, 3);
      await app.close();
    });
  },
);

test("diff rejects a dangerous base branch", async () => {
  await withTempDir(async (dir) => {
    const app = await buildApp(makeState(dir));
    for (const bad of ["base=--upload-pack%3Devil", "base=main%3B%20rm%20-rf%20%2F"]) {
      const res = await app.inject({ method: "GET", url: `/v1/workspace/diff?${bad}` });
      assert.equal(res.statusCode, 400, bad);
    }
    await app.close();
  });
});

test(
  "diff/file returns a unified diff for one file",
  { skip: HAS_GIT ? false : "git not on PATH" },
  async () => {
    await withTempDir(async (dir) => {
      initRepo(dir);
      await writeFile(join(dir, "a.txt"), "one\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "-m", "base on main"]);
      git(dir, ["checkout", "-q", "-b", "feat/x"]);
      await writeFile(join(dir, "a.txt"), "one\ntwo\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "-m", "edit a"]);

      const app = await buildApp(makeState(dir));
      const res = await app.inject({
        method: "GET",
        url: "/v1/workspace/diff/file?base=main&path=a.txt",
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as { base: string; path: string; diff: string };
      assert.equal(body.base, "main");
      assert.equal(body.path, "a.txt");
      assert.match(body.diff, /\+two/);
      await app.close();
    });
  },
);

test(
  "diff/file with uncommitted=1 shows the working-tree delta",
  { skip: HAS_GIT ? false : "git not on PATH" },
  async () => {
    await withTempDir(async (dir) => {
      initRepo(dir);
      await writeFile(join(dir, "a.txt"), "one\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "-m", "seed"]);
      // Uncommitted working-tree edit.
      await writeFile(join(dir, "a.txt"), "one\nuncommitted-line\n");
      const app = await buildApp(makeState(dir));
      const res = await app.inject({
        method: "GET",
        url: "/v1/workspace/diff/file?path=a.txt&uncommitted=1",
      });
      assert.equal(res.statusCode, 200);
      assert.match((res.json() as { diff: string }).diff, /\+uncommitted-line/);
      await app.close();
    });
  },
);

test("diff/file 400s on empty / traversal / leading-dash path", async () => {
  await withTempDir(async (dir) => {
    const app = await buildApp(makeState(dir));
    for (const bad of ["path=", "path=../escape", "path=-rf"]) {
      const res = await app.inject({ method: "GET", url: `/v1/workspace/diff/file?${bad}` });
      assert.equal(res.statusCode, 400, bad);
    }
    await app.close();
  });
});

// ====================================================================
// GET /v1/workspace + /v1/workspace/probe (git snapshot)
// ====================================================================

test("GET /v1/workspace 503s when no root; reports vcs:none for a non-git root", async () => {
  const app503 = await buildApp(makeState());
  assert.equal((await app503.inject({ method: "GET", url: "/v1/workspace" })).statusCode, 503);
  await app503.close();

  await withTempDir(async (dir) => {
    const app = await buildApp(makeState(dir));
    const snap = (await app.inject({ method: "GET", url: "/v1/workspace" })).json() as {
      root: string;
      vcs: string;
      branch?: unknown;
    };
    assert.equal(snap.root, dir);
    assert.equal(snap.vcs, "none");
    assert.equal("branch" in snap, false);
    await app.close();
  });
});

test("GET /v1/workspace/probe requires ?path and inspects the candidate", async () => {
  await withTempDir(async (dir) => {
    const app = await buildApp(makeState(dir));
    assert.equal((await app.inject({ method: "GET", url: "/v1/workspace/probe" })).statusCode, 400);
    const snap = (await app.inject({
      method: "GET",
      url: `/v1/workspace/probe?path=${encodeURIComponent(dir)}`,
    })).json() as { root: string; vcs: string };
    assert.equal(snap.root, dir);
    assert.equal(snap.vcs, "none");
    await app.close();
  });
});

test("GET /v1/workspace reports git branch/head/dirty for a real repo", { skip: !HAS_GIT }, async () => {
  await withTempDir(async (dir) => {
    initRepo(dir);
    await writeFile(join(dir, "a.txt"), "hello\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "init"]);
    const app = await buildApp(makeState(dir));

    const clean = (await app.inject({ method: "GET", url: "/v1/workspace" })).json() as {
      vcs: string;
      branch: string | null;
      head: string | null;
      dirty: boolean;
    };
    assert.equal(clean.vcs, "git");
    assert.equal(clean.branch, "main");
    assert.ok(typeof clean.head === "string" && clean.head.length > 0);
    assert.equal(clean.dirty, false);

    // Make it dirty.
    await writeFile(join(dir, "a.txt"), "changed\n");
    const dirty = (await app.inject({ method: "GET", url: "/v1/workspace" })).json() as { dirty: boolean };
    assert.equal(dirty.dirty, true);
    await app.close();
  });
});

// ====================================================================
// POST /v1/workspace/commit + /pr/preview + /pr
// ====================================================================

test("commit validates (503 no root, 400 empty/nothing-staged) and commits", { skip: !HAS_GIT }, async () => {
  const noRoot = await buildApp(makeState());
  assert.equal(
    (await noRoot.inject({ method: "POST", url: "/v1/workspace/commit", payload: { message: "x" } })).statusCode,
    503,
  );
  await noRoot.close();

  await withTempDir(async (dir) => {
    initRepo(dir);
    await writeFile(join(dir, "seed.txt"), "1\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "seed"]);
    const app = await buildApp(makeState(dir));

    assert.equal(
      (await app.inject({ method: "POST", url: "/v1/workspace/commit", payload: { message: "  " } })).statusCode,
      400,
    );
    // Clean tree → nothing to commit.
    assert.equal(
      (await app.inject({ method: "POST", url: "/v1/workspace/commit", payload: { message: "noop" } })).statusCode,
      400,
    );

    // Stage a change → success.
    await writeFile(join(dir, "b.txt"), "2\n");
    const res = await app.inject({ method: "POST", url: "/v1/workspace/commit", payload: { message: "add b" } });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { ok: boolean; head: string | null; pushed: boolean; push_error: string | null };
    assert.equal(body.ok, true);
    assert.ok(typeof body.head === "string" && body.head.length > 0);
    assert.equal(body.pushed, false);
    assert.equal(body.push_error, null);

    // push=true with no `origin` remote → pushed false + push_error set (no network).
    await writeFile(join(dir, "c.txt"), "3\n");
    const pushed = (await app.inject({
      method: "POST",
      url: "/v1/workspace/commit",
      payload: { message: "add c", push: true },
    })).json() as { pushed: boolean; push_error: string | null };
    assert.equal(pushed.pushed, false);
    assert.ok(pushed.push_error && pushed.push_error.length > 0);
    await app.close();
  });
});

test("pr/preview suggests title from the commit subject + lists commits", { skip: !HAS_GIT }, async () => {
  await withTempDir(async (dir) => {
    initRepo(dir);
    await writeFile(join(dir, "a.txt"), "1\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "init"]);
    git(dir, ["checkout", "-q", "-b", "feat/widget"]);
    await writeFile(join(dir, "b.txt"), "2\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "Add the widget"]);
    const app = await buildApp(makeState(dir));

    const pre = (await app.inject({ method: "GET", url: "/v1/workspace/pr/preview?base=main" })).json() as {
      branch: string | null;
      base: string;
      gh_available: boolean;
      suggested_title: string;
      suggested_body: string;
    };
    assert.equal(pre.branch, "feat/widget");
    assert.equal(pre.base, "main");
    assert.equal(pre.suggested_title, "Add the widget");
    assert.match(pre.suggested_body, /## Commits[\s\S]*- Add the widget/);
    assert.equal(typeof pre.gh_available, "boolean");
    await app.close();
  });
});

test("pr create rejects an empty title (before invoking gh)", async () => {
  await withTempDir(async (dir) => {
    const app = await buildApp(makeState(dir));
    assert.equal(
      (await app.inject({ method: "POST", url: "/v1/workspace/pr", payload: { title: "  " } })).statusCode,
      400,
    );
    await app.close();
  });
});
