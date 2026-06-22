// Composer = textarea + send/stop + slash palette + paste folding.
// Source of truth: `composerValue` in the store. The form keeps its
// historical id (`input-form`) and textarea id (`input`) so legacy
// CSS / focus calls (`document.getElementById("input")?.focus()`)
// continue to work; the submit handler is the React `onSubmit`.

import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
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
import { isDesktopRuntime } from "../../services/desktop";
import { FileText, Icon, Image as ImageIcon, X } from "../ui";

const PASTE_THRESHOLD_BYTES = 2048;
const ATTACHMENT_TEXT_LIMIT_BYTES = 256 * 1024;
const ATTACHMENT_IMAGE_DATA_LIMIT_BYTES = 2 * 1024 * 1024;
const ATTACHMENT_TEXT_CHAR_LIMIT = 220_000;

type ComposerAttachmentStatus = "loading" | "ready" | "error";
type ComposerAttachmentKind = "text" | "image" | "binary";

interface ComposerAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  kind: ComposerAttachmentKind;
  status: ComposerAttachmentStatus;
  payload?: string;
  previewUrl?: string;
  error?: string;
}

interface Props {
  /// Slash commands the host wires in. Composer doesn't know what
  /// any of them do; selection just calls `run()`. Lazy because the
  /// host (legacy controller) populates the table during boot —
  /// after React has already rendered.
  slashCommands: () => SlashCommand[];
  /// Picked routing for the current send. Keeps Composer agnostic
  /// of how the model menu chooses values.
  pickedRouting: () => { provider: string | null; model: string | null };
  /// `<div class="composer-meta">` children — the action toolbar
  /// (mode chip / utility buttons / model · effort · context ring).
  /// Claude-Code layout: rendered as a transparent row BELOW the input
  /// box (outside the rounded wrapper), not inside it.
  metaChildren?: React.ReactNode;
  /// Rendered as the context bar ABOVE the input box (outside the
  /// rounded wrapper) — the Claude-Code-style project · branch · diff ·
  /// CI top bar (`ComposerShoulder` in-session / `ComposerProjectRail`
  /// in the draft state).
  contextRow?: React.ReactNode;
}

export function Composer({ slashCommands, pickedRouting, metaChildren, contextRow }: Props) {
  const value = useAppStore((s) => s.composerValue);
  const setValue = useAppStore((s) => s.setComposerValue);
  const composerHistory = useAppStore((s) => s.composerHistory);
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
  const pushComposerHistory = useAppStore((s) => s.pushComposerHistory);
  const gcPaste = useAppStore((s) => s.gcPastedBlobs);
  const expandPaste = useAppStore((s) => s.expandPastedPlaceholders);
  const clearPaste = useAppStore((s) => s.clearPastedBlobs);

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashDismissedValue, setSlashDismissedValue] = useState<string | null>(null);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const historyDraftRef = useRef("");
  const placeholder = isDesktopRuntime() ? t("inputPlaceholderDesktop") : t("inputPlaceholder");
  const attachmentPending = attachments.some((attachment) => attachment.status !== "ready");
  const canSend = !attachmentPending && (Boolean(value.trim()) || attachments.length > 0);

  const focusTextareaFromShell = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return;
    if (target.closest("button,a,input,textarea,select,[role='menu'],[contenteditable='true']")) {
      return;
    }
    taRef.current?.focus();
  };

  // Auto-grow textarea height with content.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    resizeComposerTextarea(ta);
  }, [value]);

  // GC pasted blobs when their placeholder vanishes from the textarea.
  useEffect(() => { gcPaste(); }, [value, gcPaste]);

  useEffect(() => {
    const onOpenSlashMenu = () => {
      setSlashDismissedValue(null);
      setSlashIdx(0);
      setValue(value.trim().startsWith("/") ? value : "/");
      requestAnimationFrame(() => {
        taRef.current?.focus();
        const pos = taRef.current?.value.length ?? 0;
        taRef.current?.setSelectionRange(pos, pos);
      });
    };
    window.addEventListener("jarvis:composer-open-slash", onOpenSlashMenu);
    return () => window.removeEventListener("jarvis:composer-open-slash", onOpenSlashMenu);
  }, [setValue, value]);

  useEffect(() => {
    const onPickFiles = () => {
      fileInputRef.current?.click();
    };
    window.addEventListener("jarvis:composer-pick-files", onPickFiles);
    return () => window.removeEventListener("jarvis:composer-pick-files", onPickFiles);
  }, []);

  const filtered = (() => {
    if (!value.startsWith("/")) return [] as SlashCommand[];
    const prefix = value.split(/\s/, 1)[0].toLowerCase();
    if (value.length > prefix.length && /\s/.test(value[prefix.length] ?? "")) {
      return [] as SlashCommand[];
    }
    return slashCommands().filter((c) => c.cmd.startsWith(prefix));
  })();
  const slashOpen = filtered.length > 0 && slashDismissedValue !== value;

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

  const addFiles = (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    const pending = files.map((file) => ({
      file,
      attachment: {
        id: makeAttachmentId(),
        name: file.name || t("composerAttachmentUnnamed"),
        type: file.type || t("composerAttachmentUnknownType"),
        size: file.size,
        kind: attachmentKindFor(file),
        status: "loading" as const,
      },
    }));
    setAttachments((current) => [...current, ...pending.map((item) => item.attachment)]);
    requestAnimationFrame(() => taRef.current?.focus());
    for (const item of pending) {
      void readAttachment(item.file)
        .then((payload) => {
          setAttachments((current) => current.map((attachment) => (
            attachment.id === item.attachment.id
              ? { ...attachment, ...payload, status: "ready" }
              : attachment
          )));
        })
        .catch((error) => {
          setAttachments((current) => current.map((attachment) => (
            attachment.id === item.attachment.id
              ? {
                ...attachment,
                status: "error",
                error: String(error?.message || error || t("composerAttachmentReadFailed")),
              }
              : attachment
          )));
        });
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  };

  const buildContent = (raw: string) => {
    if (attachments.length === 0) return expandPaste(raw);
    const attached = attachments
      .filter((attachment) => attachment.status === "ready")
      .map(formatAttachmentForPrompt)
      .join("\n\n");
    const body = [raw, attached ? `${t("composerAttachmentPromptHeading")}:\n\n${attached}` : ""]
      .filter(Boolean)
      .join("\n\n");
    return expandPaste(body);
  };

  const buildVisibleUserContent = (raw: string) => {
    const prompt = expandPaste(raw);
    if (attachments.length === 0) return prompt;
    const summary = attachments
      .filter((attachment) => attachment.status === "ready")
      .map(formatAttachmentSummary)
      .join("\n");
    return [
      prompt,
      summary ? `${t("composerAttachmentPromptHeading")}:\n${summary}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  };

  const submit = () => {
    // Read the gate from the live store (not the captured selector)
    // so a quick second submit in the same render tick — Enter
    // autorepeat, double-click, paste-and-Enter on a touchpad — sees
    // the just-set in-flight flag instead of the stale `false`.
    const store = useAppStore.getState();
    if (store.inFlight) return;
    const raw = value.trim();
    if (!raw && attachments.length === 0) return;
    const pendingAttachment = attachments.find((attachment) => attachment.status !== "ready");
    if (pendingAttachment) {
      showBanner(
        pendingAttachment.status === "loading"
          ? t("composerAttachmentStillLoading", pendingAttachment.name)
          : t("composerAttachmentNeedsRemoval", pendingAttachment.name),
      );
      return;
    }
    const content = buildContent(raw);
    const visibleContent = buildVisibleUserContent(raw);
    const historyEntry = expandPaste(raw);
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
      pushComposerHistory(historyEntry);
      pushUser(visibleContent, content);
      setValue("");
      setHistoryIdx(null);
      historyDraftRef.current = "";
      setAttachments([]);
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
    pushComposerHistory(historyEntry);
    pushUser(visibleContent, content);
    setValue("");
    setHistoryIdx(null);
    historyDraftRef.current = "";
    setAttachments([]);
    clearPaste();
    store.setUsage({ prompt: 0, completion: 0, cached: 0, reasoning: 0, calls: 0 });
  };

  const recallHistory = (direction: "prev" | "next") => {
    if (composerHistory.length === 0) return false;
    if (direction === "prev") {
      const nextIdx = historyIdx == null
        ? composerHistory.length - 1
        : Math.max(0, historyIdx - 1);
      if (historyIdx == null) historyDraftRef.current = value;
      setHistoryIdx(nextIdx);
      setValue(composerHistory[nextIdx]);
      requestAnimationFrame(() => {
        const pos = taRef.current?.value.length ?? 0;
        taRef.current?.setSelectionRange(pos, pos);
      });
      return true;
    }
    if (historyIdx == null) return false;
    if (historyIdx >= composerHistory.length - 1) {
      setHistoryIdx(null);
      setValue(historyDraftRef.current);
      requestAnimationFrame(() => {
        const pos = taRef.current?.value.length ?? 0;
        taRef.current?.setSelectionRange(pos, pos);
      });
      return true;
    }
    const nextIdx = historyIdx + 1;
    setHistoryIdx(nextIdx);
    setValue(composerHistory[nextIdx]);
    requestAnimationFrame(() => {
      const pos = taRef.current?.value.length ?? 0;
      taRef.current?.setSelectionRange(pos, pos);
    });
    return true;
  };

  return (
    <form
      id="input-form"
      autoComplete="off"
      onSubmit={(e) => { e.preventDefault(); submit(); }}
    >
      <AutoActivatedSkillsChip />
      <div
        className={"input-wrapper" + (draggingFiles ? " is-dragging-files" : "")}
        onMouseDown={(e) => {
          focusTextareaFromShell(e.target);
        }}
        onDragEnter={(e: DragEvent<HTMLDivElement>) => {
          if (!eventHasFiles(e)) return;
          e.preventDefault();
          setDraggingFiles(true);
        }}
        onDragOver={(e: DragEvent<HTMLDivElement>) => {
          if (!eventHasFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(e: DragEvent<HTMLDivElement>) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDraggingFiles(false);
        }}
        onDrop={(e: DragEvent<HTMLDivElement>) => {
          if (!eventHasFiles(e)) return;
          e.preventDefault();
          setDraggingFiles(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <input
          ref={fileInputRef}
          className="composer-file-input"
          type="file"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            if (e.currentTarget.files) addFiles(e.currentTarget.files);
            e.currentTarget.value = "";
          }}
        />
        {attachments.length > 0 ? (
          <div className="composer-attachment-strip" aria-label={t("composerAttachmentsLabel")}>
            {attachments.map((attachment) => (
              <div
                key={attachment.id}
                className={"composer-attachment-chip is-" + attachment.status}
                title={attachmentTooltip(attachment)}
              >
                {attachment.previewUrl ? (
                  <img
                    className="composer-attachment-thumb"
                    src={attachment.previewUrl}
                    alt={t("composerAttachmentPreviewAlt", attachment.name)}
                  />
                ) : (
                  <Icon icon={attachment.kind === "image" ? ImageIcon : FileText} size={15} />
                )}
                <span className="composer-attachment-name">{attachment.name}</span>
                <span className="composer-attachment-meta">
                  {attachment.status === "loading"
                    ? t("composerAttachmentLoading")
                    : attachment.status === "error"
                      ? t("composerAttachmentError")
                      : formatBytes(attachment.size)}
                </span>
                <button
                  type="button"
                  className="composer-attachment-remove"
                  aria-label={t("composerAttachmentRemove", attachment.name)}
                  onClick={() => removeAttachment(attachment.id)}
                >
                  <Icon icon={X} size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="composer-editor-row">
          <textarea
            id="input"
            ref={taRef}
            rows={1}
            placeholder={placeholder}
            value={value}
            onChange={(e) => {
              setHistoryIdx(null);
              historyDraftRef.current = "";
              setValue(e.target.value);
            }}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onPaste={(e) => {
              if (e.clipboardData?.files?.length) {
                e.preventDefault();
                addFiles(e.clipboardData.files);
                return;
              }
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
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setSlashDismissedValue(value);
                  return;
                }
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
              if (
                !slashOpen &&
                !e.shiftKey &&
                !e.altKey &&
                !e.ctrlKey &&
                !e.metaKey &&
                (e.key === "ArrowUp" || e.key === "ArrowDown") &&
                (value.trim() === "" || historyIdx != null)
              ) {
                const handled = recallHistory(e.key === "ArrowUp" ? "prev" : "next");
                if (handled) {
                  e.preventDefault();
                  return;
                }
              }
              if (
                !slashOpen &&
                !e.shiftKey &&
                !e.altKey &&
                !e.ctrlKey &&
                !e.metaKey &&
                (e.key === "Backspace" || e.key === "Delete") &&
                value.length === 0 &&
                attachments.length > 0
              ) {
                e.preventDefault();
                removeAttachment(attachments[attachments.length - 1].id);
                return;
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
          <SendButton canSend={canSend} />
        </div>
        <SlashPalette
          open={slashOpen}
          commands={filtered}
          index={slashIdx}
          onHover={setSlashIdx}
          onPick={acceptSlash}
        />
        {metaChildren && <div className="composer-meta">{metaChildren}</div>}
      </div>
      {contextRow ? <div className="composer-context-row">{contextRow}</div> : null}
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
    </form>
  );
}

function makeAttachmentId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function attachmentKindFor(file: File): ComposerAttachmentKind {
  if (file.type.startsWith("image/")) return "image";
  if (isTextLikeFile(file)) return "text";
  return "binary";
}

export function resizeComposerTextarea(ta: HTMLTextAreaElement) {
  ta.style.height = "auto";
  const maxHeight = parseCssPx(getComputedStyle(ta).maxHeight);
  const nextHeight = maxHeight == null
    ? ta.scrollHeight
    : Math.min(ta.scrollHeight, maxHeight);
  ta.style.height = nextHeight + "px";
  ta.style.overflowY = maxHeight != null && ta.scrollHeight > maxHeight ? "auto" : "hidden";
}

function parseCssPx(value: string) {
  if (!value || value === "none") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTextLikeFile(file: File) {
  if (file.type.startsWith("text/")) return true;
  if (/\/(json|xml|yaml|x-yaml|javascript|typescript|csv|markdown)$/i.test(file.type)) return true;
  return /\.(txt|md|markdown|json|jsonl|csv|tsv|xml|yaml|yml|toml|ini|env|log|js|jsx|ts|tsx|css|scss|html|py|rs|go|java|kt|swift|rb|php|sh|zsh|fish|sql)$/i.test(file.name);
}

async function readAttachment(file: File): Promise<Partial<ComposerAttachment>> {
  const kind = attachmentKindFor(file);
  if (kind === "text") {
    const text = typeof file.text === "function" ? await file.text() : await readFileAsText(file);
    const truncated = file.size > ATTACHMENT_TEXT_LIMIT_BYTES || text.length > ATTACHMENT_TEXT_CHAR_LIMIT;
    const body = truncated ? text.slice(0, ATTACHMENT_TEXT_CHAR_LIMIT) : text;
    return {
      kind,
      payload: [
        `<attached-file name="${escapeAttr(file.name)}" type="${escapeAttr(file.type || "text/plain")}" size="${file.size}">`,
        body,
        truncated ? `\n[Truncated after ${formatBytes(ATTACHMENT_TEXT_LIMIT_BYTES)}]` : "",
        "</attached-file>",
      ].join("\n"),
    };
  }
  if (kind === "image") {
    if (file.size <= ATTACHMENT_IMAGE_DATA_LIMIT_BYTES) {
      const dataUrl = await readFileAsDataUrl(file);
      return {
        kind,
        previewUrl: dataUrl,
        payload: [
          `<attached-image name="${escapeAttr(file.name)}" type="${escapeAttr(file.type || "image")}" size="${file.size}">`,
          dataUrl,
          "</attached-image>",
        ].join("\n"),
      };
    }
    return {
      kind,
      payload: `<attached-image name="${escapeAttr(file.name)}" type="${escapeAttr(file.type || "image")}" size="${file.size}">\n[Image omitted because it is larger than ${formatBytes(ATTACHMENT_IMAGE_DATA_LIMIT_BYTES)}]\n</attached-image>`,
    };
  }
  return {
    kind,
    payload: `<attached-file name="${escapeAttr(file.name)}" type="${escapeAttr(file.type || "application/octet-stream")}" size="${file.size}">\n[Binary file attached; content is not embedded in this text-only request]\n</attached-file>`,
  };
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(fileReaderResultToString(reader.result));
    reader.onerror = () => reject(reader.error || new Error(t("composerAttachmentReadFailed")));
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(fileReaderResultToString(reader.result));
    reader.onerror = () => reject(reader.error || new Error(t("composerAttachmentReadFailed")));
    reader.readAsText(file);
  });
}

function fileReaderResultToString(result: string | ArrayBuffer | null) {
  if (typeof result === "string") return result;
  if (result instanceof ArrayBuffer) return new TextDecoder().decode(result);
  return "";
}

function formatAttachmentForPrompt(attachment: ComposerAttachment) {
  return attachment.payload || `<attached-file name="${escapeAttr(attachment.name)}" type="${escapeAttr(attachment.type)}" size="${attachment.size}" />`;
}

function formatAttachmentSummary(attachment: ComposerAttachment) {
  return `- ${attachment.name} (${formatBytes(attachment.size)})`;
}

function escapeAttr(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0).replace(/\.0$/, "")} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0).replace(/\.0$/, "")} MB`;
}

function eventHasFiles(e: DragEvent<HTMLElement>) {
  return Array.from(e.dataTransfer?.types || []).includes("Files");
}

function attachmentTooltip(attachment: ComposerAttachment) {
  if (attachment.status === "error") return attachment.error || t("composerAttachmentError");
  return `${attachment.name} · ${formatBytes(attachment.size)}`;
}
