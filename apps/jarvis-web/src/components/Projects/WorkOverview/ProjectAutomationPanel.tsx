import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../../store/appStore";
import type { Project } from "../../../types/frames";
import { t } from "../../../utils/i18n";
import { refreshProjects, updateProject } from "../../../services/projects";

export function ProjectAutomationPanel() {
  const projects = useAppStore((s) => s.projects);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const navigate = useNavigate();

  useEffect(() => {
    void refreshProjects(false);
  }, []);

  const activeProjects = projects.filter((p) => !p.archived);

  const toggle = async (project: Project) => {
    if (pending[project.id]) return;
    const enabled = project.automation?.auto_mode_enabled ?? true;
    setPending((prev) => ({ ...prev, [project.id]: true }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[project.id];
      return next;
    });
    try {
      const saved = await updateProject(project.id, {
        automation: {
          ...(project.automation ?? {}),
          auto_mode_enabled: !enabled,
        },
      });
      if (!saved) {
        setErrors((prev) => ({
          ...prev,
          [project.id]: t("autoModeFailed"),
        }));
      }
    } catch (e) {
      setErrors((prev) => ({
        ...prev,
        [project.id]: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setPending((prev) => ({ ...prev, [project.id]: false }));
    }
  };

  return (
    <div className="work-panel project-auto-panel">
      <header className="work-panel-header">
        <h3>{t("projectAutomationPanelTitle")}</h3>
        <span className="work-panel-header-meta">
          {t("projectAutomationPanelMeta", activeProjects.length)}
        </span>
      </header>

      {activeProjects.length === 0 ? (
        <div className="work-panel-empty">
          {t("projectAutomationPanelEmpty")}
        </div>
      ) : (
        <ul className="project-auto-list">
          {activeProjects.map((project) => {
            const enabled = project.automation?.auto_mode_enabled ?? true;
            const busy = !!pending[project.id];
            const error = errors[project.id];
            return (
              <li key={project.id} className="project-auto-row">
                <button
                  type="button"
                  className="project-auto-row-main"
                  onClick={() => void navigate(`/projects/${project.id}`)}
                  title={project.description ?? project.name}
                >
                  <span className="project-auto-row-name">{project.name}</span>
                  <span className="project-auto-row-desc">
                    {project.description || project.slug}
                  </span>
                  {error && (
                    <span className="project-auto-row-error">
                      {error}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className={
                    "project-auto-switch" +
                    (enabled ? " is-on" : "") +
                    (busy ? " is-pending" : "")
                  }
                  onClick={() => void toggle(project)}
                  disabled={busy}
                  aria-pressed={enabled}
                  title={
                    enabled
                      ? t("projectAutoOnHint")
                      : t("projectAutoOffHint")
                  }
                >
                  <span className="project-auto-switch-track" aria-hidden="true">
                    <span className="project-auto-switch-knob" />
                  </span>
                  <span>{enabled ? t("projectAutoOn") : t("projectAutoOff")}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
