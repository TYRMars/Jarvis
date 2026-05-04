// Top-level chat scroller. Subscribes to the messages array and
// renders the right per-row component. The three-layer
// scroll-to-bottom strategy lives in `useStickToBottom` — see that
// file's header for why a naive "scroll on every render" effect
// doesn't work with the async XMarkdown subtree.

import { useAppStore } from "../../store/appStore";
import { useStickToBottom } from "../../hooks/useStickToBottom";
import { UserBubble } from "./UserBubble";
import { AssistantBubble } from "./AssistantBubble";
import { AgentLoadingFooter } from "./AgentLoadingFooter";
import { WelcomeScreen } from "./WelcomeScreen";
import { EmptyConvoHint } from "./EmptyConvoHint";
import { MarkdownView } from "./MarkdownView";
import { SubAgentInlineList } from "../SubAgent/SubAgentInline";
import { t } from "../../utils/i18n";

export function MessageList() {
  const messages = useAppStore((s) => s.messages);
  const activeId = useAppStore((s) => s.activeId);
  const emptyHint = useAppStore((s) => s.emptyHintIdShort);
  const { ref } = useStickToBottom<HTMLElement>({ activeId });

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
      {/* SubAgent runs the main agent dispatched in this conversation.
          Renders inline as a stack of collapsible cards just below
          the latest message, complementing the workspace rail's
          global "running + recent" view. v1.0 doesn't try to nail
          the exact assistant message that triggered each dispatch;
          the cards stack at the end and stay there. */}
      <SubAgentInlineList />
      {/* Pinned to the bottom of the scroller. Self-hides when no
       * turn is in flight — covers the silent gaps between LLM
       * iterations and during long tool execution that the
       * XMarkdown tail cursor doesn't reach. */}
      <AgentLoadingFooter />
    </section>
  );
}
