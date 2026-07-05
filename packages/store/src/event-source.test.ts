import { test } from "node:test";
import assert from "node:assert/strict";

import { Fanout } from "./event-source.ts";

test("Fanout.emit: a throwing listener does not propagate out of emit", () => {
  const fanout = new Fanout<number>();
  fanout.subscribe(() => {
    throw new Error("boom");
  });
  // emit is called after the durable write commits — it must never reject the
  // already-committed mutation because one subscriber threw.
  assert.doesNotThrow(() => fanout.emit(1));
});

test("Fanout.emit: a throwing listener does not starve listeners registered after it", () => {
  const fanout = new Fanout<number>();
  const seen: number[] = [];
  fanout.subscribe(() => {
    throw new Error("boom");
  });
  fanout.subscribe((event) => {
    seen.push(event);
  });
  fanout.emit(42);
  assert.deepEqual(seen, [42], "later listener should still receive the frame");
});

test("Fanout: unsubscribe stops delivery", () => {
  const fanout = new Fanout<number>();
  const seen: number[] = [];
  const unsub = fanout.subscribe((event) => seen.push(event));
  fanout.emit(1);
  unsub();
  fanout.emit(2);
  assert.deepEqual(seen, [1]);
});
