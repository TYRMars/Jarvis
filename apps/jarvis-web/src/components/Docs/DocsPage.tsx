import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../store/appStore";
import type { DocKind, DocProject } from "../../types/frames";
import {
  createDocProject,
  deleteDocProject,
  getDocDraft,
  listDocProjects,
  loadDocDraft,
  loadDocProjects,
  saveDocDraft,
  subscribeDocs,
  updateDocProject,
} from "../../services/docs";
import { MarkdownView } from "../Chat/MarkdownView";

const KIND_OPTIONS: Array<{ value: DocKind; label: string }> = [
  { value: "note", label: "Note" },
  { value: "research", label: "Research" },
  { value: "report", label: "Report" },
  { value: "design", label: "Design" },
  { value: "guide", label: "Guide" },
];

export function DocsPage() {
  const socketWorkspace = useAppStore((s) => s.socketWorkspace);
  const [version, setVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draftBuffer, setDraftBuffer] = useState<string>("");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [query, setQuery] = useState("");

  const workspace = socketWorkspace ?? "";

  useEffect(() => {
    return subscribeDocs(() => setVersion((v) => v + 1));
  }, []);

  useEffect(() => {
    void loadDocProjects(socketWorkspace ?? undefined);
  }, [socketWorkspace]);

  const projects = useMemo(
    () => listDocProjects(workspace),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspace, version],
  );
  const visibleProjects = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.title.toLowerCase().includes(q));
  }, [projects, query]);

  const selected: DocProject | null = useMemo(
    () => (selectedId ? projects.find((p) => p.id === selectedId) ?? null : null),
    [selectedId, projects],
  );

  useEffect(() => {
    if (!selectedId) {
      setDraftBuffer("");
      setSavedAt(null);
      return;
    }
    void loadDocDraft(selectedId).then(() => {
      const d = getDocDraft(selectedId);
      setDraftBuffer(d?.content ?? "");
      setSavedAt(d?.updated_at ?? null);
    });
  }, [selectedId]);

  const onCreate = async (title: string, kind: DocKind) => {
    const t = title.trim();
    if (!t) return;
    const project = await createDocProject({
      title: t,
      kind,
      workspace: workspace || undefined,
    });
    if (project) {
      setSelectedId(project.id);
      setCreating(false);
    }
  };

  const onSave = async () => {
    if (!selectedId) return;
    const draft = await saveDocDraft(selectedId, draftBuffer);
    if (draft) setSavedAt(draft.updated_at);
  };

  const onRename = async (next: string) => {
    if (!selectedId) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    await updateDocProject(selectedId, { title: trimmed });
  };

  const onChangeKind = async (next: DocKind) => {
    if (!selectedId) return;
    await updateDocProject(selectedId, { kind: next });
  };

  const onDelete = async () => {
    if (!selectedId) return;
    if (!confirm("Delete this doc and its draft? This cannot be undone.")) {
      return;
    }
    if (await deleteDocProject(selectedId)) {
      setSelectedId(null);
    }
  };

  return (
    <main id="docs-page" className="docs-page docs-page-v0" aria-label="Doc" tabIndex={-1}>
      <header className="docs-page-header">
        <h1>Doc</h1>
        <label className="docs-search" aria-label="Search docs">
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            placeholder="Search docs"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="docs-new-btn"
          onClick={() => setCreating(true)}
        >
          New doc
        </button>
      </header>

      <div className="docs-body" style={layoutBody}>
        <aside className="docs-list" style={layoutList} aria-label="Doc list">
          {creating ? (
            <CreateDocForm
              onCancel={() => setCreating(false)}
              onCreate={onCreate}
            />
          ) : null}
          {visibleProjects.length === 0 && !creating ? (
            <div className="docs-empty-mini" style={emptyMini}>
              <p>No docs yet.</p>
              <button
                type="button"
                className="docs-new-btn"
                onClick={() => setCreating(true)}
              >
                + New doc
              </button>
            </div>
          ) : (
            <ul className="docs-rows" style={listRows}>
              {visibleProjects.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className={
                      "docs-row" +
                      (selectedId === p.id ? " is-selected" : "")
                    }
                    style={selectedId === p.id ? rowSelected : rowDefault}
                    onClick={() => setSelectedId(p.id)}
                  >
                    <div style={rowTitle}>{p.title || "(untitled)"}</div>
                    <div style={rowMeta}>
                      <span className="docs-kind-chip" style={kindChipStyle(p.kind)}>
                        {p.kind}
                      </span>
                      <span style={rowTime}>{shortTime(p.updated_at)}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="docs-editor" style={layoutEditor} aria-label="Doc editor">
          {selected ? (
            <DocEditor
              project={selected}
              draftBuffer={draftBuffer}
              setDraftBuffer={setDraftBuffer}
              savedAt={savedAt}
              previewing={previewing}
              setPreviewing={setPreviewing}
              onSave={onSave}
              onRename={onRename}
              onChangeKind={onChangeKind}
              onDelete={onDelete}
            />
          ) : (
            <div style={emptyEditor}>
              <h2>Select a doc</h2>
              <p style={mutedP}>
                Pick one on the left, or click <strong>New doc</strong> to start.
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

interface DocEditorProps {
  project: DocProject;
  draftBuffer: string;
  setDraftBuffer: (s: string) => void;
  savedAt: string | null;
  previewing: boolean;
  setPreviewing: (b: boolean) => void;
  onSave: () => void;
  onRename: (next: string) => void;
  onChangeKind: (next: DocKind) => void;
  onDelete: () => void;
}

function DocEditor(props: DocEditorProps) {
  const { project, draftBuffer, setDraftBuffer, savedAt, previewing, setPreviewing } =
    props;
  return (
    <>
      <header style={editorHeader}>
        <input
          type="text"
          value={project.title}
          onChange={(e) => props.onRename(e.target.value)}
          aria-label="Doc title"
          style={titleInput}
        />
        <div style={editorActions}>
          <select
            value={project.kind}
            onChange={(e) => props.onChangeKind(e.target.value as DocKind)}
            aria-label="Doc kind"
            style={kindSelect}
          >
            {KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="docs-toggle-preview"
            onClick={() => setPreviewing(!previewing)}
            style={ghostBtn}
          >
            {previewing ? "Edit" : "Preview"}
          </button>
          <button
            type="button"
            onClick={props.onSave}
            style={primaryBtn}
            title={savedAt ? `Saved ${shortTime(savedAt)}` : "Not yet saved"}
          >
            Save
          </button>
          <button type="button" onClick={props.onDelete} style={dangerBtn}>
            Delete
          </button>
        </div>
      </header>
      <div style={editorBody}>
        {previewing ? (
          <div style={previewPane}>
            <MarkdownView content={draftBuffer} />
          </div>
        ) : (
          <textarea
            value={draftBuffer}
            onChange={(e) => setDraftBuffer(e.target.value)}
            placeholder={"# Start writing\n\nMarkdown is supported."}
            style={editorTextarea}
            aria-label="Markdown body"
          />
        )}
      </div>
      <footer style={editorFooter}>
        <span style={mutedSpan}>
          {savedAt ? `Saved ${shortTime(savedAt)}` : "Unsaved"}
        </span>
        <span style={mutedSpan}>
          {draftBuffer.length} chars · {countLines(draftBuffer)} lines
        </span>
      </footer>
    </>
  );
}

interface CreateDocFormProps {
  onCancel: () => void;
  onCreate: (title: string, kind: DocKind) => void;
}

function CreateDocForm({ onCancel, onCreate }: CreateDocFormProps) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<DocKind>("note");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onCreate(title, kind);
      }}
      style={createForm}
    >
      <label>
        <span style={labelText}>Title</span>
        <input
          type="text"
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="weekly review"
          style={fieldInput}
        />
      </label>
      <label>
        <span style={labelText}>Kind</span>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as DocKind)}
          style={fieldInput}
        >
          {KIND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <div style={formActions}>
        <button type="button" onClick={onCancel} style={ghostBtn}>
          Cancel
        </button>
        <button type="submit" style={primaryBtn}>
          Create
        </button>
      </div>
    </form>
  );
}

// ---------- helpers ------------------------------------------------

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}

function countLines(s: string): number {
  if (!s) return 0;
  return s.split(/\r?\n/).length;
}

function kindChipStyle(kind: DocKind): React.CSSProperties {
  const palette: Record<DocKind, string> = {
    note: "#6b7280",
    research: "#0ea5e9",
    report: "#22c55e",
    design: "#a855f7",
    guide: "#f59e0b",
  };
  return {
    background: palette[kind] + "1a",
    color: palette[kind],
    border: `1px solid ${palette[kind]}33`,
    borderRadius: "9999px",
    padding: "1px 8px",
    fontSize: "11px",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    fontWeight: 600,
  };
}

// ---------- styles -------------------------------------------------

const layoutBody: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(220px, 280px) 1fr",
  gap: "16px",
  alignItems: "stretch",
  height: "calc(100% - 60px)",
  minHeight: 0,
};
const layoutList: React.CSSProperties = {
  borderRight: "1px solid var(--border, #e5e7eb)",
  paddingRight: "12px",
  overflowY: "auto",
  minHeight: 0,
};
const layoutEditor: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};
const listRows: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: "4px",
};
const rowDefault: React.CSSProperties = {
  width: "100%",
  textAlign: "left",
  padding: "10px 12px",
  borderRadius: "8px",
  border: "1px solid transparent",
  background: "transparent",
  cursor: "pointer",
};
const rowSelected: React.CSSProperties = {
  ...rowDefault,
  background: "var(--row-selected, #f3f4f6)",
  border: "1px solid var(--border, #e5e7eb)",
};
const rowTitle: React.CSSProperties = {
  fontWeight: 500,
  fontSize: "14px",
  marginBottom: "4px",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const rowMeta: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  fontSize: "11px",
};
const rowTime: React.CSSProperties = { color: "var(--muted, #6b7280)" };
const emptyMini: React.CSSProperties = {
  textAlign: "center",
  padding: "16px 0",
  color: "var(--muted, #6b7280)",
  fontSize: "13px",
};
const emptyEditor: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  color: "var(--muted, #6b7280)",
  textAlign: "center",
  gap: "8px",
};
const mutedP: React.CSSProperties = {
  color: "var(--muted, #6b7280)",
  fontSize: "13px",
  margin: 0,
};
const editorHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "12px",
  paddingBottom: "12px",
  borderBottom: "1px solid var(--border, #e5e7eb)",
};
const titleInput: React.CSSProperties = {
  flex: 1,
  fontSize: "20px",
  fontWeight: 600,
  border: "none",
  outline: "none",
  background: "transparent",
};
const editorActions: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
};
const kindSelect: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: "8px",
  border: "1px solid var(--border, #e5e7eb)",
  fontSize: "12px",
  background: "var(--bg, #fff)",
};
const editorBody: React.CSSProperties = { flex: 1, minHeight: 0, marginTop: "8px" };
const editorTextarea: React.CSSProperties = {
  width: "100%",
  height: "100%",
  resize: "none",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "8px",
  padding: "12px 14px",
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  fontSize: "14px",
  lineHeight: 1.5,
  background: "var(--bg, #fff)",
  outline: "none",
};
const previewPane: React.CSSProperties = {
  height: "100%",
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "8px",
  padding: "12px 14px",
  overflowY: "auto",
  background: "var(--bg, #fff)",
};
const editorFooter: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  paddingTop: "8px",
  fontSize: "11px",
  color: "var(--muted, #6b7280)",
};
const mutedSpan: React.CSSProperties = { color: "var(--muted, #6b7280)" };
const createForm: React.CSSProperties = {
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "10px",
  padding: "14px 14px 12px",
  display: "flex",
  flexDirection: "column",
  gap: "10px",
  marginBottom: "12px",
};
const labelText: React.CSSProperties = {
  display: "block",
  fontSize: "12px",
  color: "var(--muted, #6b7280)",
  marginBottom: "4px",
};
const fieldInput: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: "8px",
  border: "1px solid var(--border, #e5e7eb)",
  fontSize: "14px",
};
const formActions: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "8px",
};
const ghostBtn: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: "8px",
  border: "1px solid var(--border, #e5e7eb)",
  background: "transparent",
  cursor: "pointer",
};
const primaryBtn: React.CSSProperties = {
  padding: "6px 14px",
  borderRadius: "8px",
  border: "1px solid #111",
  background: "#111",
  color: "#fff",
  cursor: "pointer",
};
const dangerBtn: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: "8px",
  border: "1px solid #ef4444",
  background: "transparent",
  color: "#ef4444",
  cursor: "pointer",
};
