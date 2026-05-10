// Plugin manager UI. Two stacked panels: installed plugins (with
// remove buttons) and a marketplace stub (one-click install of
// in-tree fixture packs). Install also accepts an arbitrary local
// path so anything with a `plugin.json` works.

import { useEffect, useState, type FormEvent } from "react";
import { Row, Section } from "./Section";
import { Button, Modal, TextField } from "../../ui";
import {
  fetchMarketplace,
  installPlugin,
  listPlugins,
  uninstallPlugin,
  type PluginInstallReport,
  type InstalledPlugin,
  type MarketplaceEntry,
} from "../../../services/plugins";
import { sendFrame } from "../../../services/socket";
import { appStore } from "../../../store/appStore";
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

export function PluginsSection({
  embedded,
  onInstalled,
  showMarketplace = true,
  query = "",
}: {
  embedded?: boolean;
  onInstalled?: (report: PluginInstallReport) => void;
  showMarketplace?: boolean;
  query?: string;
} = {}) {
  const [installed, setInstalled] = useState<InstalledState>({ kind: "loading" });
  const [market, setMarket] = useState<MarketState>({ kind: "loading" });
  const [pathValue, setPathValue] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);
  const [installModalOpen, setInstallModalOpen] = useState(false);
  const [editingPlugin, setEditingPlugin] = useState<InstalledPlugin | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

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

  const doInstall = async (path: string): Promise<boolean> => {
    setInstalling(path);
    setActionError(null);
    setActionMessage(null);
    try {
      const report = await installPlugin("path", path);
      activateInstalledSkills(report.added_skills);
      refreshInstalled();
      onInstalled?.(report);
      setActionMessage(
        t("pluginsInstallSucceeded", report.added_skills.length, report.added_mcp.length),
      );
      return true;
    } catch (e: unknown) {
      setActionError(t("pluginsInstallFailed", String(e)));
      return false;
    } finally {
      setInstalling(null);
    }
  };

  const doUpdate = async (plugin: InstalledPlugin, path: string): Promise<boolean> => {
    setInstalling(plugin.name);
    setActionError(null);
    setActionMessage(null);
    try {
      await uninstallPlugin(plugin.name);
      const report = await installPlugin("path", path);
      activateInstalledSkills(report.added_skills);
      refreshInstalled();
      onInstalled?.(report);
      setActionMessage(tx("pluginsUpdateSucceeded", "Plugin updated."));
      return true;
    } catch (e: unknown) {
      setActionError(tx("pluginsUpdateFailed", "Plugin update failed: ") + String(e));
      refreshInstalled();
      return false;
    } finally {
      setInstalling(null);
    }
  };

  const doRemove = async (name: string) => {
    setActionError(null);
    setActionMessage(null);
    try {
      await uninstallPlugin(name);
      refreshInstalled();
    } catch (e: unknown) {
      setActionError(t("pluginsRemoveFailed", String(e)));
    }
  };

  const installFromPath = (path: string) => {
    void doInstall(path);
  };

  const removePlugin = (name: string) => {
    void doRemove(name);
  };

  const filteredInstalled =
    installed.kind === "ready"
      ? {
          ...installed,
          plugins: filterPlugins(installed.plugins, query),
        }
      : installed;

  const filteredMarket =
    market.kind === "ready"
      ? {
          ...market,
          entries: filterMarketplace(market.entries, query),
        }
      : market;

  return (
    <Section
      id="plugins"
      titleKey="settingsPluginsTitle"
      titleFallback="Plugins"
      descKey="settingsPluginsDesc"
      descFallback="Bundles of skills + MCP servers. Install from a local path or pick from the marketplace; uninstall pulls everything the plugin shipped."
      embedded={embedded}
    >
      <div className="settings-manage-actions">
        <Button variant="primary" onClick={() => setInstallModalOpen(true)}>
          {tx("pluginsAddBtn", "Add plugin")}
        </Button>
        <Button onClick={() => { refreshInstalled(); refreshMarket(); }}>
          {tx("settingsRefresh", "Refresh")}
        </Button>
      </div>

      {renderInstalled(filteredInstalled, removePlugin, setEditingPlugin)}

      {showMarketplace ? renderMarket(filteredMarket, installing, installFromPath) : null}

      {actionMessage && <div className="settings-form-success">{actionMessage}</div>}
      {actionError && <div className="settings-form-error">{actionError}</div>}

      <PluginPathModal
        open={installModalOpen}
        title={tx("pluginsInstallTitle", "Install from path")}
        description={tx("pluginsInstallHint", "Absolute or workspace-relative directory containing plugin.json")}
        initialPath={pathValue}
        submitLabel={installing ? tx("pluginsInstalling", "Installing…") : tx("pluginsInstallBtn", "Install")}
        busy={installing !== null}
        submitError={actionError}
        onClose={() => setInstallModalOpen(false)}
        onSubmit={async (path) => {
          setPathValue(path);
          const ok = await doInstall(path);
          if (ok) setInstallModalOpen(false);
        }}
      />

      <PluginPathModal
        open={editingPlugin !== null}
        title={tx("pluginsEditTitle", "Edit plugin")}
        description={tx(
          "pluginsEditHint",
          "Changing the path reinstalls the plugin from that directory and refreshes its skills and MCP servers.",
        )}
        initialPath={editingPlugin?.source_value ?? ""}
        submitLabel={installing ? tx("pluginsUpdating", "Updating…") : tx("pluginsUpdateBtn", "Update")}
        busy={installing !== null}
        submitError={actionError}
        onClose={() => setEditingPlugin(null)}
        onSubmit={async (path) => {
          if (!editingPlugin) return;
          const ok = path === editingPlugin.source_value
            ? true
            : await doUpdate(editingPlugin, path);
          if (ok) setEditingPlugin(null);
        }}
      />
    </Section>
  );
}

function filterPlugins(plugins: InstalledPlugin[], query: string): InstalledPlugin[] {
  const q = query.trim().toLowerCase();
  if (!q) return plugins;
  return plugins.filter((p) =>
    [
      p.name,
      p.version,
      p.description,
      p.source_kind,
      p.source_value,
      ...p.skill_names,
      ...p.mcp_prefixes,
    ].join(" ").toLowerCase().includes(q),
  );
}

function filterMarketplace(entries: MarketplaceEntry[], query: string): MarketplaceEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((entry) =>
    [
      entry.name,
      entry.description,
      entry.source,
      entry.value,
      ...(entry.tags ?? []),
    ].join(" ").toLowerCase().includes(q),
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

function renderInstalled(
  state: InstalledState,
  onRemove: (name: string) => void,
  onEdit: (plugin: InstalledPlugin) => void,
) {
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
                    {p.name}
                  </div>
                  <div className="settings-plugin-desc">{p.description}</div>
                  <div className="settings-plugin-meta">
                    {t("pluginsContributes", p.skill_names.length, p.mcp_prefixes.length)}
                  </div>
                </div>
                <div className="settings-plugin-actions">
                  <Button size="sm" onClick={() => onEdit(p)}>
                    {tx("pluginsEditBtn", "Edit")}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => onRemove(p.name)}>
                    {tx("pluginsRemoveBtn", "Remove")}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function PluginPathModal({
  open,
  title,
  description,
  initialPath,
  submitLabel,
  busy,
  submitError,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  description: string;
  initialPath: string;
  submitLabel: string;
  busy: boolean;
  submitError?: string | null;
  onClose: () => void;
  onSubmit: (path: string) => void | Promise<void>;
}) {
  const [path, setPath] = useState(initialPath);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPath(initialPath);
    setError(null);
  }, [initialPath, open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = path.trim();
    if (!trimmed) {
      setError(tx("pluginsPathRequired", "Plugin path is required."));
      return;
    }
    setError(null);
    await onSubmit(trimmed);
  };

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      size="md"
      busy={busy}
      dialogClassName="settings-plugin-modal"
    >
      <form className="settings-plugin-modal-form" onSubmit={(e) => { void submit(e); }}>
        <p className="settings-plugin-modal-desc">{description}</p>
        <TextField
          label={tx("pluginsPathLabel", "Plugin path")}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="examples/plugins/code-review-pack"
          disabled={busy}
          error={error !== null}
          hint={error ?? tx("pluginsPathHint", "Directory must contain plugin.json.")}
          autoFocus
        />
        {submitError ? <div className="settings-form-error">{submitError}</div> : null}
        <div className="ui-modal-actions">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {tx("settingsCancel", "Cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
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
