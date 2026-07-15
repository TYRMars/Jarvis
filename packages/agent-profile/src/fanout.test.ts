import { test } from "node:test";
import assert from "node:assert/strict";

import { Fanout } from "./store.ts";

// Regression for #321: a throwing subscriber on the agent-profile fan-out must
// not propagate out of `emit` (rejecting the already-committed mutation) nor
// starve the listeners registered after it.
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
