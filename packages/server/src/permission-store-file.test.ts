import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FilePermissionStore } from "./permission-store-file.ts";

async function withDirs(
  fn: (dirs: { project: string; user: string; store: FilePermissionStore }) => Promise<void>,
  defaultMode?: "ask" | "auto",
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "jarvis-perms-"));
  const project = path.join(root, "workspace", ".jarvis", "permissions.json");
  const user = path.join(root, "config", "jarvis", "permissions.json");
  const store = new FilePermissionStore({
    projectPath: project,
    userPath: user,
    ...(defaultMode ? { defaultMode } : {}),
  });
  try {
    await fn({ project, user, store });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeJson(target: string, body: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(body), "utf8");
}

test("absent files → the seeded session default, empty buckets", async () => {
  await withDirs(async ({ store }) => {
    const table = await store.snapshot();
    assert.equal(table.default_mode, "auto");
    assert.deepEqual([table.deny, table.ask, table.allow], [[], [], []]);
  }, "auto");
});

test("default_mode priority is user > project > session", async () => {
  await withDirs(async ({ project, user, store }) => {
    await writeJson(project, { default_mode: "accept-edits" });
    assert.equal((await store.snapshot()).default_mode, "accept-edits");
    await writeJson(user, { default_mode: "plan" });
    assert.equal((await store.snapshot()).default_mode, "plan");
  }, "ask");
});

test("rules merge user-first and carry their scope", async () => {
  await withDirs(async ({ project, user, store }) => {
    await writeJson(project, { allow: [{ tool: "git.status" }] });
    await writeJson(user, { allow: [{ tool: "fs.edit" }] });
    await store.appendRule("session", "allow", { tool: "echo" });

    const table = await store.snapshot();
    assert.deepEqual(
      table.allow.map((r) => [r.scope, r.tool]),
      [
        ["user", "fs.edit"],
        ["project", "git.status"],
        ["session", "echo"],
      ],
    );
  });
});

test("appendRule persists to the scope's file (and leaves the others alone)", async () => {
  await withDirs(async ({ project, user, store }) => {
    await store.appendRule("project", "deny", { tool: "shell.exec", matchers: { "/command": "rm -rf *" } });
    const onDisk = JSON.parse(await readFile(project, "utf8")) as { deny: { tool: string }[] };
    assert.deepEqual(onDisk.deny, [{ tool: "shell.exec", matchers: { "/command": "rm -rf *" } }]);
    // A fresh store over the same paths sees it (no in-process cache).
    const reopened = new FilePermissionStore({ projectPath: project, userPath: user });
    assert.equal((await reopened.snapshot()).deny.length, 1);
  });
});

test("deleteRule addresses the merged bucket and removes from the owning scope", async () => {
  await withDirs(async ({ project, user, store }) => {
    await writeJson(user, { allow: [{ tool: "fs.edit" }] });
    await writeJson(project, { allow: [{ tool: "git.status" }, { tool: "code.grep" }] });

    // Merged order: [user fs.edit, project git.status, project code.grep].
    await store.deleteRule("project", "allow", 1);
    const table = await store.snapshot();
    assert.deepEqual(
      table.allow.map((r) => r.tool),
      ["fs.edit", "code.grep"],
    );
    const onDisk = JSON.parse(await readFile(project, "utf8")) as { allow: { tool: string }[] };
    assert.deepEqual(onDisk.allow, [{ tool: "code.grep" }]);
  });
});

test("deleteRule rejects an index that belongs to another scope, and an OOB one", async () => {
  await withDirs(async ({ user, project, store }) => {
    await writeJson(user, { allow: [{ tool: "fs.edit" }] });
    await writeJson(project, { allow: [{ tool: "git.status" }] });
    // Index 0 is the user rule — deleting it "as project" must not silently
    // remove the project rule that happens to sit next to it.
    await assert.rejects(() => store.deleteRule("project", "allow", 0), /out of bounds/);
    await assert.rejects(() => store.deleteRule("user", "allow", 9), /out of bounds/);
    assert.equal((await store.snapshot()).allow.length, 2);
  });
});

test("setDefaultMode writes the file; session scope stays in memory", async () => {
  await withDirs(async ({ user, store }) => {
    await store.setDefaultMode("user", "bypass");
    const onDisk = JSON.parse(await readFile(user, "utf8")) as { default_mode: string };
    assert.equal(onDisk.default_mode, "bypass");

    await store.setDefaultMode("session", "plan");
    // The user file still wins over the session default.
    assert.equal((await store.snapshot()).default_mode, "bypass");
  });
});

test("a corrupt or non-object file degrades to empty instead of throwing", async () => {
  await withDirs(async ({ project, user, store }) => {
    await writeJson(user, { allow: [{ tool: "fs.edit" }] });
    await mkdir(path.dirname(project), { recursive: true });
    await writeFile(project, "{ not json", "utf8");
    const table = await store.snapshot();
    assert.deepEqual(
      table.allow.map((r) => r.tool),
      ["fs.edit"],
    );
  });
});

test("an unconfigured scope refuses writes rather than silently dropping them", async () => {
  const store = new FilePermissionStore({ defaultMode: "ask" });
  await assert.rejects(() => store.appendRule("user", "allow", { tool: "fs.edit" }), /not configured/);
  await assert.rejects(() => store.setDefaultMode("project", "auto"), /not configured/);
  // Session scope still works with no paths at all.
  await store.appendRule("session", "allow", { tool: "echo" });
  assert.equal((await store.snapshot()).allow.length, 1);
});
