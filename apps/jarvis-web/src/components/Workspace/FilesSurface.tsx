// Real file-tree + reader for the right-rail Files panel. Backed by
// `GET /v1/workspace/list` and `GET /v1/workspace/read` in
// `crates/harness-server/src/workspace_files.rs`.
//
// Multi-folder workspaces: when the active project has more than
// one entry in `project.workspaces[]`, every folder gets its own
// collapsible "root" node with the folder name + branch pill. With
// one folder (or no project bound) the tree is rooted at the active
// workspace and rendered flat.
//
// Single panel, two halves: the upper half is the tree, the lower
// half opens automatically when the user clicks a file and shows
// either a code preview or a binary placeholder. The split is
// intentional — the panel lives in the right rail and we don't
// want to introduce a modal for every preview.
//
// All requests are read-only and sandboxed server-side via the same
// `..`/absolute-path rejection the `fs.*` agent tools use.

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { apiUrl } from "../../services/api";
import type { ProjectWorkspace } from "../../types/frames";
import { t } from "../../utils/i18n";

interface FsEntry {
  name: string;
  kind: "dir" | "file" | "symlink" | "other";
  size?: number;
  mtime?: string;
}

interface ListResponse {
  root: string;
  dir: string;
  parent: string | null;
  entries: FsEntry[];
  truncated: boolean;
}

interface ReadResponse {
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content: string;
}

interface RootDescriptor {
  /// Absolute filesystem path. Sent as `?root=` to the API.
  path: string;
  /// Display name. Folder basename for multi-folder projects, the
  /// resolved workspace path otherwise.
  label: string;
}

function tx(key: string, fallback: string): string {
  const v = t(key);
  return v === key ? fallback : v;
}

function basename(p: string): string {
  if (!p) return "";
  const stripped = p.replace(/[\\/]+$/, "");
  const i = Math.max(stripped.lastIndexOf("/"), stripped.lastIndexOf("\\"));
  return i >= 0 ? stripped.slice(i + 1) : stripped;
}

function joinRel(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function buildQuery(parts: Record<string, string | undefined>): string {
  const entries = Object.entries(parts).filter(
    ([, v]) => typeof v === "string" && v.length > 0,
  ) as [string, string][];
  if (entries.length === 0) return "";
  return (
    "?" +
    entries
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&")
  );
}

async function fetchList(
  root: string,
  dir: string,
): Promise<ListResponse | { error: string; code: number }> {
  try {
    const r = await fetch(apiUrl(`/v1/workspace/list${buildQuery({ root, dir })}`));
    if (r.ok) return (await r.json()) as ListResponse;
    // Pull the JSON error body when we have one — the server's
    // `bad_request` / `server_error` helpers always return JSON.
    let detail = "";
    try {
      const body = await r.json();
      detail = typeof body?.error === "string" ? body.error : "";
    } catch {
      /* non-JSON body */
    }
    return { error: detail || `HTTP ${r.status}`, code: r.status };
  } catch (e: any) {
    console.warn("workspace list failed", e);
    return { error: String(e?.message ?? e), code: 0 };
  }
}

async function fetchRead(root: string, path: string): Promise<ReadResponse | null> {
  try {
    const r = await fetch(apiUrl(`/v1/workspace/read${buildQuery({ root, path })}`));
    if (r.status === 503) return null;
    if (!r.ok) throw new Error(`read ${r.status}`);
    return (await r.json()) as ReadResponse;
  } catch (e) {
    console.warn("workspace read failed", e);
    return null;
  }
}

export function FilesSurface() {
  const draftProjectId = useAppStore((s) => s.draftProjectId);
  const projectsById = useAppStore((s) => s.projectsById);
  const draftWorkspacePath = useAppStore((s) => s.draftWorkspacePath);
  const socketWorkspace = useAppStore((s) => s.socketWorkspace);

  // Resolution: project.workspaces[] (when multiple) → active path.
  const roots = useMemo<RootDescriptor[]>(() => {
    const project = draftProjectId ? projectsById[draftProjectId] : null;
    const workspaces: ProjectWorkspace[] = project?.workspaces ?? [];
    if (workspaces.length > 1) {
      return workspaces.map((w) => ({
        path: w.path,
        label: w.name || basename(w.path) || w.path,
      }));
    }
    const active = socketWorkspace ?? draftWorkspacePath;
    if (active) {
      return [{ path: active, label: basename(active) || active }];
    }
    // No active workspace + no override → backend falls back to the
    // server-pinned root. Use an empty path string so the API call
    // sends no `?root=` param.
    return [{ path: "", label: tx("filesRootLabel", "workspace") }];
  }, [draftProjectId, projectsById, socketWorkspace, draftWorkspacePath]);

  const [openPath, setOpenPath] = useState<{ root: string; path: string } | null>(null);
  const [preview, setPreview] = useState<ReadResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [filter, setFilter] = useState("");

  // Reset the preview when the active root list changes — the file
  // we had open might not exist in the new project.
  useEffect(() => {
    setOpenPath(null);
    setPreview(null);
  }, [roots.map((r) => r.path).join("|")]);

  // Lazy file load whenever the user clicks a new file.
  useEffect(() => {
    if (!openPath) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    void fetchRead(openPath.root, openPath.path).then((res) => {
      if (cancelled) return;
      setPreview(res);
      setPreviewLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [openPath]);

  return (
    <div className="files-panel">
      <label className="files-search">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <span className="sr-only">{tx("search", "Search")}</span>
        <input
          type="search"
          placeholder={tx("filesFilterPlaceholder", "Filter files…")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </label>
      <div className="files-tree" role="tree">
        {roots.map((root) => (
          <RootNode
            key={root.path || "(default)"}
            root={root}
            // Default-expand the only root; collapse-by-default for
            // multi-folder projects so the user sees folder pills first.
            initiallyOpen={roots.length === 1}
            filter={filter}
            openPath={openPath}
            onOpenFile={(p) => setOpenPath({ root: root.path, path: p })}
          />
        ))}
      </div>
      {openPath ? (
        <div className="files-preview">
          <div className="files-preview-header">
            <span className="files-preview-path" title={openPath.path}>
              {openPath.path}
            </span>
            {preview ? (
              <span className="files-preview-meta">
                {preview.binary
                  ? tx("filesBinary", "binary")
                  : `${formatSize(preview.size)}${preview.truncated ? " · " + tx("filesTruncated", "truncated") : ""}`}
              </span>
            ) : null}
            <button
              type="button"
              className="ghost-icon files-preview-close"
              onClick={() => setOpenPath(null)}
              aria-label={tx("close", "Close")}
              title={tx("close", "Close")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
          <div className="files-preview-body">
            {previewLoading ? (
              <div className="files-empty">{tx("filesLoading", "Loading…")}</div>
            ) : preview ? (
              preview.binary ? (
                <div className="files-empty">
                  {tx("filesBinaryHint", "Binary file — preview unavailable.")}
                </div>
              ) : (
                <pre className="files-preview-text">{preview.content}</pre>
              )
            ) : (
              <div className="files-empty">
                {tx("filesReadFailed", "Could not read file.")}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RootNode({
  root,
  initiallyOpen,
  filter,
  openPath,
  onOpenFile,
}: {
  root: RootDescriptor;
  initiallyOpen: boolean;
  filter: string;
  openPath: { root: string; path: string } | null;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <div className="files-root">
      <button
        type="button"
        className="files-row files-row-root"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="files-chevron" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <svg className="files-folder" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
        </svg>
        <span title={root.path || ""}>{root.label}</span>
      </button>
      {open ? (
        <DirNode
          root={root.path}
          dir=""
          depth={1}
          filter={filter.trim().toLowerCase()}
          openPath={openPath}
          onOpenFile={onOpenFile}
        />
      ) : null}
    </div>
  );
}

function DirNode({
  root,
  dir,
  depth,
  filter,
  openPath,
  onOpenFile,
}: {
  root: string;
  dir: string;
  depth: number;
  filter: string;
  openPath: { root: string; path: string } | null;
  onOpenFile: (path: string) => void;
}) {
  const [list, setList] = useState<ListResponse | null>(null);
  const [error, setError] = useState<{ msg: string; code: number } | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    const seq = ++seqRef.current;
    setError(null);
    void fetchList(root, dir).then((res) => {
      if (seq !== seqRef.current) return;
      if ("error" in res) {
        setError({ msg: res.error, code: res.code });
        return;
      }
      setList(res);
    });
  }, [root, dir]);

  if (error) {
    // 404 means the route isn't registered — almost always "the
    // server binary predates this UI build". Steer the user toward
    // a rebuild instead of a generic "could not list" dead-end.
    const hint =
      error.code === 404
        ? tx(
            "filesNeedsServerRebuild",
            "Server is missing /v1/workspace/list — rebuild and restart `jarvis serve`.",
          )
        : error.msg;
    return (
      <div
        className="files-empty"
        style={{ paddingLeft: 8 + depth * 14 }}
        title={`${error.code} · ${error.msg}`}
      >
        {hint}
      </div>
    );
  }
  if (!list) {
    return <div className="files-empty" style={{ paddingLeft: 8 + depth * 14 }}>…</div>;
  }
  if (list.entries.length === 0) {
    return (
      <div className="files-empty" style={{ paddingLeft: 8 + depth * 14 }}>
        {tx("filesDirEmpty", "(empty)")}
      </div>
    );
  }

  // Filter is applied bottom-up: an entry passes if its own name
  // matches OR (for a directory) we render it open and let its
  // children carry the filter through. v1 just hides leaf files
  // that don't match — directories stay visible because the user
  // expands them on demand.
  const filtered = filter.length === 0
    ? list.entries
    : list.entries.filter(
        (e) => e.kind === "dir" || e.name.toLowerCase().includes(filter),
      );

  return (
    <ul className="files-children" role="group">
      {filtered.map((entry) => (
        <EntryRow
          key={entry.name}
          entry={entry}
          root={root}
          parentDir={dir}
          depth={depth}
          filter={filter}
          openPath={openPath}
          onOpenFile={onOpenFile}
        />
      ))}
      {list.truncated ? (
        <li className="files-empty" style={{ paddingLeft: 8 + depth * 14 }}>
          {tx("filesTruncatedDir", "(truncated — too many entries)")}
        </li>
      ) : null}
    </ul>
  );
}

function EntryRow({
  entry,
  root,
  parentDir,
  depth,
  filter,
  openPath,
  onOpenFile,
}: {
  entry: FsEntry;
  root: string;
  parentDir: string;
  depth: number;
  filter: string;
  openPath: { root: string; path: string } | null;
  onOpenFile: (path: string) => void;
}) {
  const path = joinRel(parentDir, entry.name);
  const [open, setOpen] = useState(false);
  const isOpenFile = openPath && openPath.root === root && openPath.path === path;

  if (entry.kind === "dir") {
    return (
      <li>
        <button
          type="button"
          className="files-row"
          onClick={() => setOpen((o) => !o)}
          style={{ paddingLeft: 8 + depth * 14 }}
          aria-expanded={open}
        >
          <span className="files-chevron" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
          <svg className="files-folder" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
          </svg>
          <span>{entry.name}</span>
        </button>
        {open ? (
          <DirNode
            root={root}
            dir={path}
            depth={depth + 1}
            filter={filter}
            openPath={openPath}
            onOpenFile={onOpenFile}
          />
        ) : null}
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        className={"files-row files-row-file" + (isOpenFile ? " is-open" : "")}
        onClick={() => onOpenFile(path)}
        style={{ paddingLeft: 8 + depth * 14 + 14 }}
        title={path}
      >
        <svg className="files-file" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        <span>{entry.name}</span>
        {entry.size != null ? <em>{formatSize(entry.size)}</em> : null}
      </button>
    </li>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
