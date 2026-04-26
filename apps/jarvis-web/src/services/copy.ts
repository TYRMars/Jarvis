// Two copy affordances:
//
//  1. Whole-message copy — `.msg-copy-btn` next to each assistant
//     author label. Click is handled by event delegation on the
//     chat scroller; we read `_body._raw` (the original markdown
//     source) when present so the user gets the prose they expect,
//     not the rendered HTML.
//
//  2. Per-code-block copy — a `MutationObserver` on `#messages`
//     wraps every freshly-mounted `<pre>` from the markdown
//     renderer in a `.md-code-wrap` and adds a hover-revealed
//     `.md-code-copy` button. Skips tool / fs.write / approval-args
//     `<pre>` elements (they have their own affordances).
//
// `installCopyAffordances` is idempotent — call once at boot.

import { el } from "../utils/dom";
import { t } from "../utils/i18n";

/// Body nodes built by markdown / md_render carry the original
/// markdown source on `_raw` so the copy button hands the user the
/// raw text instead of the rendered HTML. Declare it once so the
/// reads below stay typed.
type MsgBody = HTMLElement & { _raw?: string };

export function installCopyAffordances(): void {
  const messages = document.getElementById("messages");
  if (!messages) {
    console.warn("installCopyAffordances: #messages not in DOM yet");
    return;
  }
  messages.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const msgBtn = target.closest<HTMLElement>(".msg-copy-btn");
    if (msgBtn) {
      e.stopPropagation();
      const row = msgBtn.closest<HTMLElement>(".msg-row");
      const body = row?.querySelector<MsgBody>(".msg-body");
      const text = body?._raw || body?.textContent || "";
      copyToClipboard(text, msgBtn);
      return;
    }
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

/// Copy `text` to the clipboard with a transient "copied!" badge
/// flash on the originating button. Falls back to a `textarea`-based
/// hack on browsers without `navigator.clipboard` (file://, old
/// Safari) so the affordance never silently no-ops.
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

/// "Copy whole message" SVG button slotted next to an assistant
/// author label. Click delegation in `installCopyAffordances` reads
/// the row's body text when fired.
export function copyButton(): HTMLElement {
  return el(
    "button",
    {
      type: "button",
      class: "msg-copy-btn",
      title: t("copy"),
      "aria-label": t("copy"),
    },
    [
      el(
        "svg",
        {
          width: "13",
          height: "13",
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          "stroke-width": "1.8",
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        },
        [
          el("rect", { x: "9", y: "9", width: "13", height: "13", rx: "2" }),
          el("path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" }),
        ],
      ),
    ],
  );
}
