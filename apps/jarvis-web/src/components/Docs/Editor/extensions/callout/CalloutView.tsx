// React NodeView for the Callout block.
// Visual spec §6.1: 4px coloured left border, 12/16 padding, 6px
// radius, small variant label up top, editable body via
// NodeViewContent. The variant chips at top-right swap between
// info / warning / danger / success.

import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { CALLOUT_VARIANTS, type CalloutVariant } from "./Callout";
import { t } from "../../../../../utils/i18n";

const VARIANT_LABEL: Record<CalloutVariant, string> = {
  info: "INFO",
  warning: "WARNING",
  danger: "DANGER",
  success: "SUCCESS",
};

const VARIANT_GLYPH: Record<CalloutVariant, string> = {
  info: "ⓘ",
  warning: "⚠",
  danger: "✕",
  success: "✓",
};

export function CalloutView({ node, updateAttributes, editor }: NodeViewProps) {
  const variant = (node.attrs["variant"] as CalloutVariant) ?? "info";
  const editable = editor.isEditable;
  return (
    <NodeViewWrapper
      className={`callout callout-${variant}`}
      data-variant={variant}
      data-type="callout"
    >
      <header className="callout-header" contentEditable={false}>
        <span className="callout-label">
          <span aria-hidden className="callout-glyph">
            {VARIANT_GLYPH[variant]}
          </span>
          {VARIANT_LABEL[variant]}
        </span>
        {editable ? (
          <div className="callout-variant-switcher" role="radiogroup" aria-label={t("docsEdCalloutVariant")}>
            {CALLOUT_VARIANTS.map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={v === variant}
                aria-label={VARIANT_LABEL[v]}
                title={VARIANT_LABEL[v]}
                className={
                  `callout-swatch callout-swatch-${v}` +
                  (v === variant ? " is-active" : "")
                }
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => updateAttributes({ variant: v })}
              />
            ))}
          </div>
        ) : null}
      </header>
      <NodeViewContent className="callout-body" />
    </NodeViewWrapper>
  );
}
