// Unit tests for the long-term Memory service cache + frame appliers
// (self-improving-agent Phase 1). The REST methods are thin fetch
// wrappers exercised through the route tests on the Rust side; here we
// pin the in-memory cache behaviour the Settings → Memory panel relies
// on: pinned-first sorting and the WS-frame apply path.

import { describe, it, expect, beforeEach } from "vitest";
import {
  applyMemoryDeleted,
  applyMemoryUpserted,
  memoriesSnapshot,
  subscribeMemories,
  type MemoryItem,
} from "./memories";

function mem(over: Partial<MemoryItem> & { id: string }): MemoryItem {
  return {
    scope: { kind: "user" },
    kind: "preference",
    title: over.id,
    body: "b",
    source: { kind: "user" },
    confidence: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  // Clear the module cache by deleting every id currently present.
  for (const m of memoriesSnapshot()) applyMemoryDeleted(m.id);
});

describe("memories cache", () => {
  it("upsert then snapshot returns the row", () => {
    applyMemoryUpserted(mem({ id: "a" }));
    const snap = memoriesSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].id).toBe("a");
  });

  it("sorts pinned rows ahead of unpinned", () => {
    applyMemoryUpserted(mem({ id: "plain", updated_at: "2026-02-01T00:00:00Z" }));
    applyMemoryUpserted(mem({ id: "pinned", pinned: true, updated_at: "2026-01-01T00:00:00Z" }));
    const snap = memoriesSnapshot();
    expect(snap[0].id).toBe("pinned");
    expect(snap[1].id).toBe("plain");
  });

  it("among same pinned-ness, newest updated_at wins", () => {
    applyMemoryUpserted(mem({ id: "older", updated_at: "2026-01-01T00:00:00Z" }));
    applyMemoryUpserted(mem({ id: "newer", updated_at: "2026-03-01T00:00:00Z" }));
    expect(memoriesSnapshot()[0].id).toBe("newer");
  });

  it("delete removes the row and notifies subscribers", () => {
    let hits = 0;
    const unsub = subscribeMemories(() => {
      hits += 1;
    });
    applyMemoryUpserted(mem({ id: "x" }));
    expect(memoriesSnapshot()).toHaveLength(1);
    applyMemoryDeleted("x");
    expect(memoriesSnapshot()).toHaveLength(0);
    expect(hits).toBeGreaterThanOrEqual(2);
    unsub();
  });

  it("delete of unknown id does not notify", () => {
    let hits = 0;
    const unsub = subscribeMemories(() => {
      hits += 1;
    });
    applyMemoryDeleted("ghost");
    expect(hits).toBe(0);
    unsub();
  });
});
