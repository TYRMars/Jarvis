// Per-turn + per-conversation lifecycle state. Owns the in-flight
// flag (drives the `body.turn-in-flight` class + spinner footer),
// the active conversation id, the loading-convo guard (prevents
// double-resume races), the conversation-list rows, and the right
// rail's tasks entries.

import type { StateCreator } from "zustand";
import type { ConvoListRow } from "../../types/frames";
import type { FullState } from "../appStore";
import type { TaskRailEntry } from "../types";

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

  setActiveId: (id: string | null) => void;
  setInFlight: (v: boolean) => void;
  setConvoRows: (rows: ConvoListRow[]) => void;
  setConvoListLoading: (v: boolean) => void;
  setLoadingConvoId: (id: string | null) => void;
  upsertTask: (
    entry: Omit<TaskRailEntry, "startedAt" | "updatedAt"> & { startedAt?: number },
  ) => void;
  clearTasks: () => void;
}

export const createLifecycleSlice: StateCreator<FullState, [], [], LifecycleSlice> = (set) => ({
  activeId: null,
  inFlight: false,
  turnStartedAt: null,
  convoRows: [],
  convoListLoading: false,
  loadingConvoId: null,
  tasks: [],

  setActiveId: (id) => set({ activeId: id }),
  setInFlight: (v) => {
    document.body.classList.toggle("turn-in-flight", !!v);
    set((s) => ({
      inFlight: v,
      turnStartedAt: v ? (s.turnStartedAt ?? Date.now()) : null,
    }));
  },
  setConvoRows: (rows) => set({ convoRows: rows, convoListLoading: false }),
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
