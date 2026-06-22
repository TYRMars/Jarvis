// Center column: chat header (active conversation title +
// workspace-rail toggle), error banner, scrolling message list,
// composer footer with model menu + usage badge.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Banner } from "./Banner";
import { ChatHeader } from "./ChatHeader";
import { FallbackBanner } from "./FallbackBanner";
import { Composer } from "./Composer/Composer";
import { MessageList } from "./Chat/MessageList";
import { AskTextCard } from "./Chat/AskTextCard";
import { ApprovalCard } from "./Approvals/ApprovalCard";
import { BypassBanner } from "./Approvals/BypassBanner";
import { ModeBadge } from "./Approvals/ModeBadge";
import { ModeChangedToast } from "./Approvals/ModeChangedToast";
import { PlanModeBanner } from "./Approvals/PlanModeBanner";
import { PlanProposedCard } from "./Approvals/PlanProposedCard";
import { ModelMenu } from "./ModelMenu/ModelMenu";
import { EffortLevelSelector } from "./Composer/EffortLevelSelector";
import { ContextWindowBadge } from "./ContextWindowBadge";
import { UsageBadge } from "./UsageBadge";
import { ComposerShoulder } from "./ComposerShoulder";
import { ComposerProjectRail } from "./Composer/ComposerProjectRail";
import { OpenSidebarButton, WorkspacePanelMenu } from "./Workspace/WorkspaceToggles";
import { BackgroundTasksButton } from "./BackgroundTasks/BackgroundTasksButton";
import { pickedRouting } from "../services/socket";
import { slashCommands } from "../services/slash_commands";
import { useAppStore } from "../store/appStore";
import { t } from "../utils/i18n";
import { FileText, Icon, Mic, Plus, SquareTerminal } from "./ui";

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
          <BackgroundTasksButton />
          <WorkspacePanelMenu />
        </div>
      </header>

      <Banner />
      <BypassBanner />
      <PlanModeBanner />
      <FallbackBanner />
      <ModeChangedToast />

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
        <Composer
          slashCommands={slashCommands}
          pickedRouting={pickedRouting}
          contextRow={(
            <div className="composer-meta-context">
              {inSession ? <ComposerShoulder /> : <ComposerProjectRail />}
            </div>
          )}
          metaChildren={(
            <>
              <div className="composer-actions composer-meta-controls">
                <ModeBadge />
                <ComposerUtilityButtons />
                <UsageBadge />
              </div>
              {/* Right cluster (Claude-Code order): model, then thinking
                  level, then the compact context-window ring. */}
              <div className="composer-model-cluster">
                <ModelMenu />
                <EffortLevelSelector />
                <ContextWindowBadge />
              </div>
            </>
          )}
        />
      </footer>
    </main>
  );
}

export function ComposerUtilityButtons() {
  return (
    <div className="composer-tool-group" role="group" aria-label={t("chatCoreComposerTools")}>
      <ComposerAddMenuButton />
      <VoiceInputButton />
      <ComposerToolButton label={t("chatCoreOpenDocs")} onClick={() => { window.location.href = "/docs"; }}>
        <Icon icon={FileText} size={15} />
      </ComposerToolButton>
    </div>
  );
}

function ComposerAddMenuButton() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const firstItemRef = useRef<HTMLButtonElement | null>(null);
  const secondItemRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const runAction = (eventName: "jarvis:composer-pick-files" | "jarvis:composer-open-slash") => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent(eventName));
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    setOpen(true);
    requestAnimationFrame(() => firstItemRef.current?.focus());
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      requestAnimationFrame(() => document.getElementById("composer-add-trigger")?.focus());
      return;
    }
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      event.preventDefault();
      const items = [firstItemRef.current, secondItemRef.current].filter(Boolean);
      if (items.length === 0) return;
      const current = document.activeElement;
      const currentIndex = items.findIndex((item) => item === current);
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowUp"
            ? (currentIndex <= 0 ? items.length - 1 : currentIndex - 1)
            : (currentIndex + 1) % items.length;
      items[nextIndex]?.focus();
    }
  };

  return (
    <div className="composer-add-menu" ref={rootRef}>
      <ComposerToolButton
        id="composer-add-trigger"
        label={t("chatCoreAddContext")}
        ariaExpanded={open}
        ariaHasPopup="menu"
        onKeyDown={onTriggerKeyDown}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon icon={Plus} size={16} />
      </ComposerToolButton>
      {open ? (
        <div className="composer-add-popover" role="menu" onKeyDown={onMenuKeyDown}>
          <button
            ref={firstItemRef}
            type="button"
            role="menuitem"
            className="composer-add-item"
            onClick={() => runAction("jarvis:composer-pick-files")}
          >
            <Icon icon={FileText} size={16} />
            <span>
              <strong>{t("chatCoreAttachFiles")}</strong>
              <small>{t("chatCoreAttachFilesDesc")}</small>
            </span>
          </button>
          <button
            ref={secondItemRef}
            type="button"
            role="menuitem"
            className="composer-add-item"
            onClick={() => runAction("jarvis:composer-open-slash")}
          >
            <Icon icon={SquareTerminal} size={16} />
            <span>
              <strong>{t("chatCoreSlashCommands")}</strong>
              <small>{t("chatCoreSlashCommandsDesc")}</small>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function VoiceInputButton() {
  const value = useAppStore((s) => s.composerValue);
  const setValue = useAppStore((s) => s.setComposerValue);
  const showBanner = useAppStore((s) => s.showBanner);

  return (
    <ComposerToolButton
      label={t("chatCoreVoiceInput")}
      onClick={() => {
        const SpeechRecognition =
          (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (!SpeechRecognition) {
          showBanner(t("chatCoreVoiceUnsupported"));
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
        recognition.onerror = () => showBanner(t("chatCoreVoiceFailed"));
        recognition.start();
      }}
    >
      <Icon icon={Mic} size={16} />
    </ComposerToolButton>
  );
}

function ComposerToolButton({
  id,
  label,
  ariaExpanded,
  ariaHasPopup,
  onKeyDown,
  onClick,
  children,
}: {
  id?: string;
  label: string;
  ariaExpanded?: boolean;
  ariaHasPopup?: "menu";
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      id={id}
      type="button"
      className="composer-tool-btn"
      aria-label={label}
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaHasPopup}
      title={label}
      onKeyDown={onKeyDown}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
