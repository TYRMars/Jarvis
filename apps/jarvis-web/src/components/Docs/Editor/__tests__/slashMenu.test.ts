import { describe, expect, it } from "vitest";
import {
  STANDARD_CANDIDATES,
  filterCandidates,
} from "../extensions/slashMenu/candidates";

describe("slash menu candidate filter", () => {
  it("returns the full set on empty query", () => {
    expect(filterCandidates(STANDARD_CANDIDATES, "")).toHaveLength(
      STANDARD_CANDIDATES.length,
    );
  });

  it("matches by exact title prefix", () => {
    const results = filterCandidates(STANDARD_CANDIDATES, "h2");
    expect(results.map((r) => r.id)).toEqual(["h2"]);
  });

  it("matches by keyword (zh-CN)", () => {
    const results = filterCandidates(STANDARD_CANDIDATES, "代码");
    expect(results.map((r) => r.id)).toEqual(["code"]);
  });

  it("matches case-insensitive", () => {
    const upper = filterCandidates(STANDARD_CANDIDATES, "TABLE");
    const lower = filterCandidates(STANDARD_CANDIDATES, "table");
    expect(upper).toEqual(lower);
    expect(upper.map((r) => r.id)).toContain("table");
  });

  it("returns empty for unknown query", () => {
    expect(filterCandidates(STANDARD_CANDIDATES, "xyzzy-no-match")).toHaveLength(0);
  });

  it("includes the spec's minimum candidate set", () => {
    const ids = STANDARD_CANDIDATES.map((c) => c.id).sort();
    // 11 standard entries from spec §6.3 (callout/toggle land separately).
    expect(ids).toEqual(
      [
        "h1",
        "h2",
        "h3",
        "bullet",
        "ordered",
        "task",
        "quote",
        "code",
        "divider",
        "image",
        "table",
      ].sort(),
    );
  });
});
