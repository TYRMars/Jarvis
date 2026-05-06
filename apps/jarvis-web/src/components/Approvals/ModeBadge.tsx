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
import { messages, t, type Lang } from "../../utils/i18n";

interface ModeOption {
  mode: PermissionMode;
  labelKey: string;
  descKey: string;
}

const OPTIONS: ModeOption[] = [
  { mode: "ask", labelKey: "permModeAsk", descKey: "permModeAskDesc" },
  { mode: "accept-edits", labelKey: "permModeAcceptEdits", descKey: "permModeAcceptEditsDesc" },
  { mode: "plan", labelKey: "permModePlan", descKey: "permModePlanDesc" },
  { mode: "auto", labelKey: "permModeAuto", descKey: "permModeAutoDesc" },
  { mode: "bypass", labelKey: "permModeBypass", descKey: "permModeBypassDesc" },
];

function optionLabel(opt: ModeOption, lang: Lang) {
  const label = t(opt.labelKey);
  if (lang !== "zh") return label;

  const english = messages.en[opt.labelKey];
  return typeof english === "string" ? `${label}（${english}）` : label;
}

export function ModeBadge() {
  const mode = useAppStore((s) => s.permissionMode);
  const lang = useAppStore((s) => s.lang);
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
        <span className="mode-badge-label">{t(active.labelKey)}</span>
        <svg className="mode-badge-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open ? (
        <div className="mode-badge-menu" role="menu">
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
                <span className="mode-badge-option-label">{optionLabel(opt, lang)}</span>
                <span className="mode-badge-option-check" aria-hidden="true">
                  {selected ? "✓" : ""}
                </span>
                <span className="mode-badge-option-key" aria-hidden="true">
                  {OPTIONS.indexOf(opt) + 1}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
