import { test } from "node:test";
import assert from "node:assert/strict";

import { LogBuffer } from "./logs.ts";

test("push + tail returns most recent lines oldest-first", () => {
  const buf = new LogBuffer();
  buf.push("a");
  buf.push("b");
  buf.push("c");
  assert.deepEqual(buf.tail(2), ["b", "c"]);
  assert.deepEqual(buf.tail(10), ["a", "b", "c"]);
});

test("tail(<=0) returns empty", () => {
  const buf = new LogBuffer();
  buf.push("a");
  assert.deepEqual(buf.tail(0), []);
  assert.deepEqual(buf.tail(-5), []);
});

test("push splits multi-line input and drops blank lines", () => {
  const buf = new LogBuffer();
  buf.push("one\ntwo\n\n  \nthree");
  assert.deepEqual(buf.tail(10), ["one", "two", "three"]);
});

test("buffer is bounded to its max, dropping oldest", () => {
  const buf = new LogBuffer(3);
  for (const line of ["1", "2", "3", "4", "5"]) buf.push(line);
  assert.equal(buf.size, 3);
  assert.deepEqual(buf.tail(10), ["3", "4", "5"]);
});

test("trailing whitespace is trimmed", () => {
  const buf = new LogBuffer();
  buf.push("hello   ");
  assert.deepEqual(buf.tail(1), ["hello"]);
});
