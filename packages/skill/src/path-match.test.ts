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

test("pathological `**` pattern does not catastrophically backtrack (DoS guard)", () => {
  // Many `**` tokens against a long tail that never matches the trailing literal
  // is the classic exponential-backtracking shape. With memoization it resolves
  // in well under a second; without it this hangs for minutes (#242).
  const pattern = "a" + "**".repeat(20) + "b";
  const path = "a" + "x".repeat(60); // never ends in `b`
  const start = process.hrtime.bigint();
  assert.ok(!globMatches(pattern, path));
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsedMs < 500, `match took ${elapsedMs.toFixed(1)}ms — expected near-instant`);
});

test("memoization preserves correctness for many-`**` matching cases", () => {
  // The same shape, but the tail does match — must still return true.
  assert.ok(globMatches("a" + "**".repeat(20) + "b", "a" + "x/".repeat(20) + "b"));
  assert.ok(globMatches("**/**/**/*.ts", "a/b/c/d/e.ts"));
});
