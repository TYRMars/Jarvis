// Tests for the `memory.*` markdown-memory tools. Ported from the Rust test
// modules in crates/harness-tools/src/memory.rs, memory_include.rs, and
// memory_include_tools.rs.
//
// Deterministic + network-free: every test uses a fresh temp dir (mkdtemp under
// os.tmpdir()). The single git-clone test runs a local bare repo over git's
// safe `file` transport and self-skips when `git` isn't on PATH — no network.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { ToolRegistry } from "@jarvis/core";

import {
  MEMORY_DIR,
  MAX_ENTRY_BYTES,
  MemoryDeleteTool,
  MemoryIncludeAddTool,
  MemoryIncludeListTool,
  MemoryIncludeRefreshTool,
  MemoryIncludeRemoveTool,
  MemoryListTool,
  MemoryReadTool,
  MemoryWriteTool,
  MemorySyncTool,
  MemorySyncSetupTool,
  MemorySyncStatusTool,
  MemoryICloudSetupTool,
  memorySyncBackendFromWire,
  addIncludeLine,
  directiveAsWire,
  parseIncludeDirectives,
  parseIncludeTarget,
  readIndex,
  registerMemoryTools,
  removeIncludeLine,
  resolveInclude,
  validateGitUrl,
  validateSlug,
} from "./memory-tools.ts";

// ---------- temp-dir scaffolding -------------------------------------------

let tmpRoots: string[] = [];

beforeEach(() => {
  tmpRoots = [];
});

afterEach(async () => {
  for (const dir of tmpRoots) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tmpRoots = [];
});

async function mkTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jarvis-mem-"));
  tmpRoots.push(dir);
  return dir;
}

function wsRoots(root: string) {
  return { workspaceRoot: root };
}

function dualRoots(ws: string, user: string) {
  return { workspaceRoot: ws, userRoot: user };
}

async function readFileOrUndefined(p: string): Promise<string | undefined> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return undefined;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------- slug validation -------------------------------------------------

test("slug validation rejects path traversal and reserved tokens", () => {
  for (const bad of ["../etc", "a/b", "..", "", "memory", "MEMORY", ".hidden", "x".repeat(65)]) {
    assert.throws(() => validateSlug(bad), /.*/, `expected reject: ${JSON.stringify(bad)}`);
  }
  for (const ok of ["user-prefs", "auth_flow", "api.v2", "abc"]) {
    assert.doesNotThrow(() => validateSlug(ok), `expected ok: ${ok}`);
  }
});

// ---------- write / read / delete / list (single scope) --------------------

test("write creates index and body", async () => {
  const root = await mkTmp();
  await new MemoryWriteTool(wsRoots(root)).invoke({
    slug: "user-prefs",
    summary: "User prefers Rust + tokio",
    content: "Always pick Rust over Python for this user's projects.",
  });
  const index = await readIndex(root);
  assert.ok(index !== undefined);
  assert.ok(index.includes("user-prefs.md"));
  assert.ok(index.includes("User prefers Rust + tokio"));
  const body = await fs.readFile(path.join(root, MEMORY_DIR, "user-prefs.md"), "utf8");
  assert.ok(body.includes("Always pick Rust"));
});

test("write same slug replaces index line, not appends", async () => {
  const root = await mkTmp();
  const tool = new MemoryWriteTool(wsRoots(root));
  await tool.invoke({ slug: "x", summary: "first", content: "v1" });
  await tool.invoke({ slug: "x", summary: "second", content: "v2" });
  const index = await readIndex(root);
  assert.ok(index !== undefined);
  const matches = index.split("\n").filter((l) => l.includes("x.md"));
  assert.equal(matches.length, 1, `index = ${JSON.stringify(index)}`);
  assert.ok(matches[0]!.includes("second"));
});

test("delete removes body and index line", async () => {
  const root = await mkTmp();
  await new MemoryWriteTool(wsRoots(root)).invoke({ slug: "a", summary: "A", content: "." });
  await new MemoryWriteTool(wsRoots(root)).invoke({ slug: "b", summary: "B", content: "." });
  await new MemoryDeleteTool(wsRoots(root)).invoke({ slug: "a" });
  const index = await readIndex(root);
  assert.ok(index !== undefined);
  assert.ok(!index.includes("a.md"));
  assert.ok(index.includes("b.md"));
  assert.ok(!(await pathExists(path.join(root, MEMORY_DIR, "a.md"))));
});

test("delete last entry clears index file", async () => {
  const root = await mkTmp();
  await new MemoryWriteTool(wsRoots(root)).invoke({ slug: "a", summary: "A", content: "." });
  await new MemoryDeleteTool(wsRoots(root)).invoke({ slug: "a" });
  // Index file removed entirely; list returns the empty sentinel.
  const body = await new MemoryListTool(wsRoots(root)).invoke({});
  assert.ok(body.includes("no entries yet"));
  assert.ok(!(await pathExists(path.join(root, MEMORY_DIR, "MEMORY.md"))));
});

test("write rejects oversized content", async () => {
  const root = await mkTmp();
  const huge = "x".repeat(MAX_ENTRY_BYTES + 1);
  await assert.rejects(
    () => new MemoryWriteTool(wsRoots(root)).invoke({ slug: "big", summary: "big", content: huge }),
    /content too large/,
  );
});

test("write rejects multi-line summary", async () => {
  const root = await mkTmp();
  await assert.rejects(
    () =>
      new MemoryWriteTool(wsRoots(root)).invoke({
        slug: "x",
        summary: "line one\nline two",
        content: ".",
      }),
    /single line/,
  );
});

test("read returns error for unknown slug", async () => {
  const root = await mkTmp();
  await assert.rejects(
    () => new MemoryReadTool(wsRoots(root)).invoke({ slug: "nope" }),
    /no memory entry/,
  );
});

test("read returns the exact body written", async () => {
  const root = await mkTmp();
  await new MemoryWriteTool(wsRoots(root)).invoke({
    slug: "topic",
    summary: "s",
    content: "the exact body\nwith two lines",
  });
  const body = await new MemoryReadTool(wsRoots(root)).invoke({ slug: "topic" });
  assert.equal(body, "the exact body\nwith two lines");
});

test("list on empty workspace returns sentinel", async () => {
  const root = await mkTmp();
  const body = await new MemoryListTool(wsRoots(root)).invoke({});
  assert.ok(body.includes("no entries yet") || body.includes("no memory entries"));
});

// ---------- dual-scope ------------------------------------------------------

test("user scope writes to user root", async () => {
  const ws = await mkTmp();
  const user = await mkTmp();
  await new MemoryWriteTool(dualRoots(ws, user)).invoke({
    slug: "prefs",
    summary: "User prefers pnpm",
    content: "Always use pnpm for npm-style projects.",
    scope: "user",
  });
  assert.ok(await pathExists(path.join(user, MEMORY_DIR, "prefs.md")));
  assert.ok(!(await pathExists(path.join(ws, MEMORY_DIR, "prefs.md"))));
  const userIndex = await readIndex(user);
  assert.ok(userIndex !== undefined && userIndex.includes("prefs.md"));
  // Workspace index untouched.
  assert.equal(await readIndex(ws), undefined);
});

test("read falls back to user scope when workspace misses", async () => {
  const ws = await mkTmp();
  const user = await mkTmp();
  await new MemoryWriteTool(dualRoots(ws, user)).invoke({
    slug: "prefs",
    summary: "P",
    content: "user-side body",
    scope: "user",
  });
  const body = await new MemoryReadTool(dualRoots(ws, user)).invoke({ slug: "prefs" });
  assert.equal(body, "user-side body");
});

test("read workspace first then user", async () => {
  const ws = await mkTmp();
  const user = await mkTmp();
  const roots = dualRoots(ws, user);
  await new MemoryWriteTool(roots).invoke({ slug: "x", summary: "ws", content: "workspace body" });
  await new MemoryWriteTool(roots).invoke({
    slug: "x",
    summary: "u",
    content: "user body",
    scope: "user",
  });
  // Default read → workspace wins.
  assert.equal(await new MemoryReadTool(roots).invoke({ slug: "x" }), "workspace body");
  // Explicit scope → user.
  assert.equal(await new MemoryReadTool(roots).invoke({ slug: "x", scope: "user" }), "user body");
});

test("list renders both scopes by default", async () => {
  const ws = await mkTmp();
  const user = await mkTmp();
  const roots = dualRoots(ws, user);
  await new MemoryWriteTool(roots).invoke({ slug: "proj", summary: "project fact", content: "." });
  await new MemoryWriteTool(roots).invoke({
    slug: "pref",
    summary: "user fact",
    content: ".",
    scope: "user",
  });
  const body = await new MemoryListTool(roots).invoke({});
  assert.ok(body.includes("project memory"));
  assert.ok(body.includes("user memory"));
  assert.ok(body.includes("project fact"));
  assert.ok(body.includes("user fact"));
});

test("user-scope write errors cleanly when not configured", async () => {
  const ws = await mkTmp();
  await assert.rejects(
    () =>
      new MemoryWriteTool(wsRoots(ws)).invoke({
        slug: "x",
        summary: "x",
        content: ".",
        scope: "user",
      }),
    /user-scope memory is not configured/,
  );
});

test("invalid scope arg returns clear error", async () => {
  const ws = await mkTmp();
  await assert.rejects(
    () =>
      new MemoryWriteTool(wsRoots(ws)).invoke({
        slug: "x",
        summary: "x",
        content: ".",
        scope: "global",
      }),
    /unknown scope/,
  );
});

// ---------- include directive parsing (pure functions) ---------------------

test("parse local path target", () => {
  const d = parseIncludeTarget("/Users/x/mem");
  assert.deepEqual(d, { kind: "local_path", path: "/Users/x/mem" });
});

test("parse tilde path target", () => {
  const d = parseIncludeTarget("~/jarvis-mem");
  assert.deepEqual(d, { kind: "local_path", path: "~/jarvis-mem" });
});

test("parse git url with no branch", () => {
  const d = parseIncludeTarget("git+https://host/r.git");
  assert.deepEqual(d, { kind: "git_url", url: "https://host/r.git" });
});

test("parse git url with branch", () => {
  const d = parseIncludeTarget("git+https://host/r.git#dev");
  assert.deepEqual(d, { kind: "git_url", url: "https://host/r.git", branch: "dev" });
});

test("empty target returns undefined", () => {
  assert.equal(parseIncludeTarget("   "), undefined);
});

test("validateGitUrl allows normal forms", () => {
  for (const ok of [
    "https://github.com/me/repo.git",
    "ssh://git@github.com/me/repo.git",
    "git://host/r.git",
    "file:///srv/git/r.git",
    "git@github.com:me/repo.git",
    "/tmp/local/bare/repo",
    "./relative/repo",
    "ssh://git@[::1]:22/r.git",
  ]) {
    assert.doesNotThrow(() => validateGitUrl(ok), `expected ok: ${ok}`);
  }
});

test("validateGitUrl rejects command-executing transports", () => {
  for (const bad of ["ext::sh -c id", "fd::17/foo", "-upload-pack=evil", "--foo"]) {
    assert.throws(() => validateGitUrl(bad), /.*/, `expected err: ${bad}`);
  }
});

test("parseIncludeTarget drops command-executing git transport", () => {
  assert.equal(parseIncludeTarget("git+ext::sh -c id"), undefined);
});

test("parse directives from MEMORY.md skips non-directives", () => {
  const text =
    "<!-- jarvis-include: /a -->\n<!-- jarvis-include: ~/b -->\n\n# Real content\n" +
    "- [x](x.md)\n<!-- jarvis-include: git+https://h/r.git -->\n";
  const d = parseIncludeDirectives(text);
  assert.equal(d.length, 3);
  assert.deepEqual(d[0], { kind: "local_path", path: "/a" });
  assert.deepEqual(d[1], { kind: "local_path", path: "~/b" });
  assert.equal(d[2]!.kind, "git_url");
  assert.equal(d[2]!.kind === "git_url" ? d[2].url : "", "https://h/r.git");
});

test("addIncludeLine is idempotent", () => {
  const body = "<!-- jarvis-include: /a -->\n\n- [x](x.md)\n";
  const next = addIncludeLine(body, { kind: "local_path", path: "/a" });
  assert.equal(next, body);
});

test("addIncludeLine appends above body", () => {
  const body = "- [x](x.md)\n";
  const next = addIncludeLine(body, { kind: "local_path", path: "/a" });
  assert.ok(next.startsWith("<!-- jarvis-include: /a -->\n"));
  assert.ok(next.includes("- [x](x.md)"));
});

test("removeIncludeLine strips matching line", () => {
  const body = "<!-- jarvis-include: /a -->\n<!-- jarvis-include: /b -->\n- [x](x.md)\n";
  const next = removeIncludeLine(body, "/a");
  assert.ok(!next.includes("/a"));
  assert.ok(next.includes("/b"));
});

test("directiveAsWire round-trips git+url#branch", () => {
  assert.equal(
    directiveAsWire({ kind: "git_url", url: "https://h/r.git", branch: "dev" }),
    "git+https://h/r.git#dev",
  );
  assert.equal(
    directiveAsWire({ kind: "git_url", url: "https://h/r.git" }),
    "git+https://h/r.git",
  );
});

// ---------- resolveInclude (local) -----------------------------------------

test("resolve local direct MEMORY.md", async () => {
  const dir = await mkTmp();
  await fs.writeFile(path.join(dir, "MEMORY.md"), "- [a](a.md)");
  const resolved = await resolveInclude({ kind: "local_path", path: dir }, "/dev/null");
  assert.equal(resolved, dir);
});

test("resolve local workspace layout", async () => {
  const dir = await mkTmp();
  const mem = path.join(dir, MEMORY_DIR);
  await fs.mkdir(mem, { recursive: true });
  await fs.writeFile(path.join(mem, "MEMORY.md"), "- [a](a.md)");
  const resolved = await resolveInclude({ kind: "local_path", path: dir }, "/dev/null");
  assert.equal(resolved, mem);
});

test("resolve local missing returns error", async () => {
  await assert.rejects(
    () =>
      resolveInclude(
        { kind: "local_path", path: "/tmp/does-not-exist-jarvis-include-xyz" },
        "/dev/null",
      ),
    /not found/,
  );
});

test("resolve local no MEMORY.md returns error", async () => {
  const dir = await mkTmp();
  await assert.rejects(
    () => resolveInclude({ kind: "local_path", path: dir }, "/dev/null"),
    /no MEMORY\.md/,
  );
});

// ---------- include tools (via store-less roots) ---------------------------

test("include_add writes a local directive", async () => {
  const workspace = await mkTmp();
  // Need a real local path that resolves cleanly so eager validation passes.
  const upstream = await mkTmp();
  const upstreamMem = path.join(upstream, MEMORY_DIR);
  await fs.mkdir(upstreamMem, { recursive: true });
  await fs.writeFile(path.join(upstreamMem, "MEMORY.md"), "- [foo](foo.md)\n");

  const out = await new MemoryIncludeAddTool(wsRoots(workspace)).invoke({ target: upstream });
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  const body = await fs.readFile(path.join(workspace, MEMORY_DIR, "MEMORY.md"), "utf8");
  assert.ok(body.includes("<!-- jarvis-include: "));
  assert.ok(body.includes(upstream));
});

test("include_add rejects an unresolvable target without writing MEMORY.md", async () => {
  const workspace = await mkTmp();
  await assert.rejects(
    () => new MemoryIncludeAddTool(wsRoots(workspace)).invoke({ target: "/tmp/does-not-exist-include-xyz" }),
    /not found/,
  );
  // Crucially: MEMORY.md was NOT created with a broken directive.
  assert.equal(await readFileOrUndefined(path.join(workspace, MEMORY_DIR, "MEMORY.md")), undefined);
});

test("include_list reports resolution per entry", async () => {
  const workspace = await mkTmp();
  const mem = path.join(workspace, MEMORY_DIR);
  await fs.mkdir(mem, { recursive: true });
  const upstream = await mkTmp();
  const upMem = path.join(upstream, MEMORY_DIR);
  await fs.mkdir(upMem, { recursive: true });
  await fs.writeFile(path.join(upMem, "MEMORY.md"), "- [x](x.md)\n");
  const body =
    `<!-- jarvis-include: ${upstream} -->\n` +
    `<!-- jarvis-include: /tmp/none-${process.pid} -->\n`;
  await fs.writeFile(path.join(mem, "MEMORY.md"), body);
  const out = await new MemoryIncludeListTool(wsRoots(workspace)).invoke({});
  const parsed = JSON.parse(out);
  const items = parsed.items as Array<{ resolves: boolean; error?: string }>;
  assert.equal(items.length, 2);
  assert.equal(items[0]!.resolves, true);
  assert.equal(items[1]!.resolves, false);
  assert.ok(items[1]!.error!.includes("not found"));
});

test("include_remove strips a directive", async () => {
  const workspace = await mkTmp();
  const mem = path.join(workspace, MEMORY_DIR);
  await fs.mkdir(mem, { recursive: true });
  await fs.writeFile(
    path.join(mem, "MEMORY.md"),
    "<!-- jarvis-include: /a -->\n<!-- jarvis-include: /b -->\n",
  );
  await new MemoryIncludeRemoveTool(wsRoots(workspace)).invoke({ target: "/a" });
  const body = await fs.readFile(path.join(mem, "MEMORY.md"), "utf8");
  assert.ok(!body.includes("/a"));
  assert.ok(body.includes("/b"));
});

test("include_refresh rejects local path", async () => {
  const root = await mkTmp();
  await assert.rejects(
    () => new MemoryIncludeRefreshTool(wsRoots(root)).invoke({ target: "/some/path" }),
    /only applies/,
  );
});

// ---------- git clone (local bare repo, self-skips without git) ------------

test("resolve git+url clones a local bare repo over the file transport", async (t) => {
  if (spawnSync("git", ["--version"]).status !== 0) {
    t.skip("git not available");
    return;
  }
  const upstream = await mkTmp();
  const work = await mkTmp();
  const cache = await mkTmp();
  const git = (args: string[], cwd?: string) => {
    const r = spawnSync("git", cwd ? ["-C", cwd, ...args] : args, { stdio: "ignore" });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed`);
  };
  git(["init", "-q", "--bare", "-b", "main", upstream]);
  git(["init", "-q", "-b", "main", work]);
  git(["config", "user.email", "t@t"], work);
  git(["config", "user.name", "T"], work);
  await fs.writeFile(path.join(work, "MEMORY.md"), "- [seed](seed.md)\n");
  git(["add", "-A"], work);
  git(["commit", "-qm", "seed"], work);
  git(["remote", "add", "origin", upstream], work);
  git(["push", "-q", "-u", "origin", "main"], work);

  const resolved = await resolveInclude({ kind: "git_url", url: upstream }, cache);
  const body = await fs.readFile(path.join(resolved, "MEMORY.md"), "utf8");
  assert.ok(body.includes("seed"));
});

// ---------- registration ----------------------------------------------------

test("registerMemoryTools registers the full family with correct gating", () => {
  const registry = new ToolRegistry();
  registerMemoryTools(registry, { workspaceRoot: "/ws", userRoot: "/user" });
  const expected = [
    "memory.list",
    "memory.read",
    "memory.write",
    "memory.delete",
    "memory.include_add",
    "memory.include_list",
    "memory.include_remove",
    "memory.include_refresh",
  ];
  for (const name of expected) {
    assert.ok(registry.has(name), `expected ${name} registered`);
  }
  // Read-only tools are not approval-gated; mutators are.
  const gated = ["memory.write", "memory.delete", "memory.include_add", "memory.include_remove", "memory.include_refresh"];
  const ungated = ["memory.list", "memory.read", "memory.include_list"];
  for (const name of gated) {
    assert.equal(registry.resolve(name)?.requiresApproval, true, `${name} should be gated`);
  }
  for (const name of ungated) {
    assert.notEqual(registry.resolve(name)?.requiresApproval, true, `${name} should be ungated`);
  }
});

// ---------- git/iCloud sync (memory.sync / sync_setup / sync_status) --------

test("memorySyncBackendFromWire parses the wire vocabulary", () => {
  assert.equal(memorySyncBackendFromWire(""), "none");
  assert.equal(memorySyncBackendFromWire("none"), "none");
  assert.equal(memorySyncBackendFromWire("OFF"), "none");
  assert.equal(memorySyncBackendFromWire("disabled"), "none");
  assert.equal(memorySyncBackendFromWire("git"), "git");
  assert.equal(memorySyncBackendFromWire("iCloud"), "icloud");
  assert.equal(memorySyncBackendFromWire("icloud-drive"), "icloud");
  assert.equal(memorySyncBackendFromWire("garbage"), undefined);
});

test("sync_status on a non-repo dir reports is_git_repo:false + a setup hint", async () => {
  const ws = await mkTmp();
  const out = JSON.parse(
    await new MemorySyncStatusTool({ workspaceRoot: ws }).invoke({ scope: "workspace" }),
  );
  assert.equal(out.is_git_repo, false);
  assert.match(out.setup_hint, /not a git repository/);
});

test("sync_setup_icloud errors off macOS", async () => {
  const ws = await mkTmp();
  const tool = new MemoryICloudSetupTool({ workspaceRoot: ws });
  if (process.platform === "darwin") {
    // On macOS the result depends on whether iCloud Drive is enabled — just
    // assert it doesn't throw the platform error.
    try {
      await tool.invoke({});
    } catch (e) {
      assert.doesNotMatch(String(e), /macOS-only/);
    }
  } else {
    await assert.rejects(() => tool.invoke({}), /macOS-only/);
  }
});

test("git sync roundtrip: setup → status → sync → force-update + arg guards", async (t) => {
  if (spawnSync("git", ["--version"]).status !== 0) {
    t.skip("git not available");
    return;
  }
  const git = (args: string[], cwd?: string) => {
    const r = spawnSync("git", cwd ? ["-C", cwd, ...args] : args, { stdio: "ignore" });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed`);
  };

  const ws = await mkTmp();
  const upstream = await mkTmp();
  git(["init", "-q", "--bare", "-b", "main", upstream]);
  const cfg = { workspaceRoot: ws };

  // setup: git init + remote add + seed commit + push.
  const setup = JSON.parse(
    await new MemorySyncSetupTool(cfg).invoke({ scope: "workspace", remote_url: upstream }),
  );
  assert.equal(setup.initialized, true);
  assert.equal(setup.push.ok, true, `push stderr: ${setup.push.stderr}`);

  // status reflects the repo + remote.
  const status = JSON.parse(await new MemorySyncStatusTool(cfg).invoke({ scope: "workspace" }));
  assert.equal(status.is_git_repo, true);
  assert.equal(status.branch, "main");
  assert.equal(status.remote_url, upstream);

  // sync: pull --rebase then push, both clean against the just-pushed remote.
  const sync = JSON.parse(await new MemorySyncTool(cfg).invoke({ scope: "workspace" }));
  assert.equal(sync.pull.ok, true, `pull stderr: ${sync.pull.stderr}`);
  assert.equal(sync.push.ok, true, `push stderr: ${sync.push.stderr}`);
  assert.match(sync.head, /^[0-9a-f]{40}$/);

  // setup again without force → errors (idempotent guard).
  const upstream2 = await mkTmp();
  git(["init", "-q", "--bare", "-b", "main", upstream2]);
  await assert.rejects(
    () => new MemorySyncSetupTool(cfg).invoke({ scope: "workspace", remote_url: upstream2 }),
    /already a git repository/,
  );

  // setup with force → just updates origin in place.
  const forced = JSON.parse(
    await new MemorySyncSetupTool(cfg).invoke({ scope: "workspace", remote_url: upstream2, force: true }),
  );
  assert.equal(forced.initialized, false);
  const status2 = JSON.parse(await new MemorySyncStatusTool(cfg).invoke({ scope: "workspace" }));
  assert.equal(status2.remote_url, upstream2);

  // arg guards: flag-smuggling remote / branch names are rejected.
  await assert.rejects(
    () => new MemorySyncTool(cfg).invoke({ scope: "workspace", remote: "-x" }),
    /invalid remote name/,
  );
  await assert.rejects(
    () => new MemorySyncTool(cfg).invoke({ scope: "workspace", branch: "--upload-pack=evil" }),
    /invalid branch name/,
  );
});
