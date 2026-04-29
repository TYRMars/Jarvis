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
import { TodosCountSpan, TodosList } from "./Workspace/TodosRail";
import { WorkspaceDiff, WorkspaceDiffCount } from "./Workspace/WorkspaceDiff";
import { ClearTasksButton } from "./Workspace/WorkspaceToggles";
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
      subtitle: tx("previewSubtitle", "local app surface"),
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
      key: "changeReport",
      className: "rail-change-report",
      title: t("changeReportTitle"),
      subtitle: (
        <>
          <ChangeReportCount /> <span>{tx("changeReportCountLabel", "updates")}</span>
        </>
      ),
      content: <ChangeReport />,
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
    {
      key: "todos",
      className: "rail-todos",
      title: tx("panelTodos", "TODOs"),
      subtitle: (
        <>
          <TodosCountSpan />{" "}
          <span>{tx("todosCountLabel", "items in backlog")}</span>
        </>
      ),
      content: <TodosList />,
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

function PreviewPanel() {
  return (
    <div className="preview-surface" aria-live="polite">
      <div className="preview-pixel-mascot" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className="preview-loading-row">
        <span className="preview-spinner" aria-hidden="true" />
        <span>{tx("previewSettingUp", "Setting up preview")}</span>
      </div>
    </div>
  );
}

function TerminalPanel() {
  return (
    <div className="terminal-surface">
      <div className="terminal-line">
        <span className="terminal-muted">(base)</span>
        <span> jarvis % </span>
        <span className="terminal-cursor" aria-hidden="true" />
      </div>
    </div>
  );
}

function FilesPanel() {
  const diff = useAppStore((s) => s.workspaceDiff);
  const paths = diff && diff !== "unavailable" ? diff.files.map((f) => f.path) : [];
  const roots = buildFileRoots(paths);
  return (
    <div className="files-panel">
      <label className="files-search">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <span className="sr-only">{tx("search", "Search")}</span>
        <input type="search" placeholder={tx("filesFilterPlaceholder", "Filter files... (?text to search contents)")} />
      </label>
      <div className="files-tree" role="tree">
        {roots.length === 0 ? (
          <div className="files-empty">{tx("filesEmpty", "No changed files yet.")}</div>
        ) : (
          roots.map((root) => <FileTreeRow key={root.name} name={root.name} depth={0} count={root.count} />)
        )}
      </div>
    </div>
  );
}

function FileTreeRow({ name, depth, count }: { name: string; depth: number; count?: number }) {
  return (
    <div className="files-row" role="treeitem" style={{ paddingLeft: 8 + depth * 16 }}>
      <svg className="files-chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m9 18 6-6-6-6" />
      </svg>
      <svg className="files-folder" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      </svg>
      <span>{name}</span>
      {count ? <em>{count}</em> : null}
    </div>
  );
}

function buildFileRoots(paths: string[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const [root] = path.split("/");
    if (!root) continue;
    counts.set(root, (counts.get(root) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => ({ name, count }));
}

function tx(key: string, fallback: string): string {
  const value = t(key);
  return value === key ? fallback : value;
}
