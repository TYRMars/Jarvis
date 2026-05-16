// Tests for the transcript folding classifier + grouper used by
// `<MessageList>`. These are pure data-shape tests — no React
// involved — so they stay fast and stable across UI tweaks.

import { describe, expect, it } from "vitest";
import { groupForFolding, isFoldable } from "./MessageList";
import type { ToolBlockEntry, UiMessage } from "../../store/types";

function block(over: Partial<ToolBlockEntry>): ToolBlockEntry {
  return {
    id: over.id ?? "t",
    name: over.name ?? "fs.read",
    args: over.args ?? {},
    status: over.status ?? "ok",
    output: over.output ?? null,
    progress: over.progress ?? "",
    decisionSource: null,
    startedAt: 0,
    finishedAt: 0,
  };
}

function assistant(over: {
  uid: string;
  toolCallIds: string[];
  content?: string;
  reasoning?: string;
  finalised?: boolean;
}): UiMessage {
  return {
    uid: over.uid,
    kind: "assistant",
    content: over.content ?? "",
    reasoning: over.reasoning ?? "",
    toolCallIds: over.toolCallIds,
    finalised: over.finalised ?? true,
  };
}

function user(uid: string, content = "hi", userOrdinal = 1): UiMessage {
  return { uid, kind: "user", content, userOrdinal };
}

describe("isFoldable", () => {
  it("folds an assistant with one read-only tool call and no content", () => {
    const m = assistant({ uid: "a", toolCallIds: ["t1"] });
    const blocks = { t1: block({ id: "t1", name: "fs.read" }) };
    expect(isFoldable(m, blocks)).toBe(true);
  });

  it("rejects when the assistant has visible content", () => {
    const m = assistant({ uid: "a", toolCallIds: ["t1"], content: "thinking..." });
    const blocks = { t1: block({ id: "t1", name: "fs.read" }) };
    expect(isFoldable(m, blocks)).toBe(false);
  });

  it("rejects when any tool call is a write/exec tool", () => {
    const m = assistant({ uid: "a", toolCallIds: ["t1", "t2"] });
    const blocks = {
      t1: block({ id: "t1", name: "fs.read" }),
      t2: block({ id: "t2", name: "fs.edit" }),
    };
    expect(isFoldable(m, blocks)).toBe(false);
  });

  it("rejects when a referenced tool block is missing", () => {
    const m = assistant({ uid: "a", toolCallIds: ["t1"] });
    const blocks = {};
    expect(isFoldable(m, blocks)).toBe(false);
  });

  it("rejects an assistant with no tool calls", () => {
    const m = assistant({ uid: "a", toolCallIds: [] });
    expect(isFoldable(m, {})).toBe(false);
  });

  it("rejects an unknown tool name (don't aggressively fold unknowns)", () => {
    const m = assistant({ uid: "a", toolCallIds: ["t1"] });
    const blocks = { t1: block({ id: "t1", name: "totally.new.mcp.tool" }) };
    expect(isFoldable(m, blocks)).toBe(false);
  });
});

describe("groupForFolding", () => {
  it("folds 3 consecutive read-only iterations into one group", () => {
    const msgs: UiMessage[] = [
      user("u1"),
      assistant({ uid: "a1", toolCallIds: ["t1"] }),
      assistant({ uid: "a2", toolCallIds: ["t2"] }),
      assistant({ uid: "a3", toolCallIds: ["t3"] }),
      assistant({ uid: "a4", toolCallIds: ["t4"] }), // the final reply
    ];
    const blocks = {
      t1: block({ id: "t1", name: "fs.read" }),
      t2: block({ id: "t2", name: "code.grep" }),
      t3: block({ id: "t3", name: "git.status" }),
      t4: block({ id: "t4", name: "fs.edit" }), // not foldable → standalone
    };
    const groups = groupForFolding(msgs, blocks);
    expect(groups.map((g) => g.kind)).toEqual(["single", "folded", "single"]);
    if (groups[1].kind === "folded") {
      expect(groups[1].messages.map((m) => m.uid)).toEqual(["a1", "a2", "a3"]);
    }
  });

  it("leaves a sub-threshold run inline", () => {
    const msgs: UiMessage[] = [
      user("u1"),
      assistant({ uid: "a1", toolCallIds: ["t1"] }),
      assistant({ uid: "a2", toolCallIds: ["t2"] }), // only 2 read-only — below MIN_GROUP_SIZE
      assistant({ uid: "a3", toolCallIds: ["t3"] }),
    ];
    const blocks = {
      t1: block({ id: "t1", name: "fs.read" }),
      t2: block({ id: "t2", name: "fs.read" }),
      t3: block({ id: "t3", name: "fs.edit" }),
    };
    const groups = groupForFolding(msgs, blocks);
    expect(groups.map((g) => g.kind)).toEqual([
      "single",
      "single",
      "single",
      "single",
    ]);
  });

  it("does not fold across a non-foldable interruption", () => {
    const msgs: UiMessage[] = [
      assistant({ uid: "a1", toolCallIds: ["t1"] }),
      assistant({ uid: "a2", toolCallIds: ["t2"] }),
      assistant({ uid: "a3", toolCallIds: ["t3"], content: "I think we should..." }), // breaks the run
      assistant({ uid: "a4", toolCallIds: ["t4"] }),
      assistant({ uid: "a5", toolCallIds: ["t5"] }),
      assistant({ uid: "a6", toolCallIds: ["t6"] }),
    ];
    const blocks = {
      t1: block({ id: "t1", name: "fs.read" }),
      t2: block({ id: "t2", name: "fs.read" }),
      t3: block({ id: "t3", name: "fs.read" }),
      t4: block({ id: "t4", name: "fs.read" }),
      t5: block({ id: "t5", name: "fs.read" }),
      t6: block({ id: "t6", name: "fs.read" }),
    };
    const groups = groupForFolding(msgs, blocks);
    // a1+a2 are sub-threshold (only 2) → inline. a3 standalone.
    // a4+a5+a6 hit threshold → folded.
    expect(groups.map((g) => g.kind)).toEqual([
      "single",
      "single",
      "single",
      "folded",
    ]);
    if (groups[3].kind === "folded") {
      expect(groups[3].messages.map((m) => m.uid)).toEqual(["a4", "a5", "a6"]);
    }
  });
});
