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

test("many `**` tokens against a non-matching tail resolve quickly (no catastrophic backtracking)", () => {
  // A pattern with a long run of `**` against a path that never satisfies the
  // trailing literal used to explode exponentially and freeze the event loop.
  // With memoization this must return promptly.
  const pattern = "a" + "**".repeat(20) + "b";
  const path = "a" + "x".repeat(60);
  const start = process.hrtime.bigint();
  assert.ok(!globMatches(pattern, path));
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsedMs < 200, `matcher took ${elapsedMs.toFixed(1)}ms, expected < 200ms`);
});

test("collapsed `**` runs still match correctly", () => {
  assert.ok(globMatches("src/****/*.ts", "src/a/b/c.ts"));
  assert.ok(globMatches("a**b", "axyzb"));
  assert.ok(globMatches("a****b", "a/x/y/b"));
  assert.ok(!globMatches("a**b", "axyzc"));
});
