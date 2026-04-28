// Full-page settings center. Lives at `/settings` (see App.tsx
// route registration) — separate route, separate layout. Not a
// modal: settings work better as a "place" you go than a popup
// you dismiss, especially once we add things like model defaults
// and persistent prefs.
//
// Section pattern: each section is its own component for readability.
// The left rail is hash-routed (`/settings#providers`) so every tab is
// a directly reloadable page without carrying the whole settings form
// in the DOM at once.
//
// All actual state mutation lives in `appStore` actions so
// settings changes propagate to the rest of the UI in real time
// (theme swap, lang switch, etc.). The Settings page is a
// renderer, not a state holder.

import { useEffect, useState, type ComponentType } from "react";
import { Link } from "react-router-dom";
import { AppearanceSection } from "./sections/AppearanceSection";
import { ApiSection } from "./sections/ApiSection";
import { WorkspaceSection } from "./sections/WorkspaceSection";
import { ProvidersSection } from "./sections/ProvidersSection";
import { ServerSection } from "./sections/ServerSection";
import { PreferencesSection } from "./sections/PreferencesSection";
import { ProjectsSettingsSection } from "./sections/ProjectsSettingsSection";
import { PermissionsSection } from "./sections/PermissionsSection";
import { McpSection } from "./sections/McpSection";
import { SkillsSection } from "./sections/SkillsSection";
import { SoulSection } from "./sections/SoulSection";
import { AboutSection } from "./sections/AboutSection";
import { t } from "../../utils/i18n";

interface NavItem {
  id: string;
  labelKey: string;
  fallback: string;
}

const NAV: NavItem[] = [
  { id: "appearance", labelKey: "settingsNavAppearance", fallback: "Appearance" },
  { id: "preferences", labelKey: "settingsNavPreferences", fallback: "Preferences" },
  { id: "soul", labelKey: "settingsNavSoul", fallback: "Soul" },
  { id: "permissions", labelKey: "settingsNavPermissions", fallback: "Permissions" },
  { id: "api", labelKey: "settingsNavApi", fallback: "API" },
  { id: "workspace", labelKey: "settingsNavWorkspace", fallback: "Workspace" },
  { id: "projects", labelKey: "settingsNavProjects", fallback: "Projects" },
  { id: "providers", labelKey: "settingsNavProviders", fallback: "Providers" },
  { id: "mcp", labelKey: "settingsNavMcp", fallback: "MCP" },
  { id: "skills", labelKey: "settingsNavSkills", fallback: "Skills" },
  { id: "server", labelKey: "settingsNavServer", fallback: "Server" },
  { id: "about", labelKey: "settingsNavAbout", fallback: "About" },
];

const SECTIONS: Record<string, ComponentType> = {
  appearance: AppearanceSection,
  preferences: PreferencesSection,
  soul: SoulSection,
  permissions: PermissionsSection,
  api: ApiSection,
  workspace: WorkspaceSection,
  projects: ProjectsSettingsSection,
  providers: ProvidersSection,
  mcp: McpSection,
  skills: SkillsSection,
  server: ServerSection,
  about: AboutSection,
};

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

function currentSectionId(): string {
  if (typeof window === "undefined") return NAV[0].id;
  const id = window.location.hash.replace(/^#/, "");
  return SECTIONS[id] ? id : NAV[0].id;
}

export function SettingsPage() {
  const [active, setActive] = useState(currentSectionId);
  const ActiveSection = SECTIONS[active] || AppearanceSection;

  useEffect(() => {
    const onHashChange = () => setActive(currentSectionId());
    window.addEventListener("hashchange", onHashChange);
    onHashChange();
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <div id="settings-page" className="settings-page">
      <header className="settings-header">
        <Link to="/" className="settings-back" aria-label={tx("settingsBack", "Back to chat")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m15 18-6-6 6-6" />
          </svg>
          <span>{tx("settingsBack", "Back to chat")}</span>
        </Link>
        <h1>{tx("settingsTitle", "Settings")}</h1>
      </header>

      <div className="settings-body">
        <nav className="settings-nav" aria-label={tx("settingsTitle", "Settings")}>
          {NAV.map((n) => (
            <a
              key={n.id}
              href={`#${n.id}`}
              className={"settings-nav-link" + (active === n.id ? " active" : "")}
              aria-current={active === n.id ? "page" : undefined}
              onClick={() => setActive(n.id)}
            >
              {tx(n.labelKey, n.fallback)}
            </a>
          ))}
        </nav>

        <main className="settings-content">
          <div className="settings-content-inner">
            <ActiveSection />
          </div>
        </main>
      </div>
    </div>
  );
}
