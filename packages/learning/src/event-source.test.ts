import { test } from "node:test";
import assert from "node:assert/strict";

import { Fanout } from "./event-source.ts";

// Regression for #340: a throwing subscriber must not propagate out of `emit`
// (rejecting the already-committed mutation) nor starve later listeners.
test("Fanout.emit isolates a throwing listener", () => {
  const fan = new Fanout<string>();
  const seen: string[] = [];

  fan.subscribe(() => {
    throw new Error("listener boom");
  });
  fan.subscribe((e) => seen.push(e));

  assert.doesNotThrow(() => fan.emit("frame"));
  assert.deepEqual(seen, ["frame"]);
});
