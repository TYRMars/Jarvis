import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { OpenSidebarButton } from "../Workspace/WorkspaceToggles";
import { EmptyState } from "../shared/EmptyState";
import { t } from "../../utils/i18n";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { DocOutline } from "./DocOutline";
import { kindLabel, KIND_ORDER, KindIcon, kindChipStyle } from "./KindIcon";
import { templateForKind } from "./kindTemplates";
import { SaveStatePill, type SaveState } from "./SaveStatePill";
import { TagInput } from "./TagInput";
import { useAutosave } from "./useAutosave";
import {
  applyDocFilter,
  useDocCounts,
  useDocFilterState,
  type DocScope,
  type DocSort,
  type FilteredDoc,
} from "./useDocFilter";

export function DocsPage() {
  const socketWorkspace = useAppStore((s) => s.socketWorkspace);
  const [version, setVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftBuffer, setDraftBuffer] = useState<string>("");
  const [previewing, setPreviewing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<DocProject | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const filter = useDocFilterState();

  const workspace = socketWorkspace ?? "";

  // Subscribe to the docs cache (covers WS pushes + local mutations).
  useEffect(() => subscribeDocs(() => setVersion((v) => v + 1)), []);

  // Refetch on workspace switch.
  useEffect(() => {
    void loadDocProjects(socketWorkspace ?? undefined);
  }, [socketWorkspace]);

  // Open the create form when the sidebar's "+ New" button fires.
  useEffect(() => {
    const onNew = () => setCreating(true);
    window.addEventListener("jarvis:new-doc", onNew);
    return () => window.removeEventListener("jarvis:new-doc", onNew);
  }, []);

  // Page-level keyboard shortcuts. Doc-specific only — Cmd+N is
  // handled globally in `useShortcuts.ts` so the same muscle memory
  // works on /, /projects, and /docs.
  // - Cmd/Ctrl+S → force-flush autosave (suppresses browser save).
  // - ↑/↓ when focus is on the docs page (and not inside an input
  //   or textarea) → cycle the selected doc in the list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditable =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      const onDocsPage =
        document.getElementById("docs-page")?.contains(target ?? null) ?? false;
      if (!onDocsPage) return;

      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        void autosave.flush();
        return;
      }
      if (!inEditable && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        cycleSelection(e.key === "ArrowDown" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Helper used by the ↑/↓ shortcut. Defined here (not memoised) so
  // it always reads the latest filtered list.
  const cycleSelection = (direction: 1 | -1) => {
    if (filtered.length === 0) return;
    const idx = filtered.findIndex((f) => f.project.id === selectedId);
    const nextIdx =
      idx < 0
        ? direction === 1
          ? 0
          : filtered.length - 1
        : (idx + direction + filtered.length) % filtered.length;
    setSelectedId(filtered[nextIdx].project.id);
  };

  // Online / offline awareness for the save pill.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onUp = () => setOnline(true);
    const onDown = () => setOnline(false);
    window.addEventListener("online", onUp);
    window.addEventListener("offline", onDown);
    return () => {
      window.removeEventListener("online", onUp);
      window.removeEventListener("offline", onDown);
    };
  }, []);

  const projects = useMemo(
    () => listDocProjects(workspace),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspace, version],
  );
  const counts = useDocCounts(projects);

  // Body cache for snippet search (only the currently-loaded draft).
  const draftMap = useMemo(() => {
    const m = new Map<string, string | null>();
    if (selectedId) m.set(selectedId, draftBuffer);
    return m;
  }, [selectedId, draftBuffer]);

  const filtered: FilteredDoc[] = useMemo(
    () =>
      applyDocFilter({
        projects,
        filter: filter.state,
        drafts: draftMap,
      }),
    [projects, filter.state, draftMap],
  );

  const selected: DocProject | null = useMemo(
    () => (selectedId ? projects.find((p) => p.id === selectedId) ?? null : null),
    [selectedId, projects],
  );

  // Auto-pick the first visible doc when the selection vanishes.
  useEffect(() => {
    if (selectedId) return;
    if (filtered.length > 0) {
      setSelectedId(filtered[0].project.id);
    }
  }, [selectedId, filtered]);

  // Drop selection if the selected doc is filtered out.
  useEffect(() => {
    if (!selectedId) return;
    if (!filtered.some((f) => f.project.id === selectedId)) {
      setSelectedId(filtered[0]?.project.id ?? null);
    }
  }, [selectedId, filtered]);

  // Load draft on selection change.
  useEffect(() => {
    if (!selectedId) {
      setDraftBuffer("");
      setSaveState({ kind: "idle" });
      return;
    }
    let cancelled = false;
    void loadDocDraft(selectedId).then(() => {
      if (cancelled) return;
      const d = getDocDraft(selectedId);
      const content = d?.content ?? "";
      setDraftBuffer(content);
      autosave.reset(content);
      setSaveState(
        d?.updated_at
          ? { kind: "saved", at: new Date(d.updated_at).getTime() }
          : { kind: "idle" },
      );
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const persist = useCallback(
    async (id: string, content: string) => {
      if (!online) {
        setSaveState({ kind: "offline" });
        throw new Error("offline");
      }
      setSaveState({ kind: "saving" });
      try {
        const draft = await saveDocDraft(id, content);
        if (draft) {
          setSaveState({
            kind: "saved",
            at: new Date(draft.updated_at).getTime(),
          });
        } else {
          setSaveState({ kind: "error", message: "Save failed" });
          throw new Error("save returned null");
        }
      } catch (e: any) {
        setSaveState({
          kind: "error",
          message: e?.message ?? "Save failed",
        });
        throw e;
      }
    },
    [online],
  );

  const autosave = useAutosave({
    id: selectedId,
    content: draftBuffer,
    save: persist,
  });

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
      // Honour the kind we created with by snapping the rail there.
      filter.setScope({ type: "kind", kind });
      // Seed the draft with the kind's template so the user starts
      // with structure instead of an empty textarea. Autosave picks
      // it up on the first idle tick. Notes use an empty template
      // by design — free-form should stay free.
      const template = templateForKind(kind);
      if (template) {
        setDraftBuffer(template);
        autosave.reset("");
        void persist(project.id, template);
      }
    }
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

  const onChangeTags = async (next: string[]) => {
    if (!selectedId) return;
    await updateDocProject(selectedId, { tags: next });
  };

  const onTogglePinned = async (project: DocProject) => {
    await updateDocProject(project.id, { pinned: !project.pinned });
  };

  const onToggleArchived = async (project: DocProject) => {
    await updateDocProject(project.id, { archived: !project.archived });
  };

  const onDelete = async () => {
    if (!confirmingDelete) return;
    const id = confirmingDelete.id;
    setConfirmingDelete(null);
    if (await deleteDocProject(id)) {
      setSelectedId((cur) => (cur === id ? null : cur));
    }
  };

  const tagSuggestions = useMemo(() => {
    const sorted = Array.from(counts.tags.entries()).sort(
      (a, b) => b[1] - a[1],
    );
    return sorted.map(([tag]) => tag);
  }, [counts.tags]);

  const pageTitle = scopeTitle(filter.state.scope);

  return (
    <main
      id="docs-page"
      className="docs-page docs-page-3p"
      aria-label={t("docsAriaPage")}
      tabIndex={-1}
    >
      <div className="docs-3p-grid">
        <DocsListColumn
          title={pageTitle}
          query={filter.state.query}
          onQuery={filter.setQuery}
          sort={filter.state.sort}
          onSort={filter.setSort}
          items={filtered}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onTogglePinned={onTogglePinned}
          onToggleArchived={onToggleArchived}
          onDelete={(p) => setConfirmingDelete(p)}
          onNew={() => setCreating(true)}
          creating={creating}
          onCreate={onCreate}
          onCancelCreate={() => setCreating(false)}
        />

        <DocsEditorColumn
          project={selected}
          draftBuffer={draftBuffer}
          setDraftBuffer={setDraftBuffer}
          previewing={previewing}
          setPreviewing={setPreviewing}
          saveState={saveState}
          onRetrySave={() => {
            if (selectedId) void persist(selectedId, draftBuffer);
          }}
          onFlush={() => void autosave.flush()}
          onRename={onRename}
          onChangeKind={onChangeKind}
          onChangeTags={onChangeTags}
          onTogglePinned={() => selected && onTogglePinned(selected)}
          onToggleArchived={() => selected && onToggleArchived(selected)}
          onDelete={() => selected && setConfirmingDelete(selected)}
          tagSuggestions={tagSuggestions}
        />
      </div>

      {confirmingDelete ? (
        <ConfirmDeleteDialog
          title={t("docsDeleteTitle", confirmingDelete.title)}
          detail={t("docsDeleteDetail")}
          confirmLabel={t("docsDeleteConfirm")}
          cancelLabel={t("docsCreateCancel")}
          onCancel={() => setConfirmingDelete(null)}
          onConfirm={onDelete}
        />
      ) : null}
    </main>
  );
}

// ----------------------- LIST COLUMN ------------------------------

interface ListColumnProps {
  title: string;
  query: string;
  onQuery: (q: string) => void;
  sort: DocSort;
  onSort: (s: DocSort) => void;
  items: FilteredDoc[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onTogglePinned: (p: DocProject) => void;
  onToggleArchived: (p: DocProject) => void;
  onDelete: (p: DocProject) => void;
  onNew: () => void;
  creating: boolean;
  onCreate: (title: string, kind: DocKind) => void;
  onCancelCreate: () => void;
}

function DocsListColumn(props: ListColumnProps) {
  return (
    <section className="docs-3p-list" aria-label={t("docsAriaList")}>
      <header className="docs-list-header">
        <OpenSidebarButton />
        <h1 className="docs-list-title">{props.title}</h1>
        <div className="docs-list-toolbar">
          <label className="docs-list-search" aria-label={t("docsSearchAria")}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <circle cx="11" cy="11" r="6.5" />
              <path d="m20.5 20.5-3.7-3.7" />
            </svg>
            <input
              type="search"
              placeholder={t("docsSearchPlaceholder")}
              value={props.query}
              onChange={(e) => props.onQuery(e.target.value)}
            />
          </label>
          <select
            className="docs-list-sort"
            value={props.sort}
            onChange={(e) => props.onSort(e.target.value as DocSort)}
            aria-label={t("docsSortAria")}
          >
            <option value="updated">{t("docsSortUpdated")}</option>
            <option value="created">{t("docsSortCreated")}</option>
            <option value="title">{t("docsSortTitle")}</option>
          </select>
        </div>
      </header>

      <div className="docs-list-body">
        {props.creating ? (
          <CreateDocForm
            onCancel={props.onCancelCreate}
            onCreate={props.onCreate}
          />
        ) : null}

        {props.items.length === 0 && !props.creating ? (
          <ListEmpty onNew={props.onNew} title={props.title} />
        ) : (
          <ul className="docs-list-rows">
            {props.items.map(({ project, snippet }) => (
              <li key={project.id}>
                <DocsListCard
                  project={project}
                  snippet={snippet}
                  selected={props.selectedId === project.id}
                  onSelect={() => props.onSelect(project.id)}
                  onTogglePinned={() => props.onTogglePinned(project)}
                  onToggleArchived={() => props.onToggleArchived(project)}
                  onDelete={() => props.onDelete(project)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

interface ListCardProps {
  project: DocProject;
  snippet: string | null;
  selected: boolean;
  onSelect: () => void;
  onTogglePinned: () => void;
  onToggleArchived: () => void;
  onDelete: () => void;
}

function DocsListCard({
  project,
  snippet,
  selected,
  onSelect,
  onTogglePinned,
  onToggleArchived,
  onDelete,
}: ListCardProps) {
  const tags = project.tags ?? [];
  return (
    <div
      className={
        "docs-card" +
        (selected ? " is-selected" : "") +
        (project.archived ? " is-archived" : "")
      }
    >
      <button type="button" className="docs-card-main" onClick={onSelect}>
        <div className="docs-card-head">
          <span className="docs-card-title">
            {project.pinned ? <span className="docs-card-pin">★</span> : null}
            {project.title || "(untitled)"}
          </span>
          <span className="docs-card-time">{shortTime(project.updated_at)}</span>
        </div>
        <div className="docs-card-meta">
          <span style={kindChipStyle(project.kind)}>
            <KindIcon kind={project.kind} size={11} />
            {kindLabel(project.kind)}
          </span>
          {tags.slice(0, 3).map((t) => (
            <span key={t} className="docs-card-tag">
              #{t}
            </span>
          ))}
          {tags.length > 3 ? (
            <span className="docs-card-tag is-more">+{tags.length - 3}</span>
          ) : null}
        </div>
        {snippet ? (
          <div className="docs-card-snippet" aria-label={t("docsSnippetAria")}>
            {snippet}
          </div>
        ) : null}
      </button>
      <div className="docs-card-actions" aria-label={t("docsQuickActionsAria")}>
        <button
          type="button"
          className={
            "docs-card-action" + (project.pinned ? " is-on" : "")
          }
          aria-label={project.pinned ? t("docsActionUnpin") : t("docsActionPin")}
          title={project.pinned ? t("docsActionUnpin") : t("docsActionPin")}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePinned();
          }}
        >
          ★
        </button>
        <button
          type="button"
          className="docs-card-action"
          aria-label={project.archived ? t("docsActionRestore") : t("docsActionArchive")}
          title={project.archived ? t("docsActionRestore") : t("docsActionArchive")}
          onClick={(e) => {
            e.stopPropagation();
            onToggleArchived();
          }}
        >
          {project.archived ? "↺" : "⌫"}
        </button>
        <button
          type="button"
          className="docs-card-action is-danger"
          aria-label={t("docsCardActionDelete")}
          title={t("docsCardActionDelete")}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}

function ListEmpty({
  onNew,
  title,
}: {
  onNew: () => void;
  title: string;
}) {
  return (
    <EmptyState
      icon={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 3h9l3 3v15H6z" />
          <path d="M14 3v4h4" />
          <path d="M9 12h6" />
          <path d="M9 16h6" />
        </svg>
      }
      title={t("docsListEmptyTitle", title)}
      cta={{
        label: t("docsCreateFirst"),
        onClick: onNew,
        icon: (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
        ),
      }}
    />
  );
}

// ----------------------- EDITOR COLUMN ----------------------------

interface EditorColumnProps {
  project: DocProject | null;
  draftBuffer: string;
  setDraftBuffer: (s: string) => void;
  previewing: boolean;
  setPreviewing: (b: boolean) => void;
  saveState: SaveState;
  onRetrySave: () => void;
  onFlush: () => void;
  onRename: (next: string) => void;
  onChangeKind: (next: DocKind) => void;
  onChangeTags: (next: string[]) => void;
  onTogglePinned: () => void;
  onToggleArchived: () => void;
  onDelete: () => void;
  tagSuggestions: string[];
}

function DocsEditorColumn(props: EditorColumnProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const jumpTo = (offset: number) => {
    // Scroll the textarea — or, when previewing, the rendered DOM —
    // to the heading at `offset`. For the textarea path we set the
    // selection to the offset which auto-scrolls; for preview we
    // estimate the line by counting newlines and scroll that line
    // into view by querying the rendered headings.
    if (!props.previewing) {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.selectionStart = offset;
      ta.selectionEnd = offset;
      // Ensure the line is in view; the selection-set above usually
      // handles this in modern browsers but Safari 17 sometimes
      // skips when the textarea hasn't been scrolled before.
      const before = props.draftBuffer.slice(0, offset);
      const lineIndex = before.split("\n").length - 1;
      const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 22;
      ta.scrollTop = Math.max(0, lineIndex * lineHeight - 24);
      return;
    }
    // Preview path: pick the corresponding rendered heading by index.
    const before = props.draftBuffer.slice(0, offset).split("\n");
    const headingsBefore = before.filter((line) =>
      /^\s{0,3}#{1,3}\s+/.test(line),
    ).length;
    const root = document
      .querySelector(".docs-editor-preview")
      ?.querySelectorAll("h1, h2, h3");
    if (root && root[headingsBefore]) {
      (root[headingsBefore] as HTMLElement).scrollIntoView({
        block: "start",
        behavior: "smooth",
      });
    }
  };

  if (!props.project) {
    return (
      <section className="docs-3p-editor is-empty" aria-label={t("docsAriaEditor")}>
        <div className="docs-editor-empty">
          <h2>{t("docsEmptyTitle")}</h2>
          <p>{t("docsEmptyDetail")}</p>
        </div>
      </section>
    );
  }
  const stats = bodyStats(props.draftBuffer);
  return (
    <section className="docs-3p-editor" aria-label={t("docsAriaEditor")}>
      <DocsEditorMeta {...props} />
      <DocOutline body={props.draftBuffer} onJump={jumpTo} />
      <div className="docs-editor-body">
        {props.previewing ? (
          <div className="docs-editor-preview">
            <MarkdownView content={props.draftBuffer} />
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            className="docs-editor-textarea"
            value={props.draftBuffer}
            onChange={(e) => props.setDraftBuffer(e.target.value)}
            onBlur={props.onFlush}
            placeholder={t("docsEditorBodyPlaceholder")}
            aria-label={t("docsEditorBodyAria")}
          />
        )}
      </div>
      <footer className="docs-editor-footer">
        <span className="docs-editor-counter">
          {stats.words === 0
            ? t("docsCounterEmpty")
            : t("docsCounterStats", stats.words, stats.minutes)}
        </span>
      </footer>
    </section>
  );
}

function DocsEditorMeta(props: EditorColumnProps) {
  const project = props.project!;
  return (
    <header className="docs-editor-header">
      <div className="docs-editor-title-row">
        <input
          type="text"
          className="docs-editor-title"
          value={project.title}
          onChange={(e) => props.onRename(e.target.value)}
          onBlur={(e) => props.onRename(e.target.value)}
          aria-label={t("docsEditorTitleAria")}
        />
        <div className="docs-editor-title-actions">
          <SaveStatePill state={props.saveState} onRetry={props.onRetrySave} />
          <button
            type="button"
            className={
              "docs-icon-btn" + (project.pinned ? " is-on" : "")
            }
            aria-label={project.pinned ? t("docsActionUnpin") : t("docsActionPin")}
            title={project.pinned ? t("docsActionUnpin") : t("docsActionPin")}
            onClick={props.onTogglePinned}
          >
            ★
          </button>
          <button
            type="button"
            className="docs-icon-btn"
            aria-label={project.archived ? t("docsActionRestore") : t("docsActionArchive")}
            title={project.archived ? t("docsActionRestore") : t("docsActionArchive")}
            onClick={props.onToggleArchived}
          >
            {project.archived ? "↺" : "⌫"}
          </button>
          <button
            type="button"
            className={
              "docs-toggle-preview" + (props.previewing ? " is-on" : "")
            }
            onClick={() => props.setPreviewing(!props.previewing)}
          >
            {props.previewing ? t("docsToggleEdit") : t("docsTogglePreview")}
          </button>
          <button
            type="button"
            className="docs-icon-btn is-danger"
            aria-label={t("docsActionDeleteDoc")}
            title={t("docsActionDeleteDoc")}
            onClick={props.onDelete}
          >
            ×
          </button>
        </div>
      </div>
      <div className="docs-editor-meta-row">
        <select
          className="docs-kind-select"
          value={project.kind}
          onChange={(e) => props.onChangeKind(e.target.value as DocKind)}
          aria-label={t("docsKindAria")}
        >
          {KIND_ORDER.map((k) => (
            <option key={k} value={k}>
              {kindLabel(k)}
            </option>
          ))}
        </select>
        <TagInput
          tags={project.tags ?? []}
          onChange={props.onChangeTags}
          suggestions={props.tagSuggestions}
        />
      </div>
    </header>
  );
}

// ----------------------- CREATE FORM -----------------------------

interface CreateDocFormProps {
  onCancel: () => void;
  onCreate: (title: string, kind: DocKind) => void;
}

function CreateDocForm({ onCancel, onCreate }: CreateDocFormProps) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<DocKind>("note");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  return (
    <form
      className="docs-create-form"
      onSubmit={(e) => {
        e.preventDefault();
        onCreate(title, kind);
      }}
    >
      <label className="docs-create-field">
        <span>{t("docsCreateFieldTitle")}</span>
        <input
          ref={inputRef}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t("docsCreateTitlePlaceholder")}
        />
      </label>
      <label className="docs-create-field">
        <span>{t("docsCreateFieldKind")}</span>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as DocKind)}
        >
          {KIND_ORDER.map((k) => (
            <option key={k} value={k}>
              {kindLabel(k)}
            </option>
          ))}
        </select>
      </label>
      <div className="docs-create-actions">
        <button
          type="button"
          className="docs-btn-ghost"
          onClick={onCancel}
        >
          {t("docsCreateCancel")}
        </button>
        <button type="submit" className="docs-btn-primary">
          {t("docsCreateSubmit")}
        </button>
      </div>
    </form>
  );
}

// ----------------------- helpers ---------------------------------

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = Date.now();
  const diff = now - d.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return t("docsCardTimeJustNow");
  const min = Math.floor(sec / 60);
  if (min < 60) return t("docsCardTimeM", min);
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("docsCardTimeH", hr);
  const day = Math.floor(hr / 24);
  if (day < 7) return t("docsCardTimeD", day);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}-${dd}`;
}

interface BodyStats {
  /// Word count (whitespace-split, excludes pure-punctuation tokens).
  words: number;
  /// Estimated reading time in minutes, capped at 1 minimum so a
  /// non-empty doc never reads "0 min". Uses 220 wpm — middle of
  /// Nielsen's range for screen reading of digital text.
  minutes: number;
}

function bodyStats(s: string): BodyStats {
  if (!s.trim()) return { words: 0, minutes: 0 };
  const words = (s.match(/\S+/g) ?? []).filter((w) => /\w/.test(w)).length;
  const minutes = Math.max(1, Math.round(words / 220));
  return { words, minutes };
}

function scopeTitle(scope: DocScope): string {
  switch (scope.type) {
    case "all":
      return t("docsScopeAll");
    case "pinned":
      return t("docsScopePinned");
    case "archived":
      return t("docsScopeArchive");
    case "kind":
      return kindLabel(scope.kind);
    case "tag":
      return `#${scope.tag}`;
  }
}
