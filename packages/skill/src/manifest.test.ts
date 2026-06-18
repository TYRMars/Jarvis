import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSkill, type SkillErrorKind, SkillParseError } from "./manifest.ts";

const MAX_DESCRIPTION_BYTES = 1024;

/** Run `fn`, assert it threw a {@link SkillParseError}, and return its `kind`. */
function errKind(fn: () => unknown): SkillErrorKind {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof SkillParseError, `expected SkillParseError, got ${String(e)}`);
    return e.kind;
  }
  throw new assert.AssertionError({ message: "expected the call to throw" });
}

test("parses a minimal skill", () => {
  const text = "---\nname: hello\ndescription: Says hi.\n---\n\nBody goes here.";
  const parsed = parseSkill(text);
  assert.equal(parsed.manifest.name, "hello");
  assert.equal(parsed.manifest.description, "Says hi.");
  assert.equal(parsed.manifest.activation, "both");
  assert.deepEqual(parsed.manifest.keywords, []);
  assert.deepEqual(parsed.manifest.allowed_tools, []);
  assert.deepEqual(parsed.manifest.paths, []);
  assert.equal(parsed.manifest.license, undefined);
  assert.equal(parsed.manifest.version, undefined);
  assert.equal(parsed.body, "Body goes here.");
});

test("parses full frontmatter (allowed-tools, keywords, version, license)", () => {
  const text =
    '---\nname: code-review\ndescription: review diffs.\nlicense: MIT\nactivation: auto\nallowed-tools: ["fs.read", "git.diff"]\nkeywords: [diff, pr, review]\nversion: "0.1.0"\n---\nBody.';
  const p = parseSkill(text);
  assert.equal(p.manifest.activation, "auto");
  assert.deepEqual(p.manifest.allowed_tools, ["fs.read", "git.diff"]);
  assert.deepEqual(p.manifest.keywords, ["diff", "pr", "review"]);
  assert.equal(p.manifest.version, "0.1.0");
  assert.equal(p.manifest.license, "MIT");
  assert.equal(p.body, "Body.");
});

test("parses paths frontmatter", () => {
  const text = '---\nname: tsx\ndescription: react.\npaths: ["**/*.tsx", "Cargo.toml"]\n---\nb';
  const p = parseSkill(text);
  assert.deepEqual(p.manifest.paths, ["**/*.tsx", "Cargo.toml"]);
});

test("rejects missing frontmatter", () => {
  assert.equal(errKind(() => parseSkill("no frontmatter here")), "no_frontmatter");
});

test("rejects unterminated frontmatter", () => {
  assert.equal(
    errKind(() => parseSkill("---\nname: x\ndescription: y\nstill yaml")),
    "unterminated_frontmatter",
  );
});

test("rejects an unknown field (deny_unknown_fields)", () => {
  assert.equal(
    errKind(() => parseSkill("---\nname: x\ndescription: y\nzzz: 1\n---\nbody")),
    "invalid_yaml",
  );
});

test("rejects an invalid (non-kebab) name", () => {
  assert.equal(
    errKind(() => parseSkill("---\nname: Bad_Name\ndescription: y\n---\nbody")),
    "invalid_name",
  );
});

test("rejects a name with a leading or trailing hyphen", () => {
  assert.equal(errKind(() => parseSkill("---\nname: -x\ndescription: y\n---\nb")), "invalid_name");
  assert.equal(errKind(() => parseSkill("---\nname: x-\ndescription: y\n---\nb")), "invalid_name");
});

test("rejects an over-long description", () => {
  const long = "x".repeat(MAX_DESCRIPTION_BYTES + 1);
  assert.equal(
    errKind(() => parseSkill(`---\nname: x\ndescription: ${long}\n---\nbody`)),
    "description_too_long",
  );
});

test("accepts the underscore alias for allowed-tools", () => {
  const text = "---\nname: x\ndescription: y\nallowed_tools: [a, b]\n---\nbody";
  const p = parseSkill(text);
  assert.deepEqual(p.manifest.allowed_tools, ["a", "b"]);
});

test("reports an absent required name as invalid_yaml (serde missing field)", () => {
  // No `name` key at all. Rust `SkillManifest.name` is a plain `String` with
  // no `#[serde(default)]`, so serde_yaml fails to deserialize → InvalidYaml,
  // NOT the `MissingField` validation branch (which only fires for `name: ""`).
  assert.equal(errKind(() => parseSkill("---\ndescription: y\n---\nb")), "invalid_yaml");
});

test("reports an absent required description as invalid_yaml", () => {
  assert.equal(errKind(() => parseSkill("---\nname: x\n---\nb")), "invalid_yaml");
});

test("reports an explicit-empty name as missing_field", () => {
  // `name: ""` deserializes fine (it's a valid String) then trips
  // `validate_manifest`'s `name.is_empty()` check → MissingField.
  assert.equal(errKind(() => parseSkill('---\nname: ""\ndescription: y\n---\nb')), "missing_field");
});

test("reports an explicit-empty description as missing_field", () => {
  assert.equal(errKind(() => parseSkill('---\nname: x\ndescription: ""\n---\nb')), "missing_field");
});

test("reports a null-valued required field as invalid_yaml", () => {
  // `name:` (bare key) is YAML null; a non-Option `String` rejects null at
  // deserialization time in serde → InvalidYaml.
  assert.equal(errKind(() => parseSkill("---\nname:\ndescription: y\n---\nb")), "invalid_yaml");
});

test("strips a leading BOM before the fence", () => {
  const text = "﻿---\nname: x\ndescription: y\n---\nbody";
  const p = parseSkill(text);
  assert.equal(p.manifest.name, "x");
  assert.equal(p.body, "body");
});

test("accepts a CRLF frontmatter fence", () => {
  const text = "---\r\nname: x\r\ndescription: y\r\n---\r\nbody";
  const p = parseSkill(text);
  assert.equal(p.manifest.name, "x");
  assert.equal(p.body, "body");
});

test("strips only the leading blank-line run after the close fence", () => {
  const text = "---\nname: x\ndescription: y\n---\n\n\nfirst line\nsecond";
  const p = parseSkill(text);
  assert.equal(p.body, "first line\nsecond");
});

test("rejects a wrong-typed field", () => {
  assert.equal(
    errKind(() => parseSkill("---\nname: x\ndescription: y\nkeywords: notalist\n---\nb")),
    "invalid_yaml",
  );
});

test("rejects an unknown activation variant", () => {
  assert.equal(
    errKind(() => parseSkill("---\nname: x\ndescription: y\nactivation: sometimes\n---\nb")),
    "invalid_yaml",
  );
});

test("a 64-char name is accepted; 65 is rejected", () => {
  const ok = "a".repeat(64);
  assert.equal(parseSkill(`---\nname: ${ok}\ndescription: y\n---\nb`).manifest.name, ok);
  const tooLong = "a".repeat(65);
  assert.equal(
    errKind(() => parseSkill(`---\nname: ${tooLong}\ndescription: y\n---\nb`)),
    "invalid_name",
  );
});
