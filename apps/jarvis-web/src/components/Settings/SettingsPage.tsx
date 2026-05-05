// Full-page settings center. Lives at `/settings` (see App.tsx
// route registration) — separate route, separate layout. Not a
// modal: settings work better as a "place" you go than a popup
// you dismiss, especially once we add things like model defaults
// and persistent prefs.
//
// Information architecture (post-redesign): the original 14 flat
// sections collapsed into **7 sections grouped under 3 headings**.
// Strongly-related sections were merged into super-sections with
// internal Tabs (Models = Providers + Subagents; Extensions = MCP
// + Skills + Plugins; System = Workspace + Server + Connection +
// About; Appearance & Layout = theme/lang + UI prefs). Persona,
// Permissions, and Projects stay independent since their content
// is unique enough not to share a parent.
//
// Hash routing: `/settings#<section>` selects a top-level section;
// `/settings#<section>/<tab>` also picks the inner tab for the
// super-sections. Old single-segment hashes (`#providers`,
// `#mcp`, etc.) are mapped onto the new structure via the
// LEGACY_HASH_MAP table so existing deep-links keep working.
//
// All actual state mutation lives in `appStore` actions so
// settings changes propagate to the rest of the UI in real time
// (theme swap, lang switch, etc.). The Settings page is a
// renderer, not a state holder.

import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { Link } from "react-router-dom";
import { searchSettings, type SearchHit } from "./searchIndex";
import {
  AppearanceLayoutSection,
  APPEARANCE_LAYOUT_TABS,
  DEFAULT_APPEARANCE_LAYOUT_TAB,
  type AppearanceLayoutTab,
} from "./sections/AppearanceLayoutSection";
import { ModelsSection } from "./sections/ModelsSection";
import { AgentsSection } from "./sections/AgentsSection";
import {
  ExtensionsSection,
  EXTENSIONS_TABS,
  DEFAULT_EXTENSIONS_TAB,
  type ExtensionsTab,
} from "./sections/ExtensionsSection";
import {
  SystemSection,
  SYSTEM_TABS,
  DEFAULT_SYSTEM_TAB,
  type SystemTab,
} from "./sections/SystemSection";
import { PermissionsSection } from "./sections/PermissionsSection";
import { ProjectsSettingsSection } from "./sections/ProjectsSettingsSection";
import { SoulSection } from "./sections/SoulSection";
import { t } from "../../utils/i18n";

interface NavItem {
  /// Hash id — used in URL and as the React key.
  id: string;
  /// i18n key for the visible label.
  labelKey: string;
  /// Fallback label when the i18n key is missing.
  fallback: string;
  /// Optional list of valid sub-tab ids (only on super-sections).
  tabs?: readonly string[];
  /// Default tab when none is specified in the hash.
  defaultTab?: string;
}

interface NavGroup {
  /// i18n key for the group heading.
  labelKey: string;
  /// Fallback group heading.
  fallback: string;
  /// Items inside this group.
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: "settingsNavGroupGeneral",
    fallback: "General",
    items: [
      {
        id: "appearance-layout",
        labelKey: "settingsNavAppearanceLayout",
        fallback: "Appearance & Layout",
        tabs: APPEARANCE_LAYOUT_TABS,
        defaultTab: DEFAULT_APPEARANCE_LAYOUT_TAB,
      },
      { id: "persona", labelKey: "settingsNavPersona", fallback: "Persona" },
    ],
  },
  {
    labelKey: "settingsNavGroupCapabilities",
    fallback: "Capabilities",
    items: [
      {
        id: "models",
        labelKey: "settingsNavModels",
        fallback: "Models",
      },
      {
        id: "subagents",
        labelKey: "settingsNavSubagents",
        fallback: "Subagents",
      },
      {
        id: "extensions",
        labelKey: "settingsNavExtensions",
        fallback: "Extensions",
        tabs: EXTENSIONS_TABS,
        defaultTab: DEFAULT_EXTENSIONS_TAB,
      },
      {
        id: "permissions",
        labelKey: "settingsNavPermissions",
        fallback: "Permissions",
      },
    ],
  },
  {
    labelKey: "settingsNavGroupWorkspace",
    fallback: "Workspace",
    items: [
      {
        id: "projects",
        labelKey: "settingsNavProjects",
        fallback: "Projects",
      },
      {
        id: "system",
        labelKey: "settingsNavSystem",
        fallback: "System",
        tabs: SYSTEM_TABS,
        defaultTab: DEFAULT_SYSTEM_TAB,
      },
    ],
  },
];

const ALL_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);
const FIRST_ID = ALL_ITEMS[0]?.id ?? "appearance-layout";

/// Old hash → new (section, tab) tuple. Lets bookmarks like
/// `/settings#providers` from the previous IA still land on the
/// right tab. The right side is rewritten with `replaceState`
/// (no extra history entry) on first hash-change resolve.
const LEGACY_HASH_MAP: Record<string, { id: string; tab?: string }> = {
  appearance: { id: "appearance-layout", tab: "appearance" },
  preferences: { id: "appearance-layout", tab: "layout" },
  api: { id: "system", tab: "api" },
  workspace: { id: "system", tab: "workspace" },
  server: { id: "system", tab: "server" },
  about: { id: "system", tab: "about" },
  providers: { id: "models" },
  "agent-profiles": { id: "subagents" },
  mcp: { id: "extensions", tab: "mcp" },
  skills: { id: "extensions", tab: "skills" },
  plugins: { id: "extensions", tab: "plugins" },
  soul: { id: "persona" },
  // Mappings for sections introduced on main after the redesign:
  // `agents` is the renamed AgentProfilesSection. `diagnostics`
  // lives under System.
  agents: { id: "subagents" },
  diagnostics: { id: "system", tab: "diagnostics" },
};

interface ParsedHash {
  id: string;
  tab?: string;
}

function parseHash(): ParsedHash {
  if (typeof window === "undefined") return { id: FIRST_ID };
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return { id: FIRST_ID };
  const [first, second] = raw.split("/");

  // Legacy: `#models/subagents` from the period when subagents was
  // a tab inside the Models super-section. Promoted to its own
  // top-level entry, but old bookmarks should still land right.
  if (first === "models" && second === "subagents") {
    return { id: "subagents" };
  }

  // Modern format: <section>/<tab>?
  const item = ALL_ITEMS.find((it) => it.id === first);
  if (item) {
    if (second && item.tabs?.includes(second)) {
      return { id: item.id, tab: second };
    }
    return { id: item.id, tab: item.defaultTab };
  }

  // Legacy single-segment hashes from the previous IA.
  const mapped = LEGACY_HASH_MAP[first];
  if (mapped) {
    return { id: mapped.id, tab: mapped.tab };
  }
  return { id: FIRST_ID };
}

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

function buildHash(id: string, tab?: string): string {
  if (!tab) return `#${id}`;
  // Suppress the tab segment when it matches the section's default
  // tab — keeps URLs short for the common case (`#models` instead
  // of `#models/providers`).
  const item = ALL_ITEMS.find((it) => it.id === id);
  if (item?.defaultTab && tab === item.defaultTab) return `#${id}`;
  return `#${id}/${tab}`;
}

export function SettingsPage() {
  const [parsed, setParsed] = useState<ParsedHash>(() => parseHash());
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Listen for hashchange (back/forward, manual edits, deep
  // links). Also runs once on mount to normalise legacy hashes.
  useEffect(() => {
    const onHashChange = () => {
      const next = parseHash();
      setParsed(next);
      // Rewrite legacy hashes in-place so the URL bar matches the
      // active view going forward — no new history entry.
      const expected = buildHash(next.id, next.tab);
      if (
        typeof window !== "undefined" &&
        window.location.hash !== expected &&
        window.location.hash !== `#${next.id}`
      ) {
        window.history.replaceState(null, "", expected);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    onHashChange();
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Global `/` shortcut focuses the search input. Skipped when the
  // user is already typing in another input/textarea or holding a
  // modifier (so things like Cmd+/ stay unaffected).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable) return;
      }
      e.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const setTab = (tab: string) => {
    const next: ParsedHash = { id: parsed.id, tab };
    setParsed(next);
    const expected = buildHash(next.id, next.tab);
    if (window.location.hash !== expected) {
      window.history.replaceState(null, "", expected);
    }
  };

  const setSection = (id: string) => {
    const item = ALL_ITEMS.find((it) => it.id === id);
    const next: ParsedHash = { id, tab: item?.defaultTab };
    setParsed(next);
    window.location.hash = buildHash(id, next.tab);
  };

  /// Jump to a search-hit destination — restores the right Tab
  /// when the hit was a tab match. Clears the query so the nav
  /// snaps back to the grouped view after activation.
  const activateHit = (hit: SearchHit) => {
    const { sectionId, tabId } = hit.entry;
    const next: ParsedHash = { id: sectionId, tab: tabId };
    setParsed(next);
    setQuery("");
    const expected = buildHash(sectionId, tabId);
    if (window.location.hash !== expected) {
      window.location.hash = expected;
    }
  };

  const ActiveSectionView = useMemo(() => {
    return renderSection(parsed, setTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed.id, parsed.tab]);

  const hits = useMemo(() => searchSettings(query), [query]);
  const searching = query.trim().length > 0;

  return (
    <div id="settings-page" className="settings-page">
      <a className="skip-link" href="#settings-main">Skip to main content</a>
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
          <div className="settings-nav-search">
            <svg
              className="settings-nav-search-icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              ref={searchInputRef}
              type="search"
              className="settings-nav-search-input"
              placeholder={tx("settingsSearchPlaceholder", "Search settings…")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQuery("");
                  searchInputRef.current?.blur();
                  return;
                }
                if (e.key === "Enter" && hits.length > 0) {
                  e.preventDefault();
                  activateHit(hits[0]);
                }
              }}
              aria-label={tx("settingsSearchPlaceholder", "Search settings")}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <kbd className="settings-nav-search-kbd" aria-hidden="true">/</kbd>
          </div>

          {searching ? (
            <SearchResults hits={hits} active={parsed} onActivate={activateHit} />
          ) : (
            <>
              {/* Mobile: a native select shows up via CSS at <720px. We render
                  both forms (this select + the chip list below); only one is
                  visible per viewport. Native select gives us a real iOS / Android
                  picker, which is more usable on phones than a custom dropdown. */}
              <select
                className="settings-nav-select"
                value={parsed.id}
                onChange={(e) => setSection(e.target.value)}
                aria-label={tx("settingsTitle", "Settings")}
              >
                {NAV_GROUPS.map((group) => (
                  <optgroup
                    key={group.labelKey}
                    label={tx(group.labelKey, group.fallback)}
                  >
                    {group.items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {tx(item.labelKey, item.fallback)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>

              {NAV_GROUPS.map((group) => (
              <div key={group.labelKey} className="settings-nav-group">
                <div className="settings-nav-group-title">
                  {tx(group.labelKey, group.fallback)}
                </div>
                {group.items.map((item) => {
                  const active = parsed.id === item.id;
                  return (
                    <a
                      key={item.id}
                      href={buildHash(item.id, item.defaultTab)}
                      className={"settings-nav-link" + (active ? " active" : "")}
                      aria-current={active ? "page" : undefined}
                      onClick={(e) => {
                        // Plain left-click on a same-page hash link
                        // would still scroll-jump; intercept it and
                        // route through setSection so the Tab default
                        // is restored.
                        if (
                          e.metaKey || e.ctrlKey || e.shiftKey || e.altKey ||
                          e.button !== 0
                        ) return;
                        e.preventDefault();
                        setSection(item.id);
                      }}
                    >
                      {tx(item.labelKey, item.fallback)}
                    </a>
                  );
                })}
              </div>
              ))}
            </>
          )}
        </nav>

        <main id="settings-main" className="settings-content" tabIndex={-1}>
          <div className="settings-content-inner">{ActiveSectionView}</div>
        </main>
      </div>
    </div>
  );
}

/// Renders ranked search hits as a flat list with breadcrumb
/// context (`Group · Section · Tab`). Returns an empty-state row
/// when nothing matched.
function SearchResults({
  hits,
  active,
  onActivate,
}: {
  hits: SearchHit[];
  active: ParsedHash;
  onActivate: (hit: SearchHit) => void;
}) {
  if (hits.length === 0) {
    return (
      <div className="settings-nav-empty" role="status">
        {tx("settingsSearchEmpty", "No matches.")}
      </div>
    );
  }

  return (
    <ul className="settings-nav-results" role="list">
      {hits.map((hit, idx) => {
        const e = hit.entry;
        const isActive =
          active.id === e.sectionId &&
          (!e.tabId || active.tab === e.tabId);
        const breadcrumb: string[] = [tx(e.groupKey, e.groupFallback)];
        if (e.parentSectionKey && e.parentSectionFallback) {
          breadcrumb.push(tx(e.parentSectionKey, e.parentSectionFallback));
        }
        return (
          <li key={`${e.sectionId}/${e.tabId ?? ""}/${idx}`}>
            <a
              href={buildHash(e.sectionId, e.tabId)}
              className={
                "settings-nav-result" + (isActive ? " active" : "")
              }
              aria-current={isActive ? "page" : undefined}
              onClick={(ev) => {
                if (
                  ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey ||
                  ev.button !== 0
                ) return;
                ev.preventDefault();
                onActivate(hit);
              }}
            >
              <div className="settings-nav-result-label">
                {tx(e.primaryKey, e.primaryFallback)}
              </div>
              <div className="settings-nav-result-breadcrumb">
                {breadcrumb.join(" · ")}
              </div>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/// Static map from section id → leaf renderer. Super-sections
/// receive `tab` + `onTabChange`; standalone sections render
/// directly.
function renderSection(parsed: ParsedHash, setTab: (tab: string) => void) {
  switch (parsed.id) {
    case "appearance-layout":
      return (
        <AppearanceLayoutSection
          tab={(parsed.tab as AppearanceLayoutTab) ?? DEFAULT_APPEARANCE_LAYOUT_TAB}
          onTabChange={(t) => setTab(t)}
        />
      );
    case "persona":
      return <SoulSection />;
    case "models":
      return <ModelsSection />;
    case "subagents":
      return <AgentsSection />;
    case "extensions":
      return (
        <ExtensionsSection
          tab={(parsed.tab as ExtensionsTab) ?? DEFAULT_EXTENSIONS_TAB}
          onTabChange={(t) => setTab(t)}
        />
      );
    case "permissions":
      return <PermissionsSection />;
    case "projects":
      return <ProjectsSettingsSection />;
    case "system":
      return (
        <SystemSection
          tab={(parsed.tab as SystemTab) ?? DEFAULT_SYSTEM_TAB}
          onTabChange={(t) => setTab(t)}
        />
      );
    default:
      return <AppearanceLayoutSection tab={DEFAULT_APPEARANCE_LAYOUT_TAB} onTabChange={(t) => setTab(t)} />;
  }
}

// Re-export the leaf section components so any other consumer
// (CommandPalette, deep-link generators) still has access. The
// renderer above only knows about super-sections + standalone leaves.
export type { ComponentType };
