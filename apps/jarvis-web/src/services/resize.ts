// Drag-to-resize handles. Sidebar / approval-panel widths are CSS
// vars on `:root`; we just `setProperty` on drag and persist to
// localStorage so the layout is sticky across reloads. Min/max
// clamp keeps the layout from collapsing or eating the chat column.
//
// Use:
//   installResize("resize-sidebar", "--sidebar-width", "jarvis.layout.sidebar", 200, 520);
//   installResize("resize-rail", "--rail-width", "jarvis.layout.rail", 240, 600, true);
// (true = "rail grows leftward when dragged left" — flips the delta
// sign so the right-side panel feels right.)

export function installResize(
  handleId: string,
  cssVar: string,
  storageKey: string,
  min: number,
  max: number,
  invert: boolean = false,
): void {
  const handle = document.getElementById(handleId);
  if (!handle) return;
  // Restore last persisted width on first install.
  const saved = parseInt(localStorage.getItem(storageKey) || "", 10);
  if (Number.isFinite(saved) && saved >= min && saved <= max) {
    document.documentElement.style.setProperty(cssVar, `${saved}px`);
  }
  handle.addEventListener("mousedown", (e: MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const initial = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim() || "0",
      10,
    );
    document.body.classList.add("resizing");
    const onMove = (m: MouseEvent) => {
      const delta = m.clientX - startX;
      // Sidebar grows when dragged right; rail (right side) grows
      // when dragged left, so we invert the sign.
      const next = initial + (invert ? -delta : delta);
      const clamped = Math.max(min, Math.min(max, next));
      document.documentElement.style.setProperty(cssVar, `${clamped}px`);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing");
      const final = parseInt(
        getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim() || "0",
        10,
      );
      if (Number.isFinite(final)) localStorage.setItem(storageKey, String(final));
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
  // Double-click resets to default (clears the localStorage entry
  // and removes the inline override so the CSS default takes over).
  handle.addEventListener("dblclick", () => {
    localStorage.removeItem(storageKey);
    document.documentElement.style.removeProperty(cssVar);
  });
}
