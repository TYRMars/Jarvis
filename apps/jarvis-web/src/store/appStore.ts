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
}

/// Pending or resolved approval card in the right rail.
export interface ApprovalCardState {
  id: string;
  name: string;
  arguments: any;
  status: "pending" | "approved" | "denied";
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
  /// Whether the right-hand workspace rail (tasks + plan) is open.
  /// Drives `body.workspace-rail-closed`. Persisted to localStorage.
  workspaceRailOpen: boolean;
  /// Plan card visibility within the workspace rail. Persisted.
  planCardOpen: boolean;
  /// Workspace "panel" dropdown menu (preview/diff/terminal/files
  /// stubs). Transient — not persisted.
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
  /// Live filter text typed into the sidebar search row.
  convoSearch: string;
  /// Empty-state hint kind for the recents column.
  convoStatus: ConvoStatusKind;
  /// `false` means the server reported a 503 from the conversation
  /// CRUD routes — we hide the New button and show the "persistence
  /// disabled" banner.
  persistEnabled: boolean;
}

interface AppStoreActions {
  markStateChanged: () => void;
  setConnection: (status: ConnectionStatus) => void;
  setStatus: (key: string | null, cls?: string | null) => void;
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
  setApprovalDecision: (id: string, decision: "approve" | "deny", reason?: string | null) => void;
  /// Mark every still-pending approval as denied. Called when a turn
  /// terminates so stale cards don't tempt the user into a click that
  /// would error with "no pending approval" against the now-cleared
  /// server-side responder map.
  finalizePendingApprovals: () => void;
  clearApprovals: () => void;
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
  // ---- Sidebar ----
  togglePin: (id: string) => void;
  setTitleOverride: (id: string, title: string | null) => void;
  /// Persist `value` (or clear when null) as the pinned routing for
  /// `id`. Skipped if the entry is already what we'd write.
  setConvoRoutingFor: (id: string, value: string | null) => void;
  setConvoSearch: (q: string) => void;
  setConvoStatus: (kind: ConvoStatusKind) => void;
  setPersistEnabled: (v: boolean) => void;
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
  composerValue: "",
  pastedBlobs: {},

  sidebarOpen: initialSidebarOpen(),
  workspaceRailOpen: initialWorkspaceRailOpen(),
  planCardOpen: initialPlanCardOpen(),
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

  pinned: loadPinned(),
  titleOverrides: loadTitleOverrides(),
  convoRouting: loadConvoRouting(),
  convoSearch: "",
  convoStatus: "",
  persistEnabled: true,

  markStateChanged: () => set((s) => ({ version: s.version + 1 })),
  setConnection: (status) => set({ connection: status }),
  setStatus: (statusKey, statusClass = null) => set({ statusKey, statusClass }),
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

  clearMessages: () => set({ messages: [], emptyHintIdShort: null, toolBlocks: {} }),

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
    if (lastIdx < 0) {
      // Server sent an assistant-only message before any delta — append.
      const uid = nextUid("a");
      msgs.push({
        uid,
        kind: "assistant",
        content: msg.content || "",
        reasoning: msg.reasoning_content || "",
        toolCallIds: [],
        finalised: true,
      });
      set({ messages: msgs });
      return;
    }
    const cur = msgs[lastIdx] as Extract<UiMessage, { kind: "assistant" }>;
    msgs[lastIdx] = {
      ...cur,
      // Prefer the streamed text — `finalize.message.content` is the
      // server's full version and matches what we accumulated; the
      // OR keeps us safe for tool-call-only turns where content is
      // empty but reasoning may be present.
      content: cur.content || msg.content || "",
      reasoning: msg.reasoning_content || cur.reasoning,
      finalised: true,
    };
    set({ messages: msgs });
  },

  loadHistory: (messages) => {
    const out: UiMessage[] = [];
    const tools: Record<string, ToolBlockEntry> = {};
    let userOrdinal = 0;
    for (const m of messages) {
      if (m.role === "system") {
        out.push({ uid: nextUid("s"), kind: "system", content: m.content });
      } else if (m.role === "user") {
        out.push({ uid: nextUid("u"), kind: "user", content: m.content, userOrdinal });
        userOrdinal++;
      } else if (m.role === "assistant") {
        const ids: string[] = [];
        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            ids.push(tc.id);
            tools[tc.id] = {
              id: tc.id,
              name: tc.name,
              args: tc.arguments,
              status: "ok",
              output: null,
              progress: "",
            };
          }
        }
        out.push({
          uid: nextUid("a"),
          kind: "assistant",
          content: m.content || "",
          reasoning: m.reasoning_content || "",
          toolCallIds: ids,
          finalised: true,
        });
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
    set({ messages: out, toolBlocks: tools, emptyHintIdShort: null });
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
      const tools = { ...s.toolBlocks, [id]: { id, name, args, status: "running" as const, output: null, progress: "" } };
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
      return { toolBlocks: { ...s.toolBlocks, [id]: { ...block, status, output: content } } };
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
  setApprovalDecision: (id, decision, reason) => {
    set((s) => ({
      approvals: s.approvals.map((c) =>
        c.id === id
          ? {
              ...c,
              status: decision === "approve" ? "approved" : "denied",
              reason: reason || null,
            }
          : c,
      ),
    }));
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
  setConvoSearch: (q) => set({ convoSearch: q }),
  setConvoStatus: (kind) => set({ convoStatus: kind }),
  setPersistEnabled: (v) => set({ persistEnabled: v }),
}));

/// Non-React imperative call sites can grab the store handle and
/// dispatch actions without going through a hook. The legacy modules
/// use this; React components should use `useAppStore` instead.
export const appStore = useAppStore;
