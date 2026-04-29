// Plugin manager UI. Two stacked panels: installed plugins (with
// remove buttons) and a marketplace stub (one-click install of
// in-tree fixture packs). Install also accepts an arbitrary local
// path so anything with a `plugin.json` works.

import { useEffect, useState } from "react";
import { Row, Section } from "./Section";
import {
  fetchMarketplace,
  installPlugin,
  listPlugins,
  uninstallPlugin,
  type InstalledPlugin,
  type MarketplaceEntry,
} from "../../../services/plugins";
import { t } from "../../../utils/i18n";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

type InstalledState =
  | { kind: "loading" }
  | { kind: "ready"; plugins: InstalledPlugin[] }
  | { kind: "error"; message: string };

type MarketState =
  | { kind: "loading" }
  | { kind: "ready"; entries: MarketplaceEntry[] }
  | { kind: "error"; message: string };

export function PluginsSection() {
  const [installed, setInstalled] = useState<InstalledState>({ kind: "loading" });
  const [market, setMarket] = useState<MarketState>({ kind: "loading" });
  const [pathValue, setPathValue] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refreshInstalled = () => {
    setInstalled({ kind: "loading" });
    listPlugins()
      .then((plugins) => setInstalled({ kind: "ready", plugins }))
      .catch((e: unknown) => setInstalled({ kind: "error", message: String(e) }));
  };

  const refreshMarket = () => {
    setMarket({ kind: "loading" });
    fetchMarketplace()
      .then((entries) => setMarket({ kind: "ready", entries }))
      .catch((e: unknown) => setMarket({ kind: "error", message: String(e) }));
  };

  useEffect(() => {
    refreshInstalled();
    refreshMarket();
  }, []);

  const doInstall = async (path: string) => {
    setInstalling(path);
    setActionError(null);
    try {
      await installPlugin("path", path);
      refreshInstalled();
    } catch (e: unknown) {
      setActionError(t("pluginsInstallFailed", String(e)));
    } finally {
      setInstalling(null);
    }
  };

  const doRemove = async (name: string) => {
    setActionError(null);
    try {
      await uninstallPlugin(name);
      refreshInstalled();
    } catch (e: unknown) {
      setActionError(t("pluginsRemoveFailed", String(e)));
    }
  };

  return (
    <Section
      id="plugins"
      titleKey="settingsPluginsTitle"
      titleFallback="Plugins"
      descKey="settingsPluginsDesc"
      descFallback="Bundles of skills + MCP servers. Install from a local path or pick from the marketplace; uninstall pulls everything the plugin shipped."
    >
      {renderInstalled(installed, doRemove)}

      <div className="settings-row settings-row-full">
        <div className="settings-row-label">
          <div>{tx("pluginsInstallTitle", "Install from path")}</div>
          <div className="settings-row-hint">
            {tx("pluginsInstallHint", "Absolute or workspace-relative directory containing plugin.json")}
          </div>
        </div>
        <div className="settings-row-control">
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (pathValue.trim()) void doInstall(pathValue.trim());
            }}
          >
            <input
              className="settings-input"
              type="text"
              value={pathValue}
              onChange={(e) => setPathValue(e.target.value)}
              placeholder="examples/plugins/code-review-pack"
              disabled={installing !== null}
            />
            <div className="settings-form-actions">
              <button type="submit" className="settings-btn" disabled={installing !== null}>
                {installing ? tx("pluginsInstalling", "Installing…") : tx("pluginsInstallBtn", "Install")}
              </button>
            </div>
          </form>
        </div>
      </div>

      {renderMarket(market, installing, doInstall)}

      {actionError && <div className="settings-form-error">{actionError}</div>}

      <div className="settings-row settings-row-actions">
        <button type="button" className="settings-btn" onClick={() => { refreshInstalled(); refreshMarket(); }}>
          {tx("settingsRefresh", "Refresh")}
        </button>
      </div>
    </Section>
  );
}

function renderInstalled(state: InstalledState, onRemove: (name: string) => void) {
  if (state.kind === "loading") {
    return <Row label={tx("pluginsInstalled", "Installed")}>…</Row>;
  }
  if (state.kind === "error") {
    return (
      <Row label={tx("pluginsInstalled", "Installed")}>
        <span className="settings-value error">{t("pluginsListFailed", state.message)}</span>
      </Row>
    );
  }
  if (state.plugins.length === 0) {
    return (
      <Row label={tx("pluginsInstalled", "Installed")}>
        <span className="settings-value muted">{tx("pluginsEmpty", "No plugins installed.")}</span>
      </Row>
    );
  }
  return (
    <div className="settings-row settings-row-full">
      <div className="settings-row-label">
        <div>{tx("pluginsInstalled", "Installed")}</div>
      </div>
      <div className="settings-row-control">
        <ul className="settings-plugin-list">
          {state.plugins.map((p) => (
            <li key={p.name} className="settings-plugin-item">
              <div className="settings-plugin-row">
                <div>
                  <div className="settings-plugin-name">
                    <span className="mono">{p.name}</span>
                    <span className="muted"> · {p.version}</span>
                  </div>
                  <div className="settings-plugin-desc">{p.description}</div>
                  <div className="settings-plugin-meta">
                    {t("pluginsContributes", p.skill_names.length, p.mcp_prefixes.length)}
                  </div>
                </div>
                <button
                  type="button"
                  className="settings-btn settings-btn-danger"
                  onClick={() => onRemove(p.name)}
                >
                  {tx("pluginsRemoveBtn", "Remove")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function renderMarket(
  state: MarketState,
  installing: string | null,
  onInstall: (path: string) => void,
) {
  if (state.kind === "loading") {
    return <Row label={tx("pluginsMarketplace", "Marketplace")}>…</Row>;
  }
  if (state.kind === "error") {
    return (
      <Row label={tx("pluginsMarketplace", "Marketplace")}>
        <span className="settings-value error">{state.message}</span>
      </Row>
    );
  }
  if (state.entries.length === 0) {
    return (
      <Row label={tx("pluginsMarketplace", "Marketplace")}>
        <span className="settings-value muted">{tx("pluginsMarketEmpty", "No packs yet.")}</span>
      </Row>
    );
  }
  return (
    <div className="settings-row settings-row-full">
      <div className="settings-row-label">
        <div>{tx("pluginsMarketplace", "Marketplace")}</div>
        <div className="settings-row-hint">
          {tx("pluginsMarketHint", "Built-in stub. Phase 4 will swap this for a remote index.")}
        </div>
      </div>
      <div className="settings-row-control">
        <ul className="settings-plugin-list">
          {state.entries.map((m) => (
            <li key={m.value} className="settings-plugin-item">
              <div className="settings-plugin-row">
                <div>
                  <div className="settings-plugin-name">
                    <span className="mono">{m.name}</span>
                    <span className="muted"> · {m.source}</span>
                  </div>
                  <div className="settings-plugin-desc">{m.description}</div>
                </div>
                <button
                  type="button"
                  className="settings-btn"
                  onClick={() => onInstall(m.value)}
                  disabled={installing !== null}
                >
                  {installing === m.value
                    ? tx("pluginsInstalling", "Installing…")
                    : tx("pluginsInstallBtn", "Install")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
