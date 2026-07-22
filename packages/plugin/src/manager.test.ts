// Tests for install / uninstall + ledger. Ported from the `#[cfg(test)]`
// module in crates/harness-plugin/src/manager.rs.
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { SkillCatalog, type SkillEntry } from "@jarvis/skill";
import type { McpClientConfig } from "@jarvis/mcp";

import {
  PluginManager,
  PluginManagerError,
  type McpManagerLike,
  type InstalledPlugin,
} from "./manager.ts";

/** A fake MCP manager: an in-memory prefix→config map matching the seam. */
class FakeMcp implements McpManagerLike {
  readonly slots = new Map<string, McpClientConfig>();
  /** When set, `add` rejects with this error (to exercise rollback). */
  failAddPrefix: string | undefined;

  add(config: McpClientConfig): Promise<string[]> {
    if (this.failAddPrefix !== undefined && config.prefix === this.failAddPrefix) {
      return Promise.reject(new Error(`boom adding ${config.prefix}`));
    }
    this.slots.set(config.prefix, config);
    return Promise.resolve([`${config.prefix}.tool`]);
  }
  remove(prefix: string): Promise<boolean> {
    return Promise.resolve(this.slots.delete(prefix));
  }
  get(prefix: string): Promise<unknown | undefined> {
    return Promise.resolve(this.slots.get(prefix));
  }
}

async function makeTmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "jarvis-plugin-"));
}

async function writePlugin(dir: string, manifestJson: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "plugin.json"), manifestJson);
}

async function writeSkill(
  dir: string,
  name: string,
  frontmatter: string,
  body: string,
): Promise<void> {
  const d = path.join(dir, name);
  await mkdir(d, { recursive: true });
  await writeFile(path.join(d, "SKILL.md"), `---\n${frontmatter}---\n${body}`);
}

function preexistingSkill(name: string): SkillEntry {
  return {
    manifest: {
      name,
      description: "preexisting",
      allowed_tools: [],
      activation: "both",
      keywords: [],
      paths: [],
    },
    body: "x",
    path: "/dev/null",
    source: "user",
  };
}

test("install records skills and writes ledger", async (t) => {
  const staging = await makeTmp();
  t.after(() => rm(staging, { recursive: true, force: true }));

  const pluginSrc = path.join(staging, "src");
  await writePlugin(
    pluginSrc,
    `{
      "name": "demo",
      "version": "0.1.0",
      "description": "Demo plugin.",
      "skills": ["skills/hello"]
    }`,
  );
  await writeSkill(path.join(pluginSrc, "skills"), "hello", "name: hello\ndescription: Says hi.\n", "Body.");

  const installRoot = path.join(staging, "plugins");
  const cat = SkillCatalog.empty();
  const mcp = new FakeMcp();
  const mgr = await PluginManager.open(installRoot, cat, mcp);

  const report = await mgr.installFromPath(pluginSrc);
  assert.deepEqual(report.added_skills, ["hello"]);
  assert.ok(existsSync(path.join(installRoot, "demo", "plugin.json")));
  assert.ok(existsSync(path.join(installRoot, "installed.json")));
  assert.ok(cat.get("hello"));
  // The catalog entry's path is re-pointed at the installed copy.
  assert.equal(
    cat.get("hello")?.path,
    path.join(installRoot, "demo", "skills", "hello", "SKILL.md"),
  );

  const listed = await mgr.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.name, "demo");
  assert.equal(listed[0]?.source_kind, "path");
});

test("duplicate install is rejected", async (t) => {
  const staging = await makeTmp();
  t.after(() => rm(staging, { recursive: true, force: true }));

  const pluginSrc = path.join(staging, "src");
  await writePlugin(pluginSrc, `{ "name": "demo", "version": "0.1.0", "description": "x" }`);

  const mgr = await PluginManager.open(path.join(staging, "plugins"), SkillCatalog.empty(), new FakeMcp());
  await mgr.installFromPath(pluginSrc);
  await assert.rejects(
    () => mgr.installFromPath(pluginSrc),
    (e: unknown) => e instanceof PluginManagerError && e.kind === "already_installed",
  );
});

test("skill conflict blocks install and leaves original", async (t) => {
  const staging = await makeTmp();
  t.after(() => rm(staging, { recursive: true, force: true }));

  const pluginSrc = path.join(staging, "src");
  await writePlugin(
    pluginSrc,
    `{ "name": "demo", "version": "0.1.0", "description": "x", "skills": ["skills/hello"] }`,
  );
  await writeSkill(path.join(pluginSrc, "skills"), "hello", "name: hello\ndescription: y\n", "Body.");

  const cat = SkillCatalog.empty();
  cat.insert(preexistingSkill("hello"));

  const mgr = await PluginManager.open(path.join(staging, "plugins"), cat, new FakeMcp());
  await assert.rejects(
    () => mgr.installFromPath(pluginSrc),
    (e: unknown) =>
      e instanceof PluginManagerError && e.kind === "conflict" && e.conflictKind === "skill",
  );
  // Original (preexisting) entry intact; no plugin recorded.
  assert.equal(cat.get("hello")?.body, "x");
  assert.equal((await mgr.list()).length, 0);
});

test("mcp prefix conflict blocks install", async (t) => {
  const staging = await makeTmp();
  t.after(() => rm(staging, { recursive: true, force: true }));

  const pluginSrc = path.join(staging, "src");
  await writePlugin(
    pluginSrc,
    `{
      "name": "demo", "version": "0.1.0", "description": "x",
      "mcp_servers": { "gh": { "transport": { "type": "stdio", "command": "uvx" } } }
    }`,
  );

  const mcp = new FakeMcp();
  // Pre-seed the conflicting prefix.
  mcp.slots.set("gh", { prefix: "gh", transport: { type: "stdio", command: "x" } });

  const mgr = await PluginManager.open(path.join(staging, "plugins"), SkillCatalog.empty(), mcp);
  await assert.rejects(
    () => mgr.installFromPath(pluginSrc),
    (e: unknown) =>
      e instanceof PluginManagerError && e.kind === "conflict" && e.conflictKind === "mcp prefix",
  );
});

test("install adds mcp servers with prefix forced to map key", async (t) => {
  const staging = await makeTmp();
  t.after(() => rm(staging, { recursive: true, force: true }));

  const pluginSrc = path.join(staging, "src");
  await writePlugin(
    pluginSrc,
    `{
      "name": "demo", "version": "0.1.0", "description": "x",
      "mcp_servers": {
        "gh": { "prefix": "ignored", "transport": { "type": "stdio", "command": "uvx", "args": ["x"] } }
      }
    }`,
  );

  const mcp = new FakeMcp();
  const mgr = await PluginManager.open(path.join(staging, "plugins"), SkillCatalog.empty(), mcp);
  const report = await mgr.installFromPath(pluginSrc);
  assert.deepEqual(report.added_mcp, ["gh"]);
  assert.ok(mcp.slots.has("gh"));
  assert.equal(mcp.slots.get("gh")?.prefix, "gh");
});

test("mcp add failure rolls back skills, mcp, and install dir", async (t) => {
  const staging = await makeTmp();
  t.after(() => rm(staging, { recursive: true, force: true }));

  const pluginSrc = path.join(staging, "src");
  await writePlugin(
    pluginSrc,
    `{
      "name": "demo", "version": "0.1.0", "description": "x",
      "skills": ["skills/hello"],
      "mcp_servers": {
        "aaa": { "transport": { "type": "stdio", "command": "uvx" } },
        "bbb": { "transport": { "type": "stdio", "command": "uvx" } }
      }
    }`,
  );
  await writeSkill(path.join(pluginSrc, "skills"), "hello", "name: hello\ndescription: y\n", "Body.");

  const cat = SkillCatalog.empty();
  const mcp = new FakeMcp();
  mcp.failAddPrefix = "bbb"; // "aaa" added, then "bbb" fails → roll back all.

  const installRoot = path.join(staging, "plugins");
  const mgr = await PluginManager.open(installRoot, cat, mcp);
  await assert.rejects(
    () => mgr.installFromPath(pluginSrc),
    (e: unknown) => e instanceof PluginManagerError && e.kind === "mcp",
  );
  // Skill pulled, the one successful mcp add removed, install dir gone.
  assert.equal(cat.get("hello"), undefined);
  assert.equal(mcp.slots.size, 0);
  assert.equal(existsSync(path.join(installRoot, "demo")), false);
  assert.equal((await mgr.list()).length, 0);
});

test("uninstall pulls skills, mcp servers, and dir", async (t) => {
  const staging = await makeTmp();
  t.after(() => rm(staging, { recursive: true, force: true }));

  const pluginSrc = path.join(staging, "src");
  await writePlugin(
    pluginSrc,
    `{
      "name": "demo", "version": "0.1.0", "description": "x",
      "skills": ["skills/hello"],
      "mcp_servers": { "gh": { "transport": { "type": "stdio", "command": "uvx" } } }
    }`,
  );
  await writeSkill(path.join(pluginSrc, "skills"), "hello", "name: hello\ndescription: y\n", "Body.");

  const cat = SkillCatalog.empty();
  const mcp = new FakeMcp();
  const installRoot = path.join(staging, "plugins");
  const mgr = await PluginManager.open(installRoot, cat, mcp);
  await mgr.installFromPath(pluginSrc);
  assert.ok(cat.get("hello"));
  assert.ok(mcp.slots.has("gh"));

  await mgr.uninstall("demo");
  assert.equal(cat.get("hello"), undefined);
  assert.equal(mcp.slots.has("gh"), false);
  assert.equal(await mgr.get("demo"), undefined);
  assert.equal(existsSync(path.join(installRoot, "demo")), false);
});

test("uninstall of an unknown plugin rejects", async (t) => {
  const staging = await makeTmp();
  t.after(() => rm(staging, { recursive: true, force: true }));

  const mgr = await PluginManager.open(path.join(staging, "plugins"), SkillCatalog.empty(), new FakeMcp());
  await assert.rejects(
    () => mgr.uninstall("nope"),
    (e: unknown) => e instanceof PluginManagerError && e.kind === "not_installed",
  );
});

test("ledger survives a fresh manager (reload from disk)", async (t) => {
  const staging = await makeTmp();
  t.after(() => rm(staging, { recursive: true, force: true }));

  const pluginSrc = path.join(staging, "src");
  await writePlugin(pluginSrc, `{ "name": "demo", "version": "0.2.0", "description": "x" }`);

  const installRoot = path.join(staging, "plugins");
  const mgr1 = await PluginManager.open(installRoot, SkillCatalog.empty(), new FakeMcp());
  await mgr1.installFromPath(pluginSrc);

  // Second manager over the same root re-reads installed.json.
  const mgr2 = await PluginManager.open(installRoot, SkillCatalog.empty(), new FakeMcp());
  const listed = await mgr2.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.name, "demo");
  assert.equal(listed[0]?.version, "0.2.0");
});

test("reattachInstalled re-registers skills and mcp from the ledger", async (t) => {
  const staging = await makeTmp();
  t.after(() => rm(staging, { recursive: true, force: true }));

  const pluginSrc = path.join(staging, "src");
  await writePlugin(
    pluginSrc,
    `{
      "name": "demo", "version": "0.1.0", "description": "x",
      "skills": ["skills/hello"],
      "mcp_servers": { "gh": { "transport": { "type": "stdio", "command": "uvx" } } }
    }`,
  );
  await writeSkill(path.join(pluginSrc, "skills"), "hello", "name: hello\ndescription: y\n", "Body.");

  const installRoot = path.join(staging, "plugins");
  await (await PluginManager.open(installRoot, SkillCatalog.empty(), new FakeMcp())).installFromPath(pluginSrc);

  // Fresh process: empty catalog + mcp, only the ledger persists.
  const cat = SkillCatalog.empty();
  const mcp = new FakeMcp();
  const mgr = await PluginManager.open(installRoot, cat, mcp);
  assert.equal(cat.get("hello"), undefined); // not yet reattached

  await mgr.reattachInstalled();
  assert.ok(cat.get("hello"));
  assert.equal(cat.get("hello")?.source, "plugin");
  assert.ok(mcp.slots.has("gh"));
});

test("reattach isolates one bad SKILL.md — sibling skills + MCP still come up, plugin marked degraded", async (t) => {
  const staging = await makeTmp();
  t.after(() => rm(staging, { recursive: true, force: true }));

  const pluginSrc = path.join(staging, "src");
  await writePlugin(
    pluginSrc,
    `{
      "name": "demo", "version": "0.1.0", "description": "x",
      "skills": ["skills/a", "skills/b"],
      "mcp_servers": { "gh": { "transport": { "type": "stdio", "command": "uvx" } } }
    }`,
  );
  await writeSkill(path.join(pluginSrc, "skills"), "a", "name: a\ndescription: y\n", "A.");
  await writeSkill(path.join(pluginSrc, "skills"), "b", "name: b\ndescription: y\n", "B.");

  const installRoot = path.join(staging, "plugins");
  await (await PluginManager.open(installRoot, SkillCatalog.empty(), new FakeMcp())).installFromPath(
    pluginSrc,
  );

  // The operator corrupts the *installed* copy of skill `a` (unknown frontmatter
  // field → parseSkill throws) — exactly the trigger from the bug report.
  const badSkillMd = path.join(installRoot, "demo", "skills", "a", "SKILL.md");
  await writeFile(badSkillMd, "---\nname: a\ndescription: y\nbogus: true\n---\nA.");

  const cat = SkillCatalog.empty();
  const mcp = new FakeMcp();
  const mgr = await PluginManager.open(installRoot, cat, mcp);
  await mgr.reattachInstalled();

  // The bad skill must NOT take down its siblings or the MCP server.
  assert.equal(cat.get("a"), undefined, "corrupt skill a is skipped");
  assert.ok(cat.get("b"), "sibling skill b still registered");
  assert.ok(mcp.slots.has("gh"), "MCP server still connected despite the bad skill");

  // The failure is surfaced, not silent: the ledger entry reports degraded.
  const listed = await mgr.list();
  assert.equal(listed[0]?.degraded, true);
  assert.match(listed[0]?.last_error ?? "", /skill skills\/a/);
});

test("reattach clears a stale degraded marker once the skill is fixed", async (t) => {
  const staging = await makeTmp();
  t.after(() => rm(staging, { recursive: true, force: true }));

  const pluginSrc = path.join(staging, "src");
  await writePlugin(
    pluginSrc,
    `{ "name": "demo", "version": "0.1.0", "description": "x", "skills": ["skills/a"] }`,
  );
  await writeSkill(path.join(pluginSrc, "skills"), "a", "name: a\ndescription: y\n", "A.");

  const installRoot = path.join(staging, "plugins");
  await (await PluginManager.open(installRoot, SkillCatalog.empty(), new FakeMcp())).installFromPath(
    pluginSrc,
  );

  const badSkillMd = path.join(installRoot, "demo", "skills", "a", "SKILL.md");
  const good = "---\nname: a\ndescription: y\n---\nA.";
  await writeFile(badSkillMd, "---\nname: a\ndescription: y\nbogus: true\n---\nA.");

  const mgr = await PluginManager.open(installRoot, SkillCatalog.empty(), new FakeMcp());
  await mgr.reattachInstalled();
  assert.equal((await mgr.list())[0]?.degraded, true);

  // Operator repairs the file; a subsequent reattach clears the marker.
  await writeFile(badSkillMd, good);
  await mgr.reattachInstalled();
  const listed = await mgr.list();
  assert.notEqual(listed[0]?.degraded, true);
  assert.equal(listed[0]?.last_error, undefined);
});

test("install rejects a directory without plugin.json", async (t) => {
  const staging = await makeTmp();
  t.after(() => rm(staging, { recursive: true, force: true }));

  const emptyDir = path.join(staging, "empty");
  await mkdir(emptyDir, { recursive: true });
  const mgr = await PluginManager.open(path.join(staging, "plugins"), SkillCatalog.empty(), new FakeMcp());
  await assert.rejects(
    () => mgr.installFromPath(emptyDir),
    (e: unknown) => e instanceof PluginManagerError && e.kind === "io",
  );
});

test("ledger entries with absent skill_names/mcp_prefixes default to empty arrays", async (t) => {
  const staging = await makeTmp();
  t.after(() => rm(staging, { recursive: true, force: true }));

  const installRoot = path.join(staging, "plugins");
  await mkdir(installRoot, { recursive: true });
  // Legacy ledger row missing the two optional arrays.
  const legacy: Partial<InstalledPlugin>[] = [
    {
      name: "demo",
      version: "0.1.0",
      description: "x",
      install_dir: path.join(installRoot, "demo"),
      source_kind: "path",
      source_value: "/somewhere",
      installed_at: new Date().toISOString(),
    },
  ];
  await writeFile(path.join(installRoot, "installed.json"), JSON.stringify(legacy));

  const mgr = await PluginManager.open(installRoot, SkillCatalog.empty(), new FakeMcp());
  const entry = await mgr.get("demo");
  assert.ok(entry);
  assert.deepEqual(entry.skill_names, []);
  assert.deepEqual(entry.mcp_prefixes, []);
});

test("install skips symlinks when copying the plugin tree (matches Rust copy_tree)", async (t) => {
  const staging = await makeTmp();
  t.after(() => rm(staging, { recursive: true, force: true }));

  const pluginSrc = path.join(staging, "src");
  await writePlugin(pluginSrc, `{ "name": "demo", "version": "0.1.0", "description": "x" }`);
  // A regular file lands in the install dir; a symlink (here pointing outside
  // the plugin) must NOT — Rust's copy_tree drops symlinks on purpose.
  await writeFile(path.join(pluginSrc, "real.txt"), "keep me");
  const outsideTarget = path.join(staging, "outside-secret.txt");
  await writeFile(outsideTarget, "should never be reachable from install dir");
  await symlink(outsideTarget, path.join(pluginSrc, "link.txt"));

  const installRoot = path.join(staging, "plugins");
  const mgr = await PluginManager.open(installRoot, SkillCatalog.empty(), new FakeMcp());
  await mgr.installFromPath(pluginSrc);

  const installDir = path.join(installRoot, "demo");
  assert.ok(existsSync(path.join(installDir, "real.txt")), "regular file copied");
  assert.equal(
    existsSync(path.join(installDir, "link.txt")),
    false,
    "symlink must be skipped, not copied",
  );
  // Belt-and-braces: even if some FS reported it as existing, it must not be a link.
  if (existsSync(path.join(installDir, "link.txt"))) {
    assert.equal(lstatSync(path.join(installDir, "link.txt")).isSymbolicLink(), false);
  }
});

test("concurrent installs are serialised (no interleave)", async (t) => {
  const staging = await makeTmp();
  t.after(() => rm(staging, { recursive: true, force: true }));

  // Two distinct plugins installed concurrently — both should land.
  const srcA = path.join(staging, "a");
  const srcB = path.join(staging, "b");
  await writePlugin(srcA, `{ "name": "aaa", "version": "0.1.0", "description": "x" }`);
  await writePlugin(srcB, `{ "name": "bbb", "version": "0.1.0", "description": "x" }`);

  const installRoot = path.join(staging, "plugins");
  const mgr = await PluginManager.open(installRoot, SkillCatalog.empty(), new FakeMcp());
  await Promise.all([mgr.installFromPath(srcA), mgr.installFromPath(srcB)]);

  const listed = await mgr.list();
  assert.deepEqual(listed.map((p) => p.name), ["aaa", "bbb"]);
  // Ledger on disk has both, name-sorted.
  const onDisk = JSON.parse(await readFile(path.join(installRoot, "installed.json"), "utf8")) as InstalledPlugin[];
  assert.deepEqual(onDisk.map((p) => p.name), ["aaa", "bbb"]);
});
