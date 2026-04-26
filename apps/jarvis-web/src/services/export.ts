// Conversation → Markdown exporter.
//
// Pure read-only HTTP fetch followed by client-side download — no
// live state, no mutation. Public surface is a single
// `exportConversationMarkdown(id)` that callers (slash command,
// sidebar action) invoke without threading helpers through.

import { resolveTitle } from "../store/persistence";
import { appStore } from "../store/appStore";
import { t } from "../utils/i18n";
import { apiUrl } from "./api";
import { showError } from "./status";

export async function exportConversationMarkdown(id: string): Promise<void> {
  if (!id) {
    showError(t("noActiveConversation"));
    return;
  }
  let messages: any[];
  try {
    const r = await fetch(apiUrl(`/v1/conversations/${encodeURIComponent(id)}`));
    if (!r.ok) throw new Error(`get: ${r.status}`);
    const body = await r.json();
    messages = body.messages || [];
  } catch (e: any) {
    showError(t("resumeFailed", e?.message || String(e)));
    return;
  }
  const md = renderConversationMarkdown(id, messages);
  const filename = `jarvis-${id.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.md`;
  triggerDownload(filename, md, "text/markdown;charset=utf-8");
}

/// Render a conversation snapshot as a portable Markdown file.
/// Sections in order: header (id, model if known, message count),
/// then each turn as `## You / ## Jarvis / ## Tool` blocks. Tool
/// args / outputs go into fenced ```json blocks. Reasoning blocks
/// become collapsible HTML `<details>` so the rendered MD reads
/// cleanly in GitHub / Obsidian without losing the trail.
export function renderConversationMarkdown(id: string, messages: any[]): string {
  const out: string[] = [];
  const rows = appStore.getState().convoRows;
  const matched = rows.find((r: any) => r.id === id);
  const title = (matched && resolveTitle(matched)) || `Conversation ${id.slice(0, 8)}`;
  out.push(`# ${title}`);
  out.push("");
  out.push(`- **ID:** \`${id}\``);
  out.push(`- **Exported:** ${new Date().toISOString()}`);
  out.push(`- **Messages:** ${messages.length}`);
  const routing = appStore.getState().convoRouting[id];
  if (routing) out.push(`- **Model:** \`${routing}\``);
  out.push("");
  out.push("---");
  out.push("");

  for (const m of messages) {
    if (m.role === "system") {
      out.push("## System");
      out.push("");
      out.push("```");
      out.push(m.content || "");
      out.push("```");
    } else if (m.role === "user") {
      out.push("## You");
      out.push("");
      out.push(m.content || "");
    } else if (m.role === "assistant") {
      out.push("## Jarvis");
      out.push("");
      if (m.reasoning_content) {
        out.push("<details><summary>Thinking</summary>");
        out.push("");
        out.push("```");
        out.push(m.reasoning_content);
        out.push("```");
        out.push("");
        out.push("</details>");
        out.push("");
      }
      if (m.content) out.push(m.content);
      if (m.tool_calls && m.tool_calls.length) {
        for (const tc of m.tool_calls) {
          out.push("");
          out.push(`### ⚙️ tool call \`${tc.name}\``);
          out.push("");
          out.push("```json");
          try {
            out.push(JSON.stringify(tc.arguments, null, 2));
          } catch {
            out.push(String(tc.arguments));
          }
          out.push("```");
        }
      }
    } else if (m.role === "tool") {
      out.push(`## Tool result \`${m.tool_call_id || "?"}\``);
      out.push("");
      out.push("```");
      out.push(m.content || "");
      out.push("```");
    }
    out.push("");
  }
  return out.join("\n");
}

/// Trigger a browser download for `content` under `filename`. Wraps
/// the Blob → ObjectURL → `<a>.click()` dance so callers don't have
/// to think about it — and we revoke the URL a tick later so Safari
/// has time to actually start the download before GC.
export function triggerDownload(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
