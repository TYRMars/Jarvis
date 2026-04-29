// Chat-header workspace badge — shows the active workspace root and
// git state, click to open a Recent-folders dropdown that mirrors
// `~/.config/jarvis/workspaces.json`. Selecting an entry pins it
// for the current WebSocket session via `set_workspace`; the entry
// also moves to the front of Recent so subsequent sessions find it
// first. A free-text input handles "Open folder…" — the server
// canonicalises and validates before it lands in Recent.
//
// Source-of-truth precedence for what the badge displays:
//   1. `appStore.socketWorkspace` — set by the `workspace_changed`
//      WS frame after `set_workspace` lands.
//   2. `GET /v1/workspace` — the binary's startup root (the badge's
//      historical content; still useful as fallback).

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/appStore";
import { sendFrame } from "../services/socket";
import { fetchWorkspace, shortenPath } from "../services/workspace";
import type { WorkspaceState } from "../services/workspace";
import {
  forgetWorkspace,
  listRecentWorkspaces,
  touchWorkspace,
  type RecentWorkspace,
} from "../services/workspaces";
import { t } from "../utils/i18n";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

export function WorkspaceBadge() {
  const [state, setState] = useState<WorkspaceState>({ kind: "loading" });
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<RecentWorkspace[]>([]);
  const [recentLoading, setRecentLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const socketWorkspace = useAppStore((s) => s.socketWorkspace);

  const refreshBaseline = () => {
    setState({ kind: "loading" });
    void fetchWorkspace().then(setState);
  };
  const refreshRecent = () => {
    setRecentLoading(true);
    listRecentWorkspaces()
      .then((rows) => setRecent(rows))
      .catch(() => setRecent([]))
      .finally(() => setRecentLoading(false));
  };

  useEffect(() => {
    refreshBaseline();
    refreshRecent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch the recent list whenever the dropdown opens — covers the
  // case where another window pinned a folder mid-session.
  useEffect(() => {
    if (open) refreshRecent();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const fallbackPath = state.kind === "ready" ? state.info.root : null;
  const activePath = socketWorkspace ?? fallbackPath;
  const overridden = socketWorkspace != null;

  const pin = async (path: string | null) => {
    setActionError(null);
    if (path) {
      // Touch first so the registry sees the canonical path even if
      // the WS frame fails (e.g. server restart): worst case the
      // user sees the entry in Recent without it being live-pinned.
      try {
        const canonical = await touchWorkspace(path);
        sendFrame({ type: "set_workspace", path: canonical });
      } catch (e: unknown) {
        setActionError(t("workspacePinFailed", String(e)));
        return;
      }
    } else {
      sendFrame({ type: "set_workspace", path: null });
    }
    setDraft("");
    setOpen(false);
    refreshRecent();
  };

  const drop = async (path: string) => {
    setActionError(null);
    try {
      await forgetWorkspace(path);
      refreshRecent();
    } catch (e: unknown) {
      setActionError(String(e));
    }
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

  const renderTrigger = () => {
    if (state.kind === "unconfigured") {
      return (
        <button
          type="button"
          className="workspace-badge workspace-badge-error"
          title="server didn't pin a workspace root — pick one from Recent or paste a path"
          onClick={() => setOpen((v) => !v)}
        >
          <BadgeIcon />
          <span>{tx("workspaceBadgeNone", "no workspace")}</span>
        </button>
      );
    }
    if (state.kind === "error") {
      return (
        <button
          type="button"
          className="workspace-badge workspace-badge-error"
          title={`workspace lookup failed: ${state.message}`}
          onClick={refreshBaseline}
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
      <button
        type="button"
        className={
          "workspace-badge" +
          (dirty ? " workspace-badge-dirty" : "") +
          (overridden ? " workspace-badge-pinned" : "")
        }
        title={tooltip}
        onClick={() => setOpen((v) => !v)}
        onAuxClick={refreshBaseline}
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
        <span className="workspace-badge-caret" aria-hidden>
          ▾
        </span>
      </button>
    );
  };

  return (
    <div className="workspace-badge-wrap" ref={wrapRef}>
      {renderTrigger()}
      {open && (
        <div className="workspace-popover" role="dialog">
          <div className="workspace-popover-header">
            {tx("workspaceRecent", "Recent")}
          </div>
          {recentLoading ? (
            <div className="workspace-popover-row workspace-popover-muted">…</div>
          ) : recent.length === 0 ? (
            <div className="workspace-popover-row workspace-popover-muted">
              {tx("workspaceRecentEmpty", "No recent workspaces yet.")}
            </div>
          ) : (
            <ul className="workspace-recent-list">
              {recent.map((r) => {
                const isCurrent = r.path === activePath;
                return (
                  <li key={r.path} className="workspace-recent-item">
                    <button
                      type="button"
                      className={
                        "workspace-recent-row" +
                        (isCurrent ? " workspace-recent-row-current" : "")
                      }
                      onClick={() => pin(r.path)}
                      title={r.path}
                    >
                      <span className="workspace-recent-name">{r.name}</span>
                      <span className="workspace-recent-path">
                        {shortenPath(r.path)}
                      </span>
                      {isCurrent && (
                        <span className="workspace-recent-check" aria-label="current">
                          ✓
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="workspace-recent-drop"
                      onClick={(e) => {
                        e.stopPropagation();
                        void drop(r.path);
                      }}
                      aria-label={tx("workspaceForget", "Forget")}
                      title={tx("workspaceForget", "Forget")}
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="workspace-popover-divider" />

          <div className="workspace-popover-header">
            {tx("workspaceOpenFolder", "Open folder…")}
          </div>
          <form
            className="workspace-popover-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim()) void pin(draft.trim());
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
                  onClick={() => void pin(null)}
                >
                  {tx("workspaceClearPin", "Clear pin")}
                </button>
              )}
              <button
                type="submit"
                className="workspace-popover-btn workspace-popover-btn-primary"
              >
                {tx("workspacePinSet", "Set")}
              </button>
            </div>
          </form>

          {actionError && (
            <div className="workspace-popover-error">{actionError}</div>
          )}
        </div>
      )}
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
