import { describe, expect, it } from "vitest";
import { searchSettings } from "./searchIndex";

describe("searchSettings", () => {
  it("returns no hits for an empty query", () => {
    expect(searchSettings("")).toHaveLength(0);
    expect(searchSettings("   ")).toHaveLength(0);
  });

  it("matches a section by its primary label", () => {
    const hits = searchSettings("models");
    // The top-level Models section should be the first hit (token at
    // position 0); the various Models tabs may follow if they alias
    // the word, but Models itself should rank first.
    expect(hits[0].entry.sectionId).toBe("models");
    expect(hits[0].entry.tabId).toBeUndefined();
  });

  it("matches a top-level capability by its primary label", () => {
    const hits = searchSettings("subagents");
    expect(hits[0].entry.sectionId).toBe("subagents");
    expect(hits[0].entry.tabId).toBeUndefined();
  });

  it("matches an alias keyword from the field-level synonym list", () => {
    // 'effort' is a field on the Layout tab — not in the primary
    // label, but listed as an alias.
    const hits = searchSettings("effort");
    const target = hits.find(
      (h) => h.entry.sectionId === "appearance-layout" && h.entry.tabId === "layout",
    );
    expect(target).toBeDefined();
  });

  it("matches Chinese tokens", () => {
    const hits = searchSettings("权限");
    expect(hits.some((h) => h.entry.sectionId === "permissions")).toBe(true);
  });

  it("is case-insensitive", () => {
    const lower = searchSettings("openai");
    const upper = searchSettings("OPENAI");
    expect(lower.map((h) => h.entry.sectionId)).toEqual(upper.map((h) => h.entry.sectionId));
  });

  it("returns an empty array when nothing matches", () => {
    expect(searchSettings("zzz-nonsense-xyz")).toHaveLength(0);
  });

  it("ranks an exact primary-label match above an alias hit", () => {
    // 'plugins' is the primary label of the Plugins tab AND would
    // also match the Extensions section (which lists 'plugins' is
    // not in tokens but the tab name is). Plugins tab should win.
    const hits = searchSettings("plugins");
    expect(hits[0].entry.sectionId).toBe("extensions");
    expect(hits[0].entry.tabId).toBe("plugins");
  });

  it("matches partial substrings inside a token", () => {
    // 'sub' is a substring of 'subagents'.
    const hits = searchSettings("sub");
    expect(hits.some((h) => h.entry.sectionId === "subagents")).toBe(true);
  });
});
