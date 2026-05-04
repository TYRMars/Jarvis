// Chat-area state: the list of `<UiMessage>`s rendered by
// `<MessageList>`, plus the per-conversation empty-state hint.
//
// `loadHistory`, `clearMessages`, and `applyForked` necessarily
// touch state owned by sibling slices (toolBlocks, hitls, tasks,
// plan, proposedPlan) — that's intentional. A message-list reset is
// indivisibly a chat reset, and routing each downstream wipe
// through its own action would just turn one atomic `set` into N
// renders. The unified Zustand store gives us atomic cross-slice
// writes; we use them.

import type { StateCreator } from "zustand";
import type { AnyMessage, ToolCall } from "../../types/frames";
import type { FullState } from "../appStore";
import type { TaskRailEntry, ToolBlockEntry, UiMessage } from "../types";
import { isAskToolName, nextUid } from "../uid";

export interface ChatSlice {
  /// Chat-area entries in insertion order. Empty array → React
  /// renders the welcome/empty-conv-hint card instead.
  messages: UiMessage[];
  /// Optional empty-conversation hint (id-prefix shown after a
  /// fresh `new`). Cleared once a real message lands.
  emptyHintIdShort: string | null;

  // ---- Chat-area surface ----
  clearMessages: () => void;
  showEmptyHint: (idShort: string) => void;
  /// Append a synthetic system message (e.g. the `/help` overlay).
  /// Renders as a `system` `<UiMessage>` in the chat list.
  pushSystemMessage: (content: string) => void;
  pushUserMessage: (content: string) => string;
  startAssistant: () => string;
  appendDelta: (text: string) => void;
  finalizeAssistant: (msg: {
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: ToolCall[];
  }) => void;
  /// Replace the entire visible message list with the server's
  /// snapshot for a conversation (called by `resumeConversation`).
  loadHistory: (messages: AnyMessage[]) => void;
  /// `forked` echo from the server: drop everything from the
  /// matching user ordinal forward (in-place truncate).
  applyForked: (userOrdinal: number) => void;
}

export const createChatSlice: StateCreator<FullState, [], [], ChatSlice> = (
  set,
  get,
) => ({
  messages: [],
  emptyHintIdShort: null,

  clearMessages: () =>
    // Reset every per-conversation slice so switching to a fresh /
    // empty thread doesn't leak the previous conversation's tasks
    // rail, plan card, change report, pending HITL prompts, or
    // subagent runs.
    set({
      messages: [],
      emptyHintIdShort: null,
      toolBlocks: {},
      hitls: [],
      tasks: [],
      plan: [],
      proposedPlan: null,
      subAgentRuns: {},
    }),

  showEmptyHint: (idShort) =>
    set({
      messages: [],
      toolBlocks: {},
      emptyHintIdShort: idShort,
    }),

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
      messages: [
        ...s.messages,
        { uid, kind: "user", content, userOrdinal },
      ],
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
        {
          uid,
          kind: "assistant",
          content: "",
          reasoning: "",
          toolCallIds: [],
          finalised: false,
        },
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
        {
          uid,
          kind: "assistant",
          content: "",
          reasoning: "",
          toolCallIds: [],
          finalised: false,
        },
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
      if (msgs[i].kind === "assistant") {
        lastIdx = i;
        break;
      }
    }
    const trailing =
      lastIdx >= 0
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
        out.push({
          uid: nextUid("u"),
          kind: "user",
          content: m.content,
          userOrdinal,
        });
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

  applyForked: (userOrdinal) => {
    set((s) => {
      // Drop the user message at `userOrdinal` and everything after.
      let cut = -1;
      for (let i = 0; i < s.messages.length; i++) {
        const m = s.messages[i];
        if (m.kind === "user" && m.userOrdinal === userOrdinal) {
          cut = i;
          break;
        }
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
});

