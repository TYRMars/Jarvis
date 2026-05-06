// Per-turn + per-conversation lifecycle state. Owns the in-flight
// flag (drives the `body.turn-in-flight` class + spinner footer),
// the active conversation id, the loading-convo guard (prevents
// double-resume races), the conversation-list rows, and the right
// rail's tasks entries.

import type { StateCreator } from "zustand";
import type { ConvoListRow } from "../../types/frames";
import type { FullState } from "../appStore";
import type {
  ConversationRunStatus,
  ConversationRuntime,
  ConversationSurfaceSnapshot,
  TaskRailEntry,
} from "../types";

export interface LifecycleSlice {
  /// Mirror of `state.activeId` so React deps work without needing
  /// the version bump trick. Updated by `setActiveId()`.
  activeId: string | null;
  /// Whether a turn is in flight.
  inFlight: boolean;
  /// Timestamp for the current turn's start; null when idle.
  turnStartedAt: number | null;
  /// Mirrors `state.lastConvoRows` for sidebar subscribers.
  convoRows: ConvoListRow[];
  /// Conversation list network refresh state. Used for first-load
  /// skeletons and subtle sidebar refresh affordances.
  convoListLoading: boolean;
  /// Row currently being loaded/resumed from REST + WS.
  loadingConvoId: string | null;
  /// Workspace tasks rail entries. Pushed by `pushToolStart` /
  /// `setToolEnd` in addition to the `toolBlocks` map.
  tasks: TaskRailEntry[];
  /// Per-conversation visible chat surface cache. Lets background
  /// conversation sockets keep receiving frames while another
  /// conversation is selected.
  conversationSurfaces: Record<string, ConversationSurfaceSnapshot>;
  /// Per-conversation run state. `inFlight` remains as a
  /// compatibility mirror for the currently active conversation.
  conversationRuns: Record<string, ConversationRuntime>;

  setActiveId: (id: string | null) => void;
  setInFlight: (v: boolean) => void;
  saveConversationSurface: (id: string) => void;
  restoreConversationSurface: (id: string) => boolean;
  clearConversationSurface: (id: string) => void;
  setConversationRunStatus: (
    id: string,
    status: ConversationRunStatus,
    patch?: Partial<Omit<ConversationRuntime, "conversationId" | "status">>,
  ) => void;
  isConversationRunning: (id: string | null) => boolean;
  setConvoRows: (rows: ConvoListRow[]) => void;
  setConvoListLoading: (v: boolean) => void;
  setLoadingConvoId: (id: string | null) => void;
  upsertTask: (
    entry: Omit<TaskRailEntry, "startedAt" | "updatedAt"> & { startedAt?: number },
  ) => void;
  clearTasks: () => void;
}

export const createLifecycleSlice: StateCreator<FullState, [], [], LifecycleSlice> = (set, get) => ({
  activeId: null,
  inFlight: false,
  turnStartedAt: null,
  convoRows: [],
  convoListLoading: false,
  loadingConvoId: null,
  tasks: [],
  conversationSurfaces: {},
  conversationRuns: {},

  setActiveId: (id) => {
    set((s) => {
      const running = id ? isRunActive(s.conversationRuns[id]?.status) : false;
      document.body.classList.toggle("turn-in-flight", running);
      return {
        activeId: id,
        inFlight: running,
        turnStartedAt: running
          ? (s.conversationRuns[id!]?.startedAt ?? s.turnStartedAt ?? Date.now())
          : null,
      };
    });
  },
  setInFlight: (v) => {
    document.body.classList.toggle("turn-in-flight", !!v);
    set((s) => ({
      inFlight: v,
      turnStartedAt: v ? (s.turnStartedAt ?? Date.now()) : null,
      conversationRuns: s.activeId
        ? {
            ...s.conversationRuns,
            [s.activeId]: makeRuntime(
              s.conversationRuns[s.activeId],
              s.activeId,
              v ? "running" : "idle",
            ),
          }
        : s.conversationRuns,
    }));
  },
  saveConversationSurface: (id) => {
    set((s) => ({
      conversationSurfaces: {
        ...s.conversationSurfaces,
        [id]: captureSurface(s),
      },
    }));
  },
  restoreConversationSurface: (id) => {
    let found = false;
    set((s) => {
      const surface = s.conversationSurfaces[id];
      if (!surface) return s;
      found = true;
      return {
        messages: surface.messages,
        emptyHintIdShort: surface.emptyHintIdShort,
        toolBlocks: surface.toolBlocks,
        approvals: surface.approvals,
        hitls: surface.hitls,
        tasks: surface.tasks,
        plan: surface.plan,
        proposedPlan: surface.proposedPlan,
        subAgentRuns: surface.subAgentRuns,
      };
    });
    return found;
  },
  clearConversationSurface: (id) => {
    set((s) => {
      if (!(id in s.conversationSurfaces)) return s;
      const next = { ...s.conversationSurfaces };
      delete next[id];
      return { conversationSurfaces: next };
    });
  },
  setConversationRunStatus: (id, status, patch = {}) => {
    set((s) => {
      const existing = s.conversationRuns[id];
      const nextRuntime = makeRuntime(existing, id, status, patch);
      const active = s.activeId === id;
      const running = isRunActive(status);
      if (active) document.body.classList.toggle("turn-in-flight", running);
      return {
        conversationRuns: {
          ...s.conversationRuns,
          [id]: nextRuntime,
        },
        ...(active
          ? {
              inFlight: running,
              turnStartedAt: running
                ? (s.turnStartedAt ?? nextRuntime.startedAt ?? Date.now())
                : null,
            }
          : {}),
      };
    });
  },
  isConversationRunning: (id) => {
    if (!id) return false;
    return isRunActive(get().conversationRuns[id]?.status);
  },
  setConvoRows: (rows) =>
    set((s) => {
      const activeRow = s.activeId
        ? rows.find((r) => r.id === s.activeId)
        : null;
      if (!activeRow) return { convoRows: rows, convoListLoading: false };
      const projectId = activeRow.project_id ?? null;
      const workspacePath =
        activeRow.workspace_path ??
        (projectId ? s.projectsById[projectId]?.workspaces?.[0]?.path ?? null : null);
      const workspaceChanged = workspacePath !== s.socketWorkspace;
      return {
        convoRows: rows,
        convoListLoading: false,
        draftProjectId: projectId,
        socketWorkspace: workspacePath,
        socketWorkspaceInfo: null,
        draftWorkspacePath: workspacePath,
        draftWorkspaceInfo: null,
        ...(workspaceChanged
          ? { workspaceDiff: null, workspaceDiffFileCache: {} }
          : {}),
      };
    }),
  setConvoListLoading: (v) => set({ convoListLoading: v }),
  setLoadingConvoId: (id) => set({ loadingConvoId: id }),

  upsertTask: (entry) => {
    set((s) => {
      const now = Date.now();
      const existing = s.tasks.find((t) => t.id === entry.id);
      let next: TaskRailEntry[];
      if (existing) {
        next = s.tasks.map((t) =>
          t.id === entry.id
            ? {
                ...t,
                name: entry.name || t.name,
                args: entry.args ?? t.args,
                status: entry.status,
                updatedAt: now,
              }
            : t,
        );
      } else {
        next = [
          { ...entry, startedAt: entry.startedAt ?? now, updatedAt: now },
          ...s.tasks,
        ].slice(0, 12);
      }
      return { tasks: next };
    });
  },
  clearTasks: () => set({ tasks: [] }),
});

function isRunActive(status: ConversationRunStatus | undefined): boolean {
  return status === "running" || status === "waiting_approval" || status === "waiting_hitl";
}

function makeRuntime(
  existing: ConversationRuntime | undefined,
  conversationId: string,
  status: ConversationRunStatus,
  patch: Partial<Omit<ConversationRuntime, "conversationId" | "status">> = {},
): ConversationRuntime {
  const now = Date.now();
  const active = isRunActive(status);
  return {
    conversationId,
    status,
    startedAt: patch.startedAt ?? existing?.startedAt ?? (active ? now : null),
    updatedAt: patch.updatedAt ?? now,
    currentTool: patch.currentTool ?? (active ? existing?.currentTool ?? null : null),
    lastError: patch.lastError ?? (status === "failed" ? existing?.lastError ?? null : null),
  };
}

function captureSurface(s: FullState): ConversationSurfaceSnapshot {
  return {
    messages: s.messages,
    emptyHintIdShort: s.emptyHintIdShort,
    toolBlocks: s.toolBlocks,
    approvals: s.approvals,
    hitls: s.hitls,
    tasks: s.tasks,
    plan: s.plan,
    proposedPlan: s.proposedPlan,
    subAgentRuns: s.subAgentRuns,
  };
}
