// Center column: chat header (active conversation title +
// workspace-rail toggle), error banner, scrolling message list,
// composer footer with model menu + usage badge.

import { Banner } from "./Banner";
import { ChatHeader } from "./ChatHeader";
import { Composer } from "./Composer/Composer";
import { MessageList } from "./Chat/MessageList";
import { ModelMenu } from "./ModelMenu/ModelMenu";
import { UsageBadge } from "./UsageBadge";
import { OpenSidebarButton, WorkspaceRailToggleButton } from "./Workspace/WorkspaceToggles";
import { pickedRouting } from "../services/socket";
import { slashCommands } from "../services/slash_commands";

export function AppChatPane() {
  return (
    <main id="chat">
      <header id="chat-header">
        <div className="header-leading">
          <OpenSidebarButton />
          <ChatHeader />
        </div>
        <div className="header-actions">
          <WorkspaceRailToggleButton />
        </div>
      </header>

      <Banner />

      <MessageList />

      <footer id="input-area">
        <Composer
          slashCommands={slashCommands}
          pickedRouting={pickedRouting}
          metaChildren={(
            <>
              <div className="composer-actions">
                <span data-i18n="acceptEdits">Accept edits</span>
                <span className="meta-dot">+</span>
                <UsageBadge />
              </div>
              <ModelMenu />
            </>
          )}
        />
      </footer>
    </main>
  );
}
