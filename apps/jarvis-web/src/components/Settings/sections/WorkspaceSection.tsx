// Read-only workspace inspector. Same data the chat-header
// `WorkspaceBadge` shows, but laid out so users can copy the path,
// see the full HEAD sha, and re-probe on demand. Drives the
// existing `GET /v1/workspace` endpoint — no new HTTP surface.

import { useEffect, useState } from "react";
import { Row, Section } from "./Section";
import { fetchWorkspace } from "../../../services/workspace";
import type { WorkspaceState } from "../../../services/workspace";
import { t } from "../../../utils/i18n";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

export function WorkspaceSection() {
  const [state, setState] = useState<WorkspaceState>({ kind: "loading" });
  const refresh = () => {
    setState({ kind: "loading" });
    void fetchWorkspace().then(setState);
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Section
      id="workspace"
      titleKey="settingsWorkspaceTitle"
      titleFallback="Workspace"
      descKey="settingsWorkspaceDesc"
      descFallback="The directory all fs.* / git.* / shell.exec tools are scoped to. Set at server startup via --workspace, JARVIS_FS_ROOT, or [tools].fs_root."
    >
      <Row label={tx("settingsWorkspaceRoot", "Root")}>
        <Body state={state} field="root" />
      </Row>
      <Row label={tx("settingsWorkspaceVcs", "VCS")}>
        <Body state={state} field="vcs" />
      </Row>
      <Row label={tx("settingsWorkspaceBranch", "Branch")}>
        <Body state={state} field="branch" />
      </Row>
      <Row label={tx("settingsWorkspaceHead", "HEAD")}>
        <Body state={state} field="head" />
      </Row>
      <Row label={tx("settingsWorkspaceDirty", "Working tree")}>
        <Body state={state} field="dirty" />
      </Row>
      <div className="settings-row settings-row-actions">
        <button type="button" className="settings-btn" onClick={refresh}>
          {tx("settingsRefresh", "Refresh")}
        </button>
      </div>
    </Section>
  );
}

function Body({ state, field }: { state: WorkspaceState; field: string }) {
  if (state.kind === "loading") return <span className="settings-value muted">…</span>;
  if (state.kind === "unconfigured")
    return <span className="settings-value muted">{tx("settingsWorkspaceUnset", "no workspace pinned (server didn't call AppState::with_workspace_root)")}</span>;
  if (state.kind === "error")
    return <span className="settings-value error">{state.message}</span>;
  const info = state.info as unknown as Record<string, unknown>;
  const value = info[field];
  if (value == null) return <span className="settings-value muted">—</span>;
  if (field === "dirty") {
    return value
      ? <span className="settings-value warn">{tx("settingsWorkspaceDirtyYes", "dirty (uncommitted changes)")}</span>
      : <span className="settings-value">{tx("settingsWorkspaceDirtyNo", "clean")}</span>;
  }
  // Defensive stringify: workspace fields the server ships today
  // are primitives (string / number / boolean), but the typed
  // indirection up top widens to `unknown`. Route anything
  // non-primitive through `JSON.stringify` so we don't surface
  // `[object Object]` if the server later returns a richer payload.
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else text = JSON.stringify(value);
  return <span className="settings-value mono">{text}</span>;
}
