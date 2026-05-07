// Public surface for the markdown <-> Tiptap JSON layer.
export { fromMarkdown } from "./parse";
export { toMarkdown } from "./stringify";
export { registerHandler } from "./registry";
export type {
  BlockHandler,
  MdastBlock,
  MdastNode,
  MdastPhrasing,
  MdastRoot,
  ParseContext,
  PmNode,
  SerializeContext,
} from "./types";
