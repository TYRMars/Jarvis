// Chat header crumb: "<project> / <conversation title>".
//
// The branded "Jarvis" leading segment is gone — the app icon already
// communicates the brand, so the crumb stays focused on the two pieces
// of context the user actually needs to spot at a glance:
//   1. Which project this conversation is bound to (left).
//   2. The conversation's title (right).
//
// Project source, in priority order:
//   1. `convoRows[id].project_id` — the server's persisted binding.
//   2. `draftProjectId` — what the composer chips show before the
//      first message goes out.
// When there's no binding, the project slot collapses entirely and
// only the conversation title renders (no leading separator either).

import { useAppStore } from "../store/appStore";
import { resolveTitle } from "../store/persistence";
import { t } from "../utils/i18n";

export function ChatHeader() {
  const activeId = useAppStore((s) => s.activeId);
  const rows = useAppStore((s) => s.convoRows);
  const projectsById = useAppStore((s) => s.projectsById);
  const draftProjectId = useAppStore((s) => s.draftProjectId);

  let label = "";
  let projectId: string | null | undefined = null;
  if (activeId) {
    const row = rows.find((r) => r.id === activeId);
    label = row ? resolveTitle(row) : activeId.slice(0, 8);
    projectId = row?.project_id ?? null;
  }
  // Pre-message state: no row yet, but the user may have already
  // picked a project in the resource dialog. Surface that draft so the
  // crumb doesn't show "no project" until the first message lands.
  if (!projectId) projectId = draftProjectId ?? null;
  const project = projectId ? projectsById?.[projectId] : null;
  // Fall back to the i18n "New session" string when the row has no
  // server-derived title yet (fresh session before the first user
  // message). Used to be a CSS `::before { content: "New session" }`
  // which can't follow the active language.
  const display = label || t("newSession");

  return (
    <div className="project-crumb">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      </svg>
      {project && (
        <>
          <span className="crumb-project" title={project.slug}>
            {project.name}
          </span>
          <span className="crumb-separator">/</span>
        </>
      )}
      <span id="active-id" className="conversation-id">{display}</span>
    </div>
  );
}
