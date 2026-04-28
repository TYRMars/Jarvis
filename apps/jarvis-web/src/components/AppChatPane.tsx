// Center column: chat header (active conversation title +
// workspace-rail toggle), error banner, scrolling message list,
// composer footer with model menu + usage badge.

import { Banner } from "./Banner";
import { ChatHeader } from "./ChatHeader";
import { Composer } from "./Composer/Composer";
import { MessageList } from "./Chat/MessageList";
import { AskTextCard } from "./Chat/AskTextCard";
import { ApprovalCard } from "./Approvals/ApprovalCard";
import { BypassBanner } from "./Approvals/BypassBanner";
import { ModeBadge } from "./Approvals/ModeBadge";
import { PlanProposedCard } from "./Approvals/PlanProposedCard";
import { ModelMenu } from "./ModelMenu/ModelMenu";
import { UsageBadge } from "./UsageBadge";
import { ComposerShoulder } from "./ComposerShoulder";
import { OpenSidebarButton, WorkspacePanelMenu } from "./Workspace/WorkspaceToggles";
import { pickedRouting } from "../services/socket";
import { slashCommands } from "../services/slash_commands";
import { useAppStore } from "../store/appStore";

export function AppChatPane() {
  const pendingAsk = useAppStore((s) => {
    for (let i = s.hitls.length - 1; i >= 0; i--) {
      if (s.hitls[i].status === "pending") return s.hitls[i].request.id;
    }
    return null;
  });
  const pendingApproval = useAppStore((s) => {
    for (let i = s.approvals.length - 1; i >= 0; i--) {
      if (s.approvals[i].status === "pending") return s.approvals[i];
    }
    return null;
  });
  const proposedPlan = useAppStore((s) => s.proposedPlan);

  return (
    <main id="chat">
      <header id="chat-header">
        <div className="header-leading">
          <OpenSidebarButton />
          <ChatHeader />
        </div>
        <div className="header-actions">
          <WorkspacePanelMenu />
        </div>
      </header>

      <Banner />
      <BypassBanner />

      <MessageList />

      <footer id="input-area">
        {proposedPlan != null ? (
          <div className="review-dock">
            <PlanProposedCard plan={proposedPlan} />
          </div>
        ) : null}
        {pendingApproval || pendingAsk ? (
          <div className="review-dock">
            {pendingApproval ? <ApprovalCard entry={pendingApproval} /> : null}
            {!pendingApproval && pendingAsk ? <AskTextCard requestId={pendingAsk} /> : null}
          </div>
        ) : null}
        {/* Claude Code-style shoulder above the composer — branch
         * comparison crumb, aggregate diff stat, Create draft PR
         * button. Self-hides when the server has no workspace
         * pinned. */}
        <ComposerShoulder />
        <Composer
          slashCommands={slashCommands}
          pickedRouting={pickedRouting}
          metaChildren={(
            <>
              <div className="composer-actions">
                <ModeBadge />
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
