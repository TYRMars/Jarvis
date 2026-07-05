import { test } from "node:test";
import assert from "node:assert/strict";

import { Fanout } from "./event-source.ts";

// A throwing subscriber must be isolated: `emit` runs after the durable write
// has committed, so a listener fault must neither propagate out of `emit` (which
// would reject the already-committed mutation) nor starve listeners registered
// after it. Regression guard for #340.
test("Fanout.emit isolates a throwing listener", () => {
  const fanout = new Fanout<number>();
  const seenBefore: number[] = [];
  const seenAfter: number[] = [];

  fanout.subscribe((e) => seenBefore.push(e));
  fanout.subscribe(() => {
    throw new Error("boom");
  });
  fanout.subscribe((e) => seenAfter.push(e));

  // Must not throw even though the middle listener does.
  assert.doesNotThrow(() => fanout.emit(1));

  // Both the earlier and the later listener still received the frame.
  assert.deepEqual(seenBefore, [1]);
  assert.deepEqual(seenAfter, [1]);
});

test("Fanout.subscribe returns an idempotent unsubscribe", () => {
  const fanout = new Fanout<number>();
  const seen: number[] = [];
  const off = fanout.subscribe((e) => seen.push(e));

  fanout.emit(1);
  off();
  off(); // idempotent — second call is a no-op
  fanout.emit(2);

  assert.deepEqual(seen, [1]);
});
