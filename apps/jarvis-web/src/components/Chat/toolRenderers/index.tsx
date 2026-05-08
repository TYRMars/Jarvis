// Tool args / output section dispatchers. ToolBlock decides
// "show args" / "show output" + handles the four-tier defaultOpen
// logic; this module owns the per-tool rendering picks so the
// shell stays a thin layout concern.
//
// Add a new specialised renderer here, not in ToolBlock.

import type { ReactNode } from "react";
import { FsEditDiff } from "../FsEditDiff";
import { FsWriteCard } from "../FsWriteCard";
import { ProjectChecksCard } from "../ProjectChecksCard";
import { UnifiedDiffViewer } from "../UnifiedDiffViewer";
import { WorkspaceContextCard } from "../WorkspaceContextCard";
import { isDesktopRuntime } from "../../../services/desktop";
import { t } from "../../../utils/i18n";
import { ToolOutput } from "./ToolOutput";
import { safeStringify } from "./util";

/// Render the "args" section of a tool block. Returns the full
/// section contents (label included where the renderer wants one).
export function renderArgsSection(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any,
): ReactNode {
  if (name === "fs.edit") {
    return (
      <>
        <div className="tool-label">{t("editing")}</div>
        <FsEditDiff args={args || {}} />
      </>
    );
  }
  if (name === "fs.write") {
    return <FsWriteCard args={args || {}} />;
  }
  if (name === "fs.patch" && typeof args?.diff === "string") {
    return (
      <>
        <div className="tool-label">{t("toolArguments")}</div>
        <UnifiedDiffViewer content={args.diff} />
      </>
    );
  }
  return (
    <>
      <div className="tool-label">{t("toolArguments")}</div>
      <pre className="tool-pre">{safeStringify(args)}</pre>
    </>
  );
}

/// Render the "output" section body — i.e. the part *after* the
/// `<div class="tool-label">{output}</div>` row. ToolBlock writes
/// the label; this returns the body so each renderer can swap
/// the actual presentation (diff viewer, structured card, plain
/// truncated text).
export function renderOutputBody(name: string, output: string): ReactNode {
  if (name === "git.diff" && output.trim() && output !== "(no changes)") {
    return <UnifiedDiffViewer content={output} />;
  }
  if (name === "workspace.context") {
    return <WorkspaceContextCard content={output} />;
  }
  if (name === "project.checks") {
    return <ProjectChecksCard content={output} />;
  }
  if (name.startsWith("doc.")) {
    return <DocToolCard name={name} output={output} />;
  }
  return <ToolOutput content={output} />;
}

function DocToolCard({ name, output }: { name: string; output: string }) {
  const parsed = parseJson(output);
  if (parsed === null) {
    return (
      <div className="doc-tool-card">
        <div className="doc-tool-title">{t("docToolNoDraft")}</div>
      </div>
    );
  }
  if (!isRecord(parsed)) {
    return <ToolOutput content={output} />;
  }

  if (name === "doc.list" || name === "doc.search") {
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const count = typeof parsed.count === "number" ? parsed.count : items.length;
    const query = typeof parsed.query === "string" && parsed.query.trim() ? parsed.query.trim() : null;
    return (
      <div className="doc-tool-card">
        <div className="doc-tool-title">
          {name === "doc.search" ? t("docToolSearchResults") : t("docToolDocs")} · {count}
        </div>
        {query ? <div className="doc-tool-subtitle">“{query}”</div> : null}
        <div className="doc-tool-list">
          {items.slice(0, 8).map((item, idx) => {
            const project = projectFromSearchItem(item);
            if (!project) return null;
            const key = typeof project.id === "string" ? project.id : idx;
            return <DocProjectRow key={key} project={project} />;
          })}
        </div>
      </div>
    );
  }

  if (name === "doc.get") {
    const project = isRecord(parsed.project) ? parsed.project : null;
    const draft = isRecord(parsed.draft) ? parsed.draft : null;
    return (
      <div className="doc-tool-card">
        {project ? <DocProjectRow project={project} /> : null}
        {draft ? <DocDraftPreview draft={draft} /> : null}
      </div>
    );
  }

  if (name === "doc.upsert") {
    const project = isRecord(parsed.project) ? parsed.project : null;
    const draft = isRecord(parsed.draft) ? parsed.draft : null;
    return (
      <div className="doc-tool-card">
        <div className="doc-tool-title">
          {parsed.created === true ? t("docToolCreatedDoc") : t("docToolUpdatedDoc")}
        </div>
        {project ? <DocProjectRow project={project} /> : null}
        {draft ? <DocDraftPreview draft={draft} /> : null}
      </div>
    );
  }

  if (name === "doc.create" || name === "doc.update") {
    return (
      <div className="doc-tool-card">
        <DocProjectRow project={parsed} />
      </div>
    );
  }

  if (name === "doc.delete") {
    return (
      <div className="doc-tool-card">
        <div className="doc-tool-title">
          {parsed.deleted === true ? t("docToolDeletedDoc") : t("docToolNotFound")}
        </div>
        {typeof parsed.id === "string" ? (
          <div className="doc-tool-id">{parsed.id}</div>
        ) : null}
      </div>
    );
  }

  if (name === "doc.draft.get" || name === "doc.draft.save") {
    return (
      <div className="doc-tool-card">
        <DocDraftPreview draft={parsed} />
      </div>
    );
  }

  return <ToolOutput content={output} />;
}

function parseJson(output: string): unknown {
  const trimmed = output.trim();
  if (trimmed === "null") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return output;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function projectFromSearchItem(item: unknown): Record<string, unknown> | null {
  if (!isRecord(item)) return null;
  if (isRecord(item.project)) return item.project;
  return item;
}

function DocProjectRow({ project }: { project: Record<string, unknown> }) {
  const title = typeof project.title === "string" ? project.title : "Untitled";
  const kind = typeof project.kind === "string" ? project.kind : "note";
  const id = typeof project.id === "string" ? project.id : null;
  const tags = Array.isArray(project.tags)
    ? project.tags.filter((t): t is string => typeof t === "string")
    : [];
  return (
    <div className="doc-tool-row">
      <div className="doc-tool-row-main">
        <span className="doc-tool-kind">{kind}</span>
        {id ? (
          <a
            className="doc-tool-row-title doc-tool-row-link"
            href={docHref(id)}
            title={t("docToolOpen")}
          >
            {title}
          </a>
        ) : (
          <span className="doc-tool-row-title">{title}</span>
        )}
      </div>
      {id ? <div className="doc-tool-id">{id}</div> : null}
      {tags.length > 0 ? (
        <div className="doc-tool-tags">
          {tags.slice(0, 5).map((tag) => (
            <span key={tag} className="doc-tool-tag">{tag}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function docHref(id: string): string {
  const path = `/docs/${encodeURIComponent(id)}`;
  return isDesktopRuntime() ? `#${path}` : path;
}

function DocDraftPreview({ draft }: { draft: Record<string, unknown> }) {
  const content = typeof draft.content === "string" ? draft.content : "";
  const updatedAt = typeof draft.updated_at === "string" ? draft.updated_at : null;
  const preview = content.trim() ? content.trim().slice(0, 520) : "(empty)";
  return (
    <div className="doc-tool-draft">
      <div className="doc-tool-draft-meta">
        <span>{t("docToolLatestDraft")}</span>
        {updatedAt ? <span>{updatedAt}</span> : null}
      </div>
      <pre className="doc-tool-draft-preview">{preview}</pre>
    </div>
  );
}
