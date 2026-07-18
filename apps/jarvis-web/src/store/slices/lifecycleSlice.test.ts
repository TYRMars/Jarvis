// Tests for the convo-list refresh path (`setConvoRows`). Validates that a
// same-workspace refresh preserves the fetched WorkspaceInfo and draft
// bindings for the active conversation (regression for the branch-chip
// blank + refetch flicker on every convo-list refresh), while a genuine
// workspace change still resets the workspace-derived caches.

import { describe, expect, it, beforeEach } from "vitest";
import { useAppStore } from "../appStore";
import type { WorkspaceInfo } from "../../services/workspace";
import type { ConvoListRow } from "../../types/frames";

const WS = "/home/user/proj";
const INFO: WorkspaceInfo = {
  root: WS,
  vcs: "git",
  branch: "feature/x",
  head: "abc123",
  dirty: true,
};

function row(id: string, workspace_path: string | null): ConvoListRow {
  return {
    id,
    title: "t",
    message_count: 1,
    created_at: "2026-04-26T00:00:00Z",
    updated_at: "2026-04-26T00:00:00Z",
    ...(workspace_path ? { workspace_path } : {}),
  };
}

beforeEach(() => {
  useAppStore.setState({
    activeId: "active-1",
    socketWorkspace: WS,
    socketWorkspaceInfo: INFO,
    draftWorkspaceInfo: INFO,
    draftWorkspacePath: WS,
    workspaceDiff: null,
    workspaceDiffFileCache: {},
  });
});

describe("lifecycleSlice.setConvoRows", () => {
  it("preserves WorkspaceInfo + drafts when the active workspace is unchanged", () => {
    useAppStore.getState().setConvoRows([row("active-1", WS)]);
    const s = useAppStore.getState();
    expect(s.socketWorkspaceInfo).toEqual(INFO);
    expect(s.draftWorkspaceInfo).toEqual(INFO);
    expect(s.draftWorkspacePath).toBe(WS);
    expect(s.convoRows).toHaveLength(1);
  });

  it("resets workspace-derived caches when the active workspace changes", () => {
    const NEXT = "/home/user/other";
    useAppStore.getState().setConvoRows([row("active-1", NEXT)]);
    const s = useAppStore.getState();
    expect(s.socketWorkspace).toBe(NEXT);
    expect(s.socketWorkspaceInfo).toBeNull();
    expect(s.draftWorkspaceInfo).toBeNull();
    expect(s.draftWorkspacePath).toBe(NEXT);
  });
});
