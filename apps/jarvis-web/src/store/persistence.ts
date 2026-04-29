// localStorage-backed persistence helpers + initial-value loaders.
//
// Convention:
//   - `jarvis.<feature>` for whole-app preferences (lang/theme/effort).
//   - `jarvis.convo.<feature>` for per-conversation client-side
//     metadata (pinned set, title overrides, model routing).
//   - `jarvis.layout.<feature>` for resizable column widths
//     (`services/resize.ts` writes these directly).
//   - `jarvis.workspaceRailOpen` / `jarvis.planCardOpen` for UI toggles.
//
// The store seeds itself from the `loadX()` helpers at startup;
// the `saveX()` helpers are called inside store actions whenever
// the matching slice changes. This module deliberately knows
// nothing about Zustand — keeps the persistence layer testable on
// its own and easy to swap (IndexedDB, server-side sync, …) later.

import type { ConvoListRow } from "../types/frames";
import { appStore } from "./appStore";

export type Theme = "light" | "dark";
export type Lang = "en" | "zh";

export interface JarvisSoulConfig {
  enabled: boolean;
  name: string;
  identity: string;
  tone: string;
  principles: string;
  boundaries: string;
}

export const DEFAULT_JARVIS_SOUL: JarvisSoulConfig = {
  enabled: true,
  name: "Jarvis",
  identity: "A steady, capable AI partner for thinking, building, debugging, and product work.",
  tone: "Warm, concise, curious, and direct. Prefer useful progress over theatrical personality.",
  principles: [
    "Stay honest about uncertainty.",
    "Protect the user's intent and existing work.",
    "Ask only when a choice would materially change the outcome.",
    "Make complex work feel navigable.",
  ].join("\n"),
  boundaries: "Do not pretend to have feelings, memory, access, or authority you do not have.",
};

// ---- Pinned conversations ----------------------------------------

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // jsdom in tests sometimes makes `localStorage` unavailable until
    // the environment is fully bootstrapped — fall through to the
    // empty default rather than crashing the store on creation.
    return null;
  }
}

/// Persist `value` under `key`, swallowing the rare quota-exceeded
/// or private-browsing failures (the in-memory store still works).
/// Co-located with `safeGet` so both load + store sides agree on
/// what counts as "best effort" persistence.
export function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // see safeGet
  }
}

export function loadPinned(): Set<string> {
  try {
    const raw = safeGet("jarvis.convo.pinned");
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

export function savePinned(set: Set<string>): void {
  try {
    localStorage.setItem("jarvis.convo.pinned", JSON.stringify(Array.from(set)));
  } catch {
    // Quota exceeded / private browsing — in-memory still works.
  }
}

// ---- Title overrides ---------------------------------------------

export function loadTitleOverrides(): Record<string, string> {
  try {
    const raw = safeGet("jarvis.convo.titles");
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

export function saveTitleOverrides(map: Record<string, string>): void {
  try {
    localStorage.setItem("jarvis.convo.titles", JSON.stringify(map));
  } catch {
    // see savePinned
  }
}

// ---- Per-conversation routing ------------------------------------
//
// Stored as the canonical `"<provider>|<model>"` string. Switching
// to a chat that started on Anthropic shouldn't silently flip you
// to whatever model you happened to have selected globally a moment
// ago, so we pin routing per-conversation and replay it on resume.

export function loadConvoRouting(): Record<string, string> {
  try {
    const raw = safeGet("jarvis.convo.routing");
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

export function saveConvoRouting(map: Record<string, string>): void {
  try {
    localStorage.setItem("jarvis.convo.routing", JSON.stringify(map));
  } catch {
    // see savePinned
  }
}

// ---- Whole-app preferences ---------------------------------------

export function initialLang(): Lang {
  const saved = safeGet("jarvis.lang");
  if (saved === "en" || saved === "zh") return saved;
  const nav = typeof navigator !== "undefined" ? navigator.language || "" : "";
  return nav.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function initialTheme(): Theme {
  const saved = safeGet("jarvis.theme");
  if (saved === "light" || saved === "dark") return saved;
  const dataset =
    typeof document !== "undefined" ? document.documentElement.dataset.theme : undefined;
  return dataset === "dark" ? "dark" : "light";
}

export function initialEffort(): string {
  return safeGet("jarvis.effort") || "medium";
}

/// Sticky default for the model menu — what new conversations get
/// when there's no per-conversation override saved. Empty string =
/// "let the server's registry default win". Persisted under
/// `jarvis.defaultRouting`; written by `setRouting` only when the
/// user explicitly opts in via the Preferences page (so casual
/// per-turn changes don't accidentally rewrite the default).
export function initialDefaultRouting(): string {
  return safeGet("jarvis.defaultRouting") || "";
}

export function loadJarvisSoul(): JarvisSoulConfig {
  const raw = safeGet("jarvis.soul");
  if (!raw) return DEFAULT_JARVIS_SOUL;
  try {
    const parsed = JSON.parse(raw) || {};
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_JARVIS_SOUL.enabled,
      name: typeof parsed.name === "string" ? parsed.name : DEFAULT_JARVIS_SOUL.name,
      identity: typeof parsed.identity === "string" ? parsed.identity : DEFAULT_JARVIS_SOUL.identity,
      tone: typeof parsed.tone === "string" ? parsed.tone : DEFAULT_JARVIS_SOUL.tone,
      principles: typeof parsed.principles === "string" ? parsed.principles : DEFAULT_JARVIS_SOUL.principles,
      boundaries: typeof parsed.boundaries === "string" ? parsed.boundaries : DEFAULT_JARVIS_SOUL.boundaries,
    };
  } catch {
    return DEFAULT_JARVIS_SOUL;
  }
}

export function saveJarvisSoul(config: JarvisSoulConfig): void {
  safeSet("jarvis.soul", JSON.stringify(config));
}

export function currentJarvisSoulPrompt(): string | null {
  const config = loadJarvisSoul();
  if (!config.enabled) return null;
  const sections = [
    ["Name", config.name],
    ["Identity", config.identity],
    ["Voice", config.tone],
    ["Operating principles", config.principles],
    ["Boundaries", config.boundaries],
  ]
    .map(([label, value]) => [label, value.trim()] as const)
    .filter(([, value]) => value.length > 0);
  if (sections.length === 0) return null;
  return sections.map(([label, value]) => `${label}:\n${value}`).join("\n\n");
}

/// Returns every Jarvis-owned localStorage key — used by the
/// Preferences "clear all" button so the wipe stays in sync with
/// what we actually save (no orphaned keys, no neighbour-app stomping).
export function listJarvisKeys(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("jarvis.")) out.push(k);
    }
  } catch {
    // private browsing — nothing to clear
  }
  return out;
}

/// Drop every `jarvis.*` key from localStorage in one go. Returns
/// the number of keys removed so the caller can surface a count.
export function clearAllJarvisPrefs(): number {
  const keys = listJarvisKeys();
  for (const k of keys) {
    try {
      localStorage.removeItem(k);
    } catch {
      // see safeSet
    }
  }
  return keys.length;
}

export function initialWorkspaceRailOpen(): boolean {
  return safeGet("jarvis.workspaceRailOpen") === "true";
}

export function initialPlanCardOpen(): boolean {
  return safeGet("jarvis.planCardOpen") !== "false";
}

/// Per-panel visibility within the workspace rail. Each panel
/// (`preview` / `diff` / `terminal` / `files` / `tasks` / `plan` /
/// `changeReport`) is independently
/// togglable from the panel-selector dropdown, mirroring Claude
/// Code's view menu.
///
/// **Defaults: all off.** Mirrors the Claude Code first-run
/// experience — the right rail starts empty so the chat surface
/// gets the full width, and the user opts into specific panels via
/// the panel menu. Once enabled, each panel's visibility is
/// remembered per-key in localStorage; users only have to enable
/// what they care about once.
export type WorkspacePanelKey =
  | "preview"
  | "diff"
  | "terminal"
  | "files"
  | "tasks"
  | "plan"
  | "changeReport"
  | "todos";

const PANEL_DEFAULTS: Record<WorkspacePanelKey, boolean> = {
  preview: false,
  diff: false,
  terminal: false,
  files: false,
  tasks: false,
  plan: false,
  changeReport: false,
  todos: false,
};

export function initialWorkspacePanel(key: WorkspacePanelKey): boolean {
  const stored = safeGet(`jarvis.panel.${key}`);
  if (stored === "true") return true;
  if (stored === "false") return false;
  return PANEL_DEFAULTS[key];
}

export function initialSidebarOpen(): boolean {
  return safeGet("jarvis.sidebarOpen") !== "false";
}

// ---- Title resolution --------------------------------------------

/// Resolve a conversation row's displayed title in priority order:
/// user override → server-derived (first user message) → `#<id-prefix>`.
/// Reads `titleOverrides` straight from the store so the result
/// reflects in-flight renames.
export function resolveTitle(row: ConvoListRow): string {
  const overrides = appStore.getState().titleOverrides;
  const o = overrides[row.id];
  if (o && o.trim()) return o;
  return row.title || ("#" + row.id.slice(0, 8));
}
