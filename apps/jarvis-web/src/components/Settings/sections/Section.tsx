// Shared chrome for one settings section. The id is the anchor
// target the left nav links to (`href="#appearance"` etc.); the
// title is the visible heading. Description renders smaller in
// muted text under the title — use it to explain what the section
// controls when that's not obvious from the field labels alone.
//
// Embedded mode: when a section is rendered inside a super-section
// Tab (Models / Extensions / System / AppearanceLayout), the parent
// already provides the page-level h2 + description, so the leaf
// section drops its own outer chrome and renders only its body —
// optionally prefixed by a small muted intro paragraph for
// load-bearing descriptions (e.g. "Reload after saving" on the API
// section). Pass `embedded` through from the leaf section's prop.

import { ReactNode } from "react";
import { t } from "../../../utils/i18n";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

interface Props {
  id: string;
  titleKey: string;
  titleFallback: string;
  descKey?: string;
  descFallback?: string;
  children: ReactNode;
  /// Render without the outer `<section>` / h2 chrome, for use
  /// inside a Tab. Description (if present) is preserved as a
  /// muted intro paragraph so important hints aren't lost.
  embedded?: boolean;
}

export function Section({
  id,
  titleKey,
  titleFallback,
  descKey,
  descFallback,
  children,
  embedded,
}: Props) {
  if (embedded) {
    return (
      <div className="settings-section-embedded">
        {descKey && descFallback && (
          <p className="settings-section-desc">{tx(descKey, descFallback)}</p>
        )}
        <div className="settings-section-body">{children}</div>
      </div>
    );
  }

  return (
    <section id={id} className="settings-section">
      <header className="settings-section-header">
        <h2>{tx(titleKey, titleFallback)}</h2>
        {descKey && descFallback && (
          <p className="settings-section-desc">{tx(descKey, descFallback)}</p>
        )}
      </header>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}

/// One labelled row inside a section. The label sits on the left
/// and a control on the right (radio group, input, badge, …).
export function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-label">
        <div>{label}</div>
        {hint && <div className="settings-row-hint">{hint}</div>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}
