// Customize — split into a marketplace home and a management view.
// The default `/customize` surface is now the plugin marketplace;
// `#manage` / `#manage-*` opens the installed-capabilities controls.

import { useEffect, useMemo, useState } from "react";
import { McpSection } from "../Settings/sections/McpSection";
import { SkillsSection } from "../Settings/sections/SkillsSection";
import { PluginsSection } from "../Settings/sections/PluginsSection";
import { McpMarketPanel, SkillMarketPanel } from "./MarketPanels";
import { t } from "../../utils/i18n";
import { useAppStore, appStore } from "../../store/appStore";
import { listSkills } from "../../services/skills";
import { listMcpServers } from "../../services/mcp";
import {
  fetchMarketplace,
  installPlugin,
  listPlugins,
  type MarketplaceEntry,
  type PluginInstallReport,
} from "../../services/plugins";
import { sendFrame } from "../../services/socket";

type ManageTab = "plugins" | "mcp" | "skills";
type MarketTab = "plugins" | "skills" | "mcp";
type CustomizeMode = "market" | "manage";
type CustomizeView = { mode: CustomizeMode; manageTab: ManageTab; marketTab: MarketTab };

const MANAGE_TABS: ManageTab[] = ["plugins", "mcp", "skills"];
const MARKET_TABS: MarketTab[] = ["plugins", "skills", "mcp"];

type CustomizeStats = Record<ManageTab, { total: number; active: number; hint: string }>;

const EMPTY_STATS: CustomizeStats = {
  plugins: { total: 0, active: 0, hint: "0 installed" },
  mcp: { total: 0, active: 0, hint: "0 running" },
  skills: { total: 0, active: 0, hint: "0 active" },
};

const MANAGE_META: Record<ManageTab, { label: string; desc: string }> = {
  plugins: {
    label: "Plugins",
    desc: "Manage installed plugin bundles and local plugin paths.",
  },
  mcp: {
    label: "MCP",
    desc: "Connect runtime tool servers and monitor their status.",
  },
  skills: {
    label: "Skills",
    desc: "Activate prompt capabilities for this chat session.",
  },
};

const MARKET_META: Record<MarketTab, { label: string; placeholder: string }> = {
  plugins: { label: "Plugins", placeholder: "Search plugins" },
  skills: { label: "Skills", placeholder: "Search skills" },
  mcp: { label: "MCP", placeholder: "Search MCP servers" },
};

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

function parseHash(): CustomizeView {
  if (typeof window === "undefined") {
    return { mode: "market", manageTab: "plugins", marketTab: "plugins" };
  }
  const raw = window.location.hash.replace(/^#/, "");
  if (raw === "manage") return { mode: "manage", manageTab: "plugins", marketTab: "plugins" };
  if (raw.startsWith("manage-")) {
    const tab = raw.slice("manage-".length);
    if (MANAGE_TABS.includes(tab as ManageTab)) {
      return { mode: "manage", manageTab: tab as ManageTab, marketTab: "plugins" };
    }
  }
  if (raw.startsWith("market-")) {
    const tab = raw.slice("market-".length);
    if (MARKET_TABS.includes(tab as MarketTab)) {
      return { mode: "market", manageTab: "plugins", marketTab: tab as MarketTab };
    }
  }
  if (MANAGE_TABS.includes(raw as ManageTab)) {
    return { mode: "manage", manageTab: raw as ManageTab, marketTab: "plugins" };
  }
  return { mode: "market", manageTab: "plugins", marketTab: "plugins" };
}

export function CustomizePage() {
  const [view, setView] = useState<CustomizeView>(() => parseHash());
  const activeSkills = useAppStore((s) => s.activeSkills);
  const [stats, setStats] = useState<CustomizeStats>(EMPTY_STATS);
  const [statsLoading, setStatsLoading] = useState(true);
  const [skillsRefreshToken, setSkillsRefreshToken] = useState(0);
  const [mcpRefreshToken, setMcpRefreshToken] = useState(0);

  const refreshStats = () => {
    setStatsLoading(true);
    Promise.all([listPlugins(), listMcpServers(), listSkills()])
      .then(([plugins, mcpServers, skills]) => {
        const runningMcp = mcpServers.filter((s) => s.status === "running").length;
        setStats({
          plugins: {
            total: plugins.length,
            active: plugins.length,
            hint: t("customizePluginsStat", plugins.length),
          },
          mcp: {
            total: mcpServers.length,
            active: runningMcp,
            hint: t("customizeMcpStat", runningMcp, mcpServers.length),
          },
          skills: {
            total: skills.length,
            active: activeSkills.length,
            hint: t("customizeSkillsStat", activeSkills.length, skills.length),
          },
        });
      })
      .catch(() => {
        setStats((current) => ({
          ...current,
          skills: {
            ...current.skills,
            active: activeSkills.length,
            hint: t("customizeSkillsStat", activeSkills.length, current.skills.total),
          },
        }));
      })
      .finally(() => setStatsLoading(false));
  };

  useEffect(() => {
    refreshStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setStats((current) => ({
      ...current,
      skills: {
        ...current.skills,
        active: activeSkills.length,
        hint: t("customizeSkillsStat", activeSkills.length, current.skills.total),
      },
    }));
  }, [activeSkills]);

  useEffect(() => {
    const onHash = () => setView(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = (next: CustomizeView) => {
    setView(next);
    if (typeof window === "undefined") return;
    const hash = next.mode === "manage"
      ? `#manage-${next.manageTab}`
      : next.marketTab === "plugins"
        ? ""
        : `#market-${next.marketTab}`;
    const nextUrl = `${window.location.pathname}${hash}`;
    if (`${window.location.pathname}${window.location.hash}` !== nextUrl) {
      window.history.replaceState(null, "", nextUrl);
    }
  };

  const handleSkillInstalled = () => {
    setSkillsRefreshToken((v) => v + 1);
    refreshStats();
  };

  const handleMcpInstalled = () => {
    setMcpRefreshToken((v) => v + 1);
    refreshStats();
  };

  const manage = () => navigate({ mode: "manage", manageTab: "plugins", marketTab: "plugins" });
  const market = () => navigate({ mode: "market", manageTab: "plugins", marketTab: "plugins" });

  return (
    <main id="customize-page" className="customize-page" tabIndex={-1}>
      {view.mode === "market" ? (
        <MarketView
          tab={view.marketTab}
          onTab={(tab) => navigate({ mode: "market", manageTab: "plugins", marketTab: tab })}
          onManage={manage}
          onInstalled={refreshStats}
          onSkillInstalled={handleSkillInstalled}
          onMcpInstalled={handleMcpInstalled}
        />
      ) : (
        <ManageView
          tab={view.manageTab}
          stats={stats}
          statsLoading={statsLoading}
          skillsRefreshToken={skillsRefreshToken}
          mcpRefreshToken={mcpRefreshToken}
          onTab={(tab) => navigate({ mode: "manage", manageTab: tab, marketTab: "plugins" })}
          onMarket={market}
          onInstalled={refreshStats}
        />
      )}
    </main>
  );
}

function MarketView({
  tab,
  onTab,
  onManage,
  onInstalled,
  onSkillInstalled,
  onMcpInstalled,
}: {
  tab: MarketTab;
  onTab: (tab: MarketTab) => void;
  onManage: () => void;
  onInstalled: () => void;
  onSkillInstalled: () => void;
  onMcpInstalled: () => void;
}) {
  return (
    <>
      <header className="customize-topbar">
        <nav className="customize-tabs" aria-label={tx("customizeMarketTabs", "Marketplace sections")}>
          {MARKET_TABS.map((id) => (
            <button
              key={id}
              type="button"
              className={"customize-tab" + (id === tab ? " active" : "")}
              onClick={() => onTab(id)}
              aria-current={id === tab ? "page" : undefined}
            >
              {tx(`customizeMarket${capitalize(id)}`, MARKET_META[id].label)}
            </button>
          ))}
        </nav>
        <div className="customize-top-actions">
          <button type="button" className="customize-action-btn" onClick={onManage}>
            <GearIcon />
            <span>{tx("customizeManage", "Manage")}</span>
          </button>
        </div>
      </header>
      <section className="customize-content customize-market-content">
        <div className="customize-hero">
          <h1 className="customize-title">
            {tx("customizeHeroTitle", "Let Jarvis work your way")}
          </h1>
        </div>
        {tab === "plugins" ? <PluginMarketHome onInstalled={onInstalled} /> : null}
        {tab === "skills" ? (
          <div className="customize-main-column customize-market-column">
            <SkillMarketPanel onInstalled={onSkillInstalled} />
          </div>
        ) : null}
        {tab === "mcp" ? (
          <div className="customize-main-column customize-market-column">
            <McpMarketPanel onInstalled={onMcpInstalled} />
          </div>
        ) : null}
      </section>
    </>
  );
}

function ManageView({
  tab,
  stats,
  statsLoading,
  skillsRefreshToken,
  mcpRefreshToken,
  onTab,
  onMarket,
  onInstalled,
}: {
  tab: ManageTab;
  stats: CustomizeStats;
  statsLoading: boolean;
  skillsRefreshToken: number;
  mcpRefreshToken: number;
  onTab: (tab: ManageTab) => void;
  onMarket: () => void;
  onInstalled: (report: PluginInstallReport) => void;
}) {
  const currentMeta = MANAGE_META[tab];
  return (
    <>
      <header className="customize-topbar customize-manage-topbar">
        <button type="button" className="customize-breadcrumb" onClick={onMarket}>
          {tx("customizeMarketPlugins", "Plugins")}
        </button>
        <NavIcon kind="chevron" />
        <span className="customize-breadcrumb-current">{tx("customizeManage", "Manage")}</span>
      </header>
      <section className="customize-content customize-manage-content">
        <div className="customize-main-column">
          <div className="customize-manage-toolbar">
            <nav className="customize-tabs" aria-label={tx("customizeManageTabs", "Manage sections")}>
              {MANAGE_TABS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={"customize-tab" + (id === tab ? " active" : "")}
                  onClick={() => onTab(id)}
                  aria-current={id === tab ? "page" : undefined}
                >
                  <span>{tx(`customizeNav${capitalize(id)}`, MANAGE_META[id].label)}</span>
                  <span className="customize-tab-count">{statsLoading ? "…" : stats[id].total}</span>
                </button>
              ))}
            </nav>
            <div className="customize-manage-search" aria-hidden="true">
              <SearchIcon />
              <span>{tx("customizeManageSearch", "Search installed")}</span>
            </div>
          </div>
          <div className="customize-section-label">
            {tx(`customizeNav${capitalize(tab)}`, currentMeta.label)}
            <span>{stats[tab].hint}</span>
          </div>
          <div className="customize-content-panel">
            {tab === "plugins" ? (
              <PluginsSection embedded showMarketplace={false} onInstalled={onInstalled} />
            ) : null}
            {tab === "mcp" ? <McpSection embedded refreshToken={mcpRefreshToken} /> : null}
            {tab === "skills" ? <SkillsSection embedded refreshToken={skillsRefreshToken} /> : null}
          </div>
        </div>
      </section>
    </>
  );
}

type PluginMarketState =
  | { kind: "loading" }
  | { kind: "ready"; entries: MarketplaceEntry[]; installed: Set<string> }
  | { kind: "error"; message: string };

function PluginMarketHome({ onInstalled }: { onInstalled: () => void }) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<PluginMarketState>({ kind: "loading" });
  const [installing, setInstalling] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setState({ kind: "loading" });
    Promise.all([fetchMarketplace(), listPlugins()])
      .then(([entries, installed]) => {
        setState({
          kind: "ready",
          entries,
          installed: new Set(installed.map((p) => p.source_value)),
        });
      })
      .catch((e: unknown) => setState({ kind: "error", message: String(e) }));
  };

  useEffect(() => {
    refresh();
  }, []);

  const filtered = useMemo(() => {
    if (state.kind !== "ready") return [];
    const q = query.trim().toLowerCase();
    if (!q) return state.entries;
    return state.entries.filter((entry) => {
      const haystack = [
        entry.name,
        entry.description,
        entry.source,
        entry.value,
        ...(entry.tags ?? []),
      ].join(" ").toLowerCase();
      return haystack.includes(q);
    });
  }, [query, state]);

  const install = async (entry: MarketplaceEntry) => {
    setInstalling(entry.value);
    setMessage(null);
    setError(null);
    try {
      const report = await installPlugin("path", entry.value);
      activateInstalledSkills(report.added_skills);
      onInstalled();
      refresh();
      setMessage(t("pluginsInstallSucceeded", report.added_skills.length, report.added_mcp.length));
    } catch (e: unknown) {
      setError(t("pluginsInstallFailed", String(e)));
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div className="customize-main-column customize-market-column">
      <form className="customize-market-search" onSubmit={(e) => e.preventDefault()}>
        <SearchIcon />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tx("customizeSearchPlugins", "Search plugins")}
        />
      </form>
      <div className="customize-feature-panel">
        <div className="customize-feature-chip">
          <span className="customize-feature-icon">J</span>
          <span>{tx("customizeFeaturePrompt", "Install a workflow pack and try it in chat")}</span>
        </div>
        <button type="button" className="customize-feature-btn">
          <ChatBubbleIcon />
          {tx("customizeTryInChat", "Try in chat")}
        </button>
      </div>
      <div className="customize-section-label">
        {tx("customizeFeatured", "Featured")}
      </div>
      {state.kind === "loading" ? <div className="market-empty">…</div> : null}
      {state.kind === "error" ? (
        <div className="settings-form-error">{t("marketLoadFailed", state.message)}</div>
      ) : null}
      {state.kind === "ready" ? (
        <ul className="customize-plugin-market-grid">
          {filtered.map((entry) => {
            const installed = state.installed.has(entry.value);
            return (
              <li key={entry.value} className="customize-plugin-market-item">
                <div className="customize-plugin-icon">{pluginInitial(entry.name)}</div>
                <div className="customize-plugin-copy">
                  <div className="customize-plugin-name">{entry.name}</div>
                  <div className="customize-plugin-desc">{entry.description}</div>
                </div>
                <button
                  type="button"
                  className="customize-plugin-action"
                  onClick={() => { void install(entry); }}
                  disabled={installed || installing !== null}
                  aria-label={installed ? tx("pluginsInstalled", "Installed") : tx("pluginsInstallBtn", "Install")}
                >
                  {installed ? <CheckIcon /> : installing === entry.value ? "…" : <PlusIcon />}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {message && <div className="settings-form-success">{message}</div>}
      {error && <div className="settings-form-error">{error}</div>}
    </div>
  );
}

function activateInstalledSkills(skillNames: string[]) {
  if (skillNames.length === 0) return;
  const sent = skillNames.filter((name) => sendFrame({ type: "activate_skill", name }));
  if (sent.length === 0) return;
  const current = appStore.getState().activeSkills;
  const next = Array.from(new Set([...current, ...sent]));
  appStore.getState().setActiveSkills?.(next);
}

function pluginInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "P";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function NavIcon({ kind }: { kind: string }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor" as const,
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (kind === "back") {
    return (
      <svg {...common} width={16} height={16}>
        <path d="m15 18-6-6 6-6" />
      </svg>
    );
  }
  if (kind === "chevron") {
    return (
      <svg {...common} width={14} height={14}>
        <path d="m9 18 6-6-6-6" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M9 3v3" />
      <path d="M15 3v3" />
      <rect x="6" y="6" width="12" height="9" rx="1.5" />
      <path d="M10 15v3a2 2 0 0 0 4 0v-3" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.04.04a2 2 0 1 1-2.83 2.83l-.04-.04A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6V20a2 2 0 1 1-4 0v-.06a1.7 1.7 0 0 0-1-.54 1.7 1.7 0 0 0-1.88.34l-.04.04a2 2 0 1 1-2.83-2.83l.04-.04A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1H4a2 2 0 1 1 0-4h.06a1.7 1.7 0 0 0 .54-1 1.7 1.7 0 0 0-.34-1.88l-.04-.04a2 2 0 1 1 2.83-2.83l.04.04A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6V4a2 2 0 1 1 4 0v.06a1.7 1.7 0 0 0 1 .54 1.7 1.7 0 0 0 1.88-.34l.04-.04a2 2 0 1 1 2.83 2.83l-.04.04A1.7 1.7 0 0 0 19.4 9c.22.32.4.66.54 1H20a2 2 0 1 1 0 4h-.06a1.7 1.7 0 0 0-.54 1Z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

function ChatBubbleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M21 12a8 8 0 0 1-8 8H7l-4 3 1.4-5A8 8 0 1 1 21 12Z" />
    </svg>
  );
}
