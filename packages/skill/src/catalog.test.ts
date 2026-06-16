import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SkillCatalog, type SkillSource } from "./catalog.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "jarvis-skill-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeSkill(root: string, name: string, frontmatter: string, body: string): Promise<void> {
  const d = path.join(root, name);
  await mkdir(d, { recursive: true });
  await writeFile(path.join(d, "SKILL.md"), `---\n${frontmatter}---\n${body}`);
}

test("loads skills from one root, name-ordered", async () => {
  await withTempDir(async (dir) => {
    await writeSkill(dir, "alpha", "name: alpha\ndescription: a\n", "Body A");
    await writeSkill(dir, "beta", "name: beta\ndescription: b\n", "Body B");
    const cat = await SkillCatalog.load([[dir, "user"]]);
    assert.equal(cat.size, 2);
    assert.deepEqual(cat.entries().map((e) => e.manifest.name), ["alpha", "beta"]);
    assert.equal(cat.get("alpha")?.body, "Body A");
    assert.equal(cat.get("alpha")?.source, "user");
  });
});

test("workspace root shadows user root for the same name", async () => {
  await withTempDir(async (user) => {
    await withTempDir(async (project) => {
      await writeSkill(user, "shared", "name: shared\ndescription: user one\n", "USER");
      await writeSkill(project, "shared", "name: shared\ndescription: project one\n", "PROJECT");
      const cat = await SkillCatalog.load([
        [user, "user"],
        [project, "workspace"],
      ]);
      const entry = cat.get("shared");
      assert.equal(entry?.source, "workspace");
      assert.equal(entry?.body, "PROJECT");
      assert.equal(cat.size, 1);
    });
  });
});

test("skips non-skill subdirs and unparseable skills", async () => {
  await withTempDir(async (dir) => {
    await writeSkill(dir, "good", "name: good\ndescription: g\n", "B");
    // Subdir without SKILL.md — silently ignored.
    await mkdir(path.join(dir, "noskill"), { recursive: true });
    // Skill with bad frontmatter — skipped.
    const bad = path.join(dir, "bad");
    await mkdir(bad, { recursive: true });
    await writeFile(path.join(bad, "SKILL.md"), "no frontmatter");

    const cat = await SkillCatalog.load([[dir, "user"]]);
    assert.equal(cat.size, 1);
    assert.ok(cat.get("good"));
  });
});

test("a missing root is silent", async () => {
  const cat = await SkillCatalog.load([
    [path.join(tmpdir(), "nonexistent-jarvis-skill-root", "skills"), "user"],
  ]);
  assert.ok(cat.isEmpty());
});

test("the dir name need not equal the manifest name (keyed by manifest name)", async () => {
  await withTempDir(async (dir) => {
    // Directory `weird-dir` holds a skill whose manifest name is `real-name`.
    await writeSkill(dir, "weird-dir", "name: real-name\ndescription: r\n", "B");
    const cat = await SkillCatalog.load([[dir, "user"]]);
    assert.ok(cat.get("real-name"));
    assert.equal(cat.get("weird-dir"), undefined);
  });
});

// ---------- mergeBundled ----------

const BUNDLED_WORK = "---\nname: work\ndescription: manage projects.\n---\nWORK BODY";
const BUNDLED_DOC = "---\nname: doc\ndescription: manage docs.\n---\nDOC BODY";

test("mergeBundled loads supplied default texts as bundled", () => {
  const cat = SkillCatalog.empty();
  cat.mergeBundled([
    ["work/SKILL.md", BUNDLED_WORK],
    ["doc/SKILL.md", BUNDLED_DOC],
  ]);
  assert.equal(cat.get("work")?.source, "bundled");
  assert.equal(cat.get("doc")?.source, "bundled");
  assert.equal(cat.get("work")?.body, "WORK BODY");
  assert.match(cat.get("work")?.path ?? "", /^<bundled>\/work\/SKILL\.md$/);
});

test("mergeBundled never overwrites an existing entry (lowest precedence)", async () => {
  await withTempDir(async (user) => {
    await writeSkill(user, "work", "name: work\ndescription: user override\n", "USER OVERRIDE");
    const cat = SkillCatalog.empty();
    await cat.mergeDisk(user, "user");
    cat.mergeBundled([
      ["work/SKILL.md", BUNDLED_WORK],
      ["doc/SKILL.md", BUNDLED_DOC],
    ]);
    assert.equal(cat.get("work")?.source, "user");
    assert.equal(cat.get("work")?.body, "USER OVERRIDE");
    // The bundled `doc` still loads (no user override for it).
    assert.equal(cat.get("doc")?.source, "bundled");
  });
});

test("mergeBundled skips an unparseable default text", () => {
  const cat = SkillCatalog.empty();
  cat.mergeBundled([
    ["broken/SKILL.md", "not a skill"],
    ["doc/SKILL.md", BUNDLED_DOC],
  ]);
  assert.equal(cat.size, 1);
  assert.ok(cat.get("doc"));
});

// ---------- insert / remove ----------

test("insert replaces and remove deletes", () => {
  const cat = SkillCatalog.empty();
  const src: SkillSource = "plugin";
  cat.insert({
    manifest: { name: "x", description: "d", allowed_tools: [], activation: "both", keywords: [], paths: [] },
    body: "B",
    path: "/x",
    source: src,
  });
  assert.equal(cat.get("x")?.source, "plugin");
  assert.ok(cat.remove("x"));
  assert.equal(cat.get("x"), undefined);
  assert.ok(!cat.remove("x"));
});
