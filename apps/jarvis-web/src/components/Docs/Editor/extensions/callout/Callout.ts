// Tiptap node for the Callout block (4 variants).
// Spec §6.1: defining block-group container with a single
// `variant` attr, parse/render via a `data-type="callout"` div.
//
// The `defining: true` flag means a backspace at the very start of
// the inner content lifts the user out of the callout instead of
// silently merging it into the previous paragraph — matching the
// behaviour Outline / Notion users expect.

import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { CalloutView } from "./CalloutView";

export type CalloutVariant = "info" | "warning" | "danger" | "success";

export const CALLOUT_VARIANTS: readonly CalloutVariant[] = [
  "info",
  "warning",
  "danger",
  "success",
];

export interface CalloutAttributes {
  variant: CalloutVariant;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (attrs?: { variant?: CalloutVariant }) => ReturnType;
      updateCalloutVariant: (variant: CalloutVariant) => ReturnType;
    };
  }
}

export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      variant: {
        default: "info" as CalloutVariant,
        parseHTML: (el) => normaliseVariant(el.getAttribute("data-variant")),
        renderHTML: (attrs) => ({ "data-variant": attrs["variant"] as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-type": "callout" }),
      0,
    ];
  },

  addCommands() {
    return {
      setCallout:
        (attrs) =>
        ({ commands }) => {
          const variant = attrs?.variant ?? "info";
          return commands.wrapIn(this.name, { variant });
        },
      updateCalloutVariant:
        (variant) =>
        ({ commands }) => {
          return commands.updateAttributes(this.name, { variant });
        },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },
});

function normaliseVariant(raw: string | null): CalloutVariant {
  if (raw === "warning" || raw === "danger" || raw === "success") return raw;
  return "info";
}
