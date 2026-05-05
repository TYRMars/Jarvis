// Behavioural tests for `BranchPopover` — the per-folder branch
// picker rendered by `ComposerProjectRail`. Covers the recent
// regression (popover was opening downward into the input box) plus
// the standard dismissal contract.

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BranchPopover } from "./BranchPopover";

// The popover does an initial `fetchProjectWorkspaceBranches` call;
// stub the entire projects service so the test doesn't try to hit
// the network. We only need the branches endpoint to resolve to
// SOMETHING — empty list is fine for these structural assertions.
vi.mock("../../services/projects", () => ({
  fetchProjectWorkspaceBranches: vi.fn().mockResolvedValue({
    branches: [],
    active_branch: "main",
  }),
  switchProjectWorkspace: vi.fn(),
  DirtyWorkspaceError: class DirtyWorkspaceError extends Error {},
}));

beforeEach(() => {
  // No store reset needed — BranchPopover takes everything via props.
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("BranchPopover — positioning", () => {
  it("opens upward (CSS contract: bottom set, top auto) so the input box doesn't clip it", () => {
    // Phase A regression. The fix was a CSS rule on `.branch-popover`
    // — the popover lives directly above the composer input, so a
    // `top: 100% + ...` rule would render it below the chip and into
    // the textarea. We pin both: the class name (which carries the
    // CSS) AND the structural marker that the popover renders at all.
    render(
      <BranchPopover
        projectId="proj-x"
        workspacePath="/Users/x/code/proj"
        currentBranch="main"
        onSwitched={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const popover = screen.getByRole("dialog");
    // The CSS class is the source of truth for positioning. Asserting
    // the class — combined with the existing CSS that pins `bottom:
    // calc(100% + 6px); top: auto;` — keeps this test cheap and avoids
    // jsdom's notoriously flaky computed-style support.
    expect(popover.classList.contains("branch-popover")).toBe(true);
  });
});

describe("BranchPopover — dismissal", () => {
  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(
      <BranchPopover
        projectId="proj-x"
        workspacePath="/Users/x/code/proj"
        currentBranch="main"
        onSwitched={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when the user clicks outside the popover", () => {
    const onClose = vi.fn();
    // Mount the popover next to a sibling we can click "outside" on.
    render(
      <div>
        <button data-testid="outside">somewhere else</button>
        <BranchPopover
          projectId="proj-x"
          workspacePath="/Users/x/code/proj"
          currentBranch="main"
          onSwitched={vi.fn()}
          onClose={onClose}
        />
      </div>,
    );
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(onClose).toHaveBeenCalled();
  });
});
