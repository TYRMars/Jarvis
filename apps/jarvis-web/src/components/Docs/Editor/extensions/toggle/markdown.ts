// Toggle <-> markdown handler. Wire format (spec §6.2):
//
//   <details><summary>标题文字</summary>
//
//   正文内容,可以是多段。
//   - 列表也行
//
//   </details>
//
// remark-parse hands us multi-block HTML as a sequence of three
// nodes: an opening `html` node, the inner blocks, then a closing
// `html` node. To stay inside the existing single-node-in/out
// handler protocol we use a no-blank-line variant of the same
// shape so the entire `<details>...</details>` lands in *one*
// `html` node, then re-parse the body as markdown ourselves.

import { fromMarkdown, toMarkdown } from "../../markdown";
import type {
  BlockHandler,
  MdastBlock,
  MdastNode,
  ParseContext,
  PmNode,
  SerializeContext,
} from "../../markdown/types";
import type { HTML } from "mdast";

const DETAILS_RE = /^<details(\s+open)?>\s*<summary>([\s\S]*?)<\/summary>\s*([\s\S]*?)<\/details>\s*$/i;

export const toggleHandler: BlockHandler = {
  pmType: "toggle",
  mdastTypes: ["html"],

  parse(node: MdastNode, _ctx: ParseContext): PmNode | null {
    if (node.type !== "html") return null;
    const html = (node).value ?? "";
    const m = DETAILS_RE.exec(html.trim());
    if (!m) return null;
    const open = Boolean(m[1]);
    const summary = (m[2] ?? "").trim();
    const body = (m[3] ?? "").trim();

    // Body is markdown — feed it back through fromMarkdown to
    // recover block content. The wrapping `doc` is unwrapped.
    const bodyDoc = body.length > 0 ? fromMarkdown(body) : { type: "doc", content: [] };
    const bodyContent = bodyDoc.content ?? [];

    return {
      type: "toggle",
      attrs: { open },
      content: [
        {
          type: "toggleSummary",
          content: summary.length > 0 ? [{ type: "text", text: summary }] : [],
        },
        {
          type: "toggleContent",
          content:
            bodyContent.length > 0
              ? bodyContent
              : [{ type: "paragraph" }],
        },
      ],
    };
  },

  serialize(node: PmNode, _ctx: SerializeContext): MdastBlock {
    const open = node.attrs?.["open"] === true;
    const [summaryNode, contentNode] = unpackChildren(node);
    const summaryText = inlineToString(summaryNode?.content ?? []);
    const bodyDoc: PmNode = {
      type: "doc",
      content: contentNode?.content ?? [],
    };
    let bodyMd = toMarkdown(bodyDoc).trim();
    // Defence against the literal close tag inside the body
    // breaking the round-trip; we don't expect it during normal
    // editing but guard anyway.
    bodyMd = bodyMd.replace(/<\/details>/gi, "<\\/details>");

    const html = [
      `<details${open ? " open" : ""}><summary>${escapeHtml(summaryText)}</summary>`,
      bodyMd,
      `</details>`,
    ].join("\n");
    return { type: "html", value: html } satisfies HTML;
  },
};

// ---------------------------- helpers ---------------------------

function unpackChildren(node: PmNode): [PmNode | undefined, PmNode | undefined] {
  const children = node.content ?? [];
  const summary = children.find((c) => c.type === "toggleSummary");
  const content = children.find((c) => c.type === "toggleContent");
  return [summary, content];
}

function inlineToString(nodes: readonly PmNode[]): string {
  // For v0 the toggle summary is plain text only — drop marks /
  // images / hardBreaks. Reduces the round-trip surface.
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") out += n.text ?? "";
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export type ToggleHandler = typeof toggleHandler;
