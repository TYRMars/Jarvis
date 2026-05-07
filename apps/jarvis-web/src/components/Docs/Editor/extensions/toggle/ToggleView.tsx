// React NodeView for the Toggle wrapper. Renders a chevron button
// alongside Tiptap's NodeViewContent (which paints both child
// nodes — toggleSummary on top, toggleContent below). CSS hides
// the content when `data-open="false"`.

import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";

export function ToggleView({ node, updateAttributes }: NodeViewProps) {
  const open = Boolean(node.attrs["open"]);
  return (
    <NodeViewWrapper
      className={"toggle" + (open ? " is-open" : "")}
      data-type="toggle"
      data-open={String(open)}
    >
      <button
        type="button"
        contentEditable={false}
        className="toggle-chevron"
        aria-expanded={open}
        aria-label={open ? "折叠" : "展开"}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => updateAttributes({ open: !open })}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="m6 4 4 4-4 4" />
        </svg>
      </button>
      <NodeViewContent className="toggle-children" />
    </NodeViewWrapper>
  );
}
