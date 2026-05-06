// Slash command definitions + help overlay. The palette UI lives in
// `<SlashPalette>` (React); these are the **commands** themselves —
// each row's `run()` triggers a service helper / store action.

import type { SlashCommand } from "../components/Composer/SlashPalette";
import { appStore } from "../store/appStore";
import { t } from "../utils/i18n";
import { sendFrame } from "./socket";
import { newConversation } from "./conversations";
import { exportConversationMarkdown } from "./export";

export function slashCommands(): SlashCommand[] {
  // Pull `getState` lazily inside each `run()` — `setComposerBridge`
  // captures these closures at boot, but the user invokes them later
  // when state may have moved on (active conversation changed,
  // theme toggled, etc.).
  return [
    { cmd: "/help",   descKey: "cmdHelp",   run: () => showHelpOverlay() },
    { cmd: "/goal",   descKey: "cmdGoal",   insertText: "/goal " },
    { cmd: "/new",    descKey: "cmdNew",    run: () => {
        // Same "preserve project + workspace" semantics as Cmd+K /
        // Cmd+N — `/new` should start a fresh chat without dropping
        // the user's deliberate context.
        const s = appStore.getState();
        newConversation({
          projectId: s.draftProjectId ?? null,
          workspacePath: s.draftWorkspacePath ?? null,
        });
      } },
    { cmd: "/reset",  descKey: "cmdReset",  run: () => { sendFrame({ type: "reset" }); } },
    { cmd: "/clear",  descKey: "cmdClear",  run: () => {
        const s = appStore.getState();
        s.clearMessages();
        s.clearApprovals();
      } },
    { cmd: "/export", descKey: "cmdExport", run: () => {
        const id = appStore.getState().activeId;
        if (id) void exportConversationMarkdown(id);
      } },
    { cmd: "/model",  descKey: "cmdModel",  run: () => appStore.getState().setModelMenuOpen(true) },
    { cmd: "/theme",  descKey: "cmdTheme",  run: () => {
        const s = appStore.getState();
        s.setTheme(s.theme === "dark" ? "light" : "dark");
      } },
  ];
}

/// Push an inline help message into the chat list. Renders as a
/// `system` `<UiMessage>` through `<MessageList>` /
/// `<MarkdownView>`, so the user sees commands + shortcuts without
/// a modal overlay blocking the chat.
export function showHelpOverlay(): void {
  let md = `**${t("helpTitle")}**\n\n`;
  md += `**${t("commandsHeading")}**\n\n`;
  for (const c of slashCommands()) {
    md += `- \`${c.cmd}\` — ${t(c.descKey)}\n`;
  }
  md += `\n**${t("shortcutsHeading")}**\n\n`;
  md += `- \`Enter\` — ${t("shortcutSend")}\n`;
  md += `- \`Shift + Enter\` — ${t("shortcutNewline")}\n`;
  md += `- \`Cmd / Ctrl + K\` — ${t("shortcutNew")}\n`;
  md += `- \`Cmd / Ctrl + L\` — ${t("shortcutFocusList")}\n`;
  md += `- \`Cmd / Ctrl + B\` — ${t("shortcutToggleSidebar")}\n`;
  md += `- \`Cmd / Ctrl + J\` — ${t("shortcutToggleWorkspace")}\n`;
  md += `- \`Cmd / Ctrl + P\` — ${t("shortcutQuickSwitcher")}\n`;
  md += `- \`Cmd / Ctrl + /\` — ${t("shortcutPalette")}\n`;
  md += `- \`Esc\` — ${t("shortcutClose")}\n`;
  md += `- \`?\` — ${t("shortcutHelp")}\n`;
  appStore.getState().pushSystemMessage(md);
}
