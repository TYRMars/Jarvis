// Center column: chat header (active conversation title +
// workspace-rail toggle), error banner, scrolling message list,
// composer footer with model menu + usage badge.

import type { ReactNode } from "react";
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
import { ComposerProjectRail } from "./Composer/ComposerProjectRail";
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
  const activeId = useAppStore((s) => s.activeId);
  const inSession = Boolean(activeId);

  return (
    <main id="chat" tabIndex={-1}>
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
        {/* Multi-workspace git status:
            - In-session: rendered INSIDE ComposerShoulder (replaces
              the single-branch crumb).
            - Pre-session (draft): owned by `ComposerProjectRail`, an
              interactive chip row with project picker, per-folder
              branch / worktree popover, and an `+ add folder` chip.
            Either way the rail sits above the input as part of the
            existing context surface — not a separate row that
            disappears between session-state transitions. */}
        {inSession ? <ComposerShoulder /> : <ComposerProjectRail />}
        <Composer
          slashCommands={slashCommands}
          pickedRouting={pickedRouting}
          metaChildren={(
            <>
              {inSession ? (
                <div className="composer-actions">
                  <ModeBadge />
                  <ComposerToolButton label="Open docs" onClick={() => { window.location.href = "/docs"; }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M8 6h8" />
                      <path d="M8 10h8" />
                      <path d="M8 14h5" />
                      <rect x="5" y="3" width="14" height="18" rx="2" />
                    </svg>
                  </ComposerToolButton>
                  <CommandSeedButton />
                  <VoiceInputButton />
                  <CommandSeedButton compact />
                  <UsageBadge />
                </div>
              ) : (
                <div className="composer-actions">
                  <ModeBadge />
                  <span className="meta-dot">+</span>
                  <UsageBadge />
                </div>
              )}
              <ModelMenu />
            </>
          )}
        />
      </footer>
    </main>
  );
}

function CommandSeedButton({ compact = false }: { compact?: boolean }) {
  const value = useAppStore((s) => s.composerValue);
  const setValue = useAppStore((s) => s.setComposerValue);
  return (
    <ComposerToolButton
      label={compact ? "More composer actions" : "Add command"}
      onClick={() => {
        setValue(value.trim().startsWith("/") ? value : "/");
        requestAnimationFrame(() => document.getElementById("input")?.focus());
      }}
    >
      {compact ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      )}
    </ComposerToolButton>
  );
}

function VoiceInputButton() {
  const value = useAppStore((s) => s.composerValue);
  const setValue = useAppStore((s) => s.setComposerValue);
  const showBanner = useAppStore((s) => s.showBanner);

  return (
    <ComposerToolButton
      label="Voice input"
      onClick={() => {
        const SpeechRecognition =
          (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (!SpeechRecognition) {
          showBanner("Voice input is not supported by this browser.");
          return;
        }
        const recognition = new SpeechRecognition();
        recognition.lang = navigator.language || "en-US";
        recognition.interimResults = false;
        recognition.maxAlternatives = 1;
        recognition.onresult = (event: any) => {
          const transcript = event.results?.[0]?.[0]?.transcript;
          if (!transcript) return;
          const spacer = value.trim().length ? " " : "";
          setValue(value + spacer + transcript);
          requestAnimationFrame(() => document.getElementById("input")?.focus());
        };
        recognition.onerror = () => showBanner("Voice input failed.");
        recognition.start();
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
        <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
        <path d="M12 18v3" />
      </svg>
    </ComposerToolButton>
  );
}

function ComposerToolButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" className="composer-tool-btn" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}
