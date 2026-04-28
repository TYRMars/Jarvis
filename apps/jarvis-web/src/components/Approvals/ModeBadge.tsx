// Permission-mode badge for the chat header / composer.
//
// Subscribes to `appStore.permissionMode` (set by the
// `permission_mode` server frame) and renders a pill that, on
// click, opens an inline picker with all five modes. Selecting a
// mode sends `set_mode` over the WS — the server echoes the new
// mode back via the same `permission_mode` frame, which keeps the
// store in sync.
//
// Bypass *is* selectable from the picker but pops a `confirm()`
// first — once enabled, every gated tool runs with no prompt
// until the user switches back. The badge itself is
// non-interactive when no socket is open.

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { setSocketMode, type PermissionMode } from "../../services/permissions";
import { isOpen } from "../../services/socket";
import { t } from "../../utils/i18n";

interface ModeOption {
  mode: PermissionMode;
  labelKey: string;
  descKey: string;
  /// What the badge looks like when this mode is active. Plain
  /// glyphs only — no SVG — so the chrome stays compact and lines
  /// up with neighbouring `acceptEdits` / dot separators.
  glyph: string;
}

const OPTIONS: ModeOption[] = [
  { mode: "ask", labelKey: "permModeAsk", descKey: "permModeAskDesc", glyph: "⏵" },
  { mode: "accept-edits", labelKey: "permModeAcceptEdits", descKey: "permModeAcceptEditsDesc", glyph: "⏵⏵" },
  { mode: "plan", labelKey: "permModePlan", descKey: "permModePlanDesc", glyph: "📋" },
  { mode: "auto", labelKey: "permModeAuto", descKey: "permModeAutoDesc", glyph: "🚀" },
  { mode: "bypass", labelKey: "permModeBypass", descKey: "permModeBypassDesc", glyph: "⚠" },
];

export function ModeBadge() {
  const mode = useAppStore((s) => s.permissionMode);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const socketReady = isOpen();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const active = OPTIONS.find((o) => o.mode === mode) ?? OPTIONS[0];

  return (
    <div
      className={`mode-badge${open ? " open" : ""}${mode === "bypass" ? " bypass" : ""}`}
      data-mode={mode}
      ref={ref}
    >
      <button
        type="button"
        className="mode-badge-trigger"
        onClick={() => setOpen((v) => !v)}
        title={t(active.descKey)}
        aria-haspopup="menu"
        aria-expanded={open ? true : false}
      >
        <span className="mode-badge-glyph" aria-hidden="true">{active.glyph}</span>
        <span className="mode-badge-label">{t(active.labelKey)}</span>
      </button>
      {open ? (
        <div className="mode-badge-menu" role="menu">
          <div className="mode-badge-menu-title">{t("permModePicker")}</div>
          {OPTIONS.map((opt) => {
            const selected = opt.mode === mode;
            const disabled = !socketReady;
            return (
              <button
                key={opt.mode}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={`mode-badge-option${selected ? " selected" : ""}${
                  opt.mode === "bypass" ? " danger" : ""
                }`}
                disabled={disabled}
                title={t(opt.descKey)}
                onClick={() => {
                  if (selected) {
                    setOpen(false);
                    return;
                  }
                  // Bypass disables every approval gate — get an
                  // explicit click-through before flipping. Anything
                  // else flips immediately.
                  if (opt.mode === "bypass") {
                    const ok = window.confirm(t("permModeBypassConfirm"));
                    if (!ok) return;
                  }
                  if (setSocketMode(opt.mode)) {
                    setOpen(false);
                  }
                }}
              >
                <span className="mode-badge-option-glyph" aria-hidden="true">{opt.glyph}</span>
                <span className="mode-badge-option-text">
                  <span className="mode-badge-option-label">{t(opt.labelKey)}</span>
                  <span className="mode-badge-option-desc">{t(opt.descKey)}</span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
