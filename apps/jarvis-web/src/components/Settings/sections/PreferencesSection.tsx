// Per-browser preferences. Everything here is saved to localStorage
// and applies on this device only — server-side state is untouched.
//
// Surfaces three categories:
//   1. Default model (sticky default for new conversations).
//   2. Default effort (carries through to providers that honour it).
//   3. Layout toggles (sidebar / workspace rail / plan card).
//
// A "clear all" button at the bottom drops every `jarvis.*` key in
// one go — useful when debugging or handing the browser to someone
// else.

import { useEffect, useState } from "react";
import { useAppStore, type EffortLevel } from "../../../store/appStore";
import { Row, Section } from "./Section";
import { t } from "../../../utils/i18n";
import { confirm, Select } from "../../ui";
import {
  clearAllJarvisPrefs,
  initialDefaultRouting,
  safeSet,
} from "../../../store/persistence";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

const EFFORTS: EffortLevel[] = ["low", "medium", "high", "extra-high", "max"];
const EFFORT_LABEL: Record<EffortLevel, { key: string; fallback: string }> = {
  low: { key: "effortLow", fallback: "Low" },
  medium: { key: "effortMedium", fallback: "Medium" },
  high: { key: "effortHigh", fallback: "High" },
  "extra-high": { key: "effortExtraHigh", fallback: "Extra high" },
  max: { key: "effortMax", fallback: "Max" },
};

export function PreferencesSection({ embedded }: { embedded?: boolean } = {}) {
  const providers = useAppStore((s) => s.providers);
  const effort = useAppStore((s) => s.effort);
  const setEffort = useAppStore((s) => s.setEffort);
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);
  const workspaceRailOpen = useAppStore((s) => s.workspaceRailOpen);
  const setWorkspaceRailOpen = useAppStore((s) => s.setWorkspaceRailOpen);
  const planCardOpen = useAppStore((s) => s.planCardOpen);
  const setPlanCardOpen = useAppStore((s) => s.setPlanCardOpen);
  const setRouting = useAppStore((s) => s.setRouting);

  const [savedDefault, setSavedDefault] = useState<string>("");
  const [draftDefault, setDraftDefault] = useState<string>("");
  const [justSaved, setJustSaved] = useState(false);
  const [justCleared, setJustCleared] = useState<number | null>(null);

  useEffect(() => {
    const v = initialDefaultRouting();
    setSavedDefault(v);
    setDraftDefault(v);
  }, []);

  // Build a flat option list — `<provider>|<model>` per entry plus a
  // synthetic "" for "let the server pick".
  const options: Array<{ value: string; label: string }> = [
    { value: "", label: tx("serverDefault", "(server default)") },
  ];
  for (const p of providers) {
    const seen = new Set<string>();
    for (const m of [p.default_model, ...p.models]) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      options.push({
        value: `${p.name}|${m}`,
        label: `${p.name} · ${m}${m === p.default_model ? " ★" : ""}`,
      });
    }
  }

  const dirty = draftDefault !== savedDefault;
  const onSaveDefault = () => {
    safeSet("jarvis.defaultRouting", draftDefault);
    setSavedDefault(draftDefault);
    // Also apply now to the running session if there's no per-conversation
    // override (best-effort: empty activeId → applies for the next new chat).
    setRouting(draftDefault);
    setJustSaved(true);
    window.setTimeout(() => setJustSaved(false), 1200);
  };
  const onResetDefault = () => {
    safeSet("jarvis.defaultRouting", "");
    setDraftDefault("");
    setSavedDefault("");
  };

  const onClearAll = async () => {
    const ok = await confirm({
      title: tx(
        "settingsPrefsClearConfirm",
        "Remove all Jarvis preferences from this browser?",
      ),
      danger: true,
    });
    if (!ok) return;
    const removed = clearAllJarvisPrefs();
    setJustCleared(removed);
    window.setTimeout(() => setJustCleared(null), 2400);
  };

  return (
    <Section
      id="preferences"
      titleKey="settingsPrefsTitle"
      titleFallback="Preferences"
      descKey="settingsPrefsDesc"
      descFallback="Per-browser defaults. All values are saved to localStorage; clearing removes them."
      embedded={embedded}
    >
      <Row
        label={tx("settingsPrefsDefaultRouting", "Default model")}
        hint={tx(
          "settingsPrefsDefaultRoutingHint",
          "Used as the model for every new turn unless you override per-turn from the model menu.",
        )}
      >
        <div className="settings-input-row">
          <Select
            className="settings-input"
            value={draftDefault}
            onChange={(v) => setDraftDefault(v)}
            ariaLabel={tx("settingsPrefsDefaultRouting", "Default model")}
            searchable={options.length > 12}
            options={options.map((o) => ({ value: o.value, label: o.label }))}
          />
          <button
            type="button"
            className="settings-btn"
            disabled={!dirty}
            onClick={onSaveDefault}
          >
            {justSaved ? tx("settingsSaved", "Saved") : tx("settingsSave", "Save")}
          </button>
          <button
            type="button"
            className="settings-btn settings-btn-ghost"
            onClick={onResetDefault}
            disabled={!savedDefault && !draftDefault}
          >
            {tx("settingsReset", "Reset")}
          </button>
        </div>
      </Row>

      <Row label={tx("settingsPrefsDefaultEffort", "Default effort")}>
        <div
          className="settings-pill-group"
          role="radiogroup"
          aria-label={tx("settingsPrefsDefaultEffort", "Default effort")}
        >
          {EFFORTS.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={effort === value}
              className={"settings-pill" + (effort === value ? " active" : "")}
              onClick={() => setEffort(value)}
            >
              {tx(EFFORT_LABEL[value].key, EFFORT_LABEL[value].fallback)}
            </button>
          ))}
        </div>
      </Row>

      <div className="settings-row">
        <div className="settings-row-label">
          <div>{tx("settingsPrefsLayoutHeading", "Layout")}</div>
        </div>
        <div className="settings-row-control settings-stack">
          <LayoutToggle
            label={tx("settingsPrefsSidebar", "Sidebar")}
            value={sidebarOpen}
            onChange={setSidebarOpen}
          />
          <LayoutToggle
            label={tx("settingsPrefsWorkspaceRail", "Workspace rail")}
            value={workspaceRailOpen}
            onChange={setWorkspaceRailOpen}
          />
          <LayoutToggle
            label={tx("settingsPrefsPlanCard", "Plan card")}
            value={planCardOpen}
            onChange={setPlanCardOpen}
          />
        </div>
      </div>

      <Row
        label={tx("settingsPrefsClearAll", "Clear all browser preferences")}
        hint={tx(
          "settingsPrefsClearAllHint",
          "Removes everything Jarvis has saved to localStorage on this browser.",
        )}
      >
        <div className="settings-input-row">
          <button type="button" className="settings-btn settings-btn-danger" onClick={onClearAll}>
            {tx("settingsPrefsClearAll", "Clear all browser preferences")}
          </button>
          {justCleared !== null && (
            <span className="settings-value muted">
              {tx("settingsCleared", "Cleared")} ({justCleared})
            </span>
          )}
        </div>
      </Row>
    </Section>
  );
}

function LayoutToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  const onTxt = tx("settingsPrefsOpenLabel", "open");
  const offTxt = tx("settingsPrefsClosedLabel", "closed");
  return (
    <label className="settings-toggle">
      <span className="settings-toggle-label">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        className={"settings-switch" + (value ? " on" : "")}
        onClick={() => onChange(!value)}
        title={`${label}: ${value ? onTxt : offTxt}`}
      >
        <span className="settings-switch-thumb" />
      </button>
      <span className="settings-toggle-state">{value ? onTxt : offTxt}</span>
    </label>
  );
}
