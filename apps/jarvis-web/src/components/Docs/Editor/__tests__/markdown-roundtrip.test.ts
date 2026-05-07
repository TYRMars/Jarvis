// Round-trip fixtures: markdown -> PM JSON -> markdown -> PM JSON.
//
// Equality is structural on the SECOND parse, not on the string —
// remark-stringify normalises whitespace / fence styles / ordered-
// list numbering, so byte-equality is too strict (and matches the
// spec's stated equivalence bar in §11.2).

import { describe, expect, it } from "vitest";
import { fromMarkdown, toMarkdown } from "../markdown";

interface Case {
  name: string;
  md: string;
}

const cases: Case[] = [
  {
    name: "01 plain paragraph",
    md: "Hello world.\n",
  },
  {
    name: "02 H1 + paragraph",
    md: "# Title\n\nFirst paragraph.\n",
  },
  {
    name: "03 H1 H2 H3 (caps at 3)",
    md: "# A\n\n## B\n\n### C\n",
  },
  {
    name: "04 inline marks: bold / italic / strike / code",
    md: "A **bold** *italic* ~~strike~~ `code` run.\n",
  },
  {
    name: "05 nested marks (bold + italic)",
    md: "***both*** marks at once.\n",
  },
  {
    name: "06 link with title",
    md: 'See [docs](https://example.com "Tooltip") for details.\n',
  },
  {
    name: "07 bullet list with nested list",
    md: "- top\n  - inner\n  - inner two\n- second top\n",
  },
  {
    name: "08 ordered list with custom start",
    md: "3. third\n4. fourth\n5. fifth\n",
  },
  {
    name: "09 task list mixed checked / unchecked",
    md: "- [ ] todo\n- [x] done\n- [ ] still doing\n",
  },
  {
    name: "10 blockquote multi-paragraph",
    md: "> first quote line\n>\n> second quote line\n",
  },
  {
    name: "11 fenced code block with language",
    md: '```ts\nconst x: number = 1;\nconsole.log(x);\n```\n',
  },
  {
    name: "12 fenced code block no language",
    md: "```\nplain code\nblock\n```\n",
  },
  {
    name: "13 horizontal rule between paragraphs",
    md: "first\n\n---\n\nsecond\n",
  },
  {
    name: "14 GFM table 2 columns 3 rows",
    md: "| col a | col b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n",
  },
  {
    name: "15 image (block)",
    md: "![alt text](https://example.com/x.png)\n",
  },
  {
    name: "16 mixed: heading + list + code + paragraph",
    md: "## Steps\n\n1. Run `npm install`.\n2. Read the docs.\n\n```sh\nnpm run dev\n```\n\nThat's it.\n",
  },
  {
    name: "17 hard break inside paragraph",
    md: "line one  \nline two\n",
  },
  {
    name: "18 link inside bold",
    md: "**[click me](https://example.com)** here.\n",
  },
];

describe("markdown round-trip", () => {
  for (const c of cases) {
    it(c.name, () => {
      const pm1 = fromMarkdown(c.md);
      const md2 = toMarkdown(pm1);
      const pm2 = fromMarkdown(md2);
      expect(pm2).toEqual(pm1);
    });
  }
});

describe("markdown -> doc shape", () => {
  it("returns a doc with at least one block", () => {
    const pm = fromMarkdown("hello");
    expect(pm.type).toBe("doc");
    expect(Array.isArray(pm.content)).toBe(true);
    expect((pm.content ?? []).length).toBeGreaterThan(0);
  });

  it("returns an empty paragraph for empty input", () => {
    const pm = fromMarkdown("");
    expect(pm).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
  });

  it("clamps heading depth > 3 down to 3", () => {
    const pm = fromMarkdown("###### deeply nested\n");
    const heading = pm.content?.[0];
    expect(heading?.type).toBe("heading");
    expect(heading?.attrs).toEqual({ level: 3 });
  });
});
