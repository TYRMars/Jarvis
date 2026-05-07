// Callout <-> markdown handler.
//
// Wire format (spec §6.1) is the GFM-admonition style blockquote:
//
//   > [!INFO]
//   > 这是 callout 内容
//   > 第二行
//
// remark-gfm doesn't actually special-case `[!INFO]`; the
// blockquote round-trips as-is and the marker text lands in the
// first paragraph. We pattern-match it on parse and emit it on
// serialise.

import type {
  BlockHandler,
  MdastBlock,
  MdastNode,
  ParseContext,
  PmNode,
  SerializeContext,
} from "../../markdown/types";
import type { Blockquote, Paragraph, Text } from "mdast";
import { CALLOUT_VARIANTS, type CalloutVariant } from "./Callout";

const MARKER_RE = /^\s*\[!(INFO|WARNING|DANGER|SUCCESS)\]\s*\n?/;

function variantFromMarker(label: string): CalloutVariant {
  const lower = label.toLowerCase();
  return (CALLOUT_VARIANTS as readonly string[]).includes(lower)
    ? (lower as CalloutVariant)
    : "info";
}

export const calloutHandler: BlockHandler = {
  pmType: "callout",
  mdastTypes: ["blockquote"],

  parse(node: MdastNode, ctx: ParseContext): PmNode | null {
    if (node.type !== "blockquote") return null;
    const bq = node;
    const children = bq.children;
    if (children.length === 0) return null;

    const first = children[0];
    if (!first || first.type !== "paragraph") return null;

    const para = first;
    const phrasing = para.children;
    const firstPhrasing = phrasing[0];
    if (!firstPhrasing || firstPhrasing.type !== "text") return null;
    const text = (firstPhrasing).value;

    const match = MARKER_RE.exec(text);
    if (!match) return null;
    const variant = variantFromMarker(match[1] ?? "INFO");

    // Strip the marker. Two cases:
    //   a) Marker took the whole text → drop the first paragraph entirely.
    //   b) Marker only consumed a prefix → keep the paragraph with
    //      the remaining text + later phrasing children.
    const rest = text.slice(match[0].length);
    const remainingParagraphs: MdastBlock[] = [];
    const trailingPhrasing = phrasing.slice(1);
    if (rest.length > 0 || trailingPhrasing.length > 0) {
      const newPara: Paragraph = {
        type: "paragraph",
        children: [
          ...(rest.length > 0 ? [{ type: "text", value: rest } satisfies Text] : []),
          ...(trailingPhrasing),
        ],
      };
      remainingParagraphs.push(newPara);
    }
    const innerBlocks: MdastBlock[] = [
      ...remainingParagraphs,
      ...children.slice(1),
    ];
    const innerPm = ctx.parseBlocks(innerBlocks);
    return {
      type: "callout",
      attrs: { variant },
      content: innerPm.length > 0 ? innerPm : [{ type: "paragraph" }],
    };
  },

  serialize(node: PmNode, ctx: SerializeContext): MdastBlock {
    const variant = (node.attrs?.["variant"] as CalloutVariant | undefined) ?? "info";
    const marker: Paragraph = {
      type: "paragraph",
      children: [{ type: "text", value: `[!${variant.toUpperCase()}]` } satisfies Text],
    };
    const inner = ctx.serializeBlocks(node.content ?? []);
    return {
      type: "blockquote",
      children: [marker, ...(inner as Blockquote["children"])],
    } satisfies Blockquote;
  },
};
