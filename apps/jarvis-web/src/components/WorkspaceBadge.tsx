// Chat-header workspace badge — shows the active workspace root and
// git state. Click to refresh + open a small popover that lets you
// pin a different folder for THIS WebSocket session. The pin is
// per-socket: it doesn't change anything else's view of the
// workspace, just where this session's `fs.* / git.* / shell.exec`
// tools target.
//
// Source-of-truth precedence:
//   1. `appStore.socketWorkspace` — set by the `workspace_changed`
//      WS frame after a `set_workspace` request lands.
//   2. `GET /v1/workspace` — the binary's startup root (the badge's
//      historical content; still useful as fallback).

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/appStore";
import { sendFrame } from "../services/socket";
import { fetchWorkspace, shortenPath } from "../services/workspace";
import type { WorkspaceState } from "../services/workspace";
import { t } from "../utils/i18n";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

export function WorkspaceBadge() {
  const [state, setState] = useState<WorkspaceState>({ kind: "loading" });
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const socketWorkspace = useAppStore((s) => s.socketWorkspace);

  const refresh = () => {
    setState({ kind: "loading" });
    fetchWorkspace().then(setState);
  };
  useEffect(() => {
    refresh();
    // No deps — fetch once on mount. Re-fetch is on click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Resolved label: socket override wins, else /v1/workspace.
  const fallbackPath =
    state.kind === "ready" ? state.info.root : null;
  const activePath = socketWorkspace ?? fallbackPath;
  const overridden = socketWorkspace != null;

  const submit = (path: string | null) => {
    sendFrame({ type: "set_workspace", path });
    setOpen(false);
    setDraft("");
  };

  if (state.kind === "loading") {
    return (
      <button
        type="button"
        className="workspace-badge workspace-badge-loading"
        title="loading workspace"
        disabled
      >
        <BadgeIcon />
        <span>…</span>
      </button>
    );
  }
  if (state.kind === "unconfigured") {
    return (
      <div className="workspace-badge-wrap" ref={wrapRef}>
        <button
          type="button"
          className="workspace-badge workspace-badge-error"
          title="server didn't pin a workspace root — use the popover or set JARVIS_FS_ROOT / --workspace"
          onClick={() => setOpen((v) => !v)}
        >
          <BadgeIcon />
          <span>{tx("workspaceBadgeNone", "no workspace")}</span>
        </button>
        {open && renderPopover(activePath, draft, setDraft, submit, overridden)}
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <button
        type="button"
        className="workspace-badge workspace-badge-error"
        title={`workspace lookup failed: ${state.message}`}
        onClick={refresh}
      >
        <BadgeIcon />
        <span>retry</span>
      </button>
    );
  }
  const { info } = state;
  const short = activePath ? shortenPath(activePath) : "?";
  const branch = info.vcs === "git" ? info.branch ?? "(detached)" : null;
  const dirty = info.vcs === "git" && info.dirty === true;
  const tooltip = overridden
    ? `${activePath} (session override)\nbase: ${info.root}`
    : info.vcs === "git"
      ? `${info.root}\n${info.branch ?? "(detached)"} (${info.head ?? "?"})${dirty ? " · dirty" : " · clean"}`
      : info.root;
  return (
    <div className="workspace-badge-wrap" ref={wrapRef}>
      <button
        type="button"
        className={
          "workspace-badge" +
          (dirty ? " workspace-badge-dirty" : "") +
          (overridden ? " workspace-badge-pinned" : "")
        }
        title={tooltip}
        onClick={() => setOpen((v) => !v)}
        onAuxClick={refresh}
      >
        <BadgeIcon />
        <span className="workspace-badge-path">{short}</span>
        {!overridden && branch && (
          <>
            <span className="workspace-badge-sep">·</span>
            <span className="workspace-badge-branch">
              {branch}
              {dirty && <span className="workspace-badge-dot" aria-label="dirty">●</span>}
            </span>
          </>
        )}
        {overridden && (
          <span className="workspace-badge-pin-dot" aria-label="session override">▾</span>
        )}
      </button>
      {open && renderPopover(activePath, draft, setDraft, submit, overridden)}
    </div>
  );
}

function renderPopover(
  active: string | null,
  draft: string,
  setDraft: (v: string) => void,
  submit: (path: string | null) => void,
  overridden: boolean,
) {
  return (
    <div className="workspace-popover" role="dialog">
      <div className="workspace-popover-header">
        {tx("workspaceCurrent", "Current")}
      </div>
      <div className="workspace-popover-row workspace-popover-current">
        {active ?? tx("workspaceBadgeNone", "no workspace")}
      </div>
      <div className="workspace-popover-header">
        {tx("workspacePinTitle", "Pin a folder for this session")}
      </div>
      <form
        className="workspace-popover-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim()) submit(draft.trim());
        }}
      >
        <input
          className="workspace-popover-input"
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={tx("workspacePinPlaceholder", "/path/to/project")}
          autoFocus
        />
        <div className="workspace-popover-actions">
          {overridden && (
            <button
              type="button"
              className="workspace-popover-btn"
              onClick={() => submit(null)}
            >
              {tx("workspaceClearPin", "Clear pin")}
            </button>
          )}
          <button type="submit" className="workspace-popover-btn workspace-popover-btn-primary">
            {tx("workspacePinSet", "Set")}
          </button>
        </div>
      </form>
    </div>
  );
}

function BadgeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}
