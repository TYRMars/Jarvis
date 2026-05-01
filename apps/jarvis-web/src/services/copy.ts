// Per-code-block copy affordance for X-Markdown output.
//
// Why this lives in a service instead of a React component:
// `@ant-design/x-markdown` mounts its own `createRoot()` for each
// `<MarkdownView>` instance, so the rendered `<pre>` elements do
// NOT live inside our React tree — we can't slot a button next to
// them with JSX. Instead we observe `#messages` for additions, wrap
// every fresh `<pre>` we own in a `.md-code-wrap`, and let click
// delegation route the `.md-code-copy` button back here.
//
// Whole-message copy moved to `<MessageActions>` (a real React
// component). This file no longer touches `.msg-copy-btn`.

import { t } from "../utils/i18n";

export function installCodeBlockCopyAffordances(): void {
  const messages = document.getElementById("messages");
  if (!messages) {
    console.warn("installCodeBlockCopyAffordances: #messages not in DOM yet");
    return;
  }
  messages.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const codeBtn = target.closest<HTMLElement>(".md-code-copy");
    if (codeBtn) {
      e.stopPropagation();
      const wrap = codeBtn.closest(".md-code-wrap");
      const pre = wrap?.querySelector("pre, code");
      const text = pre?.textContent || "";
      copyToClipboard(text, codeBtn);
    }
  });

  const obs = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType === 1) augmentCodeBlocks(n as Element);
      });
    }
  });
  obs.observe(messages, { childList: true, subtree: true });
}

function augmentCodeBlocks(root: Element): void {
  // Wrap any `<pre>` we own that doesn't already have a copy
  // affordance. Tool / fs-write / approval-args / diff lines have
  // their own readers (or aren't really "code") — skip them so we
  // don't duplicate buttons or wrap the wrong thing.
  const pres: HTMLElement[] = root instanceof HTMLElement && root.matches("pre")
    ? [root]
    : Array.from(root.querySelectorAll<HTMLElement>("pre"));
  for (const pre of pres) {
    if (pre.dataset.copyAugmented) continue;
    if (pre.classList.contains("tool-pre")) continue;
    if (pre.classList.contains("fs-write-pre")) continue;
    if (pre.classList.contains("args")) continue;
    // Only wrap pres that live inside a markdown body (assistant
    // text, help cards). Stops us touching arbitrary `<pre>`
    // elsewhere on the page.
    if (!pre.closest(".markdown-body")) continue;
    pre.dataset.copyAugmented = "1";
    const wrap = document.createElement("div");
    wrap.className = "md-code-wrap";
    pre.replaceWith(wrap);
    wrap.appendChild(pre);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "md-code-copy";
    btn.title = t("copy");
    btn.setAttribute("aria-label", t("copy"));
    btn.textContent = t("copy");
    wrap.appendChild(btn);
  }
}

/// Copy `text` to the clipboard. Optionally flashes "copied!" on
/// `sourceBtn` (used by the code-block delegation above; React
/// callers like `<MessageActions>` own their own flash state and
/// pass no button). Falls back to a `textarea`-based hack on
/// browsers without `navigator.clipboard` (file://, old Safari)
/// so the affordance never silently no-ops.
export function copyToClipboard(text: string, sourceBtn?: HTMLElement): void {
  const flash = (label: string) => {
    if (!sourceBtn) return;
    const original = sourceBtn.textContent;
    sourceBtn.textContent = label;
    sourceBtn.classList.add("flash");
    setTimeout(() => {
      sourceBtn.textContent = original || "";
      sourceBtn.classList.remove("flash");
    }, 900);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(() => flash(t("copied")))
      .catch(() => fallbackCopy(text, flash));
  } else {
    fallbackCopy(text, flash);
  }
}

function fallbackCopy(text: string, flash: (s: string) => void) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    flash(t("copied"));
  } catch {
    flash(t("copyFailed"));
  } finally {
    document.body.removeChild(ta);
  }
}
