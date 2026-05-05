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

import type { ReactNode } from "react";
import { PlanCountSpan, PlanList } from "./Workspace/PlanList";
import { TaskCountSpan, TasksList } from "./Workspace/TasksRail";
import { WorkspaceDiff, WorkspaceDiffCount } from "./Workspace/WorkspaceDiff";
import { ClearTasksButton } from "./Workspace/WorkspaceToggles";
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

  return (
    <aside
      id="workspace-rail"
      aria-label="Workspace panels"
    >
      <div className="workspace-rail-shell">
        <div className={`workspace-rail-stack count-${Math.min(openPanels.length, 4)}`}>
          {openPanels.map((panel) => (
            <PanelSection
              key={panel.key}
              panelKey={panel.key}
              className={panel.className}
              title={panel.title}
              subtitle={panel.subtitle}
              extraActions={panel.extraActions}
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
  children,
}: {
  panelKey: WorkspacePanelKey;
  className: string;
  title: string;
  subtitle: ReactNode;
  extraActions?: ReactNode;
  children: ReactNode;
}) {
  const setVisible = useAppStore((s) => s.setWorkspacePanelVisible);
  return (
    <section className={`rail-card ${className}`}>
      <div className="rail-card-header">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <div className="rail-header-actions">
          {extraActions}
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
      <div className="rail-card-body">{children}</div>
    </section>
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
