// Right rail: tasks card (live + cleared via clear button) + plan
// card placeholder. Both can be collapsed via the workspace panel
// menu in the chat header. Visibility is driven by body-level CSS
// classes the store toggles in `setWorkspaceRailOpen` /
// `setPlanCardOpen`.

import { TaskCountSpan, TasksList } from "./Workspace/TasksRail";
import {
  ClearTasksButton,
  ClosePlanCardButton,
  CloseWorkspaceRailButton,
  WorkspacePanelMenu,
} from "./Workspace/WorkspaceToggles";

export function AppWorkspaceRail() {
  return (
    <aside id="workspace-rail" aria-label="Tasks and plan">
      <section className="rail-card rail-tasks">
        <div className="rail-card-header">
          <div>
            <h2 data-i18n="tasks">Tasks</h2>
            <p><TaskCountSpan /> <span data-i18n="taskCountLabel">tool runs</span></p>
          </div>
          <div className="rail-header-actions">
            <WorkspacePanelMenu />
            <ClearTasksButton />
            <CloseWorkspaceRailButton />
          </div>
        </div>
        <TasksList />
      </section>

      <section className="rail-card rail-plan">
        <div className="rail-card-header">
          <div>
            <h2 data-i18n="plan">Plan</h2>
            <p data-i18n="planSubtitle">Agent notes</p>
          </div>
          <ClosePlanCardButton />
        </div>
        <div className="plan-empty">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 6h11" />
            <path d="M9 12h11" />
            <path d="M9 18h11" />
            <path d="m3 6 1 1 2-2" />
            <path d="m3 12 1 1 2-2" />
            <path d="m3 18 1 1 2-2" />
          </svg>
          <strong data-i18n="noPlan">No plan yet.</strong>
          <span data-i18n="planEmptyBody">Jarvis writes the plan here as it explores. Keep chatting.</span>
        </div>
      </section>
    </aside>
  );
}
