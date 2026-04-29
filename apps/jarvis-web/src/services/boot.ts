// One-shot boot sequence. Called from `<App>`'s mount effect:
//
//   1. Push the persisted theme / lang / rail state into the store
//      so body classes / `<html data-theme>` are in sync on first
//      paint (before React commits the first render of children
//      that subscribe to those slices).
//   2. Walk the static `data-i18n` markers App.tsx ships with so
//      the sidebar mode-row / account placeholder etc. translate.
//   3. Wire copy-to-clipboard affordances (markdown blocks etc.).
//   4. Populate the composer bridge so `<Composer>` / `<ConvoRow>`
//      can fan into convo lifecycle helpers without import cycles.
//   5. Fetch the provider catalog + initial convo list, then open
//      the WebSocket.

import { appStore } from "../store/appStore";
import { t } from "../utils/i18n";
import { installCopyAffordances } from "./copy";
import { installResize } from "./resize";
import { setStatus } from "./status";
import { apiUrl } from "./api";
import { connect, installConnectivityListeners } from "./socket";
import { refreshConvoList } from "./conversations";
import { loadProviders } from "./providers";
import { refreshProjects } from "./projects";

let booted = false;

/// Idempotent — React Strict Mode mounts effects twice in dev, and
/// we only want to open one WebSocket / register one set of side-
/// effects. Persisted preferences are seeded into the store at
/// `create()` time (see `store/appStore.ts`); this function only
/// runs the side-effects that have to wait until the DOM exists.
export function boot(): void {
  if (booted) return;
  booted = true;

  // 1. Mirror the persisted theme + lang into the DOM (the store
  //    seeded its values at construction; the actions that write
  //    `<html>` attributes need to run again now that the DOM is
  //    live).
  const s = appStore.getState();
  s.setTheme(s.theme);
  s.setLang(s.lang);
  s.setSidebarOpen(s.sidebarOpen);
  s.setWorkspaceRailOpen(s.workspaceRailOpen);
  s.setPlanCardOpen(s.planCardOpen);

  // 2. Translate the static `data-i18n` surfaces.
  applyI18n();

  // 3. Copy affordances on `<pre>` blocks etc.
  installCopyAffordances();

  // 4. Sidebar / approval-rail width drag handles.
  installResize("resize-sidebar", "--sidebar-width", "jarvis.layout.sidebar", 200, 520);
  installResize("resize-rail", "--rail-width", "jarvis.layout.rail", 320, 760, /*invert=*/ true);

  // 5. Network + WS — fire-and-forget; failures surface through the
  //    store's banner.
  void loadProviders(apiUrl);
  void refreshConvoList();
  void refreshProjects();
  installConnectivityListeners();
  connect();
}

/// Walk `[data-i18n]`, `[data-i18n-placeholder]`, `[data-i18n-title]`
/// nodes and replace their text/attribute with the translated string.
/// Only for the static App.tsx markup that hasn't been swapped to
/// `{t(...)}` JSX yet — React-rendered surfaces re-translate
/// reactively from `store.lang`.
export function applyI18n(): void {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((node) => {
    if (node.dataset.i18n) node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-placeholder]").forEach((node) => {
    if (node.dataset.i18nPlaceholder)
      node.setAttribute("placeholder", t(node.dataset.i18nPlaceholder));
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((node) => {
    if (node.dataset.i18nTitle)
      node.setAttribute("title", t(node.dataset.i18nTitle));
  });
  const cur = appStore.getState();
  if (cur.statusKey) setStatus(cur.statusKey, cur.statusClass);
}
