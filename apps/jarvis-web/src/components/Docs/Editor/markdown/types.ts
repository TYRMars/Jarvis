// Markdown <-> Tiptap JSON contract used by handlers.
//
// We reuse mdast (the GFM-extended AST emitted by remark-parse +
// remark-gfm) as the wire format on the markdown side. PM JSON is
// the wire format on the editor side. Both sides walk the trees
// recursively and dispatch to handlers keyed by node type.
//
// `Strict` typing here on purpose: handlers either know how to parse
// a node or return null (so the parser can fall back to a paragraph
// of plain text), and serialise must always produce something.

import type { Root, RootContent, PhrasingContent, Nodes } from "mdast";

/** ProseMirror JSON node — Tiptap's native shape. */
export interface PmNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  text?: string;
}

/** mdast node — re-exported for handlers' convenience. */
export type MdastNode = Nodes;
export type MdastRoot = Root;
export type MdastBlock = RootContent;
export type MdastPhrasing = PhrasingContent;

/** Context passed to a handler during parse (mdast -> PM). */
export interface ParseContext {
  /** Recursively parse a list of mdast block nodes into PM nodes. */
  parseBlocks(nodes: readonly MdastBlock[]): PmNode[];
  /** Recursively parse a list of mdast phrasing nodes into PM nodes
   *  (text + inline marks). */
  parseInline(nodes: readonly MdastPhrasing[]): PmNode[];
}

/** Context passed to a handler during serialise (PM -> mdast). */
export interface SerializeContext {
  /** Recursively serialise a list of PM block nodes into mdast. */
  serializeBlocks(nodes: readonly PmNode[]): MdastBlock[];
  /** Recursively serialise a list of PM inline nodes into mdast
   *  phrasing content. */
  serializeInline(nodes: readonly PmNode[]): MdastPhrasing[];
}

/** A bidirectional handler for one block (or one mdast type pair). */
export interface BlockHandler {
  /** PM node `type` this handler owns when serialising. */
  pmType: string;
  /** mdast node `type`s this handler claims when parsing. A single
   *  handler may claim multiple mdast shapes (e.g. Callout claims
   *  the GFM admonition blockquote shape). */
  mdastTypes: readonly string[];
  /** mdast -> PM. Return null to defer to a fallback handler. */
  parse(node: MdastNode, ctx: ParseContext): PmNode | null;
  /** PM -> mdast. Always returns something; if the node is empty,
   *  return an empty paragraph or similar so the document never
   *  loses structure. */
  serialize(node: PmNode, ctx: SerializeContext): MdastBlock | MdastBlock[];
}
