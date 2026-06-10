// Reasoning-effort quick selector for the composer toolbar.
//
// A small brain-icon button that opens a portal dropdown of the five
// effort presets (low → max), wired to `appStore.effort` /
// `setEffort`. The button is hidden entirely when the currently
// routed model reports `supportsReasoning: false`; if the capability
// is unknown (null/undefined) or no model is pinned we leave it
// visible — the catalog reports "unknown" rather than guessing, and
// the underlying effort value is harmless on a non-reasoning model.
//
// The dropdown renders through a portal on document.body so it
// escapes the composer's overflow/stacking context, positions itself
// with a viewport-aware flip (opens above the button when there isn't
// room below), and closes on outside-click + Escape.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore, type EffortLevel } from "../../store/appStore";
import { t } from "../../utils/i18n";

const EFFORT_OPTIONS: { value: EffortLevel; labelKey: string }[] = [
  { value: "low", labelKey: "effortLow" },
  { value: "medium", labelKey: "effortMedium" },
  { value: "high", labelKey: "effortHigh" },
  { value: "extra-high", labelKey: "effortExtraHigh" },
  { value: "max", labelKey: "effortMax" },
];

const DROPDOWN_MAX_HEIGHT = 240;

interface MenuPos {
  left: number;
  top?: number;
  bottom?: number;
}

export function EffortLevelSelector() {
  const providers = useAppStore((s) => s.providers);
  const routing = useAppStore((s) => s.routing);
  const effort = useAppStore((s) => s.effort);
  const setEffort = useAppStore((s) => s.setEffort);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Resolve whether the routed model supports reasoning. Hide the
  // button only on an explicit `false`; unknown / no-model stays
  // visible (see header comment).
  const supportsReasoning = useMemo(() => {
    if (!routing) return null;
    const [provider, model] = routing.split("|");
    const p = providers.find((pr) => pr.name === provider);
    const cap = (p?.capabilities ?? []).find((c) => c.model === model);
    return cap?.supportsReasoning ?? null;
  }, [providers, routing]);

  const place = () => {
    const btn = btnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const openAbove = spaceBelow < DROPDOWN_MAX_HEIGHT && rect.top > spaceBelow;
    if (openAbove) {
      setPos({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
    } else {
      setPos({ left: rect.left, top: rect.bottom + 6 });
    }
  };

  // Recompute placement synchronously when opening so the first paint
  // is already in the right spot.
  useLayoutEffect(() => {
    if (open) place();
  }, [open]);

  // Outside-click + Escape close; re-place on scroll / resize.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    const onReflow = () => place();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open]);

  if (supportsReasoning === false) return null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={"effort-level-trigger" + (open ? " open" : "")}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("composerEffortLevelButtonTitle")}
        aria-label={t("composerEffortLevelButtonTitle")}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 5a3 3 0 0 0-3 3 3 3 0 0 0-1 5.83A2.5 2.5 0 0 0 12 19a2.5 2.5 0 0 0 4-3.17A3 3 0 0 0 15 8a3 3 0 0 0-3-3Z" />
          <path d="M12 5v14" />
        </svg>
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={menuRef}
              className="effort-level-dropdown"
              role="menu"
              style={{
                left: pos.left,
                ...(pos.top != null ? { top: pos.top } : {}),
                ...(pos.bottom != null ? { bottom: pos.bottom } : {}),
              }}
            >
              <div className="effort-level-dropdown-heading">
                {t("composerEffortLevelDropdownTitle")}
              </div>
              {EFFORT_OPTIONS.map((opt) => {
                const active = opt.value === effort;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    className={"effort-level-option" + (active ? " selected" : "")}
                    onClick={() => {
                      setEffort(opt.value);
                      setOpen(false);
                    }}
                  >
                    <span className="effort-level-option-label">{t(opt.labelKey)}</span>
                    <span className="effort-level-option-check" aria-hidden="true">
                      {active ? "✓" : ""}
                    </span>
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
