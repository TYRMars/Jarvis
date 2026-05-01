// Central application store. Single source of truth for everything
// React renders + everything the service layer dispatches into.
//
// The state is partitioned into per-domain *slices* under
// `./slices/`. Each slice exports a `<Domain>Slice` interface
// describing its state + actions, and a `create<Domain>Slice`
// `StateCreator` whose `set` / `get` are typed against `FullState`
// (the intersection of all slice interfaces). Cross-slice writes
// are intentional and atomic — Zustand's unified `set` makes them a
// single render — so e.g. `clearMessages` (chatSlice) can reset
// `toolBlocks` (toolSlice) and `plan` (planSlice) in one shot.
//
// Persistence (localStorage round-trip for theme / lang / pinned
// conversations / per-convo routing / etc.) lives in
// `./persistence`; each slice seeds itself from `loadX()` helpers
// at construction and calls `saveX()` from inside the matching
// action whenever the slice changes.

import { create } from "zustand";

import { createApprovalSlice, type ApprovalSlice } from "./slices/approvalSlice";
import { createChatSlice, type ChatSlice } from "./slices/chatSlice";
import { createCoreSlice, type CoreSlice } from "./slices/coreSlice";
import { createHitlSlice, type HitlSlice } from "./slices/hitlSlice";
import { createLifecycleSlice, type LifecycleSlice } from "./slices/lifecycleSlice";
import { createPlanSlice, type PlanSlice } from "./slices/planSlice";
import { createToolSlice, type ToolSlice } from "./slices/toolSlice";

/// Full unified store shape. Every slice's `StateCreator` is typed
/// against this so cross-slice writes type-check. Consumers keep
/// using `useAppStore(s => s.messages)` etc. — slice boundaries are
/// purely an internal organisation concern.
export type FullState = ChatSlice
  & ToolSlice
  & ApprovalSlice
  & HitlSlice
  & PlanSlice
  & LifecycleSlice
  & CoreSlice;

export const useAppStore = create<FullState>()((...a) => ({
  ...createChatSlice(...a),
  ...createToolSlice(...a),
  ...createApprovalSlice(...a),
  ...createHitlSlice(...a),
  ...createPlanSlice(...a),
  ...createLifecycleSlice(...a),
  ...createCoreSlice(...a),
}));

/// Non-React imperative call sites can grab the store handle and
/// dispatch actions without going through a hook. The legacy modules
/// use this; React components should use `useAppStore` instead.
export const appStore = useAppStore;

// ---- Type re-exports for callers that imported them from this
// ---- module before the slice split. Keep the import path stable.
export type {
  ApprovalCardState,
  ConvoStatusKind,
  EffortLevel,
  HitlCardState,
  PastedBlobs,
  PlanItem,
  ProviderInfo,
  TaskRailEntry,
  TodoItem,
  ToolBlockEntry,
  UiMessage,
  UsageSnapshot,
} from "./types";
