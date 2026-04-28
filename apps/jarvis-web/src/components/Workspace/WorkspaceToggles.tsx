// React-controlled buttons that toggle the workspace rail / plan
// card / panel-menu visibility. Each one dispatches into the store;
// effects in the store sync the body classes the legacy CSS keys
// off (`workspace-rail-closed`, `plan-card-closed`).
//
// The header trigger lives in `<ChatHeader>` markup — we export a
// dedicated component for it so the chat-header layout can stay
// declarative.

import { useEffect, useRef } from "react";
import { useAppStore } from "../../store/appStore";
import { t } from "../../utils/i18n";

/// Floating "open sidebar" affordance shown in the chat header when
/// the sidebar is collapsed. Mirrors the in-sidebar toggle so the
/// user can always get back to the conversation list. Renders nothing
/// while the sidebar is open — the in-sidebar topbar owns it then.
export function OpenSidebarButton() {
  const open = useAppStore((s) => s.sidebarOpen);
  const setOpen = useAppStore((s) => s.setSidebarOpen);
  if (open) return null;
  return (
    <button
      id="open-sidebar"
      type="button"
      className="ghost-icon"
      title="Open sidebar"
      aria-label="Open sidebar"
      aria-controls="sidebar"
      aria-expanded={false}
      onClick={() => setOpen(true)}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M9 5v14" />
      </svg>
    </button>
  );
}

export function WorkspaceRailToggleButton() {
  const open = useAppStore((s) => s.workspaceRailOpen);
  const setOpen = useAppStore((s) => s.setWorkspaceRailOpen);
  return (
    <button
      id="workspace-rail-toggle"
      type="button"
      className="ghost-icon"
      title={t("tasksAndPlan") || "Tasks and plan"}
      aria-label="Tasks and plan"
      aria-expanded={open}
      onClick={(e) => {
        e.stopPropagation();
        setOpen(!open);
      }}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M15 4v16" />
        <path d="m7 9 1.5 1.5L12 7" />
        <path d="M7 15h4" />
      </svg>
    </button>
  );
}

export function CloseWorkspaceRailButton() {
  const setOpen = useAppStore((s) => s.setWorkspaceRailOpen);
  return (
    <button
      id="close-workspace-rail"
      type="button"
      className="ghost-icon rail-icon"
      title={t("close") || "Close"}
      aria-label="Close"
      onClick={() => setOpen(false)}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </svg>
    </button>
  );
}

export function ClosePlanCardButton() {
  const setOpen = useAppStore((s) => s.setPlanCardOpen);
  return (
    <button
      id="close-plan-card"
      type="button"
      className="ghost-icon rail-icon"
      title={t("close") || "Close"}
      aria-label="Close"
      onClick={() => setOpen(false)}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </svg>
    </button>
  );
}

export function ClearTasksButton() {
  const clearTasks = useAppStore((s) => s.clearTasks);
  return (
    <button
      id="clear-tasks"
      type="button"
      className="ghost-icon rail-icon"
      title={t("clearTasks") || "Clear tasks"}
      aria-label="Clear tasks"
      onClick={() => clearTasks()}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 6h18" />
        <path d="M8 6V4h8v2" />
        <path d="m19 6-1 14H6L5 6" />
      </svg>
    </button>
  );
}

export function CloseApprovalsButton() {
  return (
    <button
      id="close-approvals"
      type="button"
      className="ghost-icon panel-close"
      title={t("close") || "Close"}
      aria-label="Close"
      onClick={() => document.body.classList.remove("approvals-open")}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </svg>
    </button>
  );
}

/// The workspace "Panels" dropdown — currently mostly disabled
/// stubs (preview/diff/terminal/files), but the live items toggle
/// the workspace rail's two real cards (tasks + plan). Click-outside
/// closes via a document-level listener mounted by the panel.
export function WorkspacePanelMenu() {
  const open = useAppStore((s) => s.workspacePanelMenuOpen);
  const setOpen = useAppStore((s) => s.setWorkspacePanelMenuOpen);
  const railOpen = useAppStore((s) => s.workspaceRailOpen);
  const planOpen = useAppStore((s) => s.planCardOpen);
  const setRailOpen = useAppStore((s) => s.setWorkspaceRailOpen);
  const setPlanOpen = useAppStore((s) => s.setPlanCardOpen);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open, setOpen]);

  return (
    <div className="workspace-panel-menu-wrap" ref={wrapRef}>
      <button
        id="workspace-panel-menu-button"
        type="button"
        className="ghost-icon rail-icon"
        title={t("panels") || "Panels"}
        aria-label="Panels"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
          <path d="M15 4v16" />
        </svg>
      </button>
      <div
        id="workspace-panel-menu"
        className={"workspace-panel-menu" + (open ? "" : " hidden")}
        role="menu"
      >
        <button
          type="button"
          className={"workspace-panel-item" + (railOpen ? " is-checked" : "")}
          data-panel-action="tasks"
          role="menuitem"
          onClick={() => { setRailOpen(!railOpen); setOpen(false); }}
        >
          <span className="panel-menu-icon">⌘</span>
          <span>{t("tasks")}</span>
          <span className="panel-menu-check" aria-hidden="true">{railOpen ? "✓" : ""}</span>
        </button>
        <button
          type="button"
          className={"workspace-panel-item" + (planOpen ? " is-checked" : "")}
          data-panel-action="plan"
          role="menuitem"
          onClick={() => {
            if (!railOpen) setRailOpen(true);
            setPlanOpen(!planOpen);
            setOpen(false);
          }}
        >
          <span className="panel-menu-icon">⌁</span>
          <span>{t("plan")}</span>
          <span className="panel-menu-check" aria-hidden="true">{planOpen ? "✓" : ""}</span>
        </button>
      </div>
    </div>
  );
}
