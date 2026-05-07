// Markdown -> Tiptap (ProseMirror) JSON.
//
// Pipeline:
//   1. unified.parse() with remark-parse + remark-gfm produces an
//      mdast Root.
//   2. We walk the Root and dispatch each block to either:
//        a. a custom registered handler (Callout, Toggle, ...); or
//        b. one of the inline standard-block converters below.
//   3. Inline (phrasing) content is converted by `parseInline`,
//      which emits PM text nodes with marks reconstructed from the
//      mdast nesting (strong, emphasis, delete, inlineCode, link).
//
// The output is always a `{ type: "doc", content: [...] }` PM root;
// callers feed this directly into Tiptap's `setContent` /
// `getJSON()` shape.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type {
  Blockquote,
  Code,
  Heading,
  Image,
  Link,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  RootContent,
  Table,
  ThematicBreak,
} from "mdast";
import type {
  MdastBlock,
  MdastNode,
  MdastPhrasing,
  ParseContext,
  PmNode,
} from "./types";
import { handlersForMdastType } from "./registry";

const processor = unified().use(remarkParse).use(remarkGfm);

/** Parse a markdown string into a PM `doc` JSON node. */
export function fromMarkdown(md: string): PmNode {
  const tree = processor.parse(md) as { type: "root"; children: RootContent[] };
  const ctx: ParseContext = {
    parseBlocks: (nodes) => parseBlocks(nodes, ctx),
    parseInline: (nodes) => parseInline(nodes, ctx),
  };
  const content = parseBlocks(tree.children, ctx);
  return { type: "doc", content: content.length > 0 ? content : [emptyParagraph()] };
}

function parseBlocks(nodes: readonly MdastBlock[], ctx: ParseContext): PmNode[] {
  const out: PmNode[] = [];
  for (const node of nodes) {
    const pm = parseBlock(node, ctx);
    if (Array.isArray(pm)) out.push(...pm);
    else if (pm) out.push(pm);
  }
  return out;
}

function parseBlock(node: MdastNode, ctx: ParseContext): PmNode | PmNode[] | null {
  // Custom handlers win first so Callout can claim its blockquote
  // shape before the plain blockquote handler does.
  for (const handler of handlersForMdastType(node.type)) {
    const result = handler.parse(node, ctx);
    if (result) return result;
  }

  switch (node.type) {
    case "paragraph":
      return parseParagraph(node, ctx);
    case "heading":
      return parseHeading(node, ctx);
    case "blockquote":
      return parseBlockquote(node, ctx);
    case "list":
      return parseList(node, ctx);
    case "code":
      return parseCodeBlock(node);
    case "thematicBreak":
      return parseThematicBreak(node);
    case "table":
      return parseTable(node, ctx);
    case "html":
      // Bare HTML blocks: drop them at v0 unless a custom handler
      // claimed them above (Toggle's <details>). This avoids
      // accidentally injecting raw HTML strings into the editor.
      return null;
    default:
      // Anything we don't recognise becomes a paragraph of its
      // text representation when possible, otherwise gets dropped.
      return null;
  }
}

// -------------------- standard block parsers --------------------

function parseParagraph(node: Paragraph, ctx: ParseContext): PmNode {
  // A paragraph that contains exactly one image is hoisted into a
  // top-level image block — Tiptap's default Image extension is a
  // block node, so wrapping it in a paragraph would split the doc.
  if (node.children.length === 1 && node.children[0]?.type === "image") {
    return parseImage(node.children[0]);
  }
  const inline = parseInline(node.children, ctx);
  return inline.length > 0 ? { type: "paragraph", content: inline } : emptyParagraph();
}

function parseHeading(node: Heading, ctx: ParseContext): PmNode {
  // Editor caps heading at level 3 (spec §2.1). mdast can produce
  // depth 4-6 from `####` etc.; clamp so they don't disappear.
  const level = Math.min(3, Math.max(1, node.depth));
  const inline = parseInline(node.children, ctx);
  return {
    type: "heading",
    attrs: { level },
    content: inline.length > 0 ? inline : undefined,
  };
}

function parseBlockquote(node: Blockquote, ctx: ParseContext): PmNode {
  return {
    type: "blockquote",
    content: parseBlocks(node.children, ctx),
  };
}

function parseList(node: List, ctx: ParseContext): PmNode {
  const isTaskList = node.children.some(
    (item) => (item).checked !== null && (item).checked !== undefined,
  );
  if (isTaskList) {
    return {
      type: "taskList",
      content: node.children.map((item) => parseTaskItem(item, ctx)),
    };
  }
  if (node.ordered) {
    return {
      type: "orderedList",
      attrs: typeof node.start === "number" ? { start: node.start } : undefined,
      content: node.children.map((item) => parseListItem(item, ctx)),
    };
  }
  return {
    type: "bulletList",
    content: node.children.map((item) => parseListItem(item, ctx)),
  };
}

function parseListItem(node: ListItem, ctx: ParseContext): PmNode {
  return {
    type: "listItem",
    content: parseBlocks(node.children, ctx),
  };
}

function parseTaskItem(node: ListItem, ctx: ParseContext): PmNode {
  return {
    type: "taskItem",
    attrs: { checked: node.checked === true },
    content: parseBlocks(node.children, ctx),
  };
}

function parseCodeBlock(node: Code): PmNode {
  return {
    type: "codeBlock",
    attrs: node.lang ? { language: node.lang } : undefined,
    content: node.value ? [{ type: "text", text: node.value }] : undefined,
  };
}

function parseThematicBreak(_node: ThematicBreak): PmNode {
  return { type: "horizontalRule" };
}

function parseTable(node: Table, ctx: ParseContext): PmNode {
  const rows = node.children;
  if (rows.length === 0) return emptyParagraph();
  const out: PmNode[] = [];
  rows.forEach((row, rowIndex) => {
    const isHeader = rowIndex === 0;
    const cells = row.children.map((cell) => {
      const inline = ctx.parseInline(cell.children);
      const cellContent: PmNode[] = [
        { type: "paragraph", content: inline.length > 0 ? inline : undefined },
      ];
      return {
        type: isHeader ? "tableHeader" : "tableCell",
        content: cellContent,
      } satisfies PmNode;
    });
    out.push({ type: "tableRow", content: cells });
  });
  return { type: "table", content: out };
}

function parseImage(node: Image): PmNode {
  const attrs: Record<string, unknown> = { src: node.url };
  if (node.alt) attrs["alt"] = node.alt;
  if (node.title) attrs["title"] = node.title;
  return { type: "image", attrs };
}

// -------------------- inline (phrasing) -------------------------

function parseInline(nodes: readonly MdastPhrasing[], ctx: ParseContext): PmNode[] {
  const out: PmNode[] = [];
  for (const node of nodes) {
    pushInline(node, [], out, ctx);
  }
  return out;
}

interface MarkSpec {
  type: string;
  attrs?: Record<string, unknown>;
}

function pushInline(
  node: PhrasingContent,
  marks: MarkSpec[],
  out: PmNode[],
  ctx: ParseContext,
): void {
  switch (node.type) {
    case "text":
      pushText((node).value, marks, out);
      return;
    case "strong":
      walkInlineWithMark(node.children, [...marks, { type: "bold" }], out, ctx);
      return;
    case "emphasis":
      walkInlineWithMark(node.children, [...marks, { type: "italic" }], out, ctx);
      return;
    case "delete":
      walkInlineWithMark(node.children, [...marks, { type: "strike" }], out, ctx);
      return;
    case "inlineCode": {
      pushText((node).value, [...marks, { type: "code" }], out);
      return;
    }
    case "link": {
      const link = node;
      const linkAttrs: Record<string, unknown> = { href: link.url };
      if (link.title) linkAttrs["title"] = link.title;
      walkInlineWithMark(
        link.children,
        [...marks, { type: "link", attrs: linkAttrs }],
        out,
        ctx,
      );
      return;
    }
    case "image": {
      // Inline image inside a sentence: we preserve it as a PM
      // image node embedded in the inline stream. Tiptap's default
      // image extension can still render this, even though the
      // schema prefers block placement.
      out.push(parseImage(node));
      return;
    }
    case "break":
      out.push({ type: "hardBreak" });
      return;
    case "html":
      // Skip raw inline HTML in v0.
      return;
    default:
      // Footnote / imageReference / linkReference: drop in v0.
      return;
  }
}

function walkInlineWithMark(
  nodes: readonly PhrasingContent[],
  marks: MarkSpec[],
  out: PmNode[],
  ctx: ParseContext,
): void {
  for (const child of nodes) {
    pushInline(child, marks, out, ctx);
  }
}

function pushText(value: string, marks: readonly MarkSpec[], out: PmNode[]): void {
  if (value.length === 0) return;
  const node: PmNode = { type: "text", text: value };
  if (marks.length > 0) {
    node.marks = marks.map((m) => (m.attrs ? { type: m.type, attrs: m.attrs } : { type: m.type }));
  }
  out.push(node);
}

function emptyParagraph(): PmNode {
  return { type: "paragraph" };
}
