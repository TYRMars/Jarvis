// Assistant turn renderer. Composes:
//   - optional ThinkingDisclosure (collapsible reasoning)
//   - copy-whole-message button (delegated handler is installed once
//     via legacy `installCopyAffordances`; we keep the marker class
//     so it picks us up)
//   - markdown body via the existing X-Markdown adapter, in
//     streaming mode while the turn is still in flight
//   - associated tool blocks rendered inline so they sit visually
//     under the assistant bubble that triggered them
//
// **Continuation mode.** The agent loop fires multiple
// `assistant_message` events per user turn (one per iteration:
// think → tools → reflect → tools → reply). We keep them as
// separate `UiMessage`s in the data model so each iteration's
// tool calls attach cleanly, but we want them to *look* like one
// bubble. `continuation === true` means "the previous message is
// also assistant" → skip the avatar slot's content + the name +
// copy header so the iterations stack visually as one unit.
//
// We still render the empty avatar column so the body stays at
// the same indent — otherwise the continuation iteration would
// jump left and break alignment.

import { t } from "../../utils/i18n";
import { ThinkingDisclosure } from "./ThinkingDisclosure";
import { MarkdownView } from "./MarkdownView";
import { ToolStepRow } from "./ToolStepRow";

interface Props {
  uid: string;
  content: string;
  reasoning: string;
  toolCallIds: string[];
  finalised: boolean;
  /// True when the previous message is also an assistant message,
  /// i.e. this is iteration 2+ of the same agent turn. Suppresses
  /// the avatar / name / copy header so the page reads as one
  /// continuous Jarvis response instead of repeating "Jarvis"
  /// rows for each iteration.
  continuation?: boolean;
}

export function AssistantBubble({
  uid: _uid,
  content,
  reasoning,
  toolCallIds,
  finalised,
  continuation = false,
}: Props) {
  return (
    <div
      className={`msg-row assistant${continuation ? " assistant-continuation" : ""}`}
    >
      {continuation ? (
        // Empty placeholder keeps the body column at the same
        // indent as the first iteration's body. Visually invisible.
        <div className="msg-avatar msg-avatar-spacer" aria-hidden="true" />
      ) : (
        <div className="msg-avatar">J</div>
      )}
      <div className="msg-content">
        {!continuation ? (
          <div className="msg-author-row">
            <div className="msg-author">{t("assistant")}</div>
            <button
              type="button"
              className="msg-copy-btn"
              title={t("copy")}
              aria-label={t("copy")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
          </div>
        ) : null}
        {reasoning && <ThinkingDisclosure reasoning={reasoning} />}
        {(content || !toolCallIds.length) && (
          <MarkdownView content={content} streaming={!finalised} />
        )}
        {/* Coalesced tool-call summary — one row per assistant turn,
         * click to expand and see individual ToolBlocks inline. */}
        {toolCallIds.length > 0 ? <ToolStepRow toolCallIds={toolCallIds} /> : null}
      </div>
    </div>
  );
}
