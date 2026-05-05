// Behavioural tests for `AddFolderDialog` — the modal triggered by
// the "+" chip in `ComposerProjectRail`. Covers the new Browse
// button (Phase C.3) plus the existing validation / dedup paths.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddFolderDialog } from "./AddFolderDialog";
import type { Project } from "../../types/frames";

// `findWorkspaceByName` is the network call we need to control to
// assert browse behaviour. `probeWorkspace` and `updateProject` are
// stubbed only as much as needed for the validation paths.
vi.mock("../../services/workspace", () => ({
  findWorkspaceByName: vi.fn(),
  probeWorkspace: vi.fn(),
}));

vi.mock("../../services/projects", () => ({
  updateProject: vi.fn(),
}));

import {
  findWorkspaceByName,
  probeWorkspace,
} from "../../services/workspace";
import { updateProject } from "../../services/projects";

const PROJ: Project = {
  id: "proj-x",
  slug: "x",
  name: "Project X",
  description: null,
  instructions: "",
  tags: [],
  workspaces: [{ path: "/Users/x/code/already-bound", name: null }],
  archived: false,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  // Each test wires `window.showDirectoryPicker` itself; default is
  // unset so the Browse button is hidden by default.
  delete (window as unknown as { showDirectoryPicker?: unknown })
    .showDirectoryPicker;
  vi.clearAllMocks();
});

afterEach(() => {
  delete (window as unknown as { showDirectoryPicker?: unknown })
    .showDirectoryPicker;
});

describe("AddFolderDialog — validation", () => {
  it("submitting an empty path shows an error", async () => {
    render(
      <AddFolderDialog
        project={PROJ}
        open={true}
        onClose={vi.fn()}
        onAdded={vi.fn()}
      />,
    );
    // The Add button is disabled with empty path; submit via the form
    // directly to bypass the disabled gate and exercise the handler.
    const form = document.querySelector(".add-folder-modal") as HTMLFormElement;
    fireEvent.submit(form);
    await waitFor(() => {
      expect(screen.getByText(/Path is required/i)).toBeInTheDocument();
    });
  });

  it("submitting a path that's already in the project shows 'already added'", async () => {
    // probeWorkspace canonicalises the input — return the already-bound
    // path so the dialog's dedup check fires.
    (
      probeWorkspace as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      root: "/Users/x/code/already-bound",
      vcs: "git",
      branch: "main",
      dirty: false,
    });
    render(
      <AddFolderDialog
        project={PROJ}
        open={true}
        onClose={vi.fn()}
        onAdded={vi.fn()}
      />,
    );
    const input = screen.getByPlaceholderText(/absolute\/path|~\/code\/proj/i);
    fireEvent.change(input, {
      target: { value: "/Users/x/code/already-bound" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Add$/ }));
    await waitFor(() => {
      expect(
        screen.getByText(/already in this project/i),
      ).toBeInTheDocument();
    });
    // Project mustn't be touched in this case.
    expect(updateProject).not.toHaveBeenCalled();
  });
});

describe("AddFolderDialog — Browse button", () => {
  it("Browse button is hidden when window.showDirectoryPicker is undefined", () => {
    render(
      <AddFolderDialog
        project={PROJ}
        open={true}
        onClose={vi.fn()}
        onAdded={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Browse|浏览/ }),
    ).not.toBeInTheDocument();
  });

  it("Browse → 1 candidate → input auto-fills", async () => {
    // Mock the OS picker to resolve with a fake handle.
    (window as unknown as { showDirectoryPicker: () => Promise<{ name: string }> }).showDirectoryPicker = () =>
      Promise.resolve({ name: "svelte-learn" });
    (
      findWorkspaceByName as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(["/Users/x/code/svelte-learn"]);

    render(
      <AddFolderDialog
        project={PROJ}
        open={true}
        onClose={vi.fn()}
        onAdded={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Browse|浏览/ }));
    await waitFor(() => {
      const input = screen.getByPlaceholderText(
        /absolute\/path|~\/code\/proj/i,
      );
      expect((input as HTMLInputElement).value).toBe(
        "/Users/x/code/svelte-learn",
      );
    });
  });

  it("Browse → 2 candidates → disambiguation list renders", async () => {
    (window as unknown as { showDirectoryPicker: () => Promise<{ name: string }> }).showDirectoryPicker = () =>
      Promise.resolve({ name: "Jarvis" });
    (
      findWorkspaceByName as unknown as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce([
      "/Users/x/Documents/GitHub/Jarvis",
      "/Users/x/code/Jarvis",
    ]);

    render(
      <AddFolderDialog
        project={PROJ}
        open={true}
        onClose={vi.fn()}
        onAdded={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Browse|浏览/ }));
    // Both candidate paths render as `<code>` rows inside the inline
    // list; assert both are in the DOM.
    await waitFor(() => {
      expect(
        screen.getByText("/Users/x/Documents/GitHub/Jarvis"),
      ).toBeInTheDocument();
      expect(screen.getByText("/Users/x/code/Jarvis")).toBeInTheDocument();
    });
  });
});
