// About / footer. Version comes from the build-time `__APP_VERSION__`
// (defined in vite.config — pulled from package.json), with a
// graceful fallback to "dev" so the section still renders during
// `vite dev` where the define may not have been injected.
//
// Doc links point at the in-repo guides. `target="_blank"` so
// users don't lose their chat session navigating away.

import { Section } from "./Section";
import { t } from "../../../utils/i18n";

declare const __APP_VERSION__: string | undefined;

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

const DOCS = [
  { href: "https://github.com/zjn-tech/Jarvis/blob/main/docs/user-guide.md", labelKey: "settingsAboutDocsRunbook", fallback: "Operator runbook" },
  { href: "https://github.com/zjn-tech/Jarvis/blob/main/docs/user-guide-coding-agent.md", labelKey: "settingsAboutDocsCoding", fallback: "Coding-agent walkthrough" },
  { href: "https://github.com/zjn-tech/Jarvis/blob/main/docs/user-guide-cli.md", labelKey: "settingsAboutDocsCli", fallback: "CLI guide" },
  { href: "https://github.com/zjn-tech/Jarvis/blob/main/docs/user-guide-web.md", labelKey: "settingsAboutDocsWeb", fallback: "Web UI guide" },
];

export function AboutSection({ embedded }: { embedded?: boolean } = {}) {
  const version = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
  return (
    <Section
      id="about"
      titleKey="settingsAboutTitle"
      titleFallback="About"
      embedded={embedded}
    >
      <div className="settings-about-grid">
        <div>
          <div className="settings-row-hint">{tx("settingsAboutVersion", "Version")}</div>
          <div className="mono">{version}</div>
        </div>
        <div>
          <div className="settings-row-hint">{tx("settingsAboutBuild", "Build")}</div>
          <div className="mono">{(import.meta as { env?: { MODE?: string } }).env?.MODE ?? "production"}</div>
        </div>
      </div>

      <div className="settings-about-docs">
        <div className="settings-row-hint">{tx("settingsAboutDocs", "Documentation")}</div>
        <ul>
          {DOCS.map((d) => (
            <li key={d.href}>
              <a href={d.href} target="_blank" rel="noopener noreferrer">
                {tx(d.labelKey, d.fallback)}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M7 17 17 7" />
                  <path d="M7 7h10v10" />
                </svg>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
