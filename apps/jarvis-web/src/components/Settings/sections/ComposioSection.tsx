// Settings → Extensions → Connectors. Composio is surfaced here as a
// managed MCP gateway: the user supplies a Composio API key plus either a full
// MCP URL or a server/user pair, and Jarvis registers the resulting
// streamable-HTTP MCP server into the live tool catalog.

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button, TextField, Textarea } from "../../ui";
import { Section } from "./Section";
import { t } from "../../../utils/i18n";
import {
  addMcpServer,
  checkMcpHealth,
  configFromComposio,
  listMcpServers,
  reloadMcpServer,
  removeMcpServer,
  replaceMcpServer,
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

const COMPOSIO_DOCS_URL = "https://dashboard.composio.dev";

export function ComposioSection({ embedded }: { embedded?: boolean } = {}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [prefix, setPrefix] = useState("composio");
  const [apiKey, setApiKey] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [serverId, setServerId] = useState("");
  const [userId, setUserId] = useState("");
  const [allowTools, setAllowTools] = useState("");
  const [denyTools, setDenyTools] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [healthByPrefix, setHealthByPrefix] = useState<Record<string, McpHealth | "checking">>({});
  const [errorByPrefix, setErrorByPrefix] = useState<Record<string, string>>({});

  const refresh = () => {
    setState({ kind: "loading" });
    listMcpServers()
      .then((servers) => setState({ kind: "ready", servers: servers.filter(isComposioServer) }))
      .catch((e: unknown) => setState({ kind: "error", message: String(e) }));
  };

  useEffect(() => {
    refresh();
  }, []);

  const activeServer = useMemo(() => {
    if (state.kind !== "ready") return undefined;
    return state.servers.find((s) => s.prefix === prefix.trim());
  }, [prefix, state]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const nextPrefix = prefix.trim() || "composio";
    const fullUrl = mcpUrl.trim();
    const sid = serverId.trim();
    const uid = userId.trim();
    if (!apiKey.trim()) {
      setFormError(tx("composioKeyRequired", "Composio API key is required."));
      return;
    }
    if (!fullUrl && (!sid || !uid)) {
      setFormError(tx("composioTargetRequired", "Provide a full MCP URL or both server ID and user ID."));
      return;
    }

    setSaving(true);
    setFormError(null);
    setNotice(null);
    try {
      const cfg = configFromComposio({
        prefix: nextPrefix,
        apiKey: apiKey.trim(),
        mcpUrl: fullUrl || undefined,
        serverId: sid || undefined,
        userId: uid || undefined,
        allowTools: parseToolList(allowTools),
        denyTools: parseToolList(denyTools),
      });
      const existing = state.kind === "ready" ? state.servers.find((s) => s.prefix === nextPrefix) : undefined;
      if (existing) {
        await replaceMcpServer(nextPrefix, cfg);
      } else {
        await addMcpServer(cfg);
      }
      setApiKey("");
      setNotice(tx("composioSaved", "Composio connector is registered for this Jarvis process."));
      refresh();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : String(err));
      refresh();
    } finally {
      setSaving(false);
    }
  };

  const handleHealth = async (serverPrefix: string) => {
    setHealthByPrefix((s) => ({ ...s, [serverPrefix]: "checking" }));
    try {
      const result = await checkMcpHealth(serverPrefix);
      setHealthByPrefix((s) => ({ ...s, [serverPrefix]: result }));
    } catch (e: unknown) {
      setHealthByPrefix((s) => ({
        ...s,
        [serverPrefix]: { ok: false, latency_ms: 0, error: String(e) },
      }));
    }
  };

  const handleReload = async (serverPrefix: string) => {
    setErrorByPrefix((s) => ({ ...s, [serverPrefix]: "" }));
    setHealthByPrefix((s) => ({ ...s, [serverPrefix]: "checking" }));
    try {
      const result = await reloadMcpServer(serverPrefix);
      setHealthByPrefix((s) => ({
        ...s,
        [serverPrefix]: { ok: true, latency_ms: result.latency_ms, tools: result.tools.length },
      }));
      refresh();
    } catch (e: unknown) {
      setErrorByPrefix((s) => ({ ...s, [serverPrefix]: String(e) }));
      setHealthByPrefix((s) => {
        const next = { ...s };
        delete next[serverPrefix];
        return next;
      });
      refresh();
    }
  };

  const handleRemove = async (serverPrefix: string) => {
    setErrorByPrefix((s) => ({ ...s, [serverPrefix]: "" }));
    try {
      await removeMcpServer(serverPrefix);
      refresh();
    } catch (e: unknown) {
      setErrorByPrefix((s) => ({ ...s, [serverPrefix]: String(e) }));
    }
  };

  return (
    <Section
      id="composio"
      titleKey="settingsComposioTitle"
      titleFallback="Connectors"
      descKey="settingsComposioDesc"
      descFallback="Connect Composio-managed apps through the MCP gateway. Registered tools appear as <prefix>.<tool>."
      embedded={embedded}
    >
      <form className="settings-composio-form" onSubmit={(e) => { void submit(e); }}>
        <div className="settings-composio-form-head">
          <div>
            <div className="settings-composio-title">{tx("composioGatewayTitle", "Composio MCP gateway")}</div>
            <p>{tx("composioGatewayHint", "The key is sent to the Jarvis server for this runtime connection and is not shown again in Settings.")}</p>
          </div>
          <Button as="a" href={COMPOSIO_DOCS_URL} target="_blank" rel="noreferrer">
            {tx("composioGetKey", "Get API key")}
          </Button>
        </div>
        <div className="settings-composio-grid">
          <TextField
            label={tx("composioApiKeyLabel", "Composio API key")}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={tx("composioApiKeyPlaceholder", "Paste Composio API key")}
            disabled={saving}
            autoComplete="off"
          />
          <TextField
            label={tx("composioPrefixLabel", "Tool prefix")}
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder="composio"
            disabled={saving}
            hint={activeServer ? tx("composioPrefixExists", "Saving will replace the current connector with this prefix.") : undefined}
          />
          <TextField
            label={tx("composioMcpUrlLabel", "MCP URL")}
            value={mcpUrl}
            onChange={(e) => setMcpUrl(e.target.value)}
            placeholder="https://backend.composio.dev/v3/mcp/..."
            disabled={saving}
          />
          <div className="settings-composio-pair">
            <TextField
              label={tx("composioServerIdLabel", "Server ID")}
              value={serverId}
              onChange={(e) => setServerId(e.target.value)}
              placeholder="mcp_..."
              disabled={saving || mcpUrl.trim().length > 0}
            />
            <TextField
              label={tx("composioUserIdLabel", "User ID")}
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="user-123"
              disabled={saving || mcpUrl.trim().length > 0}
            />
          </div>
          <Textarea
            label={tx("composioAllowToolsLabel", "Allowed tools")}
            value={allowTools}
            onChange={(e) => setAllowTools(e.target.value)}
            placeholder="GMAIL_FETCH_EMAILS, GMAIL_SEND_EMAIL"
            rows={3}
            disabled={saving}
            hint={tx("composioToolListHint", "Optional comma or newline separated Composio tool names. Leave empty to expose all tools on the MCP server.")}
          />
          <Textarea
            label={tx("composioDenyToolsLabel", "Denied tools")}
            value={denyTools}
            onChange={(e) => setDenyTools(e.target.value)}
            placeholder="GMAIL_DELETE_EMAIL"
            rows={3}
            disabled={saving}
          />
        </div>
        {formError ? <div className="settings-form-error">{formError}</div> : null}
        {notice ? <div className="settings-composio-notice">{notice}</div> : null}
        <div className="settings-manage-actions">
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? tx("composioSaving", "Connecting…") : tx("composioSave", "Save and connect")}
          </Button>
          <Button type="button" onClick={refresh} disabled={saving}>
            {tx("settingsRefresh", "Refresh")}
          </Button>
        </div>
      </form>

      {renderComposioServers(state, healthByPrefix, errorByPrefix, handleHealth, handleReload, handleRemove)}
    </Section>
  );
}

function renderComposioServers(
  state: LoadState,
  healthByPrefix: Record<string, McpHealth | "checking">,
  errorByPrefix: Record<string, string>,
  onHealth: (prefix: string) => void | Promise<void>,
  onReload: (prefix: string) => void | Promise<void>,
  onRemove: (prefix: string) => void | Promise<void>,
) {
  if (state.kind === "loading") {
    return <div className="settings-composio-empty">…</div>;
  }
  if (state.kind === "error") {
    return <div className="settings-form-error">{state.message}</div>;
  }
  if (state.servers.length === 0) {
    return (
      <div className="settings-composio-empty">
        {tx("composioEmpty", "No Composio connector is registered yet.")}
      </div>
    );
  }
  return (
    <ul className="settings-mcp-list settings-composio-list">
      {state.servers.map((server) => (
        <li key={server.prefix} className="settings-mcp-item">
          <div className="settings-mcp-row">
            <div>
              <span className="settings-mcp-name">{server.prefix}</span>
              <span className="settings-tag settings-tag-muted">{server.config.transport.type}</span>
              <span className="muted">
                {" · "}
                {t("mcpToolCount", server.tools.length)}
              </span>
            </div>
            <div className="settings-mcp-actions">
              <button type="button" className="settings-btn" onClick={() => { void onHealth(server.prefix); }}>
                {tx("mcpHealthBtn", "Health")}
              </button>
              <button type="button" className="settings-btn" onClick={() => { void onReload(server.prefix); }}>
                {tx("mcpReloadBtn", "Reload")}
              </button>
              <button type="button" className="settings-btn settings-btn-danger" onClick={() => { void onRemove(server.prefix); }}>
                {tx("mcpRemoveBtn", "Remove")}
              </button>
            </div>
          </div>
          <div className="settings-composio-url">{transportUrl(server)}</div>
          {renderHealth(healthByPrefix[server.prefix])}
          {errorByPrefix[server.prefix] ? <div className="settings-form-error">{errorByPrefix[server.prefix]}</div> : null}
          {server.tools.length > 0 ? (
            <ul className="settings-mcp-tools">
              {server.tools.map((tool) => (
                <li key={tool}>{tool}</li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function isComposioServer(server: McpServerInfo): boolean {
  const url = transportUrl(server).toLowerCase();
  return server.prefix.toLowerCase().includes("composio") || url.includes("composio.dev/v3/mcp");
}

function transportUrl(server: McpServerInfo): string {
  const transport = server.config.transport;
  return transport.type === "http" || transport.type === "streamable-http" ? transport.url : "";
}

function parseToolList(raw: string): string[] | undefined {
  const out = raw
    .split(/[,\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function renderHealth(state: McpHealth | "checking" | undefined) {
  if (state === undefined) return null;
  if (state === "checking") return <div className="settings-mcp-health">…</div>;
  if (state.ok) {
    return (
      <div className="settings-mcp-health ok">
        {t("mcpHealthOk", state.latency_ms, state.tools ?? 0)}
      </div>
    );
  }
  return <div className="settings-mcp-health error">{t("mcpHealthFail", state.error ?? "")}</div>;
}
