// Top-level chat scroller. Subscribes to the messages array and
// renders the right per-row component.
//
// **Scroll-to-bottom strategy.** A naive "snap to bottom on every
// render" useEffect doesn't work because each `<MarkdownView>` mounts
// an INNER `createRoot()` and renders the XMarkdown subtree
// asynchronously. So when we load history in one batch, the parent's
// useEffect fires while only the markdown skeletons exist;
// scrollHeight is the small skeleton height; we scroll to that — i.e.
// the top — and by the time the inner roots commit, we've missed our
// chance.
//
// Three layers cover the cases:
//
//   1. **Sticky-bottom flag** updated on user scroll. While the user
//      is near the bottom (< 120px) we follow the content; once they
//      scroll up we leave them alone (no more yanking back during
//      streaming).
//
//   2. **useLayoutEffect on every render** — sync scroll-to-bottom
//      iff sticky. Handles the streaming-delta case, where each
//      delta lands as a new commit.
//
//   3. **Multi-rAF chase on conversation switch** — when activeId
//      changes (history opened, fork accepted, new convo started),
//      we run ~12 rAF passes that re-snap to bottom every frame.
//      This catches the async XMarkdown roots as they commit one by
//      one over the next ~200ms.

import { useEffect, useLayoutEffect, useRef } from "react";
import { useAppStore } from "../../store/appStore";
import { UserBubble } from "./UserBubble";
import { AssistantBubble } from "./AssistantBubble";
import { AgentLoadingFooter } from "./AgentLoadingFooter";
import { WelcomeScreen } from "./WelcomeScreen";
import { EmptyConvoHint } from "./EmptyConvoHint";
import { MarkdownView } from "./MarkdownView";
import { t } from "../../utils/i18n";

const STICK_THRESHOLD_PX = 120;
const HISTORY_RAF_FRAMES = 12;

export function MessageList() {
  const messages = useAppStore((s) => s.messages);
  const activeId = useAppStore((s) => s.activeId);
  const emptyHint = useAppStore((s) => s.emptyHintIdShort);
  const ref = useRef<HTMLElement | null>(null);
  // Track whether the user wants the view to follow new content
  // (true = stick to bottom, false = preserve their scroll position).
  // Mutated by the scroll listener; read by the layout effect.
  const stickToBottomRef = useRef(true);
  // Last activeId we reacted to — used to detect conversation switches.
  const prevActiveIdRef = useRef<string | null>(null);

  // Layer 1 — listen for user scrolls; flip the sticky flag when
  // they leave the bottom band.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distance < STICK_THRESHOLD_PX;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Layer 2 — on every render, if the user is near the bottom, snap.
  // useLayoutEffect runs sync after DOM mutations, before paint, so
  // the user never sees an intermediate "scrolled half-way" state.
  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  // Layer 3 — on conversation switch, force-stick and chase the
  // bottom across ~12 frames. Each frame catches more content as
  // the nested XMarkdown roots commit one by one.
  useEffect(() => {
    if (activeId === prevActiveIdRef.current) return;
    prevActiveIdRef.current = activeId;
    stickToBottomRef.current = true;
    const el = ref.current;
    if (!el) return;
    let frames = 0;
    let raf = 0;
    const chase = () => {
      const node = ref.current;
      if (!node) return;
      node.scrollTop = node.scrollHeight;
      frames += 1;
      if (frames < HISTORY_RAF_FRAMES) {
        raf = requestAnimationFrame(chase);
      }
    };
    raf = requestAnimationFrame(chase);
    return () => cancelAnimationFrame(raf);
  }, [activeId]);

  return (
    <section id="messages" aria-live="polite" ref={ref}>
      {messages.length === 0 && !emptyHint && <WelcomeScreen />}
      {messages.length === 0 && emptyHint && <EmptyConvoHint idShort={emptyHint} />}
      {messages.map((m, i) => {
        if (m.kind === "user") {
          return (
            <UserBubble
              key={m.uid}
              uid={m.uid}
              content={m.content}
              userOrdinal={m.userOrdinal}
            />
          );
        }
        if (m.kind === "assistant") {
          // Coalesce consecutive assistant messages from the same
          // user turn into a single visual bubble. The agent loop
          // can fire multiple `assistant_message` events per turn
          // (one per iteration: think → tool calls → reflect →
          // tool calls → final reply); we keep them as separate
          // UiMessages in the data model for clean per-iteration
          // tool-call attribution but render them stacked under one
          // avatar + name header so the user doesn't see "Jarvis,
          // Jarvis, Jarvis" repeating down the page.
          const prev = messages[i - 1];
          const continuation = prev != null && prev.kind === "assistant";
          return (
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
        }
        if (m.kind === "system") {
          return (
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
        }
        return null;
      })}
      {/* Pinned to the bottom of the scroller. Self-hides when no
       * turn is in flight — covers the silent gaps between LLM
       * iterations and during long tool execution that the
       * XMarkdown tail cursor doesn't reach. */}
      <AgentLoadingFooter />
    </section>
  );
}
