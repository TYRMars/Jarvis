// Composer = textarea + send/stop + slash palette + paste folding.
// Source of truth: `composerValue` in the store. The form keeps its
// historical id (`input-form`) and textarea id (`input`) so legacy
// CSS / focus calls (`document.getElementById("input")?.focus()`)
// continue to work; the submit handler is the React `onSubmit`.

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { t } from "../../utils/i18n";
import { SendButton, StopButton } from "../ComposerButtons";
import { SlashPalette, type SlashCommand } from "./SlashPalette";
import { sendFrame, isOpen } from "../../services/socket";

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
    return slashCommands().filter((c) => c.cmd.startsWith(prefix));
  })();
  const slashOpen = filtered.length > 0;

  // Reset slashIdx when the filtered list shrinks.
  useEffect(() => {
    if (slashIdx >= filtered.length) setSlashIdx(0);
  }, [filtered.length, slashIdx]);

  const acceptSlash = (cmd: SlashCommand) => {
    setValue("");
    try { cmd.run(); }
    catch (e: any) { showBanner(String(e?.message || e)); }
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
    if (!isOpen()) {
      showBanner(t("websocketNotConnected"));
      return;
    }
    // Flip the gate FIRST so the second click bails before pushing
    // a duplicate user bubble. Roll back if the WS send actually
    // fails — the user shouldn't be locked out by a closed socket.
    store.setInFlight(true);
    const content = expandPaste(raw);
    const { provider, model } = pickedRouting();
    const frame: any = { type: "user", content };
    if (provider) frame.provider = provider;
    if (model) frame.model = model;
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
      <div className="input-wrapper">
        <textarea
          id="input"
          ref={taRef}
          rows={1}
          placeholder={t("inputPlaceholder")}
          value={value}
          onChange={(e) => setValue(e.target.value)}
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
            if (e.key === "Enter" && !e.shiftKey) {
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
      {metaChildren && <div className="composer-meta">{metaChildren}</div>}
    </form>
  );
}
