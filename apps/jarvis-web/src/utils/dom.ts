// Tiny imperative DOM helpers. All other DOM access in the app
// goes through React; this file only survives because the inline
// markdown / diff renderers (`md_render`, `diff_render`) build
// trees with `el()` instead of JSX, and a couple of utilities
// (`pretty`) are shared across non-React surfaces.
//
// The historical `els` cache + `initElements()` were dropped when
// the imperative controller went away — every consumer either
// migrated to React state or reads through a `getElementById` at
// call time.

/// Tiny tagged-template-style DOM factory.
///
/// `props` understands a few sugar keys:
///   - `class: string` → `node.className = ...`
///   - `data: Record<string,string>` → `node.dataset[k] = v`
///   - `text: string` → `node.textContent = ...`
///   - `onclick / onkeydown / on*` → addEventListener
///   - everything else → `setAttribute`
/// `children` accepts strings (text nodes) or Elements.
///
/// `null` children are skipped, which lets callers conditionally
/// include items via `cond && el(...)`.
export function el(
  tag: string,
  props: Record<string, any> = {},
  children: Array<Node | string | null> = [],
): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") (node as any).className = v;
    else if (k === "data")
      for (const [dk, dv] of Object.entries(v)) (node as any).dataset[dk] = dv;
    else if (k === "text") (node as any).textContent = v;
    else if (k.startsWith("on")) (node as any).addEventListener(k.slice(2), v);
    else (node as any).setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

/// Pretty-print arbitrary values as JSON-ish text. Used for the
/// "raw arguments" panes in tool / approval cards. Falls back to
/// `String(value)` when `JSON.stringify` chokes (cyclic refs etc.).
export function pretty(value: any): string {
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}
