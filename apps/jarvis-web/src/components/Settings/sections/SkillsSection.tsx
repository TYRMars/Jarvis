// Skill catalogue + per-session activation. The list is read-only:
// skills live as SKILL.md files on disk and the agent loads them at
// startup. The toggle next to each row sends an `activate_skill` /
// `deactivate_skill` WS frame; the server replies with a
// `skill_activated` event that the frame dispatcher mirrors into
// `appStore.activeSkills` so all surfaces see one source of truth.

import { useEffect, useState } from "react";
import { Row, Section } from "./Section";
import { useAppStore } from "../../../store/appStore";
import { sendFrame } from "../../../services/socket";
import { listSkills, type SkillSummary } from "../../../services/skills";
import { t } from "../../../utils/i18n";

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; skills: SkillSummary[] }
  | { kind: "error"; message: string };

export function SkillsSection() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const active = useAppStore((s) => s.activeSkills);
  const [opened, setOpened] = useState<string | null>(null);

  const refresh = () => {
    setState({ kind: "loading" });
    listSkills()
      .then((skills) => setState({ kind: "ready", skills }))
      .catch((e: unknown) => setState({ kind: "error", message: String(e) }));
  };

  useEffect(() => {
    refresh();
  }, []);

  const toggle = (name: string, on: boolean) => {
    sendFrame({ type: on ? "activate_skill" : "deactivate_skill", name });
  };

  return (
    <Section
      id="skills"
      titleKey="settingsSkillsTitle"
      titleFallback="Skills"
      descKey="settingsSkillsDesc"
      descFallback="Markdown + frontmatter packs from ~/.config/jarvis/skills and <workspace>/.jarvis/skills. Toggling a skill prepends its body to this session's system prompt."
    >
      {renderList(state, active, toggle, opened, setOpened)}

      <div className="settings-row settings-row-actions">
        <button type="button" className="settings-btn" onClick={refresh}>
          {tx("settingsRefresh", "Refresh")}
        </button>
      </div>
    </Section>
  );
}

function renderList(
  state: LoadState,
  active: string[],
  onToggle: (name: string, on: boolean) => void,
  opened: string | null,
  setOpened: (name: string | null) => void,
) {
  if (state.kind === "loading") {
    return <Row label={tx("settingsSkillsTitle", "Skills")}>…</Row>;
  }
  if (state.kind === "error") {
    return (
      <Row label={tx("settingsSkillsTitle", "Skills")}>
        <span className="settings-value error">{t("skillsListFailed", state.message)}</span>
      </Row>
    );
  }
  if (state.skills.length === 0) {
    return (
      <Row label={tx("settingsSkillsTitle", "Skills")}>
        <span className="settings-value muted">{tx("skillsEmpty", "No skills loaded.")}</span>
      </Row>
    );
  }
  return (
    <div className="settings-row settings-row-full">
      <div className="settings-row-label">
        <div>{tx("skillsLabel", "Available skills")}</div>
        <div className="settings-row-hint">
          {t("skillsActiveCount", active.length, state.skills.length)}
        </div>
      </div>
      <div className="settings-row-control">
        <ul className="settings-skill-list">
          {state.skills.map((s) => {
            const isActive = active.includes(s.name);
            const isOpen = opened === s.name;
            return (
              <li key={s.name} className={"settings-skill-item" + (isActive ? " active" : "")}>
                <div className="settings-skill-row">
                  <div className="settings-skill-summary">
                    <button
                      type="button"
                      className="settings-skill-toggle"
                      aria-pressed={isActive}
                      onClick={() => onToggle(s.name, !isActive)}
                    >
                      {isActive ? tx("skillsToggleOn", "On") : tx("skillsToggleOff", "Off")}
                    </button>
                    <div>
                      <div className="settings-skill-name">
                        <span className="mono">{s.name}</span>
                        <span className="muted">
                          {" "}
                          · {tx(`skillsSource${cap(s.source)}`, s.source)}
                          {" "}
                          · {tx(`skillsActivation${cap(s.activation)}`, s.activation)}
                        </span>
                      </div>
                      <div className="settings-skill-desc">{s.description}</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="settings-btn"
                    onClick={() => setOpened(isOpen ? null : s.name)}
                  >
                    {isOpen ? tx("skillsHide", "Hide") : tx("skillsShow", "Show")}
                  </button>
                </div>
                {isOpen && <SkillBody name={s.name} />}
                {s.allowed_tools.length > 0 && (
                  <ul className="settings-skill-tools">
                    {s.allowed_tools.map((tname) => (
                      <li key={tname} className="mono">{tname}</li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function SkillBody({ name }: { name: string }) {
  const [body, setBody] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import("../../../services/skills").then(({ fetchSkill }) =>
      fetchSkill(name)
        .then((d) => !cancelled && setBody(d.body))
        .catch((e) => !cancelled && setErr(String(e))),
    );
    return () => {
      cancelled = true;
    };
  }, [name]);
  if (err) return <pre className="settings-skill-body error">{err}</pre>;
  if (body == null) return <pre className="settings-skill-body">…</pre>;
  return <pre className="settings-skill-body">{body}</pre>;
}

function cap(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/-./g, (m) => m.charAt(1).toUpperCase());
}
