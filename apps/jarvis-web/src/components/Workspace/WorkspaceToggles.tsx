// React-controlled buttons that toggle the workspace rail / plan
// card / panel-menu visibility. Each one dispatches into the store;
// effects in the store sync the body classes the legacy CSS keys
// off (`workspace-rail-closed`, `plan-card-closed`).
//
// The header trigger lives in `<ChatHeader>` markup — we export a
// dedicated component for it so the chat-header layout can stay
// declarative.

import { useEffect, useRef, type ReactNode } from "react";
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
  const label = t("openSidebar") || "Open sidebar";
  return (
    <button
      id="open-sidebar"
      type="button"
      className="ghost-icon open-sidebar-affordance"
      title={label}
      aria-label={label}
      aria-controls="sidebar"
      aria-expanded={false}
      onClick={() => setOpen(true)}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M9 5v14" />
        <path d="m13 9 3 3-3 3" />
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

/// Workspace "Panels" selector — Claude Code-style dropdown that
/// lists every panel the user can show in the right rail. Live
/// items (Diff / Tasks / Plan / Change report) toggle independent
/// per-panel visibility flags via `setWorkspacePanelVisible`. Stub
/// items (Preview / Terminal / Files) are rendered greyed-out so
/// users can see what's planned without being able to click —
/// keeps parity with the Claude Code menu reference and gives us
/// a natural place to flip them on as features land.
///
/// Click-outside closes via a document-level mousedown listener.
export function WorkspacePanelMenu() {
  const open = useAppStore((s) => s.workspacePanelMenuOpen);
  const setOpen = useAppStore((s) => s.setWorkspacePanelMenuOpen);
  const visible = useAppStore((s) => s.workspacePanelVisible);
  const setVisible = useAppStore((s) => s.setWorkspacePanelVisible);
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

  // Order matches the Claude Code reference. Stubs are kept above
  // working items intentionally — that's the order in their menu
  // and also signals "these slots exist, they'll light up later".
  const items: Array<
    | { kind: "stub"; key: string; labelKey: string; fallback: string; icon: ReactNode }
    | {
        kind: "live";
        key: import("../../store/persistence").WorkspacePanelKey;
        labelKey: string;
        fallback: string;
        icon: ReactNode;
      }
  > = [
    { kind: "stub", key: "preview",     labelKey: "panelPreview",   fallback: "Preview",   icon: <PlayIcon /> },
    { kind: "live", key: "diff",        labelKey: "panelDiff",      fallback: "Diff",      icon: <DiffIcon /> },
    { kind: "stub", key: "terminal",    labelKey: "panelTerminal",  fallback: "Terminal",  icon: <TerminalIcon /> },
    { kind: "stub", key: "files",       labelKey: "panelFiles",     fallback: "Files",     icon: <FilesIcon /> },
    { kind: "live", key: "tasks",       labelKey: "tasks",          fallback: "Tasks",     icon: <TasksIcon /> },
    { kind: "live", key: "plan",        labelKey: "plan",           fallback: "Plan",      icon: <PlanIcon /> },
    { kind: "live", key: "changeReport",labelKey: "changeReportTitle", fallback: "Change report", icon: <ChangeReportIcon /> },
  ];

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
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
        </svg>
      </button>
      <div
        id="workspace-panel-menu"
        className={"workspace-panel-menu" + (open ? "" : " hidden")}
        role="menu"
      >
        {items.map((item) => {
          if (item.kind === "stub") {
            return (
              <button
                key={item.key}
                type="button"
                className="workspace-panel-item is-disabled"
                role="menuitem"
                disabled
                title={t("panelComingSoon") || "Coming soon"}
              >
                <span className="panel-menu-icon">{item.icon}</span>
                <span className="panel-menu-label">{tx(item.labelKey, item.fallback)}</span>
                <span className="panel-menu-shortcut" aria-hidden="true">·</span>
              </button>
            );
          }
          const checked = visible[item.key];
          return (
            <button
              key={item.key}
              type="button"
              className={"workspace-panel-item" + (checked ? " is-checked" : "")}
              role="menuitemcheckbox"
              aria-checked={checked}
              onClick={() => setVisible(item.key, !checked)}
            >
              <span className="panel-menu-icon">{item.icon}</span>
              <span className="panel-menu-label">{tx(item.labelKey, item.fallback)}</span>
              <span className="panel-menu-check" aria-hidden="true">{checked ? "✓" : ""}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/// `t()` returns the key when no translation is set; this wrapper
/// falls back to the supplied English fallback so a missing zh
/// entry never leaks the raw key name into the menu.
function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

// ---- Inline icons (12px, single-stroke) for the panel menu ----

function PlayIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  );
}

function DiffIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function FilesIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

function TasksIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function PlanIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 6 9 11 4" />
      <polyline points="3 13 6 16 11 11" />
      <line x1="14" y1="7" x2="21" y2="7" />
      <line x1="14" y1="14" x2="21" y2="14" />
    </svg>
  );
}

function ChangeReportIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="15" y2="17" />
    </svg>
  );
}
