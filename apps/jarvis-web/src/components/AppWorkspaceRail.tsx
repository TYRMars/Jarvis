// Right rail — Claude Code-style stack of toggleable panels.
//
// Each panel is independently shown / hidden via the
// `WorkspacePanelMenu` dropdown that lives in the chat header.
// User selection persists to localStorage per key (see
// `store/persistence.ts::initialWorkspacePanel`). Default first-
// run layout shows the two panels a coding session looks at every
// turn (Diff + Tasks); Plan and Change report are opt-in via the
// menu — they tend to duplicate info or only matter in plan mode.
//
// Each card carries its own close ✕ that toggles the panel off
// without going through the menu — the same affordance Claude
// Code's panels expose. Re-enable from the menu.

import { useEffect, useState, type ReactNode } from "react";
import { PlanCountSpan, PlanList } from "./Workspace/PlanList";
import { TaskCountSpan, TasksList } from "./Workspace/TasksRail";
import { WorkspaceDiff, WorkspaceDiffCount } from "./Workspace/WorkspaceDiff";
import { ClearTasksButton } from "./Workspace/WorkspaceToggles";
import { ChangeReport, ChangeReportCount } from "./Workspace/ChangeReport";
import { FilesSurface } from "./Workspace/FilesSurface";
import { TerminalSurface } from "./Workspace/TerminalSurface";
import { useAppStore } from "../store/appStore";
import type { WorkspacePanelKey } from "../store/persistence";
import { t } from "../utils/i18n";

type PanelConfig = {
  key: WorkspacePanelKey;
  className: string;
  title: string;
  subtitle: ReactNode;
  extraActions?: ReactNode;
  content: ReactNode;
};

export function AppWorkspaceRail() {
  const visible = useAppStore((s) => s.workspacePanelVisible);
  const setVisible = useAppStore((s) => s.setWorkspacePanelVisible);
  const [focusedPanel, setFocusedPanel] = useState<WorkspacePanelKey | null>(null);
  const [collapsedPanels, setCollapsedPanels] = useState<Set<WorkspacePanelKey>>(() => new Set());

  useEffect(() => {
    if (focusedPanel && !visible[focusedPanel]) setFocusedPanel(null);
  }, [focusedPanel, visible]);

  useEffect(() => {
    setCollapsedPanels((current) => {
      let changed = false;
      const next = new Set<WorkspacePanelKey>();
      for (const key of current) {
        if (visible[key]) next.add(key);
        else changed = true;
      }
      return changed ? next : current;
    });
  }, [visible]);

  const anyVisible = Object.values(visible).some(Boolean);
  if (!anyVisible) return null;

  const panels: PanelConfig[] = [
    {
      key: "preview",
      className: "rail-preview",
      title: tx("panelPreview", "Preview"),
      subtitle: tx("previewSubtitleSoon", "coming soon"),
      content: <PreviewPanel />,
    },
    {
      key: "diff",
      className: "rail-ws-diff",
      title: t("wsDiffTitle"),
      subtitle: (
        <>
          <WorkspaceDiffCount /> <span>{tx("wsDiffCountLabel", "file changes")}</span>
        </>
      ),
      content: <WorkspaceDiff />,
    },
    {
      key: "terminal",
      className: "rail-terminal",
      title: tx("panelTerminal", "Terminal"),
      subtitle: tx("terminalSubtitle", "shell session"),
      content: <TerminalPanel />,
    },
    {
      key: "files",
      className: "rail-files",
      title: tx("panelFiles", "Files"),
      subtitle: tx("filesSubtitle", "workspace tree"),
      content: <FilesPanel />,
    },
    {
      key: "tasks",
      className: "rail-tasks",
      title: t("tasks"),
      subtitle: (
        <>
          <TaskCountSpan /> <span>{tx("taskCountLabel", "tool runs")}</span>
        </>
      ),
      extraActions: <ClearTasksButton />,
      content: <TasksList />,
    },
    {
      key: "changeReport",
      className: "rail-change-report",
      title: t("changeReportTitle"),
      subtitle: (
        <>
          <ChangeReportCount /> <span>{tx("changeReportCountLabel", "change(s) so far")}</span>
        </>
      ),
      content: <ChangeReport />,
    },
    {
      key: "plan",
      className: "rail-plan",
      title: t("plan"),
      subtitle: (
        <>
          <PlanCountSpan /> <span>{tx("planCountLabel", "steps")}</span>
        </>
      ),
      content: <PlanList />,
    },
  ];

  const openPanels = panels.filter((panel) => visible[panel.key]);
  const activeFocus = focusedPanel && visible[focusedPanel] ? focusedPanel : null;
  const renderedPanels = activeFocus
    ? panels.filter((panel) => panel.key === activeFocus)
    : openPanels;

  const applyPreset = (keys: WorkspacePanelKey[]) => {
    for (const panel of panels) setVisible(panel.key, keys.includes(panel.key));
    setFocusedPanel(null);
    setCollapsedPanels(new Set());
  };

  const toggleCollapsed = (key: WorkspacePanelKey) => {
    setCollapsedPanels((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <aside
      id="workspace-rail"
      aria-label="Workspace panels"
    >
      <div className="workspace-rail-shell">
        <div className="workspace-rail-toolbar" aria-label={tx("panelLayoutActions", "Panel layout")}>
          <div className="workspace-rail-toolbar-title">
            <strong>{tx("panelWorkspace", "Workspace")}</strong>
            <span>{openPanels.length} {tx("panelOpenCount", "open")}</span>
          </div>
          <div className="workspace-rail-toolbar-actions">
            {activeFocus ? (
              <>
                {openPanels.map((panel) => (
                  <button
                    key={panel.key}
                    type="button"
                    className={`rail-chip${panel.key === activeFocus ? " is-active" : ""}`}
                    aria-label={tx("panelFocus", "Focus") + " " + panel.title}
                    onClick={() => setFocusedPanel(panel.key)}
                  >
                    {panel.title}
                  </button>
                ))}
                <button
                  type="button"
                  className="rail-chip rail-chip-command"
                  onClick={() => setFocusedPanel(null)}
                >
                  {tx("panelStack", "Stack")}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="rail-chip rail-chip-command"
                  onClick={() => applyPreset(["diff", "tasks", "changeReport"])}
                >
                  {tx("panelPresetReview", "Review")}
                </button>
                <button
                  type="button"
                  className="rail-chip rail-chip-command"
                  onClick={() => applyPreset(["terminal", "files", "tasks"])}
                >
                  {tx("panelPresetBuild", "Build")}
                </button>
                <button
                  type="button"
                  className="rail-chip rail-chip-command"
                  onClick={() => applyPreset(panels.map((panel) => panel.key))}
                >
                  {tx("panelPresetAll", "All")}
                </button>
                <button
                  type="button"
                  className="rail-chip rail-chip-danger"
                  onClick={() => applyPreset([])}
                >
                  {tx("panelPresetClear", "Clear")}
                </button>
              </>
            )}
          </div>
        </div>
        <div
          className={[
            "workspace-rail-stack",
            `count-${Math.min(renderedPanels.length, 4)}`,
            activeFocus ? "is-focused" : "",
            collapsedPanels.size > 0 && !activeFocus ? "has-collapsed" : "",
          ].filter(Boolean).join(" ")}
        >
          {renderedPanels.map((panel) => (
            <PanelSection
              key={panel.key}
              panelKey={panel.key}
              className={panel.className}
              title={panel.title}
              subtitle={panel.subtitle}
              extraActions={panel.extraActions}
              focused={panel.key === activeFocus}
              collapsed={!activeFocus && collapsedPanels.has(panel.key)}
              onToggleCollapsed={() => toggleCollapsed(panel.key)}
              onToggleFocus={() => setFocusedPanel(panel.key === activeFocus ? null : panel.key)}
            >
              {panel.content}
            </PanelSection>
          ))}
        </div>
      </div>
    </aside>
  );
}

/// Per-panel chrome — title row + subtitle/count + close button +
/// optional extra actions (e.g. tasks' Clear button). Card content
/// goes in `children`.
function PanelSection({
  panelKey,
  className,
  title,
  subtitle,
  extraActions,
  focused,
  collapsed,
  onToggleCollapsed,
  onToggleFocus,
  children,
}: {
  panelKey: WorkspacePanelKey;
  className: string;
  title: string;
  subtitle: ReactNode;
  extraActions?: ReactNode;
  focused: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onToggleFocus: () => void;
  children: ReactNode;
}) {
  const setVisible = useAppStore((s) => s.setWorkspacePanelVisible);
  return (
    <section className={`rail-card ${className}${focused ? " is-focused" : ""}${collapsed ? " is-collapsed" : ""}`}>
      <div className="rail-card-header">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <div className="rail-header-actions">
          {extraActions}
          {!focused ? (
            <button
              type="button"
              className="ghost-icon rail-icon"
              title={collapsed ? tx("panelExpand", "Expand") : tx("panelCollapse", "Collapse")}
              aria-label={`${collapsed ? tx("panelExpand", "Expand") : tx("panelCollapse", "Collapse")} ${title}`}
              aria-expanded={!collapsed}
              onClick={onToggleCollapsed}
            >
              {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
            </button>
          ) : null}
          <button
            type="button"
            className="ghost-icon rail-icon"
            title={focused ? tx("panelExitFocus", "Exit focus") : tx("panelFocus", "Focus")}
            aria-label={`${focused ? tx("panelExitFocus", "Exit focus") : tx("panelFocus", "Focus")} ${title}`}
            aria-pressed={focused}
            onClick={onToggleFocus}
          >
            {focused ? <StackIcon /> : <FocusIcon />}
          </button>
          <button
            type="button"
            className="ghost-icon rail-icon"
            title={t("close") || "Close"}
            aria-label={`${t("close") || "Close"} ${title}`}
            onClick={() => setVisible(panelKey, false)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      </div>
      {/* Body wrapper: provides the scroll container so the card
       * grows to fit content up to its CSS max-height, then the
       * body scrolls internally without pushing siblings or
       * stretching the rail. The header above stays pinned. */}
      {!collapsed ? <div className="rail-card-body">{children}</div> : null}
    </section>
  );
}

function FocusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M16 3h3a2 2 0 0 1 2 2v3" />
      <path d="M21 16v3a2 2 0 0 1-2 2h-3" />
      <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
    </svg>
  );
}

function StackIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="5" width="16" height="5" rx="1.5" />
      <rect x="4" y="14" width="16" height="5" rx="1.5" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

/// Placeholder card for the not-yet-shipped Preview surface.
/// Renders a clean "Coming soon" affordance instead of pretending to
/// be loading — the previous mascot animation gave the (false)
/// impression a dev-server preview was being booted up.
function PreviewPanel() {
  return (
    <div className="rail-coming-soon" aria-live="polite">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="4" width="18" height="14" rx="2" />
        <path d="M8 21h8" />
        <path d="M12 18v3" />
        <polygon points="10 9 15 11 10 13 10 9" fill="currentColor" stroke="none" />
      </svg>
      <strong>{tx("previewComingSoon", "Preview · Coming soon")}</strong>
      <span>
        {tx(
          "previewComingSoonBody",
          "Live preview of your dev server is on the roadmap. For now, run the app locally and hit the URL in a separate tab.",
        )}
      </span>
    </div>
  );
}

function TerminalPanel() {
  return <TerminalSurface />;
}

function FilesPanel() {
  return <FilesSurface />;
}

function tx(key: string, fallback: string): string {
  const value = t(key);
  return value === key ? fallback : value;
}
