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
