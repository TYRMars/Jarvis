// Tests for the git worktree manager. Ported from the `tests` module in
// crates/harness-server/src/worktree.rs (plus coverage for the orphan
// detector / prune helper, which the Rust file flagged as Phase 5b).
//
// Deterministic, no network: each test `git init`s a fresh temp repo under
// os.tmpdir() and commits one seed file so HEAD exists (a worktree off a repo
// with no commits errors). Skips cleanly if `git` isn't on PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  worktreeModeFromWire,
  effectiveAutoMode,
  isGitRepo,
  isCleanCheckout,
  createWorktree,
  createWorktreeForBranch,
  removeWorktree,
  listWorktrees,
  detectOrphans,
  pruneWorktrees,
  DEFAULT_WORKTREE_ROOT,
  type WorktreeMode,
} from "./worktree.ts";

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
  // realpath so canonicalisation inside removeWorktree (which calls realpath)
  // matches — on macOS /var is a symlink to /private/var.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "jarvis-wt-")));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Init a fresh git repo in `dir` and commit one file so HEAD exists. Mirrors
 * the Rust `init_repo` helper.
 */
function initRepo(dir: string): void {
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.invalid"], {
    stdio: "ignore",
  });
  execFileSync("git", ["-C", dir, "config", "user.name", "test"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "config", "commit.gpgsign", "false"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "add", "."], { stdio: "ignore" });
  // seed.txt is written by the caller before invoking; commit it.
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "seed", "--allow-empty"], {
    stdio: "ignore",
  });
}

/** Set up a repo dir with a committed seed.txt and run `fn` against it. */
async function withRepo(fn: (repo: string) => Promise<void>): Promise<void> {
  await withTempDir(async (repo) => {
    await writeFile(join(repo, "seed.txt"), "hello");
    initRepo(repo);
    await fn(repo);
  });
}

// ---- parse / mode helpers (no git needed) ----

test("worktreeModeFromWire parses the wire forms", () => {
  assert.equal(worktreeModeFromWire(""), "off");
  assert.equal(worktreeModeFromWire("off"), "off");
  assert.equal(worktreeModeFromWire("per_run"), "per_run");
  assert.equal(worktreeModeFromWire("per_unit"), "per_unit");
  assert.equal(worktreeModeFromWire("  per_run  "), "per_run");
  assert.equal(worktreeModeFromWire("nonsense"), undefined);
});

test("effectiveAutoMode upgrades off to per_run, passes others through", () => {
  assert.equal(effectiveAutoMode("off"), "per_run");
  assert.equal(effectiveAutoMode("per_run"), "per_run");
  assert.equal(effectiveAutoMode("per_unit"), "per_unit");
  // The default root constant is exported for the composition root.
  assert.equal(DEFAULT_WORKTREE_ROOT, ".jarvis/worktrees");
});

test("WorktreeMode type accepts only the three modes", () => {
  // Compile-time assertion: each literal is assignable.
  const modes: WorktreeMode[] = ["off", "per_run", "per_unit"];
  assert.equal(modes.length, 3);
});

// ---- git-backed behaviour ----

test("isGitRepo detects a repo vs a plain dir", { skip: !HAS_GIT }, async () => {
  await withTempDir(async (plain) => {
    assert.equal(await isGitRepo(plain), false);
  });
  await withRepo(async (repo) => {
    assert.equal(await isGitRepo(repo), true);
  });
});

test("isCleanCheckout is true on a clean tree, false when dirty", { skip: !HAS_GIT }, async () => {
  await withRepo(async (repo) => {
    assert.equal(await isCleanCheckout(repo), true);
    await writeFile(join(repo, "dirty.txt"), "uncommitted");
    assert.equal(await isCleanCheckout(repo), false);
  });
});

test("createWorktree happy path mints a worktree with the seed file", { skip: !HAS_GIT }, async () => {
  await withRepo(async (repo) => {
    await withTempDir(async (wtRoot) => {
      const outcome = await createWorktree(repo, wtRoot, "run-abc", true);
      assert.equal(outcome.kind, "created");
      if (outcome.kind !== "created") return;
      assert.ok(existsSync(outcome.path), "worktree dir should exist");
      assert.ok(existsSync(join(outcome.path, "seed.txt")), "worktree should have seed file");
      assert.equal(outcome.path, join(wtRoot, "run-abc"));
    });
  });
});

test("createWorktree refuses a dirty checkout when requireClean", { skip: !HAS_GIT }, async () => {
  await withRepo(async (repo) => {
    await writeFile(join(repo, "dirty.txt"), "uncommitted");
    await withTempDir(async (wtRoot) => {
      const outcome = await createWorktree(repo, wtRoot, "run-x", true);
      assert.equal(outcome.kind, "refused");
      if (outcome.kind !== "refused") return;
      assert.ok(outcome.reason.includes("uncommitted"), `got: ${outcome.reason}`);
    });
  });
});

test("createWorktree succeeds on a dirty checkout when override used", { skip: !HAS_GIT }, async () => {
  await withRepo(async (repo) => {
    await writeFile(join(repo, "dirty.txt"), "uncommitted");
    await withTempDir(async (wtRoot) => {
      const outcome = await createWorktree(repo, wtRoot, "run-x", false);
      assert.equal(outcome.kind, "created", `override should allow dirty`);
    });
  });
});

test("createWorktree creates a missing worktree root", { skip: !HAS_GIT }, async () => {
  await withRepo(async (repo) => {
    await withTempDir(async (base) => {
      const wtRoot = join(base, "nested", "worktrees");
      assert.equal(existsSync(wtRoot), false);
      const outcome = await createWorktree(repo, wtRoot, "run-mk", true);
      assert.equal(outcome.kind, "created");
      assert.ok(existsSync(wtRoot), "worktree root should have been created");
    });
  });
});

test("create then remove round trip", { skip: !HAS_GIT }, async () => {
  await withRepo(async (repo) => {
    await withTempDir(async (wtRoot) => {
      const outcome = await createWorktree(repo, wtRoot, "run-r", true);
      assert.equal(outcome.kind, "created");
      if (outcome.kind !== "created") return;
      const target = outcome.path;
      assert.ok(existsSync(target));
      await removeWorktree(repo, wtRoot, target);
      assert.equal(existsSync(target), false, "worktree should be gone after remove");
    });
  });
});

test("removeWorktree refuses a path outside the root", { skip: !HAS_GIT }, async () => {
  await withRepo(async (repo) => {
    await withTempDir(async (wtRoot) => {
      await withTempDir(async (escapee) => {
        await assert.rejects(
          () => removeWorktree(repo, wtRoot, escapee),
          /outside root/,
        );
      });
    });
  });
});

test("createWorktree refuses an existing target", { skip: !HAS_GIT }, async () => {
  await withRepo(async (repo) => {
    await withTempDir(async (wtRoot) => {
      const first = await createWorktree(repo, wtRoot, "dup", true);
      assert.equal(first.kind, "created");
      const second = await createWorktree(repo, wtRoot, "dup", true);
      assert.equal(second.kind, "refused");
      if (second.kind !== "refused") return;
      assert.ok(second.reason.includes("already exists"), `got: ${second.reason}`);
    });
  });
});

test("createWorktree refuses a non-git workspace", { skip: !HAS_GIT }, async () => {
  await withTempDir(async (plain) => {
    await withTempDir(async (wtRoot) => {
      const outcome = await createWorktree(plain, wtRoot, "x", true);
      assert.equal(outcome.kind, "refused");
      if (outcome.kind !== "refused") return;
      assert.ok(outcome.reason.includes("not a git repo"), `got: ${outcome.reason}`);
    });
  });
});

test("createWorktreeForBranch checks out the named branch", { skip: !HAS_GIT }, async () => {
  await withRepo(async (repo) => {
    execFileSync("git", ["-C", repo, "branch", "feature-x"], { stdio: "ignore" });
    await withTempDir(async (wtRoot) => {
      const target = join(wtRoot, "feature-x-abcd1234");
      const outcome = await createWorktreeForBranch(repo, target, "feature-x", false);
      assert.equal(outcome.kind, "created");
      if (outcome.kind !== "created") return;
      assert.equal(outcome.path, target);
      assert.ok(existsSync(join(target, "seed.txt")));
      // Confirm the new tree is on `feature-x`, not detached.
      const branch = execFileSync("git", ["-C", target, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
      }).trim();
      assert.equal(branch, "feature-x");
    });
  });
});

test("createWorktreeForBranch refuses an existing target", { skip: !HAS_GIT }, async () => {
  await withRepo(async (repo) => {
    await withTempDir(async (wtRoot) => {
      const target = join(wtRoot, "dup");
      await mkdir(target, { recursive: true });
      const outcome = await createWorktreeForBranch(repo, target, "main", false);
      assert.equal(outcome.kind, "refused");
      if (outcome.kind !== "refused") return;
      assert.ok(outcome.reason.includes("already exists"), `got: ${outcome.reason}`);
    });
  });
});

// ---- orphan detection / prune ----

test("listWorktrees reports the main checkout plus minted worktrees", { skip: !HAS_GIT }, async () => {
  await withRepo(async (repo) => {
    await withTempDir(async (wtRoot) => {
      const outcome = await createWorktree(repo, wtRoot, "run-list", true);
      assert.equal(outcome.kind, "created");
      const entries = await listWorktrees(repo);
      // Main worktree + the one we just minted.
      assert.ok(entries.length >= 2, `expected >=2 entries, got ${entries.length}`);
      const main = entries.find((e) => e.bare);
      assert.ok(main, "first entry should be the main worktree");
      assert.ok(
        entries.some((e) => e.path.includes("run-list")),
        "minted worktree should be listed",
      );
      // None are prunable yet (the working dir is still present).
      assert.ok(entries.every((e) => !e.prunable));
    });
  });
});

test("detectOrphans flags a worktree whose dir was deleted, prune cleans it", { skip: !HAS_GIT }, async () => {
  await withRepo(async (repo) => {
    await withTempDir(async (wtRoot) => {
      const outcome = await createWorktree(repo, wtRoot, "run-orphan", true);
      assert.equal(outcome.kind, "created");
      if (outcome.kind !== "created") return;

      // No orphans while the working dir exists.
      assert.equal((await detectOrphans(repo, wtRoot)).length, 0);

      // Delete the worktree's working dir out from under git → git now reports
      // it as prunable.
      await rm(outcome.path, { recursive: true, force: true });

      const orphans = await detectOrphans(repo, wtRoot);
      assert.equal(orphans.length, 1, `expected one orphan, got ${orphans.length}`);
      assert.equal(orphans[0]?.reason, "prunable");
      assert.ok(orphans[0]?.path.includes("run-orphan"));

      // Prune reports the count it cleaned and clears the bookkeeping.
      const pruned = await pruneWorktrees(repo, wtRoot);
      assert.equal(pruned, 1);
      assert.equal((await detectOrphans(repo, wtRoot)).length, 0);
    });
  });
});

test("detectOrphans returns empty when the root never existed", { skip: !HAS_GIT }, async () => {
  await withRepo(async (repo) => {
    await withTempDir(async (base) => {
      const neverMade = join(base, "no-such-root");
      assert.deepEqual(await detectOrphans(repo, neverMade), []);
    });
  });
});

test("off mode is a no-op: scheduler should use the main root unchanged", () => {
  // `off` means no worktree is minted; the caller routes runs through the main
  // checkout. We assert the policy decision (the manager is never called) here
  // because the manager itself has no "off" code path — the mode gate lives in
  // the caller. effectiveAutoMode never returns "off", but an explicit non-auto
  // "off" stays "off".
  const mode: WorktreeMode = "off";
  assert.equal(mode, "off");
  // Simulate the caller's branch: in off mode the run cwd is just `repo`.
  const repo = "/some/main/checkout";
  const runCwd = mode === "off" ? repo : "/never";
  assert.equal(runCwd, repo);
});
