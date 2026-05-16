// P14 — Settings → System → Memory Sync.
//
// One panel covering all three backend modes:
// - `none`: shows "memory sync is off" with how-to-enable hint
// - `git`: status (branch / remote / dirty), "Sync now" + setup form
// - `icloud`: shows iCloud Drive path, setup button
//
// Talks to /v1/memory/sync_status (read) and /v1/memory/{sync,
// sync_setup, sync_setup_icloud} (write). All 503-aware — the
// operator who hasn't enabled memory sees a clean off-state
// instead of a broken page.

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "../../../services/api";
import { Section } from "./Section";
import { MemoryIncludesPanel } from "./MemoryIncludesPanel";

interface SyncStatus {
  backend: "none" | "git" | "icloud";
  user_root: string | null;
  workspace_root: string | null;
  user_scope?: GitUserScope | { error: string } | { raw: string };
}

interface GitUserScope {
  scope: string;
  dir: string;
  is_git_repo: boolean;
  branch?: string;
  remote_url?: string | null;
  dirty?: boolean;
  status?: string;
  head?: string;
  setup_hint?: string;
  hint?: string;
}

interface ActionResult {
  ok: boolean;
  message: string;
  raw?: unknown;
}

interface Props {
  embedded?: boolean;
}

export function MemorySyncSection({ embedded }: Props = {}) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionResult, setActionResult] = useState<ActionResult | null>(null);
  const [remoteUrl, setRemoteUrl] = useState("");

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(apiUrl("/v1/memory/sync_status"));
      if (r.status === 503) {
        setUnavailable(true);
        setStatus(null);
        return;
      }
      if (!r.ok) {
        setError(`HTTP ${r.status}`);
        return;
      }
      const body = (await r.json()) as SyncStatus;
      setUnavailable(false);
      setStatus(body);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const doAction = useCallback(
    async (path: string, body?: unknown): Promise<void> => {
      setActionBusy(true);
      setActionResult(null);
      try {
        const r = await fetch(apiUrl(path), {
          method: "POST",
          headers: body ? { "Content-Type": "application/json" } : {},
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await r.text();
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          // raw text — keep as-is
        }
        if (!r.ok) {
          setActionResult({
            ok: false,
            message: extractError(parsed) || `HTTP ${r.status}`,
            raw: parsed,
          });
          return;
        }
        setActionResult({
          ok: true,
          message: extractMessage(parsed) || "ok",
          raw: parsed,
        });
        await fetchStatus();
      } catch (e) {
        setActionResult({ ok: false, message: String(e) });
      } finally {
        setActionBusy(false);
      }
    },
    [fetchStatus],
  );

  const content = (
    <>
      {unavailable && (
        <div className="memory-sync-empty">
          Memory tools aren't enabled on this server. Set{" "}
          <code>JARVIS_ENABLE_MEMORY=1</code> (or{" "}
          <code>[agent].enable_memory = true</code> in config) and restart.
        </div>
      )}
      {error && (
        <div className="memory-sync-error" role="alert">
          Failed to load status: {error}
        </div>
      )}
      {!unavailable && status && (
        <>
          <div className="memory-sync-row">
            <span className="memory-sync-label">Backend</span>
            <BackendBadge backend={status.backend} />
          </div>
          <div className="memory-sync-row">
            <span className="memory-sync-label">User root</span>
            <code>{status.user_root ?? "(unconfigured)"}</code>
          </div>
          <div className="memory-sync-row">
            <span className="memory-sync-label">Workspace root</span>
            <code>{status.workspace_root ?? "(unconfigured)"}</code>
          </div>

          {status.backend === "git" && status.user_scope && (
            <GitDetails
              scope={status.user_scope as GitUserScope}
              busy={actionBusy}
              remoteUrl={remoteUrl}
              onRemoteUrlChange={setRemoteUrl}
              onSync={() => doAction("/v1/memory/sync")}
              onSetup={() =>
                doAction("/v1/memory/sync_setup", {
                  remote_url: remoteUrl,
                  force: false,
                })
              }
            />
          )}

          {status.backend === "icloud" && (
            <div className="memory-sync-icloud">
              <p>
                iCloud Drive syncs at the OS level — no manual push/pull needed.
                Use the button below to create the <code>Jarvis</code> folder
                inside iCloud Drive if it doesn't exist yet.
              </p>
              <button
                type="button"
                className="memory-sync-btn"
                disabled={actionBusy}
                onClick={() => doAction("/v1/memory/sync_setup_icloud")}
              >
                {actionBusy ? "Setting up…" : "Set up iCloud folder"}
              </button>
            </div>
          )}

          {status.backend === "none" && (
            <div className="memory-sync-off">
              Sync backend is set to <strong>none</strong>. Memory tools work
              locally but nothing leaves this machine.
              <br />
              Set <code>JARVIS_MEMORY_SYNC_BACKEND=git</code> (or{" "}
              <code>=icloud</code> on macOS) and restart to enable.
            </div>
          )}

          {actionResult && (
            <div
              className={`memory-sync-result ${actionResult.ok ? "ok" : "fail"}`}
              role="status"
            >
              {actionResult.message}
            </div>
          )}
          <div className="memory-sync-footer">
            <button
              type="button"
              className="memory-sync-btn ghost"
              disabled={loading}
              onClick={() => void fetchStatus()}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {/* P17 — include directives, independent of the sync
              backend. Workspace + user shown side-by-side; the
              user one only renders when user_root is configured. */}
          <div className="memory-includes-wrap">
            <MemoryIncludesPanel scope="workspace" />
            {status.user_root && <MemoryIncludesPanel scope="user" />}
          </div>
        </>
      )}
    </>
  );

  if (embedded) return <div className="memory-sync-pane">{content}</div>;
  return (
    <Section
      id="memory-sync"
      titleKey="settingsMemorySyncTitle"
      titleFallback="Memory Sync"
      descKey="settingsMemorySyncDesc"
      descFallback="Configure where agent-maintained memory is stored and how it syncs across machines."
    >
      <div className="memory-sync-pane">{content}</div>
    </Section>
  );
}

interface GitDetailsProps {
  scope: GitUserScope;
  busy: boolean;
  remoteUrl: string;
  onRemoteUrlChange: (v: string) => void;
  onSync: () => void;
  onSetup: () => void;
}

function GitDetails({
  scope,
  busy,
  remoteUrl,
  onRemoteUrlChange,
  onSync,
  onSetup,
}: GitDetailsProps) {
  if (!scope.is_git_repo) {
    return (
      <div className="memory-sync-setup">
        <p>Memory dir is not a git repo yet. Connect it to a remote:</p>
        <div className="memory-sync-form">
          <input
            type="text"
            placeholder="git@github.com:me/jarvis-memory.git"
            value={remoteUrl}
            onChange={(e) => onRemoteUrlChange(e.target.value)}
            disabled={busy}
            className="memory-sync-input"
          />
          <button
            type="button"
            className="memory-sync-btn"
            onClick={onSetup}
            disabled={busy || !remoteUrl.trim()}
          >
            {busy ? "Setting up…" : "Set up & push"}
          </button>
        </div>
        <details>
          <summary>Setup hint</summary>
          <pre>{scope.setup_hint ?? "—"}</pre>
        </details>
      </div>
    );
  }
  return (
    <div className="memory-sync-git">
      <div className="memory-sync-row">
        <span className="memory-sync-label">Branch</span>
        <code>{scope.branch ?? "—"}</code>
      </div>
      <div className="memory-sync-row">
        <span className="memory-sync-label">Remote</span>
        <code>{scope.remote_url ?? "(none — set one with git remote add origin)"}</code>
      </div>
      <div className="memory-sync-row">
        <span className="memory-sync-label">HEAD</span>
        <code>{scope.head?.slice(0, 12) ?? "—"}</code>
      </div>
      <div className="memory-sync-row">
        <span className="memory-sync-label">Dirty</span>
        <code>{scope.dirty ? "yes" : "no"}</code>
      </div>
      {scope.status && scope.status.trim() && (
        <details>
          <summary>git status</summary>
          <pre>{scope.status}</pre>
        </details>
      )}
      <button
        type="button"
        className="memory-sync-btn"
        onClick={onSync}
        disabled={busy}
      >
        {busy ? "Syncing…" : "Sync now"}
      </button>
    </div>
  );
}

function BackendBadge({ backend }: { backend: SyncStatus["backend"] }) {
  const label = backend === "icloud" ? "iCloud" : backend === "git" ? "Git" : "None";
  return <span className={`memory-sync-badge backend-${backend}`}>{label}</span>;
}

function extractMessage(parsed: unknown): string | null {
  if (typeof parsed === "string") return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.hint === "string") return obj.hint;
    if (obj.push && typeof obj.push === "object") {
      const push = obj.push as Record<string, unknown>;
      if (push.ok === true) return "Synced successfully.";
      if (push.ok === false && typeof push.stderr === "string") {
        return `Push failed: ${push.stderr.slice(0, 240)}`;
      }
    }
    if (typeof obj.path === "string") return `Set up at ${obj.path}`;
  }
  return null;
}

function extractError(parsed: unknown): string | null {
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.error === "string") return obj.error;
  }
  return null;
}
