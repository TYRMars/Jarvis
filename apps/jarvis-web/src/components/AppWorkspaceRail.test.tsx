import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppWorkspaceRail } from "./AppWorkspaceRail";
import { WorkspacePanelMenu } from "./Workspace/WorkspaceToggles";
import { useAppStore } from "../store/appStore";

const allPanelsClosed = {
  preview: false,
  diff: false,
  terminal: false,
  files: false,
  tasks: false,
  plan: false,
  changeReport: false,
};

beforeEach(() => {
  localStorage.clear();
  useAppStore.getState().setLang("en");
  useAppStore.setState({
    workspacePanelVisible: { ...allPanelsClosed },
    workspacePanelMenuOpen: false,
    tasks: [],
    subAgentRuns: {},
  });
});

afterEach(() => {
  useAppStore.setState({
    workspacePanelVisible: { ...allPanelsClosed, tasks: true },
    workspacePanelMenuOpen: false,
    tasks: [],
    subAgentRuns: {},
  });
});

describe("AppWorkspaceRail", () => {
  it("renders the change report panel when its visibility flag is enabled", () => {
    useAppStore.setState({
      workspacePanelVisible: { ...allPanelsClosed, changeReport: true },
      tasks: [
        {
          id: "edit-1",
          name: "fs.write",
          args: { path: "src/new-panel.tsx" },
          status: "ok",
          startedAt: 0,
          updatedAt: 1,
        },
      ],
    });

    render(<AppWorkspaceRail />);

    expect(screen.getByRole("heading", { name: "Change report" })).toBeInTheDocument();
    expect(screen.getByText("src/new-panel.tsx")).toBeInTheDocument();
  });

  it("exposes change report from the Views menu and toggles it on", () => {
    render(<WorkspacePanelMenu />);

    fireEvent.click(screen.getByRole("button", { name: "Views" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Change report/ }));

    expect(useAppStore.getState().workspacePanelVisible.changeReport).toBe(true);
  });
});
