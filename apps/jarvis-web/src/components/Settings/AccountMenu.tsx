// Account chip in the sidebar footer + the dropdown it pops open.
// Hosts the Theme + Language switchers and a (currently inert)
// Settings link. All three pieces of state live in the store; the
// chip-click and click-outside both flow through `accountMenuOpen`.

import { useEffect, useRef } from "react";
import { useAppStore } from "../../store/appStore";
import { t } from "../../utils/i18n";

export function AccountMenu() {
  const open = useAppStore((s) => s.accountMenuOpen);
  const setOpen = useAppStore((s) => s.setAccountMenuOpen);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open, setOpen]);

  return (
    <div className="account-menu-wrap" ref={wrapRef}>
      <div
        id="account-menu"
        className={"account-menu" + (open ? "" : " hidden")}
        role="menu"
      >
        <div className="account-menu-email">zhangjianan1996@icloud.com</div>
        <ThemeRow />
        <LangRow />
      </div>
      <button
        id="account-menu-button"
        type="button"
        className="account-chip"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 21a8 8 0 1 0-16 0" />
          <circle cx="12" cy="7" r="4" />
        </svg>
        <span>zhangjianan</span>
      </button>
    </div>
  );
}

function ThemeRow() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  return (
    <div className="account-menu-row">
      <span className="account-menu-label">{t("theme")}</span>
      <div className="mini-switch" role="group" aria-label="Theme">
        {(["light", "dark"] as const).map((t2) => (
          <button
            key={t2}
            type="button"
            className={"theme-btn" + (theme === t2 ? " active" : "")}
            data-theme-value={t2}
            aria-pressed={theme === t2}
            onClick={() => setTheme(t2)}
          >
            {t(t2 === "light" ? "themeLight" : "themeDark")}
          </button>
        ))}
      </div>
    </div>
  );
}

function LangRow() {
  const lang = useAppStore((s) => s.lang);
  const setLang = useAppStore((s) => s.setLang);
  return (
    <div className="account-menu-row">
      <span className="account-menu-label">{t("language")}</span>
      <div className="mini-switch" role="group" aria-label="Language">
        {(["en", "zh"] as const).map((l) => (
          <button
            key={l}
            type="button"
            className={"lang-btn" + (lang === l ? " active" : "")}
            data-lang={l}
            aria-pressed={lang === l}
            onClick={() => setLang(l)}
          >
            {l === "en" ? "EN" : "中文"}
          </button>
        ))}
      </div>
    </div>
  );
}
