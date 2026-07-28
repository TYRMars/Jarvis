// Runtime MCP server management. Each row is one server registered
// via the harness `McpManager` (backed by `Arc<RwLock<ToolRegistry>>`
// on the Rust side); add and remove mutate the live tool catalogue
// without restarting the binary. The legacy `ServerSection` still
// shows a flat read-only list of prefixes — that view stays for
// auditing and is the source of truth across restarts; this one is
// the interactive plane.

import { useEffect, useState, type FormEvent } from "react";
import { Row, Section } from "./Section";
import { Button, Modal, TextField } from "../../ui";
import { t } from "../../../utils/i18n";
import {
  addMcpServer,
  checkMcpHealth,
  configFromCommandLine,
  listMcpServers,
  reloadMcpServer,
  removeMcpServer,
  type McpHealth,
  type McpServerInfo,
  type McpServerStatus,
} from "../../../services/mcp";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; servers: McpServerInfo[] }
  | { kind: "error"; message: string };

export function McpSection({
  embedded,
  refreshToken = 0,
  query = "",
}: {
  embedded?: boolean;
  refreshToken?: number;
  query?: string;
} = {}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [adding, setAdding] = useState(false);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<McpServerInfo | null>(null);
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
  }, [refreshToken]);

  const submitServer = async (
    prefix: string,
    cmdline: string,
    current: McpServerInfo | null,
  ): Promise<boolean> => {
    const nextPrefix = prefix.trim();
    const nextCmdline = cmdline.trim();
    if (!nextPrefix || !nextCmdline) {
      setAddError(tx("mcpAddMissing", "Prefix and command are required."));
      return false;
    }
    setAdding(true);
    setAddError(null);
    try {
      if (current) {
        await removeMcpServer(current.prefix);
      }
      await addMcpServer(configFromCommandLine(nextPrefix, nextCmdline));
      setAddPrefix("");
      setAddCmdline("");
      refresh();
      return true;
    } catch (e: unknown) {
      setAddError(current ? t("mcpReloadFailed", String(e)) : t("mcpAddFailed", String(e)));
      refresh();
      return false;
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

  const handleReload = async (prefix: string) => {
    setErrorByPrefix((s) => ({ ...s, [prefix]: "" }));
    setHealthByPrefix((s) => ({ ...s, [prefix]: "checking" }));
    try {
      const result = await reloadMcpServer(prefix);
      setHealthByPrefix((s) => ({
        ...s,
        [prefix]: {
          ok: true,
          latency_ms: result.latency_ms,
          tools: result.tools.length,
        },
      }));
      refresh();
    } catch (e: unknown) {
      setErrorByPrefix((s) => ({
        ...s,
        [prefix]: t("mcpReloadFailed", String(e)),
      }));
      setHealthByPrefix((s) => {
        const next = { ...s };
        delete next[prefix];
        return next;
      });
      refresh();
    }
  };

  const filteredState =
    state.kind === "ready"
      ? { ...state, servers: filterMcpServers(state.servers, query) }
      : state;

  return (
    <Section
      id="mcp"
      titleKey="settingsMcpTitle"
      titleFallback="MCP servers"
      descKey="settingsMcpDesc"
      descFallback="Add or remove external MCP servers at runtime. Tools register as <prefix>.<remote-name>."
      embedded={embedded}
    >
      <div className="settings-manage-actions">
        <Button variant="primary" onClick={() => setAddModalOpen(true)}>
          {tx("mcpAddTitle", "Add server")}
        </Button>
        <Button onClick={refresh}>{tx("settingsRefresh", "Refresh")}</Button>
      </div>

      {renderList(
        filteredState,
        handleRemove,
        handleHealth,
        handleReload,
        setEditingServer,
        healthByPrefix,
        errorByPrefix,
      )}

      {addError && <div className="settings-form-error">{addError}</div>}

      <McpServerModal
        open={addModalOpen}
        title={tx("mcpAddTitle", "Add server")}
        prefix={addPrefix}
        cmdline={addCmdline}
        busy={adding}
        submitLabel={adding ? tx("mcpAdding", "Adding…") : tx("mcpAddBtn", "Add")}
        submitError={addError}
        onPrefix={setAddPrefix}
        onCmdline={setAddCmdline}
        onClose={() => setAddModalOpen(false)}
        onSubmit={async (e, prefix, cmdline) => {
          e.preventDefault();
          const ok = await submitServer(prefix, cmdline, null);
          if (ok) setAddModalOpen(false);
        }}
      />

      <McpServerModal
        open={editingServer !== null}
        title={tx("mcpEditTitle", "Edit server")}
        prefix={editingServer?.prefix ?? ""}
        cmdline={editingServer ? commandLineFromConfig(editingServer) : ""}
        busy={adding}
        submitLabel={adding ? tx("mcpAdding", "Saving…") : tx("mcpSaveBtn", "Save")}
        submitError={addError}
        onPrefix={() => undefined}
        onCmdline={() => undefined}
        onClose={() => setEditingServer(null)}
        onSubmit={async (e, prefix, cmdline) => {
          e.preventDefault();
          if (!editingServer) return;
          const ok = await submitServer(prefix, cmdline, editingServer);
          if (ok) setEditingServer(null);
        }}
      />
    </Section>
  );
}

function renderList(
  state: LoadState,
  onRemove: (prefix: string) => void | Promise<void>,
  onHealth: (prefix: string) => void | Promise<void>,
  onReload: (prefix: string) => void | Promise<void>,
  onEdit: (server: McpServerInfo) => void,
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
                  <span className="settings-mcp-name">{s.prefix}</span>
                  <span
                    className={`settings-tag ${statusTagClass(s.status)}`}
                    title={`status: ${s.status}`}
                  >
                    {statusLabel(s.status)}
                  </span>
                  <span className="muted">
                    {" · "}
                    {t("mcpToolCount", s.tools.length)}
                  </span>
                </div>
                <div className="settings-mcp-actions">
                  {s.config.transport.type === "stdio" && (
                    <button type="button" className="settings-btn" onClick={() => onEdit(s)}>
                      {tx("settingsEdit", "Edit")}
                    </button>
                  )}
                  <button type="button" className="settings-btn" onClick={() => { void onHealth(s.prefix); }}>
                    {tx("mcpHealthBtn", "Health")}
                  </button>
                  <button type="button" className="settings-btn" onClick={() => { void onReload(s.prefix); }}>
                    {tx("mcpReloadBtn", "Reload")}
                  </button>
                  <button type="button" className="settings-btn settings-btn-danger" onClick={() => { void onRemove(s.prefix); }}>
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
                    <li key={name}>{name}</li>
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

function McpServerModal({
  open,
  title,
  prefix,
  cmdline,
  busy,
  submitLabel,
  submitError,
  onPrefix,
  onCmdline,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  prefix: string;
  cmdline: string;
  busy: boolean;
  submitLabel: string;
  submitError?: string | null;
  onPrefix: (value: string) => void;
  onCmdline: (value: string) => void;
  onClose: () => void;
  onSubmit: (e: FormEvent, prefix: string, cmdline: string) => void | Promise<void>;
}) {
  const [localPrefix, setLocalPrefix] = useState(prefix);
  const [localCmdline, setLocalCmdline] = useState(cmdline);

  useEffect(() => {
    if (!open) return;
    setLocalPrefix(prefix);
    setLocalCmdline(cmdline);
  }, [cmdline, open, prefix]);

  return (
    <Modal open={open} title={title} onClose={onClose} size="md" busy={busy}>
      <form
        className="settings-plugin-modal-form"
        onSubmit={(e) => { void onSubmit(e, localPrefix, localCmdline); }}
      >
        <p className="settings-plugin-modal-desc">
          {tx("mcpCommandLineHelp", "e.g. uvx mcp-server-filesystem /tmp")}
        </p>
        <TextField
          label={tx("mcpPrefixLabel", "Prefix")}
          value={localPrefix}
          onChange={(e) => {
            setLocalPrefix(e.target.value);
            onPrefix(e.target.value);
          }}
          placeholder="github"
          disabled={busy}
          autoFocus
        />
        <TextField
          label={tx("mcpCommandLineLabel", "Command line")}
          value={localCmdline}
          onChange={(e) => {
            setLocalCmdline(e.target.value);
            onCmdline(e.target.value);
          }}
          placeholder="uvx mcp-server-github"
          disabled={busy}
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

function commandLineFromConfig(server: McpServerInfo): string {
  const transport = server.config.transport;
  if (transport.type === "stdio") {
    return [transport.command, ...(transport.args ?? [])].filter(Boolean).join(" ");
  }
  if (transport.type === "http" || transport.type === "streamable-http") {
    return transport.url;
  }
  return "";
}

function filterMcpServers(servers: McpServerInfo[], query: string): McpServerInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return servers;
  return servers.filter((server) =>
    [
      server.prefix,
      server.status,
      server.config.transport.type,
      commandLineFromConfig(server),
      ...server.tools,
    ].join(" ").toLowerCase().includes(q),
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

function statusTagClass(status: McpServerStatus): string {
  switch (status) {
    case "running":
      return "settings-tag-muted";
    case "stopped":
      return "settings-tag-warn";
    case "unhealthy":
      return "settings-tag-danger";
  }
}

function statusLabel(status: McpServerStatus): string {
  switch (status) {
    case "running":
      return tx("mcpStatusRunning", "Running");
    case "stopped":
      return tx("mcpStatusStopped", "Stopped");
    case "unhealthy":
      return tx("mcpStatusUnhealthy", "Needs attention");
  }
}
