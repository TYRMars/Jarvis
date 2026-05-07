// Callout round-trip — one fixture per variant + a nested case.
//
// Importing the callout extension's index.ts has the side effect of
// registering its handler with the markdown registry, which is what
// flips the serializer over to the GFM-admonition shape.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { fromMarkdown, toMarkdown } from "../markdown";
import {
  _clearHandlersForTesting,
  registerHandler,
} from "../markdown/registry";
import { calloutHandler } from "../extensions/callout/markdown";
import type { PmNode } from "../markdown/types";

beforeAll(() => {
  _clearHandlersForTesting();
  registerHandler(calloutHandler);
});

afterEach(() => {
  // No-op: handlers persist across tests in the same file. We
  // re-register in beforeAll so callout tests are self-contained.
});

interface Case {
  name: string;
  md: string;
  expectVariant: "info" | "warning" | "danger" | "success";
}

const cases: Case[] = [
  {
    name: "info variant single paragraph",
    md: "> [!INFO]\n>\n> 这是 info 内容\n",
    expectVariant: "info",
  },
  {
    name: "warning variant",
    md: "> [!WARNING]\n>\n> Heads up.\n",
    expectVariant: "warning",
  },
  {
    name: "danger variant",
    md: "> [!DANGER]\n>\n> Boom.\n",
    expectVariant: "danger",
  },
  {
    name: "success variant",
    md: "> [!SUCCESS]\n>\n> Tests passed.\n",
    expectVariant: "success",
  },
];

describe("callout round-trip", () => {
  for (const c of cases) {
    it(c.name, () => {
      const pm1 = fromMarkdown(c.md);
      // Top-level should contain a callout.
      const callout = pm1.content?.[0];
      expect(callout?.type).toBe("callout");
      expect(callout?.attrs).toEqual({ variant: c.expectVariant });

      // Re-emit and re-parse — must stabilise.
      const md2 = toMarkdown(pm1);
      const pm2 = fromMarkdown(md2);
      expect(pm2).toEqual(pm1);
    });
  }

  it("stays a plain blockquote when no marker is present", () => {
    const md = "> just a quote\n>\n> with two paragraphs\n";
    const pm = fromMarkdown(md);
    expect(pm.content?.[0]?.type).toBe("blockquote");
  });

  it("handles a callout containing a nested list", () => {
    const md = "> [!INFO]\n>\n> First.\n>\n> - one\n> - two\n";
    const pm1 = fromMarkdown(md);
    const callout = pm1.content?.[0] as PmNode;
    expect(callout.type).toBe("callout");
    expect(callout.attrs?.["variant"]).toBe("info");
    // Inside should have at least a paragraph + a bulletList.
    const innerTypes = (callout.content ?? []).map((c) => c.type);
    expect(innerTypes).toContain("paragraph");
    expect(innerTypes).toContain("bulletList");
    // Round-trip stabilises.
    const md2 = toMarkdown(pm1);
    const pm2 = fromMarkdown(md2);
    expect(pm2).toEqual(pm1);
  });
});
