import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAppStore } from "../../store/appStore";
import type { DocProject } from "../../types/frames";
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
import { sendFrame } from "../../services/socket";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { DocOutline } from "./DocOutline";
import { BlockEditor, createMockUploadAdapter } from "./Editor";
import { SaveStatePill, type SaveState } from "./SaveStatePill";
import { TagInput } from "./TagInput";
import { useAutosave } from "./useAutosave";

// Mock upload adapter — every editor instance shares one. We mint
// a single object URL per file and the browser keeps the bytes
// alive until the tab closes. Replace with a real backend-backed
// adapter when /docs gets server-side image hosting.
const UPLOAD_ADAPTER = createMockUploadAdapter();

export function DocsPage() {
  const { id: routeId } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const socketWorkspace = useAppStore((s) => s.socketWorkspace);
  const [version, setVersion] = useState(0);
  const [draftBuffer, setDraftBuffer] = useState<string>("");
  // `draftReady` gates BlockEditor mount until `loadDocDraft`
  // resolves for the active doc. Without this gate, switching from
  // doc A to doc B would mount BlockEditor with whatever
  // draftBuffer the previous doc left behind — the editor's
  // `initialMarkdown` is captured once via `useState` and never
  // re-read, so subsequent setDraftBuffer calls are silently
  // ignored. Result: doc B shows doc A's body, and any typing
  // overwrites A's content under B's id. Holding mount until the
  // draft load completes for *this* id eliminates the race.
  const [draftReady, setDraftReady] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<DocProject | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  const workspace = socketWorkspace ?? "";

  // Subscribe to the docs cache (covers WS pushes + local mutations).
  useEffect(() => subscribeDocs(() => setVersion((v) => v + 1)), []);

  // Refetch on workspace switch.
  useEffect(() => {
    void loadDocProjects(socketWorkspace ?? undefined);
  }, [socketWorkspace]);

  // Sidebar's "+ New" button creates inline now, but the legacy
  // event listener stays so any other surface that dispatches the
  // event keeps working — it just creates a doc and routes to it.
  useEffect(() => {
    const onNew = () => {
      void (async () => {
        const project = await createDocProject({
          title: t("docsCreateUntitled") || "Untitled",
          kind: "note",
          ...(workspace ? { workspace } : {}),
        });
        if (project) void navigate(`/docs/${project.id}`);
      })();
    };
    window.addEventListener("jarvis:new-doc", onNew);
    return () => window.removeEventListener("jarvis:new-doc", onNew);
  }, [workspace, navigate]);

  // Cmd/Ctrl+S forces a flush of the autosave timer.
  // (The textarea-era ↑/↓ list cycling is gone — selection now lives
  // in the sidebar's NavLinks, which already get keyboard nav from
  // the platform.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const onDocsPage =
        document.getElementById("docs-page")?.contains(target ?? null) ?? false;
      if (!onDocsPage) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        void autosave.flush();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Resolve the route id to a real project. Mismatches (deleted doc,
  // wrong workspace, hand-typed garbage URL) show the empty state.
  const selected: DocProject | null = useMemo(
    () => (routeId ? projects.find((p) => p.id === routeId) ?? null : null),
    [routeId, projects],
  );

  // Auto-pick first non-archived doc when no route id is set —
  // replace history so the bare /docs URL doesn't pollute the back
  // stack. Triggers only on initial mount / when projects load in.
  useEffect(() => {
    if (routeId) return;
    const first = projects.find((p) => !p.archived);
    if (first) {
      void navigate(`/docs/${first.id}`, { replace: true });
    }
  }, [routeId, projects, navigate]);

  // Load draft on selection change.
  //
  // Two ordering rules matter here:
  // 1. Reset `draftReady` to false BEFORE kicking off the load, so
  //    the BlockEditor unmounts (or stays unmounted) for the
  //    duration of the fetch. The remount that lands after
  //    `setDraftReady(true)` then reads the *correct* initial
  //    content via the editor's lazy `useState`.
  // 2. Clear `draftBuffer` synchronously too. If a render slips in
  //    between "selected.id changed" and the load completing,
  //    nothing is allowed to render the BlockEditor with stale
  //    bytes — even the loading skeleton sees an empty string.
  useEffect(() => {
    if (!selected) {
      setDraftBuffer("");
      setSaveState({ kind: "idle" });
      setDraftReady(false);
      return;
    }
    const id = selected.id;
    setDraftReady(false);
    setDraftBuffer("");
    let cancelled = false;
    void loadDocDraft(id).then(() => {
      if (cancelled) return;
      const d = getDocDraft(id);
      const content = d?.content ?? "";
      setDraftBuffer(content);
      autosave.reset(content);
      setSaveState(
        d?.updated_at
          ? { kind: "saved", at: new Date(d.updated_at).getTime() }
          : { kind: "idle" },
      );
      setDraftReady(true);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

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
      } catch (e) {
        const message =
          e instanceof Error
            ? e.message
            : typeof e === "string"
              ? e
              : "Save failed";
        setSaveState({ kind: "error", message });
        throw e;
      }
    },
    [online],
  );

  const autosave = useAutosave({
    id: selected?.id ?? null,
    content: draftBuffer,
    save: persist,
  });

  const onRename = async (next: string) => {
    if (!selected) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    await updateDocProject(selected.id, { title: trimmed });
  };

  const onChangeTags = async (next: string[]) => {
    if (!selected) return;
    await updateDocProject(selected.id, { tags: next });
  };

  const onTogglePinned = async () => {
    if (!selected) return;
    await updateDocProject(selected.id, { pinned: !selected.pinned });
  };

  const onToggleArchived = async () => {
    if (!selected) return;
    await updateDocProject(selected.id, { archived: !selected.archived });
  };

  const onAskAgent = () => {
    if (!selected) return;
    sendFrame({ type: "activate_skill", name: "doc" });
    const excerpt = draftBuffer.trim().slice(0, 800);
    useAppStore
      .getState()
      .setComposerValue(
        t("docsAskAgentPrompt", selected.id, selected.title, excerpt),
      );
    void navigate("/");
    requestAnimationFrame(() => document.getElementById("input")?.focus());
  };

  const onDelete = async () => {
    if (!confirmingDelete) return;
    const id = confirmingDelete.id;
    setConfirmingDelete(null);
    if (await deleteDocProject(id)) {
      // Surface goes back to the empty / first-doc state. The auto-
      // pick effect above will route us to the next doc on its own.
      if (routeId === id) void navigate("/docs", { replace: true });
    }
  };

  // Tag suggestions: union of all existing tags ranked by frequency.
  // Source-of-truth for the editor's TagInput autocomplete.
  const tagSuggestions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of projects) {
      for (const tag of p.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([tag]) => tag);
  }, [projects]);

  const onCreateFirst = async () => {
    const project = await createDocProject({
      title: t("docsCreateUntitled") || "Untitled",
      kind: "note",
      ...(workspace ? { workspace } : {}),
    });
    if (project) void navigate(`/docs/${project.id}`);
  };

  return (
    <main
      id="docs-page"
      className="docs-page docs-page-single"
      aria-label={t("docsAriaPage")}
      tabIndex={-1}
    >
      {selected ? (
        <DocsEditorColumn
          project={selected}
          draftBuffer={draftBuffer}
          setDraftBuffer={(next) => {
            setDraftBuffer(next);
            setSaveState((prev) =>
              prev.kind === "saving" || prev.kind === "offline"
                ? prev
                : { kind: "idle" },
            );
          }}
          draftReady={draftReady}
          previewing={previewing}
          setPreviewing={setPreviewing}
          saveState={saveState}
          onRetrySave={() => {
            if (selected) void persist(selected.id, draftBuffer);
          }}
          onFlush={() => void autosave.flush()}
          onRename={onRename}
          onChangeTags={onChangeTags}
          onTogglePinned={onTogglePinned}
          onToggleArchived={onToggleArchived}
          onAskAgent={onAskAgent}
          onDelete={() => setConfirmingDelete(selected)}
          tagSuggestions={tagSuggestions}
        />
      ) : (
        <DocsEmptyPane onCreate={() => void onCreateFirst()} />
      )}

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

// ---------------------- empty pane ------------------------------

function DocsEmptyPane({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="docs-3p-editor is-empty" aria-label={t("docsAriaEditor")}>
      <header className="docs-empty-header">
        <OpenSidebarButton />
      </header>
      <EmptyState
        icon={
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 3h9l3 3v15H6z" />
            <path d="M14 3v4h4" />
            <path d="M9 12h6" />
            <path d="M9 16h6" />
          </svg>
        }
        title={t("docsEmptyTitle")}
        hint={t("docsEmptyDetail")}
        cta={{
          label: t("docsCreateFirst"),
          onClick: onCreate,
          icon: (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
          ),
        }}
      />
    </section>
  );
}

// ---------------------- editor pane -----------------------------

interface EditorColumnProps {
  project: DocProject;
  draftBuffer: string;
  setDraftBuffer: (s: string) => void;
  /** False while the parent is still fetching the draft for the
   *  active doc id. The body region renders a skeleton during this
   *  window so the BlockEditor never mounts with stale bytes from
   *  the previous selection. */
  draftReady: boolean;
  previewing: boolean;
  setPreviewing: (b: boolean) => void;
  saveState: SaveState;
  onRetrySave: () => void;
  onFlush: () => void;
  onRename: (next: string) => void;
  onChangeTags: (next: string[]) => void;
  onTogglePinned: () => void;
  onToggleArchived: () => void;
  onAskAgent: () => void;
  onDelete: () => void;
  tagSuggestions: string[];
}

function DocsEditorColumn(props: EditorColumnProps) {
  const jumpTo = (offset: number) => {
    // Heading order is the same in the markdown source and in the
    // rendered DOM (preview or BlockEditor), so we count headings
    // before `offset` and scroll the Nth heading element into view.
    const before = props.draftBuffer.slice(0, offset).split("\n");
    const headingsBefore = before.filter((line) =>
      /^\s{0,3}#{1,3}\s+/.test(line),
    ).length;
    const rootSelector = props.previewing
      ? ".docs-editor-preview"
      : ".docs-editor-body .ProseMirror";
    const root = document
      .querySelector(rootSelector)
      ?.querySelectorAll("h1, h2, h3");
    const target = root?.[headingsBefore];
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  };

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
        ) : props.draftReady ? (
          <BlockEditor
            // Mount-only `initialMarkdown` is now safe because
            // `draftReady` flips false during the load and back to
            // true only after the buffer matches this doc's
            // server-side draft. See the comment on `draftReady`
            // in DocsPage for the race the gate prevents.
            key={props.project.id}
            initialMarkdown={props.draftBuffer}
            onMarkdownChange={props.setDraftBuffer}
            uploadAdapter={UPLOAD_ADAPTER}
            ariaLabel={t("docsEditorBodyAria")}
          />
        ) : (
          <div className="docs-editor-loading" aria-busy>
            <span className="docs-editor-loading-spinner" aria-hidden />
          </div>
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
  const project = props.project;
  const titleRef = useRef<HTMLInputElement>(null);

  // Local mirror of the title so onChange doesn't fire a network
  // PUT per keystroke (the previous design caused a save storm —
  // 11 chars typed = 11 PATCH requests, with intermediate states
  // like "d" or "Te" persisting if the user paused).
  // Commit happens on blur or Enter — explicit save points the
  // user can predict.
  const [titleDraft, setTitleDraft] = useState(project.title);

  // Sync the draft from the project ONLY when the doc id changes.
  // Syncing on every render would clobber in-flight typing (the
  // backend echo would arrive a tick after each PATCH and reset
  // the input). Tracking by id confines the sync to genuine
  // selection changes.
  const prevIdRef = useRef(project.id);
  useEffect(() => {
    if (prevIdRef.current === project.id) return;
    prevIdRef.current = project.id;
    setTitleDraft(project.title);

    // Auto-focus + select for "new doc" UX. When the title is one
    // of the i18n untitled defaults, the user almost certainly
    // wants to type a real name immediately — saves a click.
    const untitledLabels = [
      t("docsCreateUntitled") || "Untitled",
      t("docsUntitled") || "Untitled",
      "Untitled",
      "未命名文档",
    ];
    if (untitledLabels.includes(project.title)) {
      // RAF defers focus until React's commit phase finishes, so
      // the input element is mounted in its post-render position.
      const handle = window.requestAnimationFrame(() => {
        titleRef.current?.focus();
        titleRef.current?.select();
      });
      return () => window.cancelAnimationFrame(handle);
    }
    return;
  }, [project.id, project.title]);

  const commitRename = () => {
    const trimmed = titleDraft.trim();
    if (trimmed.length === 0) {
      // Empty title — revert local state to whatever the server has.
      setTitleDraft(project.title);
      return;
    }
    if (trimmed === project.title) return;
    props.onRename(trimmed);
  };

  return (
    <header className="docs-editor-header">
      <div className="docs-editor-title-row">
        <OpenSidebarButton />
        <input
          ref={titleRef}
          type="text"
          className="docs-editor-title"
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitRename();
              // Hand focus to the editor body so the user can keep
              // typing without a separate click.
              const body = document.querySelector<HTMLElement>(
                ".docs-editor-body .ProseMirror",
              );
              body?.focus();
            } else if (e.key === "Escape") {
              // Discard local edit and bail out of the input.
              setTitleDraft(project.title);
              titleRef.current?.blur();
            }
          }}
          aria-label={t("docsEditorTitleAria")}
        />
        <div className="docs-editor-title-actions">
          <SaveStatePill state={props.saveState} onRetry={props.onRetrySave} />
          <button
            type="button"
            className={"docs-icon-btn" + (project.pinned ? " is-on" : "")}
            aria-label={
              project.pinned ? t("docsActionUnpin") : t("docsActionPin")
            }
            title={project.pinned ? t("docsActionUnpin") : t("docsActionPin")}
            onClick={props.onTogglePinned}
          >
            ★
          </button>
          <button
            type="button"
            className="docs-icon-btn"
            aria-label={t("docsActionSave")}
            title={t("docsActionSave")}
            onClick={props.onFlush}
            disabled={props.saveState.kind === "saving"}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <path d="M17 21v-8H7v8" />
              <path d="M7 3v5h8" />
            </svg>
          </button>
          <button
            type="button"
            className="docs-icon-btn"
            aria-label={
              project.archived
                ? t("docsActionRestore")
                : t("docsActionArchive")
            }
            title={
              project.archived
                ? t("docsActionRestore")
                : t("docsActionArchive")
            }
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
            className="docs-icon-btn"
            aria-label={t("docsAskAgent")}
            title={t("docsAskAgent")}
            onClick={props.onAskAgent}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
              <path d="M8 9h8" />
              <path d="M8 13h5" />
            </svg>
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
        <TagInput
          tags={project.tags ?? []}
          onChange={props.onChangeTags}
          suggestions={props.tagSuggestions}
        />
      </div>
    </header>
  );
}

// ---------------------- helpers ---------------------------------

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
