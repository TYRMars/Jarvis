// Top-level chat scroller. Subscribes to the messages array and
// renders the right per-row component. Auto-scrolls to bottom on
// every change so streaming deltas feel like a normal terminal.
// When there are no messages we render either the empty-conv hint
// (just after `new`) or the welcome screen.

import { useEffect, useRef } from "react";
import { useAppStore } from "../../store/appStore";
import { UserBubble } from "./UserBubble";
import { AssistantBubble } from "./AssistantBubble";
import { WelcomeScreen } from "./WelcomeScreen";
import { EmptyConvoHint } from "./EmptyConvoHint";
import { MarkdownView } from "./MarkdownView";
import { t } from "../../utils/i18n";

export function MessageList() {
  const messages = useAppStore((s) => s.messages);
  const emptyHint = useAppStore((s) => s.emptyHintIdShort);
  const ref = useRef<HTMLElement | null>(null);

  // Snap to bottom on every render. Cheap; the scroller is not deep.
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  });

  return (
    <section id="messages" aria-live="polite" ref={ref}>
      {messages.length === 0 && !emptyHint && <WelcomeScreen />}
      {messages.length === 0 && emptyHint && <EmptyConvoHint idShort={emptyHint} />}
      {messages.map((m) => {
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
          return (
            <AssistantBubble
              key={m.uid}
              uid={m.uid}
              content={m.content}
              reasoning={m.reasoning}
              toolCallIds={m.toolCallIds}
              finalised={m.finalised}
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
    </section>
  );
}
