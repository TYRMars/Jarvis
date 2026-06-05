// M3.3 UX: tiny notice above the composer telling the user which
// skills *will* auto-activate on the next user turn given the
// files the agent touched in the previous turn. Backed by the
// `skill_auto_activated_for_next_turn` WS frame; falls back to
// rendering nothing when no skills match — no chrome cost on
// quiet sessions.
//
// Self-contained on purpose: the chip subscribes to its single
// store field and renders inline; no portal, no popover. Sits
// between the form opening tag and the input-wrapper in Composer
// so it visually attaches to the input the user is about to type
// into.

import { useAppStore } from "../../store/appStore";
import { t } from "../../utils/i18n";

export function AutoActivatedSkillsChip() {
  const skills = useAppStore((s) => s.autoActivatedNextTurnSkills);
  if (!skills || skills.length === 0) return null;
  return (
    <div className="composer-auto-skills" role="status" aria-live="polite">
      <span className="composer-auto-skills-label">
        {t("composerAutoSkillsLabel")}
      </span>
      <ul className="composer-auto-skills-list">
        {skills.map((name) => (
          <li key={name} className="composer-auto-skills-pill" title={t("composerAutoSkillsTooltip", name)}>
            {name}
          </li>
        ))}
      </ul>
    </div>
  );
}
