// Shared chrome for one settings section. The id is the anchor
// target the left nav links to (`href="#appearance"` etc.); the
// title is the visible heading. Description renders smaller in
// muted text under the title — use it to explain what the section
// controls when that's not obvious from the field labels alone.

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
}

export function Section({ id, titleKey, titleFallback, descKey, descFallback, children }: Props) {
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
