// Public surface for the Docs block editor. Importing this barrel
// also imports — and therefore registers — every custom block's
// markdown handler, so callers don't have to thread `registerHandler`
// themselves.

import "./editor.css";

export { BlockEditor, type BlockEditorProps } from "./BlockEditor";
export {
  fromMarkdown,
  toMarkdown,
  type PmNode,
} from "./markdown";
export {
  createMockUploadAdapter,
  type ImageUploadAdapter,
  type ImageUploadResult,
} from "./extensions/imageUpload";
export {
  CALLOUT_VARIANTS,
  type CalloutVariant,
} from "./extensions/callout";
export type { SlashCandidate } from "./extensions/slashMenu";
