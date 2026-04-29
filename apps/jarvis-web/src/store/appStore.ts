// Central application store. Single source of truth for everything
// React renders + everything the service layer dispatches into.
// Persistence (localStorage round-trip for theme / lang / pinned
// conversations / per-convo routing / etc.) lives in
// `./persistence`; the store seeds itself from `loadX()` helpers
// at construction and calls the `saveX()` helpers from inside the
// matching action whenever the slice changes.

import { create } from "zustand";
import {
  loadConvoRouting,
  loadPinned,
  loadTitleOverrides,
  initialEffort,
  initialLang,
  initialPlanCardOpen,
  initialSidebarOpen,
  initialTheme,
  initialWorkspacePanel,
  initialWorkspaceRailOpen,
  safeSet,
  savePinned,
  saveTitleOverrides,
  saveConvoRouting,
} from "./persistence";
import type {
  AnyMessage,
  ConnectionStatus,
  ConvoListRow,
  HitlRequest,
  HitlResponse,
  Project,
  ToolCall,
} from "../types/frames";

/// Status of the conversation list panel. Drives an empty-state
/// banner the sidebar renders in place of the recent rows.
export type ConvoStatusKind = "" | "empty" | "noMatches" | "disabled";

/// One row in the workspace tasks rail. Mirrors enough of
/// `ToolBlockEntry` to render the card without re-walking the chat
/// history; `updatedAt` powers ordering and recency hints.
export interface TaskRailEntry {
  id: string;
  name: string;
  args: any;
  status: "running" | "ok" | "error" | "denied";
  startedAt: number;
  updatedAt: number;
}

/// One step in the agent's working plan. Shape mirrors
/// `harness_core::PlanItem` (snake_case wire format → camelCase note
/// is identical here since `note` matches both). The plan card
/// renders these as a checklist; each `plan_update` event replaces
/// the whole array (typed snapshot, not patch).
export interface PlanItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  note?: string | null;
}

/// Provider description served by `GET /v1/providers`. The model
/// menu groups options under provider, surfaces the default model
/// first, and marks one provider as `is_default` so we can
/// pre-select on first connect.
export interface ProviderInfo {
  name: string;
  default_model: string;
  models: string[];
  is_default: boolean;
}

/// Effort levels surfaced in the model menu's right column. Names
/// match the legacy enum so `state.effort` round-trips through
/// localStorage unchanged.
export type EffortLevel = "low" | "medium" | "high" | "extra-high" | "max";

interface UsageSnapshot {
  prompt: number;
  completion: number;
  cached: number;
  reasoning: number;
  calls: number;
}

/// Single chat-area entry the React `<MessageList>` renders. Order
/// matches insertion: history items load via `loadHistory`, live
/// items append as frames arrive. `assistant` entries carry an
/// ordered list of associated `toolCallIds` so each tool block can
/// render right under the assistant turn that triggered it.
export type UiMessage =
  | { uid: string; kind: "system"; content: string }
  | { uid: string; kind: "user"; content: string; userOrdinal: number }
  | {
      uid: string;
      kind: "assistant";
      content: string;
      reasoning: string;
      toolCallIds: string[];
      finalised: boolean;
    }
  | { uid: string; kind: "system_hint"; idShort: string };

function isAskToolName(name: string | undefined): boolean {
  return typeof name === "string" && name.startsWith("ask.");
}

/// One imperative tool invocation. Lives in a flat map keyed by id;
/// the `<AssistantBubble>` looks them up by the ids it owns.
///
/// `progress` accumulates streaming chunks pushed by
/// `AgentEvent::ToolProgress` (only emitted by tools that opted in,
/// e.g. `shell.exec` line-by-line). Cleared when `output` is set so
/// the final result the model saw is what the UI shows.
export interface ToolBlockEntry {
  id: string;
  name: string;
  args: any;
  status: "running" | "ok" | "error" | "denied";
  output: string | null;
  progress: string;
  /// Where the approval decision came from. Set by the
  /// `approval_decision` frame handler when the server attaches
  /// a `source` field. `null` means the tool didn't go through
  /// the approval gate (read-only tools), or the server didn't
  /// supply a source (older builds without the permission store).
  decisionSource: import("../types/frames").ApprovalSource | null;
  /// Wall-clock millis at `tool_start`. Used by `<ToolBlock>` to
  /// render an execution-duration chip alongside the result, so
  /// users can spot a slow `code.grep` / `shell.exec` without
  /// reading raw logs. Synthesised at `loadHistory` time for
  /// historical entries (no real timestamp persisted).
  startedAt: number;
  /// Wall-clock millis at `tool_end`; null while running.
  finishedAt: number | null;
}

/// Pending or resolved approval card in the right rail.
export interface ApprovalCardState {
  id: string;
  name: string;
  arguments: any;
  status: "pending" | "approved" | "denied";
  reason: string | null;
}

/// Pending or resolved native HITL card in the right rail.
export interface HitlCardState {
  request: HitlRequest;
  status: "pending" | HitlResponse["status"];
  payload?: any;
  reason: string | null;
}

/// Composer paste-blob map. The key is a short hex token; the value
/// is the original (potentially huge) text the user pasted. The
/// composer textarea shows `[Pasted N KB] #<token>` placeholders
/// instead, and `expandPastedPlaceholders` substitutes them back at
/// submit time.
export type PastedBlobs = Record<string, string>;

interface AppStoreState {
  /// Monotonic version bump; subscribers re-read selectors when this
  /// changes. Used by the few non-React surfaces that want a coarse
  /// "anything changed?" trigger.
  version: number;
  /// WS connection status. Transitions go through here so React
  /// subscribers (`<ConnectionStatus>`) re-render on open/close.
  connection: ConnectionStatus;
  statusKey: string | null;
  statusClass: string | null;
  /// Number of consecutive failed reconnect attempts. Bumped by the
  /// socket layer's backoff loop, reset to 0 on a successful open.
  /// Used by `<ConnectionStatus>` to render "reconnecting (N)…".
  reconnectAttempt: number;
  bannerError: string | null;
  /// Per-turn token usage. Mirrored from the imperative usage module
  /// via `setUsage()`; React `<UsageBadge>` reads this.
  usage: UsageSnapshot;
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
  /// Chat-area entries in insertion order. Empty array → React
  /// renders the welcome/empty-conv-hint card instead.
  messages: UiMessage[];
  /// Optional empty-conversation hint (id-prefix shown after a
  /// fresh `new`). Cleared once a real message lands.
  emptyHintIdShort: string | null;
  /// Flat tool-block map. Assistant messages reference entries by id.
  toolBlocks: Record<string, ToolBlockEntry>;
  /// Pending / resolved approval cards rendered in the right rail.
  /// Order = arrival order; React renders newest at the bottom of
  /// the list.
  approvals: ApprovalCardState[];
  /// Native `ask.*` requests rendered beside approval cards.
  hitls: HitlCardState[];
  /// Composer textarea value (controlled by React). The legacy
  /// imperative composer used to read straight from the DOM; the
  /// React `<Composer>` uses this as its sole source of truth.
  composerValue: string;
  /// Pasted-blob sidecar for the composer. See `PastedBlobs`.
  pastedBlobs: PastedBlobs;

  // ---- Workspace rail / panel toggles ----
  /// Whether the left-hand sidebar (conversation list + nav) is open.
  /// Drives `body.sidebar-closed`. Persisted to localStorage.
  sidebarOpen: boolean;
  /// Whether the right-hand workspace rail is open at all. Drives
  /// `body.workspace-rail-closed`. When false, NO panels render
  /// regardless of their individual visibility flags.
  /// Persisted to localStorage.
  workspaceRailOpen: boolean;
  /// Legacy plan-card-open switch — kept for one release while
  /// downstream callers migrate to `workspacePanelVisible.plan`.
  /// New code should NOT read this directly.
  planCardOpen: boolean;
  /// Per-panel visibility within the workspace rail. Each panel
  /// is independently togglable from the panel-selector dropdown
  /// (Claude Code style). Defaults: diff + tasks visible, plan +
  /// changeReport hidden. Persisted per key as `jarvis.panel.<key>`.
  workspacePanelVisible: Record<import("./persistence").WorkspacePanelKey, boolean>;
  /// Workspace "panel" dropdown menu open/closed state. Transient.
  workspacePanelMenuOpen: boolean;
  /// Account chip dropdown (theme + language switcher). Transient.
  accountMenuOpen: boolean;
  // ---- Settings (theme + language) ----
  /// Active theme; applied to `<html data-theme="…">` by the
  /// `setTheme` action. Persisted to localStorage.
  theme: "light" | "dark";
  /// Active locale. The `t()` helper still reads through
  /// `legacy/state.lang` for legacy parity, but components subscribe
  /// here so they re-render when the user toggles the switch.
  lang: "en" | "zh";

  // ---- Model picker ----
  /// Provider catalog from `/v1/providers`. Empty until the boot
  /// fetch resolves; the menu renders an "Server default" placeholder
  /// while that's outstanding.
  providers: ProviderInfo[];
  /// Current routing in `"<provider>|<model>"` form. Empty string
  /// means "let the server pick its own default" — a real value
  /// (even one matching the server default) is sent on every send/
  /// resume frame.
  routing: string;
  /// Effort level surfaced in the model menu's right column. Persisted
  /// to localStorage by `setEffort`.
  effort: EffortLevel;
  /// Whether the model dropdown is currently open. Drives both the
  /// `<ModelMenu>` visibility and the `aria-expanded` on its trigger.
  modelMenuOpen: boolean;

  /// Quick switcher (Cmd+P) open state. Mounted/unmounted off this
  /// flag; when closed the modal is unmounted entirely so its
  /// keydown handlers can't fire.
  quickOpen: boolean;
  /// Workspace tasks rail entries. Pushed by `pushToolStart` /
  /// `setToolEnd` in addition to the `toolBlocks` map.
  tasks: TaskRailEntry[];
  /// Latest agent plan snapshot. Replaced wholesale on every
  /// `plan_update` event; cleared on `reset`. Empty array means
  /// "no plan yet" — the rail's empty-state UI handles that.
  plan: PlanItem[];

  // ---- Sidebar / conversation list ----
  /// Pinned conversation ids. Persisted to localStorage by
  /// `togglePin`; the React sidebar subscribes to this for the pin
  /// star state and the recents/pinned partition.
  pinned: Set<string>;
  /// Per-conversation title overrides (user-renamed). Falls back to
  /// the server-derived title when absent.
  titleOverrides: Record<string, string>;
  /// Per-conversation `"<provider>|<model>"` routing. Replayed on
  /// resume so switching to a chat that started on Anthropic doesn't
  /// silently flip you to the global current selection.
  convoRouting: Record<string, string>;
  /// Empty-state hint kind for the recents column.
  convoStatus: ConvoStatusKind;
  /// `false` means the server reported a 503 from the conversation
  /// CRUD routes — we hide the New button and show the "persistence
  /// disabled" banner.
  persistEnabled: boolean;

  // ---- Projects ----
  /// `false` means the server has no `ProjectStore` configured (503
  /// from `/v1/projects`). The whole project UI hides itself in that
  /// case — the "new conversation" button reverts to its bare form.
  projectsAvailable: boolean;
  /// Newest-updated-first list of (non-archived by default) projects.
  /// Maintained by `services/projects.ts::refreshProjects`.
  projects: Project[];
  /// O(1) lookup keyed by `Project.id`. Used by `<ConvoRow>` to
  /// render a project chip without iterating `projects`.
  projectsById: Record<string, Project>;
  /// Sidebar conversation-list filter. When set, `refreshConvoList`
  /// passes `?project_id=X` and the rail header shows a chip the user
  /// can click to clear.
  activeProjectFilter: string | null;

  // ---- Deep search ----
}

interface AppStoreActions {
  markStateChanged: () => void;
  setConnection: (status: ConnectionStatus) => void;
  setStatus: (key: string | null, cls?: string | null) => void;
  setReconnectAttempt: (n: number) => void;
  showBanner: (msg: string | null) => void;
  setUsage: (u: UsageSnapshot) => void;
  setActiveId: (id: string | null) => void;
  setInFlight: (v: boolean) => void;
  setConvoRows: (rows: ConvoListRow[]) => void;
  setConvoListLoading: (v: boolean) => void;
  setLoadingConvoId: (id: string | null) => void;
  // ---- Chat-area surface ----
  clearMessages: () => void;
  showEmptyHint: (idShort: string) => void;
  /// Append a synthetic system message (e.g. the `/help` overlay).
  /// Renders as a `system` `<UiMessage>` in the chat list.
  pushSystemMessage: (content: string) => void;
  pushUserMessage: (content: string) => string;
  startAssistant: () => string;
  appendDelta: (text: string) => void;
  finalizeAssistant: (msg: { content?: string | null; reasoning_content?: string | null; tool_calls?: ToolCall[] }) => void;
  /// Replace the entire visible message list with the server's
  /// snapshot for a conversation (called by `resumeConversation`).
  loadHistory: (messages: AnyMessage[]) => void;
  /// Tool-call lifecycle. The assistant message that triggered the
  /// call is whatever entry is currently last in the list.
  pushToolStart: (id: string, name: string, args: any) => void;
  /// Streaming chunk from a still-running tool. Appended to
  /// `toolBlocks[id].progress` so `<ToolBlock>` re-renders with the
  /// growing output.
  appendToolProgress: (id: string, stream: string, chunk: string) => void;
  setToolEnd: (id: string, content: string) => void;
  /// `forked` echo from the server: drop everything from the
  /// matching user ordinal forward (in-place truncate).
  applyForked: (userOrdinal: number) => void;
  // ---- Approvals ----
  pushApprovalRequest: (id: string, name: string, args: any) => void;
  setApprovalDecision: (
    id: string,
    decision: "approve" | "deny",
    reason?: string | null,
    source?: import("../types/frames").ApprovalSource | null,
  ) => void;
  /// Mark every still-pending approval as denied. Called when a turn
  /// terminates so stale cards don't tempt the user into a click that
  /// would error with "no pending approval" against the now-cleared
  /// server-side responder map.
  finalizePendingApprovals: () => void;
  clearApprovals: () => void;
  // ---- Native HITL ----
  pushHitlRequest: (request: HitlRequest) => void;
  setHitlResponse: (response: HitlResponse) => void;
  finalizePendingHitls: () => void;
  clearHitls: () => void;
  // ---- Composer ----
  setComposerValue: (v: string) => void;
  /// Add a paste blob and return its placeholder string. The composer
  /// inserts the placeholder into the textarea at the cursor.
  addPastedBlob: (text: string) => string;
  /// Drop blobs whose placeholder no longer appears in the composer
  /// value. Called on every input event.
  gcPastedBlobs: () => void;
  /// Replace `[Pasted N KB] #abc12345` placeholders in `text` with
  /// the original blobs. Used at submit time.
  expandPastedPlaceholders: (text: string) => string;
  /// Drop all blobs (e.g. after submit).
  clearPastedBlobs: () => void;
  // ---- UI toggles ----
  setSidebarOpen: (open: boolean) => void;
  setWorkspaceRailOpen: (open: boolean) => void;
  setPlanCardOpen: (open: boolean) => void;
  /// Toggle one panel's visibility. Persists per-key. Auto-opens
  /// the rail if it's closed and the user is enabling a panel,
  /// auto-closes the rail if disabling the last visible panel.
  setWorkspacePanelVisible: (
    key: import("./persistence").WorkspacePanelKey,
    open: boolean,
  ) => void;
  setWorkspacePanelMenuOpen: (open: boolean) => void;
  setAccountMenuOpen: (open: boolean) => void;
  // ---- Settings ----
  setTheme: (theme: "light" | "dark") => void;
  setLang: (lang: "en" | "zh") => void;
  // ---- Model picker ----
  setProviders: (providers: ProviderInfo[]) => void;
  /// Sets `routing` and persists it on the active conversation (when
  /// one is open) so resume restores the same provider+model.
  setRouting: (value: string) => void;
  setEffort: (value: EffortLevel) => void;
  setModelMenuOpen: (open: boolean) => void;
  // ---- Quick switcher ----
  setQuickOpen: (v: boolean) => void;
  // ---- Tasks rail ----
  upsertTask: (entry: Omit<TaskRailEntry, "startedAt" | "updatedAt"> & { startedAt?: number }) => void;
  clearTasks: () => void;
  /// Replace the plan snapshot. Empty `items` clears the plan.
  setPlan: (items: PlanItem[]) => void;
  // ---- Sidebar ----
  togglePin: (id: string) => void;
  setTitleOverride: (id: string, title: string | null) => void;
  /// Persist `value` (or clear when null) as the pinned routing for
  /// `id`. Skipped if the entry is already what we'd write.
  setConvoRoutingFor: (id: string, value: string | null) => void;
  setConvoStatus: (kind: ConvoStatusKind) => void;
  setPersistEnabled: (v: boolean) => void;

  // ---- Projects ----
  setProjectsAvailable: (v: boolean) => void;
  setProjects: (rows: Project[]) => void;
  /// Insert or update a single project in the cache + the ordered list
  /// (used by create/update/restore so the rail re-renders without a
  /// full refetch).
  upsertProject: (p: Project) => void;
  setActiveProjectFilter: (id: string | null) => void;

  // ---- Permission system ----
  permissionMode: "ask" | "accept-edits" | "plan" | "auto" | "bypass";
  /// Bumped every time the server emits `permission_rules_changed`.
  /// Settings/Permissions section watches this and re-fetches.
  permissionRulesVersion: number;
  /// Plan proposed by the agent (Plan Mode) waiting for user accept.
  /// Cleared when the user accepts or refines.
  proposedPlan: string | null;
  /// Skill names currently active on this WS session. Mirrored from
  /// the server's `skill_activated` / `skill_deactivated` frames so
  /// every component (Settings tab, future header chip) sees the
  /// same source of truth. Empty until the user toggles one.
  activeSkills: string[];
  /// Per-socket workspace override, mirrored from
  /// `workspace_changed`. `null` means "use the binary's startup
  /// root" (whatever `GET /v1/workspace` returns). The chat-header
  /// `WorkspaceBadge` shows this in preference to the server-wide
  /// path so the UI never lies about which folder the agent is
  /// actually targeting.
  socketWorkspace: string | null;
  setPermissionMode: (mode: "ask" | "accept-edits" | "plan" | "auto" | "bypass") => void;
  bumpPermissionRulesVersion?: () => void;
  setProposedPlan: (plan: string | null) => void;
  setActiveSkills?: (names: string[]) => void;
  setSocketWorkspace?: (path: string | null) => void;

  // ---- Workspace diff (right-rail review card) ----
  /// `null` = not fetched yet; `"unavailable"` = server returned 503
  /// (no workspace root pinned; UI hides the card); a `WorkspaceDiff`
  /// = the latest snapshot. Fetching is push-style — the card mounts
  /// and calls `refreshWorkspaceDiff()`.
  workspaceDiff: import("../services/workspaceDiff").WorkspaceDiffState;
  /// True while a refresh is in flight. Drives the spinner on the
  /// refresh button without leaving stale data on screen.
  workspaceDiffLoading: boolean;
  /// Per-file diff cache so re-expanding a row doesn't refetch.
  /// Keyed by `<base>::<path>` to keep the namespace tidy when the
  /// user changes the base. Cleared on every full refresh.
  workspaceDiffFileCache: Record<string, string>;
  setWorkspaceDiff: (
    diff: import("../services/workspaceDiff").WorkspaceDiffState,
  ) => void;
  setWorkspaceDiffLoading: (loading: boolean) => void;
  setWorkspaceDiffFileEntry: (key: string, diff: string) => void;
  clearWorkspaceDiffFileCache: () => void;
}

let uidSeq = 0;
function nextUid(prefix: string): string {
  uidSeq += 1;
  return `${prefix}_${Date.now().toString(36)}_${uidSeq}`;
}

export const useAppStore = create<AppStoreState & AppStoreActions>((set, get) => ({
  version: 0,
  connection: "connecting",
  statusKey: null,
  reconnectAttempt: 0,
  statusClass: null,
  bannerError: null,
  usage: { prompt: 0, completion: 0, cached: 0, reasoning: 0, calls: 0 },
  activeId: null,
  inFlight: false,
  turnStartedAt: null,
  convoRows: [],
  convoListLoading: false,
  loadingConvoId: null,
  messages: [],
  emptyHintIdShort: null,
  toolBlocks: {},
  approvals: [],
  hitls: [],
  composerValue: "",
  pastedBlobs: {},

  sidebarOpen: initialSidebarOpen(),
  workspaceRailOpen: initialWorkspaceRailOpen(),
  planCardOpen: initialPlanCardOpen(),
  workspacePanelVisible: {
    preview: initialWorkspacePanel("preview"),
    diff: initialWorkspacePanel("diff"),
    terminal: initialWorkspacePanel("terminal"),
    files: initialWorkspacePanel("files"),
    tasks: initialWorkspacePanel("tasks"),
    plan: initialWorkspacePanel("plan"),
    changeReport: initialWorkspacePanel("changeReport"),
  },
  workspacePanelMenuOpen: false,
  accountMenuOpen: false,
  theme: initialTheme(),
  lang: initialLang(),
  providers: [],
  routing: "",
  effort: initialEffort() as EffortLevel,
  modelMenuOpen: false,
  quickOpen: false,
  tasks: [],
  plan: [],

  pinned: loadPinned(),
  titleOverrides: loadTitleOverrides(),
  convoRouting: loadConvoRouting(),
  convoStatus: "",
  persistEnabled: true,
  projectsAvailable: true,
  projects: [],
  projectsById: {},
  activeProjectFilter: null,
  permissionMode: "ask",
  permissionRulesVersion: 0,
  proposedPlan: null,
  activeSkills: [],
  socketWorkspace: null,
  workspaceDiff: null,
  workspaceDiffLoading: false,
  workspaceDiffFileCache: {},

  markStateChanged: () => set((s) => ({ version: s.version + 1 })),
  setConnection: (status) => set({ connection: status }),
  setStatus: (statusKey, statusClass = null) => set({ statusKey, statusClass }),
  setReconnectAttempt: (reconnectAttempt) => set({ reconnectAttempt }),
  showBanner: (msg) => set({ bannerError: msg }),
  setUsage: (usage) => set({ usage }),
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

  // ---- Chat-area surface ----

  clearMessages: () =>
    // Reset every per-conversation slice so switching to a fresh /
    // empty thread doesn't leak the previous conversation's tasks
    // rail, plan card, change report, or pending HITL prompts.
    set({
      messages: [],
      emptyHintIdShort: null,
      toolBlocks: {},
      hitls: [],
      tasks: [],
      plan: [],
      proposedPlan: null,
    }),

  showEmptyHint: (idShort) =>
    set({ messages: [], toolBlocks: {}, emptyHintIdShort: idShort }),

  pushSystemMessage: (content) => {
    const uid = nextUid("s");
    set((s) => ({
      messages: [...s.messages, { uid, kind: "system", content }],
      emptyHintIdShort: null,
    }));
  },

  pushUserMessage: (content) => {
    const uid = nextUid("u");
    const userOrdinal = get().messages.filter((m) => m.kind === "user").length;
    set((s) => ({
      messages: [...s.messages, { uid, kind: "user", content, userOrdinal }],
      emptyHintIdShort: null,
    }));
    return uid;
  },

  startAssistant: () => {
    // Reuse a trailing in-flight assistant entry (same turn streaming
    // continues into it); otherwise append a fresh one.
    const tail = get().messages[get().messages.length - 1];
    if (tail && tail.kind === "assistant" && !tail.finalised) return tail.uid;
    const uid = nextUid("a");
    set((s) => ({
      messages: [
        ...s.messages,
        { uid, kind: "assistant", content: "", reasoning: "", toolCallIds: [], finalised: false },
      ],
      emptyHintIdShort: null,
    }));
    return uid;
  },

  appendDelta: (text) => {
    if (!text) return;
    // Ensure an assistant entry exists.
    let msgs = get().messages;
    const tail = msgs[msgs.length - 1];
    if (!tail || tail.kind !== "assistant" || tail.finalised) {
      const uid = nextUid("a");
      msgs = [
        ...msgs,
        { uid, kind: "assistant", content: "", reasoning: "", toolCallIds: [], finalised: false },
      ];
    }
    const lastIdx = msgs.length - 1;
    const last = msgs[lastIdx] as Extract<UiMessage, { kind: "assistant" }>;
    const updated = { ...last, content: last.content + text };
    const next = msgs.slice(0, lastIdx).concat(updated);
    set({ messages: next, emptyHintIdShort: null });
  },

  finalizeAssistant: (msg) => {
    const msgs = get().messages.slice();
    let lastIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].kind === "assistant") { lastIdx = i; break; }
    }
    const trailing = lastIdx >= 0
      ? (msgs[lastIdx] as Extract<UiMessage, { kind: "assistant" }>)
      : null;
    // Append a fresh assistant entry when there isn't one to merge
    // into, OR when the trailing one is already finalised. The
    // already-finalised case fires on multi-iteration turns where
    // iteration N+1 jumps straight to a tool call without any
    // delta text first: without this, `assistant_message` would
    // silently update iteration N's bubble (the previous turn's,
    // visually) and the next `tool_start` would attach this
    // iteration's tool calls to it — exactly the "tool call shows
    // up under the previous assistant message" rendering bug.
    // `appendDelta` already applies the same tail-finalised rule;
    // matching it here keeps the two entry-points symmetric.
    if (!trailing || trailing.finalised) {
      msgs.push({
        uid: nextUid("a"),
        kind: "assistant",
        content: msg.content || "",
        reasoning: msg.reasoning_content || "",
        toolCallIds: [],
        finalised: true,
      });
      set({ messages: msgs });
      return;
    }
    msgs[lastIdx] = {
      ...trailing,
      // Prefer the streamed text — `finalize.message.content` is the
      // server's full version and matches what we accumulated; the
      // OR keeps us safe for tool-call-only turns where content is
      // empty but reasoning may be present.
      content: trailing.content || msg.content || "",
      reasoning: msg.reasoning_content || trailing.reasoning,
      finalised: true,
    };
    set({ messages: msgs });
  },

  loadHistory: (messages) => {
    const out: UiMessage[] = [];
    const tools: Record<string, ToolBlockEntry> = {};
    /// Insertion-ordered list of tool ids as we walk the history.
    /// Used at the end to synthesize the `tasks` rail entries so the
    /// right-rail Tasks / Change Report cards survive a page refresh
    /// or conversation switch — without this, those cards stayed
    /// empty until the *next* live tool call landed.
    const toolOrder: string[] = [];
    let userOrdinal = 0;
    for (const m of messages) {
      if (m.role === "system") {
        continue;
      } else if (m.role === "user") {
        out.push({ uid: nextUid("u"), kind: "user", content: m.content, userOrdinal });
        userOrdinal++;
      } else if (m.role === "assistant") {
        const ids: string[] = [];
        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            if (isAskToolName(tc.name)) continue;
            ids.push(tc.id);
            tools[tc.id] = {
              id: tc.id,
              name: tc.name,
              args: tc.arguments,
              status: "ok",
              output: null,
              progress: "",
              decisionSource: null,
              // Synthetic timestamps for historical entries — the
              // store doesn't persist real durations, so we fill in
              // 0 deltas. The header just hides the duration chip
              // when start === finish.
              startedAt: 0,
              finishedAt: 0,
            };
            toolOrder.push(tc.id);
          }
        }
        if (m.content || m.reasoning_content || ids.length) {
          out.push({
            uid: nextUid("a"),
            kind: "assistant",
            content: m.content || "",
            reasoning: m.reasoning_content || "",
            toolCallIds: ids,
            finalised: true,
          });
        }
      } else if (m.role === "tool") {
        // Splice the tool result into the matching block we just built.
        const block = tools[m.tool_call_id];
        if (block) {
          block.output = m.content;
          if (m.content?.startsWith("tool denied:")) block.status = "denied";
          else if (m.content?.startsWith("tool error:")) block.status = "error";
        }
      }
    }
    // Rebuild the tasks rail from the now-populated tool blocks.
    // Synthesise monotonically-increasing timestamps so a future
    // live tool call landing on top sorts correctly. The
    // history doesn't carry actual tool start/end timestamps —
    // the conversation store persists message JSON, not event
    // metadata — so wall-clock ordering is approximate but
    // good enough for the rail's "what happened in this turn"
    // affordance.
    const baseTs = Date.now() - toolOrder.length;
    const rebuiltTasks: TaskRailEntry[] = toolOrder.map((id, i) => {
      const block = tools[id];
      return {
        id,
        name: block.name,
        args: block.args,
        status: block.status,
        startedAt: baseTs + i,
        updatedAt: baseTs + i,
      };
    });
    set({
      messages: out,
      toolBlocks: tools,
      hitls: [],
      tasks: rebuiltTasks,
      // The plan is per-turn ephemeral — it lives only in agent-loop
      // events (`AgentEvent::PlanUpdate`), never persisted into the
      // conversation store. Restoring a thread starts the plan card
      // empty, same as a fresh `new` would.
      plan: [],
      proposedPlan: null,
      emptyHintIdShort: null,
    });
  },

  pushToolStart: (id, name, args) => {
    set((s) => {
      const msgs = s.messages.slice();
      // Attach to the trailing assistant turn (creating one if the
      // model fired a tool call before any visible text).
      let lastIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].kind === "assistant") { lastIdx = i; break; }
      }
      if (lastIdx < 0) {
        const uid = nextUid("a");
        msgs.push({
          uid,
          kind: "assistant",
          content: "",
          reasoning: "",
          toolCallIds: [id],
          finalised: false,
        });
      } else {
        const cur = msgs[lastIdx] as Extract<UiMessage, { kind: "assistant" }>;
        if (!cur.toolCallIds.includes(id)) {
          msgs[lastIdx] = { ...cur, toolCallIds: [...cur.toolCallIds, id] };
        }
      }
      const tools = {
        ...s.toolBlocks,
        [id]: {
          id,
          name,
          args,
          status: "running" as const,
          output: null,
          progress: "",
          decisionSource: null,
          startedAt: Date.now(),
          finishedAt: null,
        },
      };
      return { messages: msgs, toolBlocks: tools, emptyHintIdShort: null };
    });
  },

  appendToolProgress: (id, _stream, chunk) => {
    set((s) => {
      const block = s.toolBlocks[id];
      if (!block) return s;
      // Streams are interleaved verbatim — `<ToolBlock>` shows the
      // raw scroll-back; the model still gets the formatted summary
      // via `output`. The `_stream` label is currently informational
      // only; future work could colourise stderr.
      return {
        toolBlocks: {
          ...s.toolBlocks,
          [id]: { ...block, progress: block.progress + chunk },
        },
      };
    });
  },

  setToolEnd: (id, content) => {
    set((s) => {
      const block = s.toolBlocks[id];
      if (!block) return s;
      const denied = content.startsWith("tool denied:");
      const failed = content.startsWith("tool error:");
      const status: ToolBlockEntry["status"] = denied ? "denied" : failed ? "error" : "ok";
      return {
        toolBlocks: {
          ...s.toolBlocks,
          [id]: { ...block, status, output: content, finishedAt: Date.now() },
        },
      };
    });
  },

  applyForked: (userOrdinal) => {
    set((s) => {
      // Drop the user message at `userOrdinal` and everything after.
      let cut = -1;
      for (let i = 0; i < s.messages.length; i++) {
        const m = s.messages[i];
        if (m.kind === "user" && m.userOrdinal === userOrdinal) { cut = i; break; }
      }
      if (cut < 0) return s;
      // Compute which tool blocks survive and GC the rest.
      const kept = s.messages.slice(0, cut);
      const survivingIds = new Set<string>();
      for (const m of kept) {
        if (m.kind === "assistant") for (const id of m.toolCallIds) survivingIds.add(id);
      }
      const tools: Record<string, ToolBlockEntry> = {};
      for (const [k, v] of Object.entries(s.toolBlocks)) {
        if (survivingIds.has(k)) tools[k] = v;
      }
      return { messages: kept, toolBlocks: tools };
    });
  },

  // ---- Approvals ----
  pushApprovalRequest: (id, name, args) => {
    set((s) => {
      // Idempotent: a duplicate frame with the same id is a no-op.
      if (s.approvals.some((c) => c.id === id)) return s;
      return {
        approvals: [
          ...s.approvals,
          { id, name, arguments: args, status: "pending", reason: null },
        ],
      };
    });
  },
  setApprovalDecision: (id, decision, reason, source) => {
    set((s) => {
      // Update the approval card (right rail / review dock).
      const approvals = s.approvals.map((c) =>
        c.id === id
          ? {
              ...c,
              status: decision === "approve" ? ("approved" as const) : ("denied" as const),
              reason: reason || null,
            }
          : c,
      );
      // Stamp the source onto the matching tool block so the chat
      // history can render an "auto-approved by user-rule" chip.
      // Only attach when the server actually told us where the
      // decision came from — older builds omit `source`.
      if (source && s.toolBlocks[id]) {
        return {
          approvals,
          toolBlocks: {
            ...s.toolBlocks,
            [id]: { ...s.toolBlocks[id], decisionSource: source },
          },
        };
      }
      return { approvals };
    });
  },
  /// Mark any still-pending approval cards as denied. Called when the
  /// agent emits `done` / `error` / `interrupted` — the server has
  /// cleared its `pending` responder map at that point, so a late
  /// click would error with "no pending approval". Reflecting the
  /// fact UI-side stops the user from trying.
  finalizePendingApprovals: () => {
    set((s) => ({
      approvals: s.approvals.map((c) =>
        c.status === "pending"
          ? { ...c, status: "denied", reason: c.reason ?? "(turn ended)" }
          : c,
      ),
    }));
  },
  clearApprovals: () => set({ approvals: [] }),

  // ---- Native HITL ----
  pushHitlRequest: (request) => {
    set((s) => {
      if (s.hitls.some((c) => c.request.id === request.id)) return s;
      return {
        hitls: [...s.hitls, { request, status: "pending", reason: null }],
        emptyHintIdShort: null,
      };
    });
  },
  setHitlResponse: (response) => {
    set((s) => ({
      hitls: s.hitls.map((c) =>
        c.request.id === response.request_id
          ? {
              ...c,
              status: response.status,
              payload: response.payload,
              reason: response.reason || null,
            }
          : c,
      ),
    }));
  },
  finalizePendingHitls: () => {
    set((s) => ({
      hitls: s.hitls.map((c) =>
        c.status === "pending"
          ? { ...c, status: "cancelled", reason: c.reason ?? "(turn ended)" }
          : c,
      ),
    }));
  },
  clearHitls: () => set({ hitls: [] }),

  // ---- Composer ----
  setComposerValue: (v) => set({ composerValue: v }),
  addPastedBlob: (text) => {
    const token =
      Math.floor(Date.now() / 1000).toString(16).slice(-4) +
      Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
    const kb = (new Blob([text]).size / 1024).toFixed(1).replace(/\.0$/, "");
    set((s) => ({ pastedBlobs: { ...s.pastedBlobs, [token]: text } }));
    return `[Pasted ${kb} KB] #${token}`;
  },
  gcPastedBlobs: () => {
    set((s) => {
      if (!Object.keys(s.pastedBlobs).length) return s;
      const next: PastedBlobs = {};
      for (const [tok, val] of Object.entries(s.pastedBlobs)) {
        if (s.composerValue.includes(`#${tok}`)) next[tok] = val;
      }
      if (Object.keys(next).length === Object.keys(s.pastedBlobs).length) return s;
      return { pastedBlobs: next };
    });
  },
  expandPastedPlaceholders: (text) => {
    const blobs = get().pastedBlobs;
    if (!Object.keys(blobs).length) return text;
    return text.replace(/\[Pasted [\d.]+ KB\] #([a-f0-9]{4,16})/g, (full, tok) =>
      blobs[tok] === undefined ? full : blobs[tok],
    );
  },
  clearPastedBlobs: () => set({ pastedBlobs: {} }),

  // ---- UI toggles ----
  setSidebarOpen: (open) => {
    document.body.classList.toggle("sidebar-closed", !open);
    safeSet("jarvis.sidebarOpen", open ? "true" : "false");
    set({ sidebarOpen: open });
  },
  setWorkspaceRailOpen: (open) => {
    document.body.classList.toggle("workspace-rail-closed", !open);
    safeSet("jarvis.workspaceRailOpen", open ? "true" : "false");
    set({ workspaceRailOpen: open });
  },
  setPlanCardOpen: (open) => {
    document.body.classList.toggle("plan-card-closed", !open);
    safeSet("jarvis.planCardOpen", open ? "true" : "false");
    set({ planCardOpen: open });
  },
  setWorkspacePanelVisible: (key, open) => {
    safeSet(`jarvis.panel.${key}`, open ? "true" : "false");
    set((s) => {
      const next = { ...s.workspacePanelVisible, [key]: open };
      // Auto-open the rail when enabling a panel and the rail is
      // currently closed — without this the user would toggle a
      // panel and see nothing change. Auto-close it when the user
      // turns OFF the last visible panel so we don't render an
      // empty rail.
      const anyVisible = Object.values(next).some(Boolean);
      let railOpen = s.workspaceRailOpen;
      if (open && !s.workspaceRailOpen) {
        document.body.classList.toggle("workspace-rail-closed", false);
        safeSet("jarvis.workspaceRailOpen", "true");
        railOpen = true;
      } else if (!open && !anyVisible && s.workspaceRailOpen) {
        document.body.classList.toggle("workspace-rail-closed", true);
        safeSet("jarvis.workspaceRailOpen", "false");
        railOpen = false;
      }
      return { workspacePanelVisible: next, workspaceRailOpen: railOpen };
    });
  },
  setWorkspacePanelMenuOpen: (open) => set({ workspacePanelMenuOpen: open }),
  setAccountMenuOpen: (open) => set({ accountMenuOpen: open }),
  // ---- Settings ----
  setTheme: (theme) => {
    document.documentElement.dataset.theme = theme;
    safeSet("jarvis.theme", theme);
    set({ theme });
  },
  setLang: (lang) => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    safeSet("jarvis.lang", lang);
    set({ lang });
  },
  // ---- Model picker ----
  setProviders: (providers) => set({ providers }),
  setRouting: (value) => {
    set((s) => {
      const next: any = { routing: value };
      // Persist this routing on the active conversation so resuming
      // restores the same provider+model. Skip when no conversation
      // is open or the value is unchanged.
      const id = s.activeId;
      if (id && s.convoRouting[id] !== value) {
        const map = { ...s.convoRouting };
        if (value) map[id] = value;
        else delete map[id];
        saveConvoRouting(map);
        next.convoRouting = map;
      }
      return next;
    });
  },
  setEffort: (value) => {
    safeSet("jarvis.effort", value);
    set({ effort: value });
  },
  setModelMenuOpen: (open) => set({ modelMenuOpen: open }),
  // ---- Quick switcher ----
  setQuickOpen: (v) => set({ quickOpen: v }),
  // ---- Tasks rail ----
  upsertTask: (entry) => {
    set((s) => {
      const now = Date.now();
      const existing = s.tasks.find((t) => t.id === entry.id);
      let next: TaskRailEntry[];
      if (existing) {
        next = s.tasks.map((t) =>
          t.id === entry.id
            ? { ...t, name: entry.name || t.name, args: entry.args ?? t.args, status: entry.status, updatedAt: now }
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
  setPlan: (items) => set({ plan: items }),
  // ---- Sidebar ----
  togglePin: (id) => {
    set((s) => {
      const next = new Set(s.pinned);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      savePinned(next);
      return { pinned: next };
    });
  },
  setTitleOverride: (id, title) => {
    set((s) => {
      const next = { ...s.titleOverrides };
      if (title && title.trim()) next[id] = title.trim();
      else delete next[id];
      saveTitleOverrides(next);
      return { titleOverrides: next };
    });
  },
  setConvoRoutingFor: (id, value) => {
    set((s) => {
      if ((s.convoRouting[id] ?? null) === value) return s;
      const next = { ...s.convoRouting };
      if (value) next[id] = value;
      else delete next[id];
      saveConvoRouting(next);
      return { convoRouting: next };
    });
  },
  setConvoStatus: (kind) => set({ convoStatus: kind }),
  setPersistEnabled: (v) => set({ persistEnabled: v }),

  setProjectsAvailable: (v) => set({ projectsAvailable: v }),
  setProjects: (rows) =>
    set({
      projects: rows,
      projectsById: Object.fromEntries(rows.map((p) => [p.id, p])),
    }),
  upsertProject: (p) => {
    set((s) => {
      const idx = s.projects.findIndex((row) => row.id === p.id);
      const projects =
        idx >= 0
          ? s.projects.map((row, i) => (i === idx ? p : row))
          : [p, ...s.projects];
      return {
        projects,
        projectsById: { ...s.projectsById, [p.id]: p },
      };
    });
  },
  setActiveProjectFilter: (id) => set({ activeProjectFilter: id }),

  setPermissionMode: (mode) => set({ permissionMode: mode }),
  bumpPermissionRulesVersion: () =>
    set((s) => ({ permissionRulesVersion: s.permissionRulesVersion + 1 })),
  setProposedPlan: (plan) => set({ proposedPlan: plan }),
  setActiveSkills: (names) => set({ activeSkills: names }),
  setSocketWorkspace: (path) => set({ socketWorkspace: path }),
  setWorkspaceDiff: (workspaceDiff) =>
    set({ workspaceDiff, workspaceDiffFileCache: {} }),
  setWorkspaceDiffLoading: (workspaceDiffLoading) => set({ workspaceDiffLoading }),
  setWorkspaceDiffFileEntry: (key, diff) =>
    set((s) => ({
      workspaceDiffFileCache: { ...s.workspaceDiffFileCache, [key]: diff },
    })),
  clearWorkspaceDiffFileCache: () => set({ workspaceDiffFileCache: {} }),
}));

/// Non-React imperative call sites can grab the store handle and
/// dispatch actions without going through a hook. The legacy modules
/// use this; React components should use `useAppStore` instead.
export const appStore = useAppStore;
