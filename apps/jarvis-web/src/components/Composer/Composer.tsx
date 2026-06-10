// Composer = textarea + send/stop + slash palette + paste folding.
// Source of truth: `composerValue` in the store. The form keeps its
// historical id (`input-form`) and textarea id (`input`) so legacy
// CSS / focus calls (`document.getElementById("input")?.focus()`)
// continue to work; the submit handler is the React `onSubmit`.

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { t } from "../../utils/i18n";
import { SendButton, StopButton } from "../ComposerButtons";
import { AutoActivatedSkillsChip } from "./AutoActivatedSkillsChip";
import { SlashPalette, type SlashCommand } from "./SlashPalette";
import { sendFrame, isOpen } from "../../services/socket";
import { startConversationTurn } from "../../services/conversationSockets";
import { currentJarvisSoulPrompt } from "../../store/persistence";
import { isLocalProjectId } from "../../services/projects";
import { nextPermissionMode, setSocketMode } from "../../services/permissions";

const PASTE_THRESHOLD_BYTES = 2048;

interface Props {
  /// Slash commands the host wires in. Composer doesn't know what
  /// any of them do; selection just calls `run()`. Lazy because the
  /// host (legacy controller) populates the table during boot —
  /// after React has already rendered.
  slashCommands: () => SlashCommand[];
  /// Picked routing for the current send. Keeps Composer agnostic
  /// of how the model menu chooses values.
  pickedRouting: () => { provider: string | null; model: string | null };
  /// `<div class="composer-meta">` children. Hosts the imperative
  /// model menu / accept-edits chip / usage badge until those bits
  /// migrate too. Render whatever you like inside the meta slot.
  metaChildren?: React.ReactNode;
}

export function Composer({ slashCommands, pickedRouting, metaChildren }: Props) {
  const value = useAppStore((s) => s.composerValue);
  const setValue = useAppStore((s) => s.setComposerValue);
  // We *subscribe* to `inFlight` so the SendButton / disabled state
  // re-renders, but the submit() guard reads from the store directly
  // — capturing inFlight via the selector is racy across two quick
  // submits in the same render tick (we'd push two user messages
  // before React's re-render commits).
  const inFlight = useAppStore((s) => s.inFlight);
  void inFlight; // referenced for the side-effect of subscribing
  const showBanner = useAppStore((s) => s.showBanner);
  const pushUser = useAppStore((s) => s.pushUserMessage);
  const addPaste = useAppStore((s) => s.addPastedBlob);
  const gcPaste = useAppStore((s) => s.gcPastedBlobs);
  const expandPaste = useAppStore((s) => s.expandPastedPlaceholders);
  const clearPaste = useAppStore((s) => s.clearPastedBlobs);

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const [slashIdx, setSlashIdx] = useState(0);

  // Auto-grow textarea height with content.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }, [value]);

  // GC pasted blobs when their placeholder vanishes from the textarea.
  useEffect(() => { gcPaste(); }, [value, gcPaste]);

  const filtered = (() => {
    if (!value.startsWith("/")) return [] as SlashCommand[];
    const prefix = value.split(/\s/, 1)[0].toLowerCase();
    if (value.length > prefix.length && /\s/.test(value[prefix.length] ?? "")) {
      return [] as SlashCommand[];
    }
    return slashCommands().filter((c) => c.cmd.startsWith(prefix));
  })();
  const slashOpen = filtered.length > 0;

  // Reset slashIdx when the filtered list shrinks.
  useEffect(() => {
    if (slashIdx >= filtered.length) setSlashIdx(0);
  }, [filtered.length, slashIdx]);

  const acceptSlash = (cmd: SlashCommand) => {
    if (cmd.insertText != null) {
      setValue(cmd.insertText);
      requestAnimationFrame(() => {
        taRef.current?.focus();
        const pos = cmd.insertText?.length ?? 0;
        taRef.current?.setSelectionRange(pos, pos);
      });
      return;
    }
    setValue("");
    try { cmd.run?.(); }
    catch (e: any) { showBanner(String(e?.message || e)); }
  };

  // Tab in an empty/idle textarea (no slash palette open) advances the
  // permission mode through the canonical cycle, mirroring the mode
  // chip's click-to-cycle. Sends the change over the per-socket
  // `set_mode` frame; the server echoes a `permission_mode` frame that
  // syncs the store. No-op when no socket is open. Bypass needs an
  // explicit confirm — the same guard the chip / ModeBadge use.
  const cyclePermissionMode = () => {
    if (!isOpen()) return;
    const current = useAppStore.getState().permissionMode;
    const next = nextPermissionMode(current);
    if (next === "bypass") {
      const ok = window.confirm(t("permModeBypassConfirm"));
      if (!ok) return;
    }
    setSocketMode(next);
  };

  const submit = () => {
    // Read the gate from the live store (not the captured selector)
    // so a quick second submit in the same render tick — Enter
    // autorepeat, double-click, paste-and-Enter on a touchpad — sees
    // the just-set in-flight flag instead of the stale `false`.
    const store = useAppStore.getState();
    if (store.inFlight) return;
    const raw = value.trim();
    if (!raw) return;
    const content = expandPaste(raw);
    const { provider, model } = pickedRouting();
    if (store.persistEnabled) {
      const isNew = !store.activeId;
      const conversationId = store.activeId || crypto.randomUUID();
      const projectId = store.draftProjectId;
      if (store.activeId) store.saveConversationSurface(store.activeId);
      store.setActiveId(conversationId);
      if (isNew) {
        store.clearMessages();
      }
      const ok = startConversationTurn({
        conversationId,
        content,
        routing: { provider, model },
        isNew,
        projectId: projectId && !isLocalProjectId(projectId) ? projectId : null,
        workspacePath: store.draftWorkspacePath,
        soulPrompt: currentJarvisSoulPrompt(),
      });
      if (!ok) {
        store.setInFlight(false);
        return;
      }
      pushUser(content);
      setValue("");
      clearPaste();
      store.setUsage({ prompt: 0, completion: 0, cached: 0, reasoning: 0, calls: 0 });
      store.saveConversationSurface(conversationId);
      return;
    }
    // Non-persisted sessions use the shared socket service, which
    // does not synchronously create a per-conversation run. Flip the
    // gate before sending so same-tick duplicate submits are blocked.
    store.setInFlight(true);
    if (!isOpen()) {
      showBanner(t("websocketNotConnected"));
      store.setInFlight(false);
      return;
    }
    const frame: any = { type: "user", content };
    if (provider) frame.provider = provider;
    if (model) frame.model = model;
    const soulPrompt = currentJarvisSoulPrompt();
    if (soulPrompt) frame.soul_prompt = soulPrompt;
    if (!sendFrame(frame)) {
      store.setInFlight(false);
      return;
    }
    pushUser(content);
    setValue("");
    clearPaste();
    store.setUsage({ prompt: 0, completion: 0, cached: 0, reasoning: 0, calls: 0 });
  };

  return (
    <form
      id="input-form"
      autoComplete="off"
      onSubmit={(e) => { e.preventDefault(); submit(); }}
    >
      <AutoActivatedSkillsChip />
      <div className="input-wrapper">
        <textarea
          id="input"
          ref={taRef}
          rows={1}
          placeholder={t("inputPlaceholder")}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onPaste={(e) => {
            const text = e.clipboardData?.getData("text") || "";
            if (text.length < PASTE_THRESHOLD_BYTES) return;
            e.preventDefault();
            const placeholder = addPaste(text);
            const ta = e.currentTarget;
            const start = ta.selectionStart ?? value.length;
            const end = ta.selectionEnd ?? value.length;
            const next = value.slice(0, start) + placeholder + value.slice(end);
            setValue(next);
            // Restore caret after the placeholder. requestAnimationFrame
            // because React commits the value first.
            requestAnimationFrame(() => {
              if (taRef.current) {
                const caret = start + placeholder.length;
                taRef.current.setSelectionRange(caret, caret);
              }
            });
          }}
          onKeyDown={(e) => {
            if (composingRef.current || e.nativeEvent.isComposing) {
              return;
            }
            if (slashOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSlashIdx((i) => (i + 1) % filtered.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSlashIdx((i) => (i - 1 + filtered.length) % filtered.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                acceptSlash(filtered[slashIdx]);
                return;
              }
            }
            // Tab (no modifiers) cycles the permission mode, but only
            // when the slash palette is closed so it doesn't steal the
            // palette's accept-selection Tab above. Shift/Alt/Ctrl/Meta
            // Tab is left alone (browser focus traversal).
            if (
              e.key === "Tab" &&
              !slashOpen &&
              !e.shiftKey &&
              !e.altKey &&
              !e.ctrlKey &&
              !e.metaKey
            ) {
              e.preventDefault();
              cyclePermissionMode();
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              if (useAppStore.getState().inFlight) {
                return;
              }
              e.preventDefault();
              submit();
            }
          }}
        />
        <StopButton />
        <SendButton />
        <SlashPalette
          open={slashOpen}
          commands={filtered}
          index={slashIdx}
          onHover={setSlashIdx}
          onPick={acceptSlash}
        />
      </div>
      <div className="composer-hint-row" aria-hidden="true">
        <span className={"input-hint" + (value.length === 0 ? " visible" : "")}>
          {t("composerInputSendHint")}
        </span>
        {slashOpen ? (
          <span className="slash-command-count">
            {t("composerSlashCommandsCount", filtered.length)}
          </span>
        ) : null}
      </div>
      {metaChildren && <div className="composer-meta">{metaChildren}</div>}
    </form>
  );
}
