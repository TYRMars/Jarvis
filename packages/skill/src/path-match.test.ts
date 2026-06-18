import { test } from "node:test";
import assert from "node:assert/strict";

import { anyGlobMatches, globMatches } from "./path-match.ts";

test("literal matches", () => {
  assert.ok(globMatches("Cargo.toml", "Cargo.toml"));
  assert.ok(!globMatches("Cargo.toml", "Cargo.lock"));
});

test("`*` matches within a segment only", () => {
  assert.ok(globMatches("*.rs", "lib.rs"));
  assert.ok(!globMatches("*.rs", "lib.rs.bak"));
  assert.ok(!globMatches("*.rs", "src/lib.rs"));
});

test("`**` crosses segments", () => {
  assert.ok(globMatches("**/*.tsx", "App.tsx"));
  assert.ok(globMatches("**/*.tsx", "src/components/App.tsx"));
  assert.ok(!globMatches("**/*.tsx", "App.ts"));
});

test("`**` matches zero segments", () => {
  assert.ok(globMatches("**/foo", "foo"));
  assert.ok(globMatches("**/foo", "a/b/foo"));
  assert.ok(!globMatches("**/foo", "foobar"));
});

test("`?` matches exactly one non-slash char", () => {
  assert.ok(globMatches("a?c", "abc"));
  assert.ok(!globMatches("a?c", "ac"));
  assert.ok(!globMatches("a?c", "abbc"));
  assert.ok(!globMatches("a?c", "a/c"));
});

test("`**` in the middle of a pattern", () => {
  assert.ok(globMatches("src/**/*.rs", "src/lib.rs"));
  assert.ok(globMatches("src/**/*.rs", "src/a/b/c.rs"));
  assert.ok(!globMatches("src/**/*.rs", "tests/a.rs"));
});

test("backslashes in the input path are normalised", () => {
  assert.ok(globMatches("src/**/*.rs", "src\\foo\\bar.rs"));
});

test("empty pattern matches only the empty path", () => {
  assert.ok(globMatches("", ""));
  assert.ok(!globMatches("", "x"));
});

test("anyGlobMatches short-circuits", () => {
  const pats = ["*.lock", "**/*.tsx"];
  assert.ok(anyGlobMatches(pats, "src/App.tsx"));
  assert.ok(anyGlobMatches(pats, "Cargo.lock"));
  assert.ok(!anyGlobMatches(pats, "src/lib.rs"));
});

test("anyGlobMatches over an empty pattern list is false", () => {
  assert.ok(!anyGlobMatches([], "anything"));
});
