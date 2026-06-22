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
import {
  ClipboardList,
  Diff,
  Files,
  Icon,
  ListChecks,
  ListTodo,
  PanelLeftOpen,
  PanelRight,
  Play,
  SquareTerminal,
  Trash2,
  X,
} from "../ui";

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
      <Icon icon={PanelLeftOpen} size={17} strokeWidth={1.8} />
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
      aria-label={t("wkSpaceTasksAndPlan")}
      aria-expanded={open}
      onClick={(e) => {
        e.stopPropagation();
        setOpen(!open);
      }}
    >
      <Icon icon={PanelRight} size={17} strokeWidth={1.8} />
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
      aria-label={t("wkSpaceClose")}
      onClick={() => setOpen(false)}
    >
      <Icon icon={X} size={15} strokeWidth={2} />
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
      aria-label={t("wkSpaceClose")}
      onClick={() => setOpen(false)}
    >
      <Icon icon={X} size={15} strokeWidth={2} />
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
      aria-label={t("wkSpaceClearTasks")}
      onClick={() => clearTasks()}
    >
      <Icon icon={Trash2} size={15} strokeWidth={1.9} />
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
      aria-label={t("wkSpaceClose")}
      onClick={() => document.body.classList.remove("approvals-open")}
    >
      <Icon icon={X} size={16} strokeWidth={2} />
    </button>
  );
}

/// Workspace "Views" selector — Claude Code-style dropdown that
/// lists every panel the user can show in the right rail.
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

  const items: Array<{
    key: import("../../store/persistence").WorkspacePanelKey;
    labelKey: string;
    fallback: string;
    icon: ReactNode;
    shortcut?: string;
  }> = [
    { key: "preview",      labelKey: "panelPreview",   fallback: "Preview",   icon: <Icon icon={Play} size={13} strokeWidth={2} />, shortcut: "⇧⌘P" },
    { key: "diff",         labelKey: "panelDiff",      fallback: "Diff",      icon: <Icon icon={Diff} size={13} strokeWidth={2} />, shortcut: "⇧⌘D" },
    { key: "terminal",     labelKey: "panelTerminal",  fallback: "Terminal",  icon: <Icon icon={SquareTerminal} size={13} strokeWidth={2} />, shortcut: "^`" },
    { key: "files",        labelKey: "panelFiles",     fallback: "Files",     icon: <Icon icon={Files} size={13} strokeWidth={2} /> },
    { key: "tasks",        labelKey: "tasks",          fallback: "Tasks",     icon: <Icon icon={ListTodo} size={13} strokeWidth={2} /> },
    { key: "changeReport", labelKey: "changeReportTitle", fallback: "Change report", icon: <Icon icon={ClipboardList} size={13} strokeWidth={2} /> },
    { key: "plan",         labelKey: "plan",           fallback: "Plan",      icon: <Icon icon={ListChecks} size={13} strokeWidth={2} /> },
  ];

  return (
    <div className="workspace-panel-menu-wrap" ref={wrapRef}>
      <button
        id="workspace-panel-menu-button"
        type="button"
        className="ghost-icon rail-icon"
        title={tx("views", "Views")}
        aria-label={tx("views", "Views")}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        <Icon icon={PanelRight} size={15} strokeWidth={1.9} />
      </button>
      <div
        id="workspace-panel-menu"
        className={"workspace-panel-menu" + (open ? "" : " hidden")}
        role="menu"
      >
        {items.map((item) => {
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
              <span className="panel-menu-shortcut" aria-hidden="true">{checked ? "✓" : item.shortcut || ""}</span>
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
