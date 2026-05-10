// Skill catalogue + per-session activation. The list is read-only:
// skills live as SKILL.md files on disk and the agent loads them at
// startup. The toggle next to each row sends an `activate_skill` /
// `deactivate_skill` WS frame; the server replies with a
// `skill_activated` event that the frame dispatcher mirrors into
// `appStore.activeSkills` so all surfaces see one source of truth.

import { useEffect, useState } from "react";
import { Row, Section } from "./Section";
import { Button, Modal } from "../../ui";
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

export function SkillsSection({
  embedded,
  refreshToken = 0,
  query = "",
}: {
  embedded?: boolean;
  refreshToken?: number;
  query?: string;
} = {}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const active = useAppStore((s) => s.activeSkills);
  const [opened, setOpened] = useState<SkillSummary | null>(null);

  const refresh = () => {
    setState({ kind: "loading" });
    listSkills()
      .then((skills) => setState({ kind: "ready", skills }))
      .catch((e: unknown) => setState({ kind: "error", message: String(e) }));
  };

  useEffect(() => {
    refresh();
  }, [refreshToken]);

  const toggle = (name: string, on: boolean) => {
    sendFrame({ type: on ? "activate_skill" : "deactivate_skill", name });
  };

  const filteredState =
    state.kind === "ready"
      ? { ...state, skills: filterSkills(state.skills, query) }
      : state;

  return (
    <Section
      id="skills"
      titleKey="settingsSkillsTitle"
      titleFallback="Skills"
      descKey="settingsSkillsDesc"
      descFallback="Markdown + frontmatter packs from ~/.config/jarvis/skills and <workspace>/.jarvis/skills. Toggling a skill prepends its body to this session's system prompt."
      embedded={embedded}
    >
      <div className="settings-manage-actions">
        <Button onClick={refresh}>{tx("settingsRefresh", "Refresh")}</Button>
      </div>

      {renderList(filteredState, active, toggle, setOpened)}

      <Modal
        open={opened !== null}
        title={opened?.name ?? tx("settingsSkillsTitle", "Skills")}
        onClose={() => setOpened(null)}
        size="lg"
        dialogClassName="settings-skill-modal"
      >
        {opened ? (
          <div className="settings-skill-modal-content">
            <div className="settings-skill-modal-head">
              <p className="settings-plugin-modal-desc">{opened.description}</p>
              <SkillSwitch
                name={opened.name}
                active={active.includes(opened.name)}
                onToggle={toggle}
              />
            </div>
            <SkillBody name={opened.name} />
          </div>
        ) : null}
      </Modal>
    </Section>
  );
}

function renderList(
  state: LoadState,
  active: string[],
  onToggle: (name: string, on: boolean) => void,
  setOpened: (skill: SkillSummary) => void,
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
            return (
              <li key={s.name} className={"settings-skill-item" + (isActive ? " active" : "")}>
                <div className="settings-skill-row">
                  <button
                    type="button"
                    className="settings-skill-open"
                    onClick={() => setOpened(s)}
                  >
                    <div>
                      <div className="settings-skill-name">
                        {s.name}
                      </div>
                      <div className="settings-skill-desc">{s.description}</div>
                    </div>
                  </button>
                  <SkillSwitch name={s.name} active={isActive} onToggle={onToggle} />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function SkillSwitch({
  name,
  active,
  onToggle,
}: {
  name: string;
  active: boolean;
  onToggle: (name: string, on: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={"settings-skill-switch" + (active ? " is-on" : "")}
      role="switch"
      aria-checked={active}
      aria-label={active ? tx("skillsToggleOn", "On") : tx("skillsToggleOff", "Off")}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(name, !active);
      }}
    >
      <span />
    </button>
  );
}

function filterSkills(skills: SkillSummary[], query: string): SkillSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return skills;
  return skills.filter((s) =>
    [
      s.name,
      s.description,
      s.source,
      s.activation,
      ...s.allowed_tools,
    ].join(" ").toLowerCase().includes(q),
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
