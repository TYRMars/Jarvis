// Behavioural tests for `ComposerProjectRail` — the new-conversation
// chip row that hosts the project picker, per-folder branch chips,
// and the "+ folder" / "+ 新建项目" actions.
//
// jsdom + @testing-library/react. We mock the heavyweight children
// (`BranchPopover`, `AddFolderDialog`, `ProjectCreatePanel`) to
// stubs that render an identifiable marker so the rail's wiring can
// be asserted without standing up their full UI.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerProjectRail } from "./ComposerProjectRail";
import { useAppStore } from "../../store/appStore";
import type { Project } from "../../types/frames";

// `vi.mock` factories run BEFORE imports. Returning a div with a known
// data-attribute lets the rail's open/close flow be observed via
// `screen.queryByTestId(...)` instead of poking inside the real
// dialog/popover children.
vi.mock("./BranchPopover", () => ({
  BranchPopover: ({ workspacePath }: { workspacePath: string }) => (
    <div data-testid="branch-popover" data-workspace={workspacePath} />
  ),
}));

vi.mock("./AddFolderDialog", () => ({
  AddFolderDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-folder-dialog" /> : null,
}));

vi.mock("../Projects/ProjectList", () => ({
  ProjectCreatePanel: () => <div data-testid="project-create-panel" />,
}));

const PROJ_A: Project = {
  id: "proj-a",
  slug: "alpha",
  name: "Alpha",
  description: null,
  instructions: "",
  tags: [],
  workspaces: [
    { path: "/Users/x/code/alpha", name: null },
    { path: "/Users/x/code/alpha-docs", name: null },
  ],
  archived: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const PROJ_B: Project = {
  ...PROJ_A,
  id: "proj-b",
  slug: "beta",
  name: "Beta",
  workspaces: [],
};

beforeEach(() => {
  // Reset every store slot the rail reads / writes. Keeps tests
  // independent in any order vitest happens to run them.
  const s = useAppStore.getState();
  s.setActiveId(null);
  s.setProjects([PROJ_A, PROJ_B]);
  s.setProjectsAvailable(true);
  s.setDraftProjectId(null);
  s.setDraftWorkspace(null);
});

afterEach(() => {
  // Some tests open the popover or dialog — close them so DOM
  // assertions in the next test start clean.
  useAppStore.getState().setActiveId(null);
});

describe("ComposerProjectRail — render gates", () => {
  it("renders nothing when activeId is set (in-session is owned by the shoulder)", () => {
    useAppStore.getState().setActiveId("convo-123");
    const { container } = render(<ComposerProjectRail />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when projectsAvailable is false (server didn't expose a project store)", () => {
    useAppStore.getState().setProjectsAvailable(false);
    const { container } = render(<ComposerProjectRail />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the placeholder chip when no project is bound", () => {
    render(<ComposerProjectRail />);
    // Empty-state copy is the i18n key 'sessionChipFreeChat' →
    // "对话" / "Free chat" depending on language.
    const chip = screen.getByRole("button", {
      name: /Project binding is optional|项目绑定是可选的|Free chat|对话/,
    });
    expect(chip).toBeInTheDocument();
  });
});

describe("ComposerProjectRail — project picker", () => {
  it("toggles the popover open / closed on chip click", () => {
    render(<ComposerProjectRail />);
    const chip = screen.getByRole("button", { name: /Free chat|对话|Project binding is optional|项目绑定是可选的/ });
    fireEvent.click(chip);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(chip);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("popover does NOT contain a 对话 / Free chat row (regression for B.1)", () => {
    render(<ComposerProjectRail />);
    fireEvent.click(screen.getByRole("button", { name: /Free chat|对话|Project binding is optional|项目绑定是可选的/ }));
    const menu = screen.getByRole("menu");
    // Free chat is NOT a project — listing it as a row was redundant.
    // Only project rows + the create-new row should be present.
    const rows = within(menu).getAllByRole("button");
    const labels = rows.map((r) => r.textContent ?? "");
    for (const l of labels) {
      expect(l).not.toBe("对话");
      expect(l).not.toBe("Free chat");
    }
  });

  it("popover contains a + 新建项目 / + New project row at the bottom (regression for B.2)", () => {
    render(<ComposerProjectRail />);
    fireEvent.click(screen.getByRole("button", { name: /Free chat|对话|Project binding is optional|项目绑定是可选的/ }));
    const menu = screen.getByRole("menu");
    const rows = within(menu).getAllByRole("button");
    const last = rows[rows.length - 1];
    expect(last.textContent).toMatch(/新建项目|New project/);
  });

  it("clicking a project row sets draftProjectId + closes the popover", () => {
    render(<ComposerProjectRail />);
    fireEvent.click(screen.getByRole("button", { name: /Free chat|对话|Project binding is optional|项目绑定是可选的/ }));
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    // Popover closes
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    // Store updated
    expect(useAppStore.getState().draftProjectId).toBe("proj-a");
  });

  it("+ 新建项目 click opens the shared ProjectCreatePanel", () => {
    render(<ComposerProjectRail />);
    fireEvent.click(screen.getByRole("button", { name: /Free chat|对话|Project binding is optional|项目绑定是可选的/ }));
    fireEvent.click(screen.getByRole("button", { name: /新建项目|New project/ }));
    expect(screen.getByTestId("project-create-panel")).toBeInTheDocument();
  });
});

describe("ComposerProjectRail — bound project state", () => {
  beforeEach(() => {
    useAppStore.getState().setDraftProjectId("proj-a");
  });

  it("renders one folder chip per project workspace", () => {
    render(<ComposerProjectRail />);
    // Two workspaces on PROJ_A → two folder chips. We match on the
    // composer-folder-chip class because folder names appear inside
    // multiple buttons and a name-based getByRole match is brittle.
    const chips = document.querySelectorAll(".composer-folder-chip");
    expect(chips.length).toBe(2);
  });

  it("clicking a folder chip pins it as the active workspace (draft)", () => {
    render(<ComposerProjectRail />);
    const chips = document.querySelectorAll(".composer-folder-chip");
    fireEvent.click(chips[0]);
    expect(useAppStore.getState().draftWorkspacePath).toBe(
      "/Users/x/code/alpha",
    );
  });

  it("clear (✕) button on the project chip drops the draft binding", () => {
    render(<ComposerProjectRail />);
    fireEvent.click(screen.getByRole("button", { name: "Clear project" }));
    expect(useAppStore.getState().draftProjectId).toBeNull();
  });
});
