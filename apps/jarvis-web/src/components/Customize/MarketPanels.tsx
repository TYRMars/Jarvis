import { useEffect, useMemo, useState, type FormEvent } from "react";
import { addMcpServer } from "../../services/mcp";
import {
  installSkillFromMarket,
  mcpConfigFromMarketEntry,
  searchMcpMarket,
  searchSkillMarket,
  type MarketMcpEntry,
  type MarketSkillEntry,
} from "../../services/market";
import { sendFrame } from "../../services/socket";
import { appStore } from "../../store/appStore";
import { t } from "../../utils/i18n";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

type MarketState<T> =
  | { kind: "loading" }
  | { kind: "ready"; entries: T[] }
  | { kind: "error"; message: string };

export function SkillMarketPanel({ onInstalled }: { onInstalled?: () => void }) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<MarketState<MarketSkillEntry>>({ kind: "loading" });
  const [installing, setInstalling] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = (q = query) => {
    setState({ kind: "loading" });
    searchSkillMarket(q)
      .then((entries) => setState({ kind: "ready", entries }))
      .catch((e: unknown) => setState({ kind: "error", message: String(e) }));
  };

  useEffect(() => {
    refresh("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    refresh(query);
  };

  const install = async (entry: MarketSkillEntry) => {
    const key = `${entry.source}/${entry.skillId}`;
    setInstalling(key);
    setMessage(null);
    setError(null);
    try {
      const skill = await installSkillFromMarket(entry.source, entry.skillId);
      activateSkill(skill.name);
      onInstalled?.();
      setMessage(t("marketSkillInstalled", skill.name));
    } catch (e: unknown) {
      setError(t("marketSkillInstallFailed", String(e)));
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div className="market-panel" aria-label={tx("marketSkillTitle", "Online Skill market")}>
      <MarketHeader
        title={tx("marketSkillTitle", "Online Skill market")}
        hint={tx("marketSkillHint", "Search open-source Skills and install them into this workspace.")}
        query={query}
        setQuery={setQuery}
        onSubmit={submit}
        placeholder={tx("marketSkillSearchPlaceholder", "Search pnpm, docs, git…")}
      />
      {renderSkillMarket(state, installing, (entry) => { void install(entry); })}
      {message && <div className="settings-form-success">{message}</div>}
      {error && <div className="settings-form-error">{error}</div>}
    </div>
  );
}

export function McpMarketPanel({ onInstalled }: { onInstalled?: () => void }) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<MarketState<MarketMcpEntry>>({ kind: "loading" });
  const [installing, setInstalling] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = (q = query) => {
    setState({ kind: "loading" });
    searchMcpMarket(q)
      .then((entries) => setState({ kind: "ready", entries }))
      .catch((e: unknown) => setState({ kind: "error", message: String(e) }));
  };

  useEffect(() => {
    refresh("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    refresh(query);
  };

  const install = async (entry: MarketMcpEntry) => {
    const cfg = mcpConfigFromMarketEntry(entry);
    if (!cfg) return;
    setInstalling(entry.name);
    setMessage(null);
    setError(null);
    try {
      await addMcpServer(cfg);
      onInstalled?.();
      setMessage(t("marketMcpInstalled", cfg.prefix));
    } catch (e: unknown) {
      setError(t("marketMcpInstallFailed", String(e)));
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div className="market-panel" aria-label={tx("marketMcpTitle", "Online MCP market")}>
      <MarketHeader
        title={tx("marketMcpTitle", "Online MCP market")}
        hint={tx("marketMcpHint", "Search the official MCP registry and add stdio servers directly.")}
        query={query}
        setQuery={setQuery}
        onSubmit={submit}
        placeholder={tx("marketMcpSearchPlaceholder", "Search filesystem, git, browser…")}
      />
      {renderMcpMarket(state, installing, (entry) => { void install(entry); })}
      {message && <div className="settings-form-success">{message}</div>}
      {error && <div className="settings-form-error">{error}</div>}
    </div>
  );
}

function MarketHeader({
  title,
  hint,
  query,
  setQuery,
  onSubmit,
  placeholder,
}: {
  title: string;
  hint: string;
  query: string;
  setQuery: (value: string) => void;
  onSubmit: (e: FormEvent) => void;
  placeholder: string;
}) {
  return (
    <div className="market-head">
      <div className="market-title-block">
        <div className="market-title">{title}</div>
        <div className="market-hint">{hint}</div>
      </div>
      <form className="market-search" onSubmit={onSubmit}>
        <input
          className="settings-input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
        />
        <button type="submit" className="settings-btn">
          {tx("marketSearchBtn", "Search")}
        </button>
      </form>
    </div>
  );
}

function renderSkillMarket(
  state: MarketState<MarketSkillEntry>,
  installing: string | null,
  onInstall: (entry: MarketSkillEntry) => void,
) {
  if (state.kind === "loading") return <div className="market-empty">…</div>;
  if (state.kind === "error") {
    return <div className="settings-form-error">{t("marketLoadFailed", state.message)}</div>;
  }
  if (state.entries.length === 0) {
    return <div className="market-empty">{tx("marketEmpty", "No matching entries.")}</div>;
  }
  return (
    <ul className="market-list">
      {state.entries.map((entry) => {
        const key = `${entry.source}/${entry.skillId}`;
        return (
          <li key={key} className="market-item">
            <div className="market-item-main">
              <div className="market-item-title">
                <span className="mono">{entry.name}</span>
                {entry.isOfficial && <span className="market-tag">{tx("marketOfficial", "Official")}</span>}
              </div>
              <div className="market-item-desc">{entry.installHint}</div>
              <div className="market-tags">
                <span>{entry.source}</span>
                {entry.installs != null && <span>{t("marketInstalls", entry.installs)}</span>}
              </div>
            </div>
            <button
              type="button"
              className="settings-btn"
              onClick={() => onInstall(entry)}
              disabled={installing !== null}
            >
              {installing === key ? tx("marketInstalling", "Installing…") : tx("marketInstallBtn", "Install")}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function renderMcpMarket(
  state: MarketState<MarketMcpEntry>,
  installing: string | null,
  onInstall: (entry: MarketMcpEntry) => void,
) {
  if (state.kind === "loading") return <div className="market-empty">…</div>;
  if (state.kind === "error") {
    return <div className="settings-form-error">{t("marketLoadFailed", state.message)}</div>;
  }
  if (state.entries.length === 0) {
    return <div className="market-empty">{tx("marketEmpty", "No matching entries.")}</div>;
  }
  return (
    <ul className="market-list">
      {state.entries.map((entry) => (
        <McpMarketItem key={entry.name} entry={entry} installing={installing} onInstall={onInstall} />
      ))}
    </ul>
  );
}

function McpMarketItem({
  entry,
  installing,
  onInstall,
}: {
  entry: MarketMcpEntry;
  installing: string | null;
  onInstall: (entry: MarketMcpEntry) => void;
}) {
  const cfg = useMemo(() => mcpConfigFromMarketEntry(entry), [entry]);
  const hasRemoteOnly = !cfg && entry.remotes.length > 0;
  const disabledReason = hasRemoteOnly
    ? tx("marketMcpRemoteOnly", "HTTP remote, not supported by this runtime yet")
    : tx("marketMcpNeedsEnv", "Needs manual command or environment variables");
  return (
    <li className="market-item">
      <div className="market-item-main">
        <div className="market-item-title">
          <span className="mono">{entry.title || entry.name}</span>
          {entry.isLatest && <span className="market-tag">{tx("marketLatest", "Latest")}</span>}
        </div>
        <div className="market-item-desc">{entry.description || entry.name}</div>
        <div className="market-tags">
          {entry.packages.slice(0, 3).map((pkg) => (
            <span key={`${pkg.registryType}:${pkg.identifier}`}>
              {pkg.registryType} · {pkg.identifier}
            </span>
          ))}
          {entry.remotes.slice(0, 2).map((remote) => (
            <span key={`${remote.transportType}:${remote.url}`}>{remote.transportType}</span>
          ))}
          {entry.repositoryUrl && <span>{entry.repositoryUrl.replace(/^https?:\/\//, "")}</span>}
        </div>
      </div>
      <button
        type="button"
        className="settings-btn"
        onClick={() => onInstall(entry)}
        disabled={installing !== null || cfg == null}
        title={cfg == null ? disabledReason : undefined}
      >
        {installing === entry.name ? tx("marketAdding", "Adding…") : tx("marketAddBtn", "Add")}
      </button>
    </li>
  );
}

function activateSkill(name: string) {
  if (!sendFrame({ type: "activate_skill", name })) return;
  const current = appStore.getState().activeSkills;
  const next = Array.from(new Set([...current, name]));
  appStore.getState().setActiveSkills?.(next);
}
