// Sidebar "New session" button. Click opens a single popover that
// covers two orthogonal bindings the new conversation will inherit:
//
//   1. **Workspace** — which folder the agent's fs / git / shell
//      tools target. Lives in the per-conversation
//      workspaces ledger (so `Resume` later restores it).
//   2. **Project** — which `harness-core::Project` metadata
//      container injects its `instructions` into the system prompt.
//
// They're independent: a session can have a workspace but no
// project (most common — every chat in a repo), a project but no
// workspace (rare — pure prompt-bound chat), both, or neither.
//
// Without projects available the popover collapses to "workspace
// only"; without workspaces (e.g. server didn't wire the registry)
// it falls back to the legacy project-only flow.

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../store/appStore";
import { newConversation } from "../../services/conversations";
import { isLocalProjectId } from "../../services/projects";
import { listRecentWorkspaces, touchWorkspace, type RecentWorkspace } from "../../services/workspaces";
import { shortenPath } from "../../services/workspace";
import { chipColor } from "./ProjectsList";
import { t } from "../../utils/i18n";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

export function NewConvoButton() {
  const persistEnabled = useAppStore((s) => s.persistEnabled);
  const projectsAvailable = useAppStore((s) => s.projectsAvailable);
  const projects = useAppStore((s) => s.projects);
  const activeFilter = useAppStore((s) => s.activeProjectFilter);
  const socketWorkspace = useAppStore((s) => s.socketWorkspace);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [recent, setRecent] = useState<RecentWorkspace[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Load recent + initialise the selected workspace from the active
  // pin every time the popover opens.
  useEffect(() => {
    if (!open) return;
    setSelectedWorkspace(socketWorkspace ?? null);
    setPickError(null);
    listRecentWorkspaces()
      .then((rows) => setRecent(rows))
      .catch(() => setRecent([]));
  }, [open, socketWorkspace]);

  const onClick = () => {
    const noProjects = !projectsAvailable || projects.length === 0;
    // Even with no projects we still want the workspace picker —
    // open the popover unless the user has neither projects nor any
    // recent workspaces, in which case there's nothing to choose
    // and the legacy single-action button is the right behaviour.
    if (noProjects && recent.length === 0 && !socketWorkspace) {
      const projectId = activeFilter ?? null;
      newConversation({ projectId: isLocalProjectId(projectId) ? null : projectId });
      navigate("/");
      return;
    }
    setOpen((v) => !v);
  };

  // Run a free-text path through the workspaces registry so the
  // canonicalised value lands in Recent and gets used verbatim
  // by the WS New frame.
  const acceptFreePath = async (raw: string) => {
    setPickError(null);
    try {
      const canonical = await touchWorkspace(raw);
      setSelectedWorkspace(canonical);
      setRecent((rows) => {
        const filtered = rows.filter((r) => r.path !== canonical);
        const name =
          canonical.split("/").filter((s) => s.length > 0).pop() ?? canonical;
        return [
          { path: canonical, name, last_used_at: new Date().toISOString() },
          ...filtered,
        ];
      });
    } catch (e: unknown) {
      setPickError(t("workspacePinFailed", String(e)));
    }
  };

  const fire = (projectId: string | null) => {
    setOpen(false);
    setSearch("");
    newConversation({
      projectId: isLocalProjectId(projectId) ? null : projectId,
      workspacePath: selectedWorkspace,
    });
    navigate("/");
  };

  const visibleProjects = (() => {
    const q = search.trim().toLowerCase();
    const live = projects.filter((p) => !p.archived);
    if (!q) return live;
    return live.filter(
      (p) =>
        p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q),
    );
  })();

  const showProjects = projectsAvailable && projects.length > 0;

  return (
    <div className="new-convo-wrapper" ref={containerRef}>
      <button
        id="new-convo"
        type="button"
        className="nav-item"
        title={t("newConversation")}
        disabled={!persistEnabled}
        onClick={onClick}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
        <span>{t("newSession")}</span>
      </button>

      {open && (
        <div className="new-convo-popover" role="menu">
          {/* ---------- Workspace section ---------- */}
          <div className="new-convo-section-label">
            {tx("newWorkspaceHeading", "Workspace")}
          </div>
          <button
            type="button"
            className={
              "new-convo-popover-row" +
              (selectedWorkspace == null ? " selected" : "")
            }
            onClick={() => setSelectedWorkspace(null)}
          >
            <span className="project-dot" aria-hidden="true" />
            <div className="new-convo-popover-text">
              <strong>{tx("newWorkspaceNone", "No workspace")}</strong>
              <em>{tx("newWorkspaceNoneHint", "Use the binary's startup root")}</em>
            </div>
          </button>
          {recent.map((r) => {
            const isSel = r.path === selectedWorkspace;
            return (
              <button
                key={r.path}
                type="button"
                className={"new-convo-popover-row" + (isSel ? " selected" : "")}
                onClick={() => setSelectedWorkspace(r.path)}
                title={r.path}
              >
                <span className="project-dot" aria-hidden="true" />
                <div className="new-convo-popover-text">
                  <strong>{r.name}</strong>
                  <em>{shortenPath(r.path)}</em>
                </div>
                {isSel && <span className="new-convo-popover-check">✓</span>}
              </button>
            );
          })}
          <FreePathRow onSubmit={acceptFreePath} />
          {pickError && (
            <div className="new-convo-popover-error">{pickError}</div>
          )}

          {/* ---------- Project section ---------- */}
          {showProjects && (
            <>
              <div className="new-convo-section-label">
                {tx("newProjectHeading", "Project")}
              </div>
              <button
                type="button"
                className="new-convo-popover-row default"
                onClick={() => fire(null)}
              >
                <span className="project-dot" aria-hidden="true" />
                <div className="new-convo-popover-text">
                  <strong>{tx("freeChat", "Free chat")}</strong>
                  <em>{tx("freeChatHint", "No project context")}</em>
                </div>
              </button>
              {projects.length > 5 && (
                <input
                  type="search"
                  className="new-convo-popover-search"
                  placeholder="Search projects..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              )}
              <div className="new-convo-popover-list">
                {visibleProjects.length === 0 && (
                  <div className="new-convo-popover-empty">No matching projects</div>
                )}
                {visibleProjects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="new-convo-popover-row"
                    onClick={() => fire(p.id)}
                    title={p.description ?? p.name}
                  >
                    <span
                      className="project-dot"
                      style={{ background: chipColor(p.slug) }}
                      aria-hidden="true"
                    />
                    <div className="new-convo-popover-text">
                      <strong>{p.name}</strong>
                      {p.description ? (
                        <em>{p.description}</em>
                      ) : (
                        <em>{p.slug}</em>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}

          {/* No projects available → just a "Start" button so the
              workspace selection can land without forcing the user
              to pick a project. */}
          {!showProjects && (
            <div className="new-convo-popover-actions">
              <button
                type="button"
                className="new-convo-popover-start"
                onClick={() => fire(null)}
              >
                {tx("newConversationStart", "Start session")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/// Inline "type a path and press enter" row. Lives at the bottom of
/// the workspace section so users who haven't pinned anything
/// recently can still bring up a folder without leaving the popover.
function FreePathRow({ onSubmit }: { onSubmit: (path: string) => void }) {
  const [draft, setDraft] = useState("");
  return (
    <form
      className="new-convo-popover-free"
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.trim()) {
          onSubmit(draft.trim());
          setDraft("");
        }
      }}
    >
      <input
        type="text"
        className="new-convo-popover-free-input"
        placeholder={tx("newWorkspaceFreePlaceholder", "Open folder…  /path/to/project")}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
    </form>
  );
}
