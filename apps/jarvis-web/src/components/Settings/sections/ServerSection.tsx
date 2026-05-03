// Server runtime snapshot. Read-only — every value is computed from
// env vars / config file at server startup; changing them requires
// editing the file or env and restarting. The section's job is just
// to make the current state honestly visible so users don't have to
// `ps -ef` to know what they got.

import { useEffect, useState } from "react";
import { Row, Section } from "./Section";
import { fetchServerInfo } from "../../../services/serverInfo";
import type { ServerInfoState } from "../../../services/serverInfo";
import { t } from "../../../utils/i18n";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

export function ServerSection({ embedded }: { embedded?: boolean } = {}) {
  const [state, setState] = useState<ServerInfoState>({ kind: "loading" });
  const refresh = () => {
    setState({ kind: "loading" });
    void fetchServerInfo().then(setState);
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.kind === "loading") {
    return (
      <Section
        id="server"
        titleKey="settingsServerTitle"
        titleFallback="Server"
        descKey="settingsServerDesc"
        descFallback="Live snapshot of the running jarvis serve process."
        embedded={embedded}
      >
        <p className="settings-empty">…</p>
      </Section>
    );
  }
  if (state.kind === "error") {
    return (
      <Section
        id="server"
        titleKey="settingsServerTitle"
        titleFallback="Server"
        descKey="settingsServerDesc"
        descFallback="Live snapshot of the running jarvis serve process."
        embedded={embedded}
      >
        <p className="settings-empty error">
          {tx("settingsServerLoadFailed", `failed to load: ${state.message}`)
            .replace("{msg}", state.message)}
        </p>
      </Section>
    );
  }

  const info = state.info;
  const noneTxt = tx("settingsServerNoneConfigured", "(none configured)");
  const ynTxt = (b: boolean | undefined) =>
    b ? tx("settingsServerEnabled", "enabled") : tx("settingsServerDisabled", "disabled");

  return (
    <Section
      id="server"
      titleKey="settingsServerTitle"
      titleFallback="Server"
      descKey="settingsServerDesc"
      descFallback="Live snapshot of the running jarvis serve process."
      embedded={embedded}
    >
      <Row label={tx("settingsServerListenAddr", "Listen address")}>
        <span className="settings-value mono">{info.listen_addr ?? noneTxt}</span>
      </Row>
      <Row label={tx("settingsServerConfigPath", "Config file")}>
        <span className="settings-value mono">{info.config_path ?? noneTxt}</span>
      </Row>
      <Row label={tx("settingsServerPersistence", "Persistence")}>
        <span className="settings-value">
          {info.persistence ? (
            <span className="mono">{info.persistence}</span>
          ) : (
            <span className="muted">{noneTxt}</span>
          )}
        </span>
      </Row>
      <Row label={tx("settingsServerProjectStore", "Project store")}>
        <span className="settings-value">{ynTxt(info.project_store)}</span>
      </Row>
      <Row label={tx("settingsServerMemoryMode", "Memory mode")}>
        <span className="settings-value">
          {info.memory ? (
            <>
              <span className="mono">{info.memory.mode}</span>
              {info.memory.budget_tokens != null && (
                <span className="muted"> · {info.memory.budget_tokens} tokens</span>
              )}
            </>
          ) : (
            <span className="muted">{noneTxt}</span>
          )}
        </span>
      </Row>
      <Row label={tx("settingsServerApprovalMode", "Approval mode")}>
        <span className="settings-value">
          {info.approval_mode ? (
            <span className="mono">{info.approval_mode}</span>
          ) : (
            <span className="muted">{noneTxt}</span>
          )}
        </span>
      </Row>
      <Row label={tx("settingsServerCodingMode", "Coding mode")}>
        <span className="settings-value">{ynTxt(info.coding_mode)}</span>
      </Row>
      <Row label={tx("settingsServerProjectContext", "Auto-load project context")}>
        <span className="settings-value">
          {info.project_context?.loaded ? (
            <>
              {ynTxt(true)}
              {info.project_context.max_bytes != null && (
                <span className="muted"> · {info.project_context.max_bytes} B cap</span>
              )}
            </>
          ) : (
            ynTxt(false)
          )}
        </span>
      </Row>

      <div className="settings-row settings-row-full">
        <div className="settings-row-label">
          <div>{tx("settingsServerToolsHeading", "Built-in tools")}</div>
          <div className="settings-row-hint">
            {info.tool_count} · {tx("settingsServerToolsHint", "Bold = enabled.")}
          </div>
        </div>
        <div className="settings-row-control">
          <ul className="settings-tools-grid">
            {(info.tools ?? []).map((name) => (
              <li key={name} className="mono">{name}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="settings-row settings-row-full">
        <div className="settings-row-label">
          <div>{tx("settingsServerMcpHeading", "MCP servers")}</div>
        </div>
        <div className="settings-row-control">
          {info.mcp_servers && info.mcp_servers.length > 0 ? (
            <ul className="settings-tools-grid">
              {info.mcp_servers.map((name) => (
                <li key={name} className="mono">{name}</li>
              ))}
            </ul>
          ) : (
            <span className="settings-value muted">
              {tx("settingsServerMcpEmpty", "No MCP servers configured.")}
            </span>
          )}
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
