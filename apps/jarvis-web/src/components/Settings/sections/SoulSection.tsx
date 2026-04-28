import { useState } from "react";
import {
  DEFAULT_JARVIS_SOUL,
  loadJarvisSoul,
  saveJarvisSoul,
  type JarvisSoulConfig,
} from "../../../store/persistence";
import { t } from "../../../utils/i18n";
import { Row, Section } from "./Section";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

export function SoulSection() {
  const [saved, setSaved] = useState<JarvisSoulConfig>(() => loadJarvisSoul());
  const [draft, setDraft] = useState<JarvisSoulConfig>(() => loadJarvisSoul());
  const [justSaved, setJustSaved] = useState(false);

  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);
  const patch = (delta: Partial<JarvisSoulConfig>) =>
    setDraft((cur) => ({ ...cur, ...delta }));

  const onSave = () => {
    saveJarvisSoul(draft);
    setSaved(draft);
    setJustSaved(true);
    window.setTimeout(() => setJustSaved(false), 1200);
  };

  const onReset = () => {
    setDraft(DEFAULT_JARVIS_SOUL);
  };

  return (
    <Section
      id="soul"
      titleKey="settingsSoulTitle"
      titleFallback="Jarvis Soul"
      descKey="settingsSoulDesc"
      descFallback="Jarvis's product-level identity and style. Sent as extra instructions with each new turn; not written into conversation history."
    >
      <Row
        label={tx("settingsSoulEnabled", "Enabled")}
        hint={tx("settingsSoulEnabledHint", "When off, Jarvis uses only the server and project instructions.")}
      >
        <label className="settings-toggle">
          <span className="settings-toggle-label">
            {draft.enabled
              ? tx("settingsServerEnabled", "enabled")
              : tx("settingsServerDisabled", "disabled")}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={draft.enabled}
            className={"settings-switch" + (draft.enabled ? " on" : "")}
            onClick={() => patch({ enabled: !draft.enabled })}
          >
            <span className="settings-switch-thumb" />
          </button>
        </label>
      </Row>

      <Row label={tx("settingsSoulName", "Name")}>
        <input
          className="settings-input"
          value={draft.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </Row>

      <SoulTextarea
        label={tx("settingsSoulIdentity", "Identity")}
        hint={tx("settingsSoulIdentityHint", "What Jarvis is for, in one clear paragraph.")}
        value={draft.identity}
        onChange={(identity) => patch({ identity })}
      />
      <SoulTextarea
        label={tx("settingsSoulTone", "Voice")}
        hint={tx("settingsSoulToneHint", "How Jarvis should sound in day-to-day use.")}
        value={draft.tone}
        onChange={(tone) => patch({ tone })}
      />
      <SoulTextarea
        label={tx("settingsSoulPrinciples", "Principles")}
        hint={tx("settingsSoulPrinciplesHint", "Stable behavior rules. One per line works well.")}
        value={draft.principles}
        onChange={(principles) => patch({ principles })}
      />
      <SoulTextarea
        label={tx("settingsSoulBoundaries", "Boundaries")}
        hint={tx("settingsSoulBoundariesHint", "Things Jarvis should avoid or be explicit about.")}
        value={draft.boundaries}
        onChange={(boundaries) => patch({ boundaries })}
      />

      <div className="settings-row settings-row-actions">
        <div className="settings-input-row">
          <button type="button" className="settings-btn" disabled={!dirty} onClick={onSave}>
            {justSaved ? tx("settingsSaved", "Saved") : tx("settingsSave", "Save")}
          </button>
          <button type="button" className="settings-btn settings-btn-ghost" onClick={onReset}>
            {tx("settingsReset", "Reset")}
          </button>
        </div>
      </div>
    </Section>
  );
}

function SoulTextarea({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Row label={label} hint={hint}>
      <textarea
        className="settings-input settings-textarea settings-soul-textarea"
        rows={4}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Row>
  );
}
