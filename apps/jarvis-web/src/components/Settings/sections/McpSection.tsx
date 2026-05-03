// Runtime MCP server management. Each row is one server registered
// via the harness `McpManager` (backed by `Arc<RwLock<ToolRegistry>>`
// on the Rust side); add and remove mutate the live tool catalogue
// without restarting the binary. The legacy `ServerSection` still
// shows a flat read-only list of prefixes — that view stays for
// auditing and is the source of truth across restarts; this one is
// the interactive plane.

import { useEffect, useState } from "react";
import { Row, Section } from "./Section";
import { t } from "../../../utils/i18n";
import {
  addMcpServer,
  checkMcpHealth,
  configFromCommandLine,
  listMcpServers,
  removeMcpServer,
  type McpHealth,
  type McpServerInfo,
} from "../../../services/mcp";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; servers: McpServerInfo[] }
  | { kind: "error"; message: string };

export function McpSection({ embedded }: { embedded?: boolean } = {}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [adding, setAdding] = useState(false);
  const [healthByPrefix, setHealthByPrefix] = useState<Record<string, McpHealth | "checking">>({});
  const [errorByPrefix, setErrorByPrefix] = useState<Record<string, string>>({});
  const [addPrefix, setAddPrefix] = useState("");
  const [addCmdline, setAddCmdline] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const refresh = () => {
    setState({ kind: "loading" });
    listMcpServers()
      .then((servers) => setState({ kind: "ready", servers }))
      .catch((e: unknown) => setState({ kind: "error", message: String(e) }));
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addPrefix.trim() || !addCmdline.trim()) {
      setAddError(tx("mcpAddMissing", "Prefix and command are required."));
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      await addMcpServer(configFromCommandLine(addPrefix.trim(), addCmdline.trim()));
      setAddPrefix("");
      setAddCmdline("");
      refresh();
    } catch (e: unknown) {
      setAddError(t("mcpAddFailed", String(e)));
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (prefix: string) => {
    setErrorByPrefix((s) => ({ ...s, [prefix]: "" }));
    try {
      await removeMcpServer(prefix);
      refresh();
    } catch (e: unknown) {
      setErrorByPrefix((s) => ({ ...s, [prefix]: t("mcpRemoveFailed", String(e)) }));
    }
  };

  const handleHealth = async (prefix: string) => {
    setHealthByPrefix((s) => ({ ...s, [prefix]: "checking" }));
    try {
      const result = await checkMcpHealth(prefix);
      setHealthByPrefix((s) => ({ ...s, [prefix]: result }));
    } catch (e: unknown) {
      setHealthByPrefix((s) => ({
        ...s,
        [prefix]: { ok: false, latency_ms: 0, error: String(e) },
      }));
    }
  };

  return (
    <Section
      id="mcp"
      titleKey="settingsMcpTitle"
      titleFallback="MCP servers"
      descKey="settingsMcpDesc"
      descFallback="Add or remove external MCP servers at runtime. Tools register as <prefix>.<remote-name>."
      embedded={embedded}
    >
      {renderList(state, handleRemove, handleHealth, healthByPrefix, errorByPrefix)}

      <div className="settings-row settings-row-full">
        <div className="settings-row-label">
          <div>{tx("mcpAddTitle", "Add server")}</div>
          <div className="settings-row-hint">{tx("mcpCommandLineHelp", "e.g. uvx mcp-server-filesystem /tmp")}</div>
        </div>
        <div className="settings-row-control">
          <form className="settings-form" onSubmit={handleAdd}>
            <div className="settings-form-row">
              <label className="settings-form-label" htmlFor="mcp-add-prefix">
                {tx("mcpPrefixLabel", "Prefix")}
              </label>
              <input
                id="mcp-add-prefix"
                className="settings-input"
                type="text"
                value={addPrefix}
                onChange={(e) => setAddPrefix(e.target.value)}
                placeholder="github"
                disabled={adding}
              />
            </div>
            <div className="settings-form-row">
              <label className="settings-form-label" htmlFor="mcp-add-cmdline">
                {tx("mcpCommandLineLabel", "Command line")}
              </label>
              <input
                id="mcp-add-cmdline"
                className="settings-input"
                type="text"
                value={addCmdline}
                onChange={(e) => setAddCmdline(e.target.value)}
                placeholder="uvx mcp-server-github"
                disabled={adding}
              />
            </div>
            {addError && <div className="settings-form-error">{addError}</div>}
            <div className="settings-form-actions">
              <button type="submit" className="settings-btn" disabled={adding}>
                {adding ? tx("mcpAdding", "Adding…") : tx("mcpAddBtn", "Add")}
              </button>
            </div>
          </form>
        </div>
      </div>

      <div className="settings-row settings-row-actions">
        <button type="button" className="settings-btn" onClick={refresh}>
          {tx("settingsRefresh", "Refresh")}
        </button>
      </div>
    </Section>
  );
}

function renderList(
  state: LoadState,
  onRemove: (prefix: string) => void,
  onHealth: (prefix: string) => void,
  healthByPrefix: Record<string, McpHealth | "checking">,
  errorByPrefix: Record<string, string>,
) {
  if (state.kind === "loading") {
    return <Row label={tx("mcpServers", "MCP servers")}>…</Row>;
  }
  if (state.kind === "error") {
    return (
      <Row label={tx("mcpServers", "MCP servers")}>
        <span className="settings-value error">{t("mcpListFailed", state.message)}</span>
      </Row>
    );
  }
  if (state.servers.length === 0) {
    return (
      <Row label={tx("mcpServers", "MCP servers")}>
        <span className="settings-value muted">{tx("mcpEmpty", "No MCP servers connected.")}</span>
      </Row>
    );
  }
  return (
    <div className="settings-row settings-row-full">
      <div className="settings-row-label">
        <div>{tx("mcpServers", "MCP servers")}</div>
      </div>
      <div className="settings-row-control">
        <ul className="settings-mcp-list">
          {state.servers.map((s) => (
            <li key={s.prefix} className="settings-mcp-item">
              <div className="settings-mcp-row">
                <div>
                  <span className="mono">{s.prefix}</span>
                  <span className="muted">
                    {" "}
                    · {s.config.transport.type}
                    {" "}
                    · {tx(`mcpStatus${capitalize(s.status)}`, s.status)}
                    {" "}
                    · {t("mcpToolCount", s.tools.length)}
                  </span>
                </div>
                <div className="settings-mcp-actions">
                  <button type="button" className="settings-btn" onClick={() => onHealth(s.prefix)}>
                    {tx("mcpHealthBtn", "Health")}
                  </button>
                  <button type="button" className="settings-btn settings-btn-danger" onClick={() => onRemove(s.prefix)}>
                    {tx("mcpRemoveBtn", "Remove")}
                  </button>
                </div>
              </div>
              {renderHealth(healthByPrefix[s.prefix])}
              {errorByPrefix[s.prefix] && (
                <div className="settings-form-error">{errorByPrefix[s.prefix]}</div>
              )}
              {s.tools.length > 0 && (
                <ul className="settings-mcp-tools">
                  {s.tools.map((name) => (
                    <li key={name} className="mono">{name}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function renderHealth(state: McpHealth | "checking" | undefined) {
  if (state === undefined) return null;
  if (state === "checking") {
    return <div className="settings-mcp-health">…</div>;
  }
  if (state.ok) {
    return (
      <div className="settings-mcp-health ok">
        {t("mcpHealthOk", state.latency_ms, state.tools ?? 0)}
      </div>
    );
  }
  return (
    <div className="settings-mcp-health error">
      {t("mcpHealthFail", state.error ?? "")}
    </div>
  );
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
