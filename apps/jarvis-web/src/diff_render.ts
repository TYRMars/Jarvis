// Render `fs.edit` tool arguments as a unified diff card.
//
// `fs.edit` ships `{path, old_string, new_string, replace_all}`. The
// raw <pre> dump is barely readable for anything more than a one-line
// change; this module turns it into a Claude Code-style diff view
// with line numbers, context preservation, and red/green highlighting.

import { diffLines, Change } from "diff";

const CONTEXT_LINES = 3; // lines kept around each change hunk

interface DiffRow {
  kind: "ctx" | "del" | "add" | "gap";
  text: string;
  oldNo?: number;
  newNo?: number;
}

/// Build a flat list of rows representing the patch from `oldText` to
/// `newText`. Long unchanged stretches collapse into a single `gap`
/// row so the model's intent stays visible without forcing the user
/// to scroll past 200 lines of context.
export function buildDiffRows(oldText: string, newText: string): DiffRow[] {
  const changes: Change[] = diffLines(oldText, newText);
  const rows: DiffRow[] = [];

  // Pre-flatten: each change becomes one row per line so we can apply
  // context windowing uniformly.
  type Tok = { kind: "ctx" | "del" | "add"; text: string };
  const toks: Tok[] = [];
  for (const c of changes) {
    const lines = stripTrailingNewline(c.value).split("\n");
    const kind: Tok["kind"] = c.added ? "add" : c.removed ? "del" : "ctx";
    for (const line of lines) toks.push({ kind, text: line });
  }

  // Mark which context lines are "near a change" — keep those, collapse the rest.
  const keep = new Array<boolean>(toks.length).fill(false);
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].kind !== "ctx") {
      for (
        let j = Math.max(0, i - CONTEXT_LINES);
        j <= Math.min(toks.length - 1, i + CONTEXT_LINES);
        j++
      ) {
        keep[j] = true;
      }
    }
  }

  let oldNo = 0;
  let newNo = 0;
  let gappedSinceLastKept = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const advanceOld = t.kind !== "add";
    const advanceNew = t.kind !== "del";
    if (advanceOld) oldNo++;
    if (advanceNew) newNo++;
    if (!keep[i] && t.kind === "ctx") {
      gappedSinceLastKept++;
      continue;
    }
    if (gappedSinceLastKept > 0) {
      rows.push({ kind: "gap", text: `… ${gappedSinceLastKept} unchanged line${gappedSinceLastKept === 1 ? "" : "s"} …` });
      gappedSinceLastKept = 0;
    }
    rows.push({
      kind: t.kind,
      text: t.text,
      oldNo: advanceOld ? oldNo : undefined,
      newNo: advanceNew ? newNo : undefined,
    });
  }
  if (gappedSinceLastKept > 0) {
    rows.push({ kind: "gap", text: `… ${gappedSinceLastKept} unchanged line${gappedSinceLastKept === 1 ? "" : "s"} …` });
  }
  return rows;
}

function stripTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}

/// Build the DOM tree for a `fs.edit` diff card. Caller appends it
/// where the plain `pre.tool-pre` would otherwise have gone.
export function renderEditDiff(
  args: { path?: string; old_string?: string; new_string?: string; replace_all?: boolean },
  el: (tag: string, attrs?: any, children?: any) => HTMLElement,
  t: (key: string, ...rest: any[]) => string,
): HTMLElement {
  const path = args.path || "?";
  const oldText = args.old_string || "";
  const newText = args.new_string || "";
  const replaceAll = !!args.replace_all;

  const container = el("div", { class: "diff-card" });

  // Header: file path + replace_all badge if set.
  const header = el("div", { class: "diff-header" }, [
    el("span", { class: "diff-path", text: path }),
  ]);
  if (replaceAll) {
    header.appendChild(el("span", { class: "diff-badge", text: t("replaceAll") }));
  }
  container.appendChild(header);

  const rows = buildDiffRows(oldText, newText);
  const body = el("div", { class: "diff-body" });

  for (const r of rows) {
    if (r.kind === "gap") {
      body.appendChild(el("div", { class: "diff-row gap" }, [
        el("span", { class: "diff-gutter" }, []),
        el("span", { class: "diff-line", text: r.text }),
      ]));
      continue;
    }
    const sign = r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ";
    body.appendChild(el("div", { class: `diff-row ${r.kind}` }, [
      el("span", { class: "diff-lineno old", text: r.oldNo == null ? "" : String(r.oldNo) }),
      el("span", { class: "diff-lineno new", text: r.newNo == null ? "" : String(r.newNo) }),
      el("span", { class: "diff-sign", text: sign }),
      el("span", { class: "diff-line", text: r.text || " " }),
    ]));
  }
  container.appendChild(body);

  return container;
}
