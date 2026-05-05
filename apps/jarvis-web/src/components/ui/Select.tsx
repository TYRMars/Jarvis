// Custom dropdown that replaces the browser's `<select>` for places
// that want consistent styling, dark-mode-aware option rows, optional
// inline search, and a "no current value" placeholder. The native
// element is fine for short, never-customised lists; this is for the
// long, language-aware lists in Settings → Providers, the kanban
// column-kind picker, and so on.
//
// API mirrors `<select>` as closely as it usefully can:
//   - `value` is the current selection (controlled).
//   - `onChange(value)` fires on pick.
//   - `options` is the items list `{value, label, group?}` — `group`
//     surfaces a heading row when present, mimicking `<optgroup>`.
//
// What we DON'T do (yet, by design):
//   - Multi-select. Add a `<MultiSelect>` sibling when needed.
//   - Async / paginated options. Pass a pre-resolved array.
//   - Free-typing / combobox. Use a `<TextField>` + suggestion list.
//
// Accessibility: `role="combobox"` on the trigger, `role="listbox"`
// on the popup, `role="option"` per item, `aria-activedescendant` for
// keyboard navigation. ESC closes, Enter / Space picks, ↑/↓ moves the
// active row, type-ahead jumps to the first option whose label
// matches the typed prefix.

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export interface SelectOption<T extends string = string> {
  /// Identity stored in `value`. Must be unique within the option list.
  value: T;
  /// Display text. Free-form ReactNode so callers can prefix icons
  /// without breaking the type.
  label: ReactNode;
  /// Optional group heading. Consecutive options with the same `group`
  /// get a single heading row above them.
  group?: string;
  /// Disable individual rows (e.g. "currently active" mode). Renders
  /// at lower opacity and skips during keyboard navigation.
  disabled?: boolean;
  /// Used by the type-ahead search. Defaults to the option's text
  /// content; supply explicitly when `label` is a complex node and
  /// the searchable surface should be different.
  searchText?: string;
}

export interface SelectProps<T extends string = string> {
  value: T;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  /// Placeholder shown on the trigger when `value` matches no option.
  /// (Common for "create" forms before the user picks anything.)
  placeholder?: ReactNode;
  /// Optional `aria-label` on the trigger when no visible label is
  /// nearby. Always set in form contexts to keep VoiceOver happy.
  ariaLabel?: string;
  /// Trigger class. Default styling is shared with `.settings-input`
  /// so the control fits inside a `<Row>` settings cell.
  className?: string;
  /// Show an inline search filter at the top of the popup. Right call
  /// for ≥ ~12 options (Providers list, model picker); leave off for
  /// short lists.
  searchable?: boolean;
  /// Disable the whole control.
  disabled?: boolean;
  /// Force the popup width — defaults to "match trigger". Specify when
  /// the trigger is narrow (icon-only) but the labels are long.
  popupMinWidth?: number;
}

export function Select<T extends string = string>({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  className,
  searchable = false,
  disabled = false,
  popupMinWidth,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState<number>(() =>
    Math.max(
      0,
      options.findIndex((o) => o.value === value),
    ),
  );
  const [query, setQuery] = useState("");
  // Portal-positioned popup: tracks the trigger's bounding rect so we
  // can render the popup at fixed coords inside `<body>` and escape
  // any `overflow: hidden|auto|scroll` ancestor (modal scroll
  // containers, kanban panes, etc.). Recomputed on every open and on
  // window scroll/resize while open.
  const [popupRect, setPopupRect] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const reactId = useId();

  // Filter options against the search query (when searchable).
  const filtered = useMemo(() => {
    if (!searchable || !query.trim()) return options;
    const q = query.trim().toLowerCase();
    return options.filter((opt) => {
      const text =
        opt.searchText ??
        (typeof opt.label === "string" ? opt.label : String(opt.value));
      return text.toLowerCase().includes(q);
    });
  }, [options, query, searchable]);

  // Snap the active index into range when the filtered list changes.
  useEffect(() => {
    if (filtered.length === 0) {
      setActiveIdx(0);
      return;
    }
    if (activeIdx >= filtered.length) setActiveIdx(0);
  }, [filtered, activeIdx]);

  // Outside-click close. Skip when the popup isn't open so we don't
  // burn a global listener at idle.
  //
  // Capture phase is intentional: ancestor containers (e.g. the
  // shared `<Modal>` shell, which calls `e.stopPropagation()` on
  // pointerdown to keep clicks inside the dialog from dismissing it
  // via the backdrop) would otherwise swallow the bubble before
  // the document-level listener fires, leaving the popup open after
  // a click elsewhere in the modal — including a click on a
  // sibling Select's trigger, which then leaves two popups visible
  // at once.
  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popupRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointer, true);
    return () =>
      document.removeEventListener("pointerdown", onDocPointer, true);
  }, [open]);

  // Auto-focus search field when opening so type-ahead works without
  // a second click.
  useEffect(() => {
    if (open && searchable) {
      // Defer one frame so the input exists in the DOM.
      const id = window.setTimeout(() => searchRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open, searchable]);

  // Compute / track the popup's portal-fixed coordinates.
  //  - useLayoutEffect for the initial measurement so we don't paint
  //    a frame at (0, 0) before the rect lands.
  //  - Capture-phase scroll listener so popups close-track even when
  //    a nested scroller (modal body) moves.
  //  - Flip-up when there's less room below than above + the popup's
  //    natural max-height (320px) wouldn't fit; cap maxHeight so the
  //    popup is never taller than its viewport budget.
  useLayoutEffect(() => {
    if (!open) {
      setPopupRect(null);
      return;
    }
    const POPUP_MAX = 320;
    const MARGIN = 8;
    const compute = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom - MARGIN;
      const above = r.top - MARGIN;
      const flipUp = below < 200 && above > below;
      if (flipUp) {
        setPopupRect({
          top: Math.max(MARGIN, r.top - Math.min(POPUP_MAX, above) - 4),
          left: r.left,
          width: r.width,
          maxHeight: Math.min(POPUP_MAX, Math.max(120, above)),
        });
      } else {
        setPopupRect({
          top: r.bottom + 4,
          left: r.left,
          width: r.width,
          maxHeight: Math.min(POPUP_MAX, Math.max(120, below)),
        });
      }
    };
    compute();
    const onScroll = () => compute();
    const onResize = () => compute();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const selected = options.find((o) => o.value === value) ?? null;

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onPopupKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => stepIdx(filtered, i, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => stepIdx(filtered, i, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = filtered[activeIdx];
      if (opt && !opt.disabled) {
        onChange(opt.value);
        setOpen(false);
        triggerRef.current?.focus();
      }
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIdx(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIdx(filtered.length - 1);
    }
  };

  const popupId = `${reactId}-popup`;
  const activeId = `${reactId}-opt-${activeIdx}`;

  return (
    <div className={"ui-select" + (open ? " open" : "")}>
      <button
        ref={triggerRef}
        type="button"
        className={"ui-select-trigger" + (className ? " " + className : "")}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={popupId}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKey}
      >
        <span className="ui-select-trigger-label">
          {selected ? selected.label : (placeholder ?? "")}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="ui-select-chevron"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && popupRect && createPortal(
        <div
          ref={popupRef}
          id={popupId}
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={activeId}
          onKeyDown={onPopupKey}
          className="ui-select-popup ui-select-popup-portal"
          style={{
            position: "fixed",
            top: `${popupRect.top}px`,
            left: `${popupRect.left}px`,
            minWidth: `${Math.max(popupRect.width, popupMinWidth ?? 0)}px`,
            maxHeight: `${popupRect.maxHeight}px`,
            // Must clear `.docs-modal-overlay` (z-index: 1000) so the
            // popup is visible when this Select is rendered inside a
            // Modal. 1100 leaves headroom for any future overlay layer
            // above the modal but below page-blocking dialogs.
            zIndex: 1100,
          }}
        >
          {searchable && (
            <div className="ui-select-search">
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search…"
                aria-label="Search options"
              />
            </div>
          )}
          {filtered.length === 0 ? (
            <div className="ui-select-empty">No matches</div>
          ) : (
            <ul className="ui-select-list">
              {filtered.map((opt, idx) => {
                const showHeading =
                  opt.group && opt.group !== filtered[idx - 1]?.group;
                return (
                  <li key={String(opt.value)}>
                    {showHeading ? (
                      <div className="ui-select-group">{opt.group}</div>
                    ) : null}
                    <div
                      id={`${reactId}-opt-${idx}`}
                      role="option"
                      aria-selected={opt.value === value}
                      aria-disabled={opt.disabled}
                      className={
                        "ui-select-option" +
                        (idx === activeIdx ? " active" : "") +
                        (opt.value === value ? " selected" : "") +
                        (opt.disabled ? " disabled" : "")
                      }
                      onMouseEnter={() => setActiveIdx(idx)}
                      onClick={() => {
                        if (opt.disabled) return;
                        onChange(opt.value);
                        setOpen(false);
                        triggerRef.current?.focus();
                      }}
                    >
                      <span className="ui-select-option-label">{opt.label}</span>
                      {opt.value === value && (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.4"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                          className="ui-select-check"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

/// Step the active index forward or backward, skipping disabled rows
/// so keyboard nav doesn't land on something the user can't pick.
function stepIdx<T extends string>(
  list: SelectOption<T>[],
  current: number,
  delta: 1 | -1,
): number {
  if (list.length === 0) return 0;
  let i = current;
  for (let n = 0; n < list.length; n++) {
    i = (i + delta + list.length) % list.length;
    if (!list[i].disabled) return i;
  }
  return current;
}
