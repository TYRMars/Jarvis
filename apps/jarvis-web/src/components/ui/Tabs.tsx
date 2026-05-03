// Tabs primitive — used by the redesigned settings super-sections
// (Models / Extensions / System / AppearanceLayout) to switch
// between subviews without changing the routed section.
//
// Both controlled (`value` + `onChange`) and uncontrolled
// (`defaultValue`) shapes are supported; the settings page uses
// the controlled form so it can sync the active tab to a hash
// suffix (`#models/subagents`).
//
// Visuals lean on existing settings tokens — no new CSS variables
// introduced. The active tab is underlined with the `accent` color;
// inactive tabs are muted text with a subtle hover bg.

import { useState, type ReactNode } from "react";

export interface TabItem {
  /// Stable id used in URL hash and as the React key.
  id: string;
  /// Display label (already localised by the caller).
  label: string;
  /// Optional small hint shown on hover (title attribute).
  hint?: string;
  /// Optional badge value (e.g. count) shown after the label.
  badge?: ReactNode;
  /// Body content rendered when this tab is active.
  content: ReactNode;
}

interface CommonProps {
  items: TabItem[];
  /// ARIA label for the tablist (screen readers).
  ariaLabel?: string;
  /// Optional class for the outer wrapper.
  className?: string;
}

interface ControlledProps extends CommonProps {
  value: string;
  onChange: (id: string) => void;
  defaultValue?: never;
}

interface UncontrolledProps extends CommonProps {
  value?: never;
  onChange?: never;
  defaultValue?: string;
}

export type TabsProps = ControlledProps | UncontrolledProps;

export function Tabs(props: TabsProps) {
  const { items, ariaLabel, className } = props;
  const isControlled = "value" in props && props.value !== undefined;
  const fallback = items[0]?.id ?? "";
  const [internal, setInternal] = useState<string>(
    props.defaultValue ?? fallback,
  );
  const active = isControlled && props.value ? props.value : internal;
  const setActive = (id: string) => {
    if (isControlled) {
      props.onChange?.(id);
    } else {
      setInternal(id);
    }
  };

  // Resolve to a known tab even if the caller passes a stale id
  // (e.g. from a deep-link). Falling back keeps the panel from
  // rendering empty.
  const activeItem =
    items.find((it) => it.id === active) ?? items[0];

  return (
    <div className={"settings-tabs" + (className ? " " + className : "")}>
      <div
        role="tablist"
        aria-label={ariaLabel}
        className="settings-tabs-list"
      >
        {items.map((it) => {
          const selected = activeItem && it.id === activeItem.id;
          return (
            <button
              key={it.id}
              type="button"
              role="tab"
              id={`settings-tab-${it.id}`}
              aria-selected={selected}
              aria-controls={`settings-tabpanel-${it.id}`}
              tabIndex={selected ? 0 : -1}
              title={it.hint}
              className={
                "settings-tabs-tab" + (selected ? " active" : "")
              }
              onClick={() => setActive(it.id)}
              onKeyDown={(e) => {
                if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                e.preventDefault();
                const idx = items.findIndex((x) => x.id === activeItem?.id);
                if (idx < 0) return;
                const delta = e.key === "ArrowRight" ? 1 : -1;
                const next = items[(idx + delta + items.length) % items.length];
                setActive(next.id);
                const el = document.getElementById(`settings-tab-${next.id}`);
                el?.focus();
              }}
            >
              <span>{it.label}</span>
              {it.badge !== undefined && (
                <span className="settings-tabs-badge" aria-hidden="true">
                  {it.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {activeItem && (
        <div
          role="tabpanel"
          id={`settings-tabpanel-${activeItem.id}`}
          aria-labelledby={`settings-tab-${activeItem.id}`}
          className="settings-tabs-panel"
        >
          {activeItem.content}
        </div>
      )}
    </div>
  );
}
