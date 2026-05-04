// Sidebar footer settings menu. Hosts quick Theme + Language
// switchers and a Settings link to the full /settings page. All
// state lives in the store; click and click-outside both flow through
// `accountMenuOpen`.

import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useAppStore } from "../../store/appStore";
import { t } from "../../utils/i18n";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

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
        <div className="account-menu-title">{tx("settingsTitle", "Settings")}</div>
        <ThemeRow />
        <LangRow />
        <Link
          to="/settings"
          className="account-menu-link"
          onClick={() => setOpen(false)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
          </svg>
          <span>{tx("settingsTitle", "Settings")}</span>
        </Link>
      </div>
      <button
        id="account-menu-button"
        type="button"
        className="account-chip"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        <SettingsIcon />
        <span>{tx("settingsTitle", "Settings")}</span>
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

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
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
