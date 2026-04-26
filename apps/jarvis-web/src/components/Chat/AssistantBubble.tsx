// Assistant turn renderer. Composes:
//   - optional ThinkingDisclosure (collapsible reasoning)
//   - copy-whole-message button (delegated handler is installed once
//     via legacy `installCopyAffordances`; we keep the marker class
//     so it picks us up)
//   - markdown body via the existing X-Markdown adapter, in
//     streaming mode while the turn is still in flight
//   - associated tool blocks rendered inline so they sit visually
//     under the assistant bubble that triggered them

import { useAppStore } from "../../store/appStore";
import { t } from "../../utils/i18n";
import { ThinkingDisclosure } from "./ThinkingDisclosure";
import { MarkdownView } from "./MarkdownView";
import { ToolBlock } from "./ToolBlock";

interface Props {
  uid: string;
  content: string;
  reasoning: string;
  toolCallIds: string[];
  finalised: boolean;
}

export function AssistantBubble({ uid: _uid, content, reasoning, toolCallIds, finalised }: Props) {
  const tools = useAppStore((s) => s.toolBlocks);
  return (
    <div className="msg-row assistant">
      <div className="msg-avatar">J</div>
      <div className="msg-content">
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
        {reasoning && <ThinkingDisclosure reasoning={reasoning} />}
        {(content || !toolCallIds.length) && (
          <MarkdownView content={content} streaming={!finalised} />
        )}
        {toolCallIds.map((id) => {
          const block = tools[id];
          if (!block) return null;
          return <ToolBlock key={id} entry={block} />;
        })}
      </div>
    </div>
  );
}
