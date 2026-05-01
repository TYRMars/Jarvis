// Everything that isn't strictly a chat-message-flow concern:
// connection / status banner, usage badge, composer + paste blobs,
// sidebar / workspace-rail / panel-visibility toggles, theme + lang,
// model picker (providers + routing + effort), quick switcher,
// persistent TODOs, sidebar pinned/title overrides + per-convo
// routing + persistence flag, projects, per-socket workspace +
// draft workspace + draft project, workspace diff cache.
//
// This is the "kitchen sink" slice — the chat-surface refactor's
// non-goal was to split these too. They cohabit until a separate
// pass touches the sidebar / workspace-rail surfaces.

import type { StateCreator } from "zustand";
import type { ConnectionStatus, Project } from "../../types/frames";
import type { WorkspaceInfo } from "../../services/workspace";
import type {
  WorkspacePanelKey,
} from "../persistence";
import {
  initialEffort,
  initialLang,
  initialPlanCardOpen,
  initialSidebarOpen,
  initialTheme,
  initialWorkspacePanel,
  initialWorkspaceRailOpen,
  loadConvoRouting,
  loadPinned,
  loadTitleOverrides,
  safeSet,
  saveConvoRouting,
  savePinned,
  saveTitleOverrides,
} from "../persistence";
import type { FullState } from "../appStore";
import type {
  ConvoStatusKind,
  EffortLevel,
  PastedBlobs,
  ProviderInfo,
  TodoItem,
  UsageSnapshot,
} from "../types";

/// Sort TODOs newest-`updated_at` first to match the server's
/// `ORDER BY updated_at DESC`. Stable comparator so equal stamps
/// keep insertion order.
function sortTodosByUpdatedDesc(items: TodoItem[]): TodoItem[] {
  return items.slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export interface CoreSlice {
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
  workspacePanelVisible: Record<WorkspacePanelKey, boolean>;
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
  /// Persistent project TODOs for the active workspace. Hydrated
  /// from `GET /v1/todos` on mount of the TODOs panel; live updates
  /// arrive via `todo_upserted` / `todo_deleted` WS frames. Sort
  /// order matches the server: newest `updated_at` first.
  todos: TodoItem[];

  // ---- Sidebar / conversation list ----
  pinned: Set<string>;
  titleOverrides: Record<string, string>;
  convoRouting: Record<string, string>;
  convoStatus: ConvoStatusKind;
  persistEnabled: boolean;

  // ---- Projects ----
  projectsAvailable: boolean;
  projects: Project[];
  projectsById: Record<string, Project>;
  activeProjectFilter: string | null;

  // ---- Per-socket workspace / draft picker ----
  socketWorkspace: string | null;
  socketWorkspaceInfo: WorkspaceInfo | null;
  draftWorkspacePath: string | null;
  draftWorkspaceInfo: WorkspaceInfo | null;
  draftProjectId: string | null;

  // ---- Workspace diff (right-rail review card) ----
  workspaceDiff: import("../../services/workspaceDiff").WorkspaceDiffState;
  workspaceDiffLoading: boolean;
  workspaceDiffFileCache: Record<string, string>;

  markStateChanged: () => void;
  setConnection: (status: ConnectionStatus) => void;
  setStatus: (key: string | null, cls?: string | null) => void;
  setReconnectAttempt: (n: number) => void;
  showBanner: (msg: string | null) => void;
  setUsage: (u: UsageSnapshot) => void;

  setComposerValue: (v: string) => void;
  addPastedBlob: (text: string) => string;
  gcPastedBlobs: () => void;
  expandPastedPlaceholders: (text: string) => string;
  clearPastedBlobs: () => void;

  setSidebarOpen: (open: boolean) => void;
  setWorkspaceRailOpen: (open: boolean) => void;
  setPlanCardOpen: (open: boolean) => void;
  setWorkspacePanelVisible: (key: WorkspacePanelKey, open: boolean) => void;
  setWorkspacePanelMenuOpen: (open: boolean) => void;
  setAccountMenuOpen: (open: boolean) => void;

  setTheme: (theme: "light" | "dark") => void;
  setLang: (lang: "en" | "zh") => void;

  setProviders: (providers: ProviderInfo[]) => void;
  setRouting: (value: string) => void;
  setEffort: (value: EffortLevel) => void;
  setModelMenuOpen: (open: boolean) => void;
  setQuickOpen: (v: boolean) => void;

  setTodos: (items: TodoItem[]) => void;
  upsertTodo: (item: TodoItem) => void;
  removeTodo: (id: string) => void;

  togglePin: (id: string) => void;
  setTitleOverride: (id: string, title: string | null) => void;
  setConvoRoutingFor: (id: string, value: string | null) => void;
  setConvoStatus: (kind: ConvoStatusKind) => void;
  setPersistEnabled: (v: boolean) => void;

  setProjectsAvailable: (v: boolean) => void;
  setProjects: (rows: Project[]) => void;
  upsertProject: (p: Project) => void;
  setActiveProjectFilter: (id: string | null) => void;

  setSocketWorkspace: (path: string | null, info?: WorkspaceInfo | null) => void;
  setDraftWorkspace: (path: string | null, info?: WorkspaceInfo | null) => void;
  setDraftProjectId: (id: string | null) => void;

  setWorkspaceDiff: (
    diff: import("../../services/workspaceDiff").WorkspaceDiffState,
  ) => void;
  setWorkspaceDiffLoading: (loading: boolean) => void;
  setWorkspaceDiffFileEntry: (key: string, diff: string) => void;
  clearWorkspaceDiffFileCache: () => void;
}

export const createCoreSlice: StateCreator<FullState, [], [], CoreSlice> = (set, get) => ({
  version: 0,
  connection: "connecting",
  statusKey: null,
  reconnectAttempt: 0,
  statusClass: null,
  bannerError: null,
  usage: { prompt: 0, completion: 0, cached: 0, reasoning: 0, calls: 0 },

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
    todos: initialWorkspacePanel("todos"),
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
  todos: [],

  pinned: loadPinned(),
  titleOverrides: loadTitleOverrides(),
  convoRouting: loadConvoRouting(),
  convoStatus: "",
  persistEnabled: true,
  projectsAvailable: true,
  projects: [],
  projectsById: {},
  activeProjectFilter: null,

  socketWorkspace: null,
  socketWorkspaceInfo: null,
  draftWorkspacePath: null,
  draftWorkspaceInfo: null,
  draftProjectId: null,

  workspaceDiff: null,
  workspaceDiffLoading: false,
  workspaceDiffFileCache: {},

  markStateChanged: () => set((s) => ({ version: s.version + 1 })),
  setConnection: (status) => set({ connection: status }),
  setStatus: (statusKey, statusClass = null) => set({ statusKey, statusClass }),
  setReconnectAttempt: (reconnectAttempt) => set({ reconnectAttempt }),
  showBanner: (msg) => set({ bannerError: msg }),
  setUsage: (usage) => set({ usage }),

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  setQuickOpen: (v) => set({ quickOpen: v }),

  // ---- Persistent TODOs ----
  setTodos: (items) =>
    set({
      // Server already returns newest-first; trust the order.
      todos: items.slice(),
    }),
  upsertTodo: (item) =>
    set((s) => {
      const filtered = s.todos.filter((t) => t.id !== item.id);
      return { todos: sortTodosByUpdatedDesc([item, ...filtered]) };
    }),
  removeTodo: (id) => set((s) => ({ todos: s.todos.filter((t) => t.id !== id) })),

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

  // ---- Projects ----
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

  // ---- Per-socket workspace ----
  setSocketWorkspace: (path, info = null) =>
    set({
      socketWorkspace: path,
      socketWorkspaceInfo: path ? info : null,
      draftWorkspacePath: path,
      draftWorkspaceInfo: path ? info : null,
      workspaceDiff: null,
      workspaceDiffFileCache: {},
    }),
  setDraftWorkspace: (path, info = null) =>
    set({ draftWorkspacePath: path, draftWorkspaceInfo: path ? info : null }),
  setDraftProjectId: (id) => set({ draftProjectId: id }),

  // ---- Workspace diff ----
  setWorkspaceDiff: (workspaceDiff) =>
    set({ workspaceDiff, workspaceDiffFileCache: {} }),
  setWorkspaceDiffLoading: (workspaceDiffLoading) => set({ workspaceDiffLoading }),
  setWorkspaceDiffFileEntry: (key, diff) =>
    set((s) => ({
      workspaceDiffFileCache: { ...s.workspaceDiffFileCache, [key]: diff },
    })),
  clearWorkspaceDiffFileCache: () => set({ workspaceDiffFileCache: {} }),
});
