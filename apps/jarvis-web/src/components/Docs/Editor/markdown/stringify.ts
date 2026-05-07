// Tiptap (ProseMirror) JSON -> Markdown.
//
// Walks the PM JSON, builds an mdast Root, and runs remark-stringify
// + remark-gfm against it. Inline marks are reconstructed by
// nesting strong / emphasis / delete / link around the text leaf
// (with inlineCode rendered as a phrasing-leaf when the `code` mark
// is set).
//
// Custom blocks (Callout, Toggle, ...) hand off to their registered
// `BlockHandler.serialize`. Anything we don't know about becomes a
// paragraph with the joined text — best effort to keep the user's
// data instead of dropping it.

import { unified } from "unified";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import type {
  Blockquote,
  Code,
  Heading,
  Image,
  InlineCode,
  Link,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Strong,
  Table,
  TableCell,
  TableRow,
  Text,
  ThematicBreak,
  Break,
  Emphasis,
  Delete,
} from "mdast";
import type { MdastBlock, PmNode, SerializeContext } from "./types";
import { handlerForPmType } from "./registry";

const stringifier = unified()
  .use(remarkGfm)
  .use(remarkStringify, {
    bullet: "-",
    listItemIndent: "one",
    rule: "-",
    fences: true,
    emphasis: "*",
    strong: "*",
    fence: "`",
  });

/** Serialise a Tiptap `doc` JSON node to a markdown string. */
export function toMarkdown(pm: PmNode): string {
  if (pm.type !== "doc") {
    throw new Error(`toMarkdown: expected a "doc" root, got "${pm.type}"`);
  }
  const ctx: SerializeContext = {
    serializeBlocks: (nodes) => serializeBlocks(nodes, ctx),
    serializeInline: (nodes) => serializeInline(nodes, ctx),
  };
  const root: Root = { type: "root", children: serializeBlocks(pm.content ?? [], ctx) };
  return stringifier.stringify(root);
}

function serializeBlocks(nodes: readonly PmNode[], ctx: SerializeContext): RootContent[] {
  const out: RootContent[] = [];
  for (const node of nodes) {
    const result = serializeBlock(node, ctx);
    if (Array.isArray(result)) {
      out.push(...(result));
    } else if (result) {
      out.push(result);
    }
  }
  return out;
}

function serializeBlock(
  node: PmNode,
  ctx: SerializeContext,
): MdastBlock | MdastBlock[] | null {
  const custom = handlerForPmType(node.type);
  if (custom) {
    return custom.serialize(node, ctx);
  }
  switch (node.type) {
    case "paragraph":
      return paragraph(node, ctx);
    case "heading":
      return heading(node, ctx);
    case "bulletList":
    case "orderedList":
      return list(node, ctx);
    case "taskList":
      return taskList(node, ctx);
    case "blockquote":
      return blockquote(node, ctx);
    case "codeBlock":
      return codeBlock(node);
    case "horizontalRule":
      return thematicBreak();
    case "table":
      return table(node, ctx);
    case "image":
      // Block-level image: emit a paragraph containing only the
      // image so it round-trips back to an isolated image when
      // re-parsed (parseParagraph hoists it).
      return { type: "paragraph", children: [imageNode(node)] } satisfies Paragraph;
    case "hardBreak":
      // hardBreak isn't a standalone block; treat as empty paragraph.
      return { type: "paragraph", children: [] } satisfies Paragraph;
    default:
      // Unknown PM block: try to flatten to text inside a paragraph.
      return { type: "paragraph", children: ctx.serializeInline(node.content ?? []) };
  }
}

// ----------------- standard block serialisers ------------------

function paragraph(node: PmNode, ctx: SerializeContext): Paragraph {
  return { type: "paragraph", children: ctx.serializeInline(node.content ?? []) };
}

function heading(node: PmNode, ctx: SerializeContext): Heading {
  const level = clampHeadingLevel(node.attrs?.["level"]);
  return {
    type: "heading",
    depth: level,
    children: ctx.serializeInline(node.content ?? []),
  };
}

function clampHeadingLevel(raw: unknown): 1 | 2 | 3 {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? parseInt(raw, 10)
        : 1;
  if (Number.isNaN(n) || n <= 1) return 1;
  if (n >= 3) return 3;
  return 2;
}

function list(node: PmNode, ctx: SerializeContext): List {
  const ordered = node.type === "orderedList";
  const startAttr = node.attrs?.["start"];
  const start = ordered && typeof startAttr === "number" ? startAttr : null;
  const children: ListItem[] = (node.content ?? []).map((item) => listItem(item, ctx, null));
  return {
    type: "list",
    ordered,
    spread: false,
    ...(start !== null ? { start } : {}),
    children,
  };
}

function listItem(node: PmNode, ctx: SerializeContext, checked: boolean | null): ListItem {
  return {
    type: "listItem",
    spread: false,
    checked,
    children: ctx.serializeBlocks(node.content ?? []) as ListItem["children"],
  };
}

function taskList(node: PmNode, ctx: SerializeContext): List {
  const children: ListItem[] = (node.content ?? []).map((item) => {
    const checked = item.attrs?.["checked"] === true;
    return listItem(item, ctx, checked);
  });
  return { type: "list", ordered: false, spread: false, children };
}

function blockquote(node: PmNode, ctx: SerializeContext): Blockquote {
  return {
    type: "blockquote",
    children: ctx.serializeBlocks(node.content ?? []) as Blockquote["children"],
  };
}

function codeBlock(node: PmNode): Code {
  const text = (node.content ?? [])
    .map((c) => (c.type === "text" ? c.text ?? "" : ""))
    .join("");
  const lang = node.attrs?.["language"];
  return {
    type: "code",
    lang: typeof lang === "string" && lang.length > 0 ? lang : null,
    meta: null,
    value: text,
  };
}

function thematicBreak(): ThematicBreak {
  return { type: "thematicBreak" };
}

function table(node: PmNode, ctx: SerializeContext): Table {
  const rows: TableRow[] = (node.content ?? []).map((row) => {
    const cells: TableCell[] = (row.content ?? []).map((cell) => {
      const inlineSrc = (cell.content ?? []).flatMap((p) => p.content ?? []);
      return { type: "tableCell", children: ctx.serializeInline(inlineSrc) };
    });
    return { type: "tableRow", children: cells };
  });
  return { type: "table", children: rows };
}

function imageNode(node: PmNode): Image {
  const rawSrc = node.attrs?.["src"];
  const alt = node.attrs?.["alt"];
  const title = node.attrs?.["title"];
  return {
    type: "image",
    url: typeof rawSrc === "string" ? rawSrc : "",
    alt: typeof alt === "string" ? alt : null,
    title: typeof title === "string" ? title : null,
  };
}

// -------------------- inline serialiser ------------------------

function serializeInline(nodes: readonly PmNode[], _ctx: SerializeContext): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const node of nodes) {
    if (node.type === "hardBreak") {
      out.push({ type: "break" } satisfies Break);
      continue;
    }
    if (node.type === "image") {
      out.push(imageNode(node));
      continue;
    }
    if (node.type === "text") {
      const text = node.text ?? "";
      if (text.length === 0) continue;
      out.push(wrapMarks(text, node.marks ?? []));
      continue;
    }
    // Fallback: a stray block inside an inline run flattens to text.
    if (node.content) {
      out.push(...serializeInline(node.content, _ctx));
    }
  }
  return out;
}

function wrapMarks(
  text: string,
  marks: readonly { type: string; attrs?: Record<string, unknown> }[],
): PhrasingContent {
  // `code` mark must produce an inlineCode leaf; everything else
  // wraps a phrasing parent. Walk inside-out, pulling code out
  // first, then iterating the remaining marks from innermost
  // (last in the list) to outermost (first).
  const codeIndex = marks.findIndex((m) => m.type === "code");
  let current: PhrasingContent;
  let remaining: readonly { type: string; attrs?: Record<string, unknown> }[];
  if (codeIndex >= 0) {
    current = { type: "inlineCode", value: text } satisfies InlineCode;
    remaining = marks.filter((_, i) => i !== codeIndex);
  } else {
    current = { type: "text", value: text } satisfies Text;
    remaining = marks;
  }
  for (let i = remaining.length - 1; i >= 0; i--) {
    const mark = remaining[i];
    if (!mark) continue;
    current = wrapWithMark(mark, current);
  }
  return current;
}

function wrapWithMark(
  mark: { type: string; attrs?: Record<string, unknown> },
  child: PhrasingContent,
): PhrasingContent {
  switch (mark.type) {
    case "bold":
      return { type: "strong", children: [child] } satisfies Strong;
    case "italic":
      return { type: "emphasis", children: [child] } satisfies Emphasis;
    case "strike":
      return { type: "delete", children: [child] } satisfies Delete;
    case "link": {
      const rawHref = mark.attrs?.["href"];
      const href = typeof rawHref === "string" ? rawHref : "";
      const title = mark.attrs?.["title"];
      return {
        type: "link",
        url: href,
        title: typeof title === "string" ? title : null,
        children: [child],
      } satisfies Link;
    }
    default:
      return child;
  }
}
