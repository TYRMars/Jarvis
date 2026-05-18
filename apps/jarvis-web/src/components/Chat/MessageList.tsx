// Top-level chat scroller. Subscribes to the messages array and
// renders the right per-row component. The three-layer
// scroll-to-bottom strategy lives in `useStickToBottom` — see that
// file's header for why a naive "scroll on every render" effect
// doesn't work with the async XMarkdown subtree.
//
// MessageList is also the "view transformer" layer: before
// rendering, it groups consecutive assistant iterations whose tool
// calls are *all* read-only and whose visible content is empty
// into a single `<CollapsedToolGroup>` card. This keeps a long
// investigation loop (read → grep → read → grep → … before the
// real edit) from drowning the transcript. The fold threshold is
// `MIN_GROUP_SIZE` — small enough to be useful, large enough that
// brief lookups don't get hidden behind an extra click.

import { Fragment, useMemo, type ReactNode } from "react";
import { useAppStore } from "../../store/appStore";
import { useStickToBottom } from "../../hooks/useStickToBottom";
import { UserBubble } from "./UserBubble";
import { AssistantBubble } from "./AssistantBubble";
import { AgentLoadingFooter } from "./AgentLoadingFooter";
import { WelcomeScreen } from "./WelcomeScreen";
import { EmptyConvoHint } from "./EmptyConvoHint";
import { CollapsedToolGroup } from "./CollapsedToolGroup";
import { CompactionMarker } from "./CompactionMarker";
import { MarkdownView } from "./MarkdownView";
import { isReadOnlyTool } from "./toolStepSummary";
import { t } from "../../utils/i18n";
import type { UiMessage, ToolBlockEntry } from "../../store/types";
import type { CompactionMarker as CompactionMarkerData } from "../../store/slices/memorySlice";

const MIN_GROUP_SIZE = 3;

type AssistantMsg = Extract<UiMessage, { kind: "assistant" }>;

type Group =
  | { kind: "single"; message: UiMessage }
  | { kind: "folded"; messages: AssistantMsg[] };

/// True when this assistant message qualifies for folding: it has
/// at least one tool call, every tool call is a known read-only
/// tool, and its visible body content is empty (whitespace-only is
/// treated as empty). Reasoning is allowed — it lives inside a
/// collapsed disclosure either way.
///
/// Exported for testing — see [`groupForFolding`].
export function isFoldable(
  m: UiMessage,
  toolBlocks: Record<string, ToolBlockEntry>,
): m is AssistantMsg {
  if (m.kind !== "assistant") return false;
  if (m.toolCallIds.length === 0) return false;
  if (m.content.trim().length > 0) return false;
  for (const id of m.toolCallIds) {
    const b = toolBlocks[id];
    // Missing block = can't classify safely → don't fold.
    if (!b) return false;
    if (!isReadOnlyTool(b.name)) return false;
  }
  return true;
}

/// Walk `messages` once, batching runs of foldable assistant
/// iterations of length >= MIN_GROUP_SIZE into a `folded` group;
/// everything else stays as its own `single` entry. Runs shorter
/// than the threshold pass through unchanged so brief reads still
/// render inline.
///
/// Exported for testing — the rest of the SPA should never need to
/// call this directly. The classifier `isFoldable` is exposed
/// alongside for the same reason.
export function groupForFolding(
  messages: UiMessage[],
  toolBlocks: Record<string, ToolBlockEntry>,
): Group[] {
  const out: Group[] = [];
  let buf: AssistantMsg[] = [];
  const flushBuf = () => {
    if (buf.length >= MIN_GROUP_SIZE) {
      out.push({ kind: "folded", messages: buf });
    } else {
      for (const m of buf) out.push({ kind: "single", message: m });
    }
    buf = [];
  };
  for (const m of messages) {
    if (isFoldable(m, toolBlocks)) {
      buf.push(m);
    } else {
      flushBuf();
      out.push({ kind: "single", message: m });
    }
  }
  flushBuf();
  return out;
}

export function MessageList() {
  const messages = useAppStore((s) => s.messages);
  const toolBlocks = useAppStore((s) => s.toolBlocks);
  const activeId = useAppStore((s) => s.activeId);
  const emptyHint = useAppStore((s) => s.emptyHintIdShort);
  const markerMap = useAppStore((s) => s.compactionMarkers);
  const { ref } = useStickToBottom<HTMLElement>({ activeId });

  const groups = useMemo(
    () => groupForFolding(messages, toolBlocks),
    [messages, toolBlocks],
  );

  // Markers indexed by the message count at receive time. We render
  // a marker *before* the group whose head sits at or past
  // `marker.turnIndex` so a "compaction happened, then the LLM
  // responded" pair reads top-to-bottom as: marker → assistant
  // response.
  const markers: CompactionMarkerData[] = useMemo(() => {
    const key = activeId ?? "__active__";
    const list = markerMap[key] ?? [];
    // NoOp emits every iteration; filter them out of the chat
    // surface — the diagnostics panel still picks them up via
    // /v1/diagnostics/memory counters.
    return list.filter((m) => m.source !== "no_op");
  }, [activeId, markerMap]);

  // Group offsets: index into `messages` where each group starts.
  // Lets us interleave compaction markers at the right boundary.
  const groupOffsets = useMemo(() => {
    const offs: number[] = [];
    let acc = 0;
    for (const g of groups) {
      offs.push(acc);
      acc += g.kind === "folded" ? g.messages.length : 1;
    }
    return offs;
  }, [groups]);

  return (
    <section id="messages" aria-live="polite" ref={ref}>
      {messages.length === 0 && !emptyHint && <WelcomeScreen />}
      {messages.length === 0 && emptyHint && <EmptyConvoHint idShort={emptyHint} />}
      {groups.map((g, gi) => {
        const offset = groupOffsets[gi];
        const nextOffset =
          gi + 1 < groupOffsets.length ? groupOffsets[gi + 1] : messages.length;
        // Markers whose `turnIndex` lands at-or-before the next
        // group's start are rendered before this group, so the
        // compaction appears in the transcript where it actually
        // happened. `gi === 0` also picks up the leading "before
        // anything else" bucket.
        const precedingMarkers = markers.filter(
          (m) =>
            (gi === 0 ? m.turnIndex <= offset : m.turnIndex > offset && m.turnIndex <= nextOffset),
        );
        const marker = (m: CompactionMarkerData) => (
          <CompactionMarker key={`marker-${m.seq}`} marker={m} />
        );
        let body: ReactNode;
        if (g.kind === "folded") {
          const head = g.messages[0];
          body = <CollapsedToolGroup key={`grp-${head.uid}`} messages={g.messages} />;
        } else {
          const m = g.message;
          if (m.kind === "user") {
            body = (
              <UserBubble
                key={m.uid}
                uid={m.uid}
                content={m.content}
                userOrdinal={m.userOrdinal}
              />
            );
          } else if (m.kind === "assistant") {
            // Coalesce consecutive assistant messages from the same
            // user turn into a single visual bubble. The agent loop
            // can fire multiple `assistant_message` events per turn
            // (one per iteration: think → tool calls → reflect →
            // tool calls → final reply); we keep them as separate
            // UiMessages in the data model for clean per-iteration
            // tool-call attribution but render them stacked under one
            // avatar + name header so the user doesn't see "Jarvis,
            // Jarvis, Jarvis" repeating down the page.
            //
            // Continuation here is computed against the prior *group*,
            // not the prior raw message: a folded read-only run
            // immediately followed by a final reply still wants the
            // reply to read as a continuation of the same Jarvis turn.
            const prev = groups[gi - 1];
            const continuation =
              prev != null &&
              (prev.kind === "folded" ||
                (prev.kind === "single" && prev.message.kind === "assistant"));
            body = (
              <AssistantBubble
                key={m.uid}
                uid={m.uid}
                content={m.content}
                reasoning={m.reasoning}
                toolCallIds={m.toolCallIds}
                finalised={m.finalised}
                continuation={continuation}
              />
            );
          } else if (m.kind === "system") {
            body = (
              <div key={m.uid} className="msg-row system">
                <div className="msg-avatar">?</div>
                <div className="msg-content">
                  <div className="msg-author">{t("system")}</div>
                  <div className="msg-body">
                    <MarkdownView content={m.content} />
                  </div>
                </div>
              </div>
            );
          } else {
            body = null;
          }
        }
        return (
          <Fragment key={`row-${gi}`}>
            {precedingMarkers.map(marker)}
            {body}
          </Fragment>
        );
      })}
      {/* Trailing markers — emits that arrived after every existing
       * message. Common case: a compaction-on-empty conversation
       * (no messages yet) or events queued mid-stream just before
       * the next `assistant_message` lands. */}
      {markers
        .filter((m) => m.turnIndex >= messages.length)
        .map((m) => (
          <CompactionMarker key={`marker-tail-${m.seq}`} marker={m} />
        ))}
      {/* Pinned to the bottom of the scroller. Self-hides when no
       * turn is in flight — covers the silent gaps between LLM
       * iterations and during long tool execution that the
       * XMarkdown tail cursor doesn't reach. */}
      <AgentLoadingFooter />
    </section>
  );
}
