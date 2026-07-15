import { test } from "node:test";
import assert from "node:assert/strict";

import { Fanout } from "./event-source.ts";

// Regression for #340: a throwing subscriber must not (a) propagate out of
// `emit` — which would reject the already-committed mutation that called it —
// nor (b) starve the listeners registered after it.
test("Fanout.emit isolates a throwing listener", () => {
  const fan = new Fanout<string>();
  const seen: string[] = [];

  fan.subscribe(() => {
    throw new Error("listener boom");
  });
  fan.subscribe((e) => seen.push(e));

  assert.doesNotThrow(() => fan.emit("frame"));
  // The listener registered after the throwing one still received the frame.
  assert.deepEqual(seen, ["frame"]);
});

test("Fanout.emit keeps delivering across multiple throwing listeners", () => {
  const fan = new Fanout<number>();
  const seen: number[] = [];

  fan.subscribe(() => {
    throw new Error("first boom");
  });
  fan.subscribe((e) => seen.push(e * 10));
  fan.subscribe(() => {
    throw new Error("second boom");
  });
  fan.subscribe((e) => seen.push(e * 100));

  assert.doesNotThrow(() => fan.emit(2));
  assert.deepEqual(seen, [20, 200]);
});
