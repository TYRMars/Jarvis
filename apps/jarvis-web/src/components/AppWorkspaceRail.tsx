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
import { ChangeReport, ChangeReportCount } from "./Workspace/ChangeReport";
import { PlanCountSpan, PlanList } from "./Workspace/PlanList";
import { TaskCountSpan, TasksList } from "./Workspace/TasksRail";
import { WorkspaceDiff, WorkspaceDiffCount } from "./Workspace/WorkspaceDiff";
import { ClearTasksButton, CloseWorkspaceRailButton } from "./Workspace/WorkspaceToggles";
import { useAppStore } from "../store/appStore";
import type { WorkspacePanelKey } from "../store/persistence";
import { t } from "../utils/i18n";

type PanelConfig = {
  key: WorkspacePanelKey;
  className: string;
  label: string;
  title: string;
  subtitle: ReactNode;
  extraActions?: ReactNode;
  content: ReactNode;
};

export function AppWorkspaceRail() {
  const visible = useAppStore((s) => s.workspacePanelVisible);

  // Hide the entire <aside> when no panels are active. The
  // master `workspaceRailOpen` flag still controls whether the
  // body grid reserves the column at all, but we also short-
  // circuit here so the empty rail doesn't paint a blank
  // background while the column collapses on its own.
  const anyVisible =
    visible.diff || visible.tasks || visible.plan || visible.changeReport;
  if (!anyVisible) return null;

  const panels: PanelConfig[] = [
    {
      key: "diff",
      className: "rail-ws-diff",
      label: tx("panelDiff", "Diff"),
      title: t("wsDiffTitle"),
      subtitle: (
        <>
          <WorkspaceDiffCount /> <span>{tx("wsDiffCountLabel", "file changes")}</span>
        </>
      ),
      content: <WorkspaceDiff />,
    },
    {
      key: "changeReport",
      className: "rail-change-report",
      label: tx("changeReportTitle", "Change report"),
      title: t("changeReportTitle"),
      subtitle: (
        <>
          <ChangeReportCount /> <span>{tx("changeReportCountLabel", "updates")}</span>
        </>
      ),
      content: <ChangeReport />,
    },
    {
      key: "tasks",
      className: "rail-tasks",
      label: tx("tasks", "Tasks"),
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
      label: tx("plan", "Plan"),
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
        <div className="workspace-rail-header">
          <div className="workspace-rail-heading">
            <span className="workspace-rail-kicker">{tx("workspace", "Workspace")}</span>
            <h2>{tx("panels", "Panels")}</h2>
          </div>
          <CloseWorkspaceRailButton />
        </div>
        <div className="workspace-rail-tabs" aria-label="Open workspace panels">
          {openPanels.map((panel) => (
            <span key={panel.key} className={`workspace-rail-tab ${panel.className}`}>
              {panel.label}
            </span>
          ))}
        </div>
        <div className="workspace-rail-stack">
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

function tx(key: string, fallback: string): string {
  const value = t(key);
  return value === key ? fallback : value;
}
