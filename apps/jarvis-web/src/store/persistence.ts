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

export function initialWorkspaceRailOpen(): boolean {
  return safeGet("jarvis.workspaceRailOpen") !== "false";
}

export function initialPlanCardOpen(): boolean {
  return safeGet("jarvis.planCardOpen") !== "false";
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
