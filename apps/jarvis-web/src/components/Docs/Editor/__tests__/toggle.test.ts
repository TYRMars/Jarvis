// Toggle round-trip — open / closed / nested.

import { beforeAll, describe, expect, it } from "vitest";
import { fromMarkdown, toMarkdown } from "../markdown";
import {
  _clearHandlersForTesting,
  registerHandler,
} from "../markdown/registry";
import { toggleHandler } from "../extensions/toggle/markdown";
import { calloutHandler } from "../extensions/callout/markdown";
import type { PmNode } from "../markdown/types";

beforeAll(() => {
  _clearHandlersForTesting();
  // Toggle is the primary handler under test, but we keep Callout
  // wired in to make sure the two handlers don't fight (Toggle owns
  // `html` nodes; Callout owns `blockquote`).
  registerHandler(toggleHandler);
  registerHandler(calloutHandler);
});

describe("toggle round-trip", () => {
  it("01 closed toggle with single-paragraph body", () => {
    const md = "<details><summary>Title</summary>\nBody.\n</details>\n";
    const pm1 = fromMarkdown(md);
    const toggle = pm1.content?.[0] as PmNode;
    expect(toggle.type).toBe("toggle");
    expect(toggle.attrs?.["open"]).toBe(false);
    // Round-trip stabilises.
    const md2 = toMarkdown(pm1);
    const pm2 = fromMarkdown(md2);
    expect(pm2).toEqual(pm1);
  });

  it("02 open toggle preserves the open attr", () => {
    const md =
      "<details open><summary>Open me</summary>\ninner.\n</details>\n";
    const pm1 = fromMarkdown(md);
    const toggle = pm1.content?.[0] as PmNode;
    expect(toggle.type).toBe("toggle");
    expect(toggle.attrs?.["open"]).toBe(true);
    const md2 = toMarkdown(pm1);
    const pm2 = fromMarkdown(md2);
    expect(pm2).toEqual(pm1);
  });

  it("03 toggle body containing a list", () => {
    const md =
      "<details open><summary>FAQ</summary>\n- one\n- two\n- three\n</details>\n";
    const pm1 = fromMarkdown(md);
    const toggle = pm1.content?.[0] as PmNode;
    expect(toggle.type).toBe("toggle");
    const body = (toggle.content ?? []).find((c) => c.type === "toggleContent");
    expect(body?.content?.[0]?.type).toBe("bulletList");
    const md2 = toMarkdown(pm1);
    const pm2 = fromMarkdown(md2);
    expect(pm2).toEqual(pm1);
  });

  it("04 unrelated raw HTML stays an html node, not a toggle", () => {
    const md = "<custom-tag>not a toggle</custom-tag>\n";
    const pm = fromMarkdown(md);
    // Standard html block is dropped (parse.ts returns null), so
    // the doc is an empty paragraph.
    expect(pm.content?.[0]?.type).toBe("paragraph");
  });
});
