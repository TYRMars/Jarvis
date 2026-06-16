import { test } from "node:test";
import assert from "node:assert/strict";

import { SkillCatalog, type SkillEntry } from "./catalog.ts";
import type { SkillActivation } from "./manifest.ts";
import {
  pickAutoSkills,
  pickPathMatchSkills,
  queryTokenSet,
  scoreSkill,
} from "./selector.ts";

function entry(
  name: string,
  desc: string,
  keywords: string[],
  activation: SkillActivation,
  paths: string[] = [],
): SkillEntry {
  return {
    manifest: {
      name,
      description: desc,
      allowed_tools: [],
      activation,
      keywords,
      paths,
    },
    body: `body of ${name}`,
    path: `/dev/${name}`,
    source: "workspace",
  };
}

function catalogOf(...entries: SkillEntry[]): SkillCatalog {
  const cat = SkillCatalog.empty();
  for (const e of entries) cat.insert(e);
  return cat;
}

// ---------- scoreSkill ----------

test("scores zero for a manual-activation skill", () => {
  const q = queryTokenSet("pdf invoice");
  assert.equal(scoreSkill("pdf-helper", "PDFs.", ["pdf"], "manual", q), 0);
});

test("keyword weight dominates description tokens", () => {
  const q = queryTokenSet("pdf in the document");
  const withKeyword = scoreSkill("a", "x", ["pdf"], "auto", q);
  const onlyDesc = scoreSkill("b", "pdf is mentioned here", [], "auto", q);
  assert.ok(withKeyword > onlyDesc, "keyword weight should dominate");
});

// ---------- pickAutoSkills ----------

test("CJK keywords match inside longer query tokens", () => {
  const cat = catalogOf(entry("doc", "管理 Jarvis 的文档库。", ["文档", "草稿"], "both"));
  const picks = pickAutoSkills(cat, "帮我写一篇产品需求文档", 2, []);
  assert.deepEqual(picks, ["doc"]);
});

test("picks top-K in score order", () => {
  const cat = catalogOf(
    entry("pdf-helper", "Read PDF files.", ["pdf"], "both"),
    entry("code-review", "Review diffs.", ["review", "diff", "pr"], "both"),
    entry("manual-only", "Should not auto.", ["pdf"], "manual"),
  );

  assert.deepEqual(pickAutoSkills(cat, "Can you review my PR diff?", 2, []), ["code-review"]);

  const picks = pickAutoSkills(cat, "summarise this pdf for me", 2, []);
  assert.deepEqual(picks, ["pdf-helper"]);
  assert.ok(!picks.includes("manual-only"));
});

test("exclude filters already-active skills", () => {
  const cat = catalogOf(entry("pdf-helper", "PDF.", ["pdf"], "auto"));
  assert.deepEqual(pickAutoSkills(cat, "pdf please", 2, ["pdf-helper"]), []);
});

test("empty / whitespace query picks nothing", () => {
  const cat = catalogOf(entry("pdf-helper", "PDF.", ["pdf"], "auto"));
  assert.deepEqual(pickAutoSkills(cat, "   ", 2, []), []);
});

test("topK = 0 picks nothing", () => {
  const cat = catalogOf(entry("pdf-helper", "PDF.", ["pdf"], "auto"));
  assert.deepEqual(pickAutoSkills(cat, "pdf", 0, []), []);
});

test("zero-score skills are dropped", () => {
  const cat = catalogOf(entry("nope", "Totally unrelated.", ["sailboat"], "auto"));
  assert.deepEqual(pickAutoSkills(cat, "review my code", 2, []), []);
});

test("ties break by name", () => {
  const cat = catalogOf(
    entry("zebra", "review!", ["review"], "auto"),
    entry("alpha", "review!", ["review"], "auto"),
  );
  assert.deepEqual(pickAutoSkills(cat, "code review please", 2, []), ["alpha", "zebra"]);
});

// ---------- pickPathMatchSkills ----------

test("path-match picks the skill with a matching glob", () => {
  const cat = catalogOf(
    entry("rs-helper", "Helps with Rust files.", [], "auto", ["**/*.rs"]),
    entry("tsx-helper", "Helps with React.", [], "auto", ["**/*.tsx"]),
  );
  assert.deepEqual(pickPathMatchSkills(cat, ["src/lib.rs"], 5, []), ["rs-helper"]);
});

test("path-match skips manual-only skills", () => {
  const cat = catalogOf(entry("manual-only", "x", [], "manual", ["**/*.rs"]));
  assert.deepEqual(pickPathMatchSkills(cat, ["lib.rs"], 5, []), []);
});

test("path-match dedupes against the manual-active set", () => {
  const cat = catalogOf(entry("rs-helper", "x", [], "auto", ["**/*.rs"]));
  assert.deepEqual(pickPathMatchSkills(cat, ["lib.rs"], 5, ["rs-helper"]), []);
});

test("path-match respects the topK cap", () => {
  const cat = SkillCatalog.empty();
  for (let i = 0; i < 5; i += 1) {
    cat.insert(entry(`rs-${i}`, "x", [], "auto", ["**/*.rs"]));
  }
  assert.equal(pickPathMatchSkills(cat, ["lib.rs"], 2, []).length, 2);
});

test("path-match empty inputs return empty", () => {
  const cat = SkillCatalog.empty();
  assert.deepEqual(pickPathMatchSkills(cat, [], 5, []), []);
  assert.deepEqual(pickPathMatchSkills(cat, ["lib.rs"], 0, []), []);
});

// ---------- queryTokenSet ----------

test("queryTokenSet drops stopwords + 1-char tokens, lowercases", () => {
  const s = queryTokenSet("The Quick A fox");
  assert.ok(s.has("quick"));
  assert.ok(s.has("fox"));
  assert.ok(!s.has("the"));
  assert.ok(!s.has("a"));
});
