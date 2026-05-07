// Callout extension entry point. Importing this module also
// registers its markdown handler so any serializer call later in
// the same JS realm sees the Callout shape.

import { registerHandler } from "../../markdown";
import type { SlashCandidate } from "../slashMenu/candidates";
import { calloutHandler } from "./markdown";
import type { CalloutVariant } from "./Callout";

registerHandler(calloutHandler);

export { Callout, CALLOUT_VARIANTS, type CalloutVariant } from "./Callout";
export { calloutHandler } from "./markdown";

const VARIANT_DESC: Record<CalloutVariant, string> = {
  info: "提示 / 说明",
  warning: "警告 / 注意",
  danger: "危险 / 错误",
  success: "成功 / 完成",
};

const VARIANT_ICON: Record<CalloutVariant, string> = {
  info: "ⓘ",
  warning: "⚠",
  danger: "✕",
  success: "✓",
};

/** Slash-menu entries for the four Callout variants. The editor
 *  mounts these alongside `STANDARD_CANDIDATES`. */
export function calloutCandidates(): SlashCandidate[] {
  const variants: CalloutVariant[] = ["info", "warning", "danger", "success"];
  return variants.map((variant) => ({
    id: `callout-${variant}`,
    title: `Callout · ${variant[0]?.toUpperCase()}${variant.slice(1)}`,
    description: VARIANT_DESC[variant],
    keywords: ["callout", variant, "提示", "admonition"],
    icon: VARIANT_ICON[variant],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setCallout({ variant }).run();
    },
  }));
}
