// Toggle (collapsible details) block — three Tiptap nodes:
//   - toggle: the wrapper, holds the open/closed state
//   - toggleSummary: the always-visible header line (inline only)
//   - toggleContent: the body, hidden via CSS when collapsed
//
// Spec §6.2 — collapse is a CSS-only affair; we never remove the
// content from the doc tree (so the cursor can't slip into a
// hidden region — see the NodeView's `tabIndex=-1` guard plus
// `pointer-events: none` on `.toggle-content` when closed).

import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { ToggleView } from "./ToggleView";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    toggle: {
      setToggle: (attrs?: { open?: boolean }) => ReturnType;
      setToggleOpen: (open: boolean) => ReturnType;
    };
  }
}

export const Toggle = Node.create({
  name: "toggle",
  group: "block",
  content: "toggleSummary toggleContent",
  defining: true,

  addAttributes() {
    return {
      open: {
        default: false,
        parseHTML: (el) => el.getAttribute("data-open") === "true",
        renderHTML: (attrs) => ({
          "data-open": String(Boolean(attrs["open"])),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="toggle"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-type": "toggle" }),
      0,
    ];
  },

  addCommands() {
    return {
      setToggle:
        (attrs) =>
        ({ chain }) => {
          const open = attrs?.open ?? false;
          // Insert a Toggle wrapping the current paragraph as summary
          // and an empty paragraph as the body.
          return chain()
            .insertContent({
              type: this.name,
              attrs: { open },
              content: [
                { type: "toggleSummary" },
                {
                  type: "toggleContent",
                  content: [{ type: "paragraph" }],
                },
              ],
            })
            .run();
        },
      setToggleOpen:
        (open) =>
        ({ commands }) => {
          return commands.updateAttributes(this.name, { open });
        },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ToggleView);
  },
});

export const ToggleSummary = Node.create({
  name: "toggleSummary",
  // Inline-only content for the visible header line. `defining`
  // keeps backspace from merging the summary into a previous block.
  content: "inline*",
  defining: true,
  isolating: true,

  parseHTML() {
    return [{ tag: 'div[data-toggle-part="summary"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-toggle-part": "summary" }),
      0,
    ];
  },
});

export const ToggleContent = Node.create({
  name: "toggleContent",
  content: "block+",
  defining: true,
  isolating: true,

  parseHTML() {
    return [{ tag: 'div[data-toggle-part="content"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-toggle-part": "content" }),
      0,
    ];
  },
});
