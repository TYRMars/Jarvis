// Shared empty-state card. One canonical shape for "this list /
// board / search has nothing to show", used across Chat / Projects /
// Docs so the visual contract stays unified.
//
// Spec: docs/design-system/patterns.md#empty-states.
//   - centered (flex column, justify-center, align-center)
//   - 32×32 monochrome icon (optional)
//   - title 14/560
//   - hint 13/normal, line-height 1.5 (optional, single sentence)
//   - primary-accent CTA (optional, for an obvious next action)
//
// Render contexts vary in width:
//   - chat sidebar     ~280px
//   - docs list column ~280px
//   - projects canvas  up to 960px
// The card auto-caps at max-width: 360px; on narrower hosts it
// shrinks to fit. Layout is the same in all three.

import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  hint?: string;
  cta?: {
    label: string;
    onClick: () => void;
    icon?: ReactNode;
  };
}

export function EmptyState({ icon, title, hint, cta }: EmptyStateProps) {
  return (
    <div className="empty-state-card" aria-live="polite">
      {icon && (
        <div className="empty-state-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <h2 className="empty-state-title">{title}</h2>
      {hint && <p className="empty-state-hint">{hint}</p>}
      {cta && (
        <button
          type="button"
          className="empty-state-cta"
          onClick={cta.onClick}
        >
          {cta.icon}
          <span>{cta.label}</span>
        </button>
      )}
    </div>
  );
}
