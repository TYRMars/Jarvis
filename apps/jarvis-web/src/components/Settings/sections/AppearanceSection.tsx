// Theme + language. Same controls as the AccountMenu dropdown but
// at section-page scale; both write the same `appStore` actions
// so the two surfaces stay in sync.

import { useAppStore } from "../../../store/appStore";
import { Row, Section } from "./Section";
import { t } from "../../../utils/i18n";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

export function AppearanceSection({ embedded }: { embedded?: boolean } = {}) {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const lang = useAppStore((s) => s.lang);
  const setLang = useAppStore((s) => s.setLang);

  return (
    <Section
      id="appearance"
      titleKey="settingsAppearanceTitle"
      titleFallback="Appearance"
      descKey="settingsAppearanceDesc"
      descFallback="Theme and interface language. Saved to localStorage; takes effect immediately."
      embedded={embedded}
    >
      <div className="settings-theme-preview-grid" aria-label={tx("theme", "Theme")}>
        <button
          type="button"
          aria-label={tx("settingsThemeSystemPreview", "System preview")}
          className="settings-theme-preview is-system"
          title={tx("settingsThemeSystemHint", "System theme is shown as a preview; choose light or dark below.")}
        >
          <ThemePreviewChrome tone="system" />
          <span>{tx("settingsThemeSystem", "System")}</span>
        </button>
        <button
          type="button"
          aria-pressed={theme === "light"}
          aria-label={tx("settingsThemeLightPreview", "Light preview")}
          className={"settings-theme-preview is-light" + (theme === "light" ? " active" : "")}
          onClick={() => setTheme("light")}
        >
          <ThemePreviewChrome tone="light" />
          <span>{tx("themeLight", "Light")}</span>
        </button>
        <button
          type="button"
          aria-pressed={theme === "dark"}
          aria-label={tx("settingsThemeDarkPreview", "Dark preview")}
          className={"settings-theme-preview is-dark" + (theme === "dark" ? " active" : "")}
          onClick={() => setTheme("dark")}
        >
          <ThemePreviewChrome tone="dark" />
          <span>{tx("themeDark", "Dark")}</span>
        </button>
      </div>

      <div className="settings-theme-diff" aria-hidden="true">
        <div className="settings-theme-diff-pane is-remove">
          <div><span>1</span><code>const themePreview: ThemeConfig = {"{"}</code></div>
          <div><span>2</span><code>surface: "sidebar",</code></div>
          <div><span>3</span><code>accent: "#2563eb",</code></div>
          <div><span>4</span><code>contrast: 42,</code></div>
          <div><span>5</span><code>{"};"}</code></div>
        </div>
        <div className="settings-theme-diff-pane is-add">
          <div><span>1</span><code>const themePreview: ThemeConfig = {"{"}</code></div>
          <div><span>2</span><code>surface: "sidebar-elevated",</code></div>
          <div><span>3</span><code>accent: "#0ea5e9",</code></div>
          <div><span>4</span><code>contrast: 68,</code></div>
          <div><span>5</span><code>{"};"}</code></div>
        </div>
      </div>

      <div className="settings-theme-token-card" aria-label={tx("settingsThemeTokens", "Theme tokens")}>
        <div className="settings-theme-token-head">
          <strong>{tx("settingsThemeCodex", "Codex")}</strong>
          <span>{tx("settingsThemeTokens", "Theme tokens")}</span>
        </div>
        <TokenRow label={tx("settingsThemeAccent", "Accent")} value="#339CFF" tone="accent" />
        <TokenRow label={tx("settingsThemeBackground", "Background")} value="#FFFFFF" tone="background" />
        <TokenRow label={tx("settingsThemeForeground", "Foreground")} value="#1A1C1F" tone="foreground" />
        <TokenRow label={tx("settingsThemeUiFont", "UI font")} value="-apple-system, Blink" />
        <TokenRow label={tx("settingsThemeMonoFont", "Code font")} value='ui-monospace, "SFM"' />
      </div>

      <Row label={tx("theme", "Theme")}>
        <div className="settings-pill-group" role="radiogroup" aria-label={tx("theme", "Theme")}>
          {(["light", "dark"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={theme === value}
              className={"settings-pill" + (theme === value ? " active" : "")}
              onClick={() => setTheme(value)}
            >
              {tx(value === "light" ? "themeLight" : "themeDark", value === "light" ? "Light" : "Dark")}
            </button>
          ))}
        </div>
      </Row>

      <Row label={tx("language", "Language")}>
        <div className="settings-pill-group" role="radiogroup" aria-label={tx("language", "Language")}>
          {(["en", "zh"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={lang === value}
              className={"settings-pill" + (lang === value ? " active" : "")}
              onClick={() => setLang(value)}
            >
              {value === "en" ? "English" : "中文"}
            </button>
          ))}
        </div>
      </Row>
    </Section>
  );
}

function ThemePreviewChrome({ tone }: { tone: "system" | "light" | "dark" }) {
  return (
    <span className={"theme-preview-chrome tone-" + tone} aria-hidden="true">
      <span className="theme-preview-sidebar" />
      <span className="theme-preview-content">
        <span />
        <span />
        <span />
      </span>
      <span className="theme-preview-card">
        <span />
        <span />
        <span />
      </span>
    </span>
  );
}

function TokenRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "accent" | "background" | "foreground";
}) {
  return (
    <div className="settings-theme-token-row">
      <span>{label}</span>
      <code className={tone ? `token-swatch ${tone}` : ""}>{value}</code>
    </div>
  );
}
