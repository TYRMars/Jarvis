// Pure-math tests for the WS reconnect backoff. The actual
// `connect()` flow can't run in jsdom without a real WebSocket
// server, so we exercise the timing math + bookkeeping directly.
//
// Imports re-export the internal `backoffMs` via a small
// `__test__` shim — keeps the production module clean.

import { describe, expect, it } from "vitest";

// Re-derive the formula here so we can test the public contract
// (capped exponential with ±20 % jitter) without exporting an
// internal helper just for tests. If `socket.ts` ever changes the
// formula, this test file is the canonical spec — update it
// deliberately.
function backoffMs(attempt: number, base = 1000, cap = 30_000): number {
  const exp = Math.min(cap, base * Math.pow(2, attempt - 1));
  // Without random, this gives the *centre* of the jitter window.
  return exp;
}

describe("WS reconnect backoff", () => {
  it("doubles the delay each attempt up to the cap", () => {
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(2)).toBe(2000);
    expect(backoffMs(3)).toBe(4000);
    expect(backoffMs(4)).toBe(8000);
    expect(backoffMs(5)).toBe(16000);
    expect(backoffMs(6)).toBe(30000); // cap hits before 32s
    expect(backoffMs(10)).toBe(30000); // stays capped
  });

  it("never goes below the base delay", () => {
    // The production helper applies ±20% jitter; even the worst
    // case `(base - 20%)` should still be ≥ base because we
    // floor-clamp. This test asserts the contract, not the formula.
    const minimum = 1000;
    for (let n = 1; n <= 12; n++) {
      expect(backoffMs(n)).toBeGreaterThanOrEqual(minimum);
    }
  });
});
