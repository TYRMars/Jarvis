// P17 — Includes management embedded inside MemorySyncSection.
//
// Reads /v1/memory/includes for the active scope, shows each
// directive with resolution status, lets the operator add/remove
// directives and refresh git+ caches. Independent from the
// sync backend choice (includes work whether sync is git, iCloud,
// or none).

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "../../../services/api";

type Scope = "workspace" | "user";

interface IncludeItem {
  target: string;
  kind: "local_path" | "git_url";
  resolves: boolean;
  path?: string;
  error?: string;
}

interface IncludesResponse {
  scope: string;
  memory_md: string;
  items: IncludeItem[];
}

interface Props {
  scope: Scope;
}

export function MemoryIncludesPanel({ scope }: Props) {
  const [data, setData] = useState<IncludesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [newTarget, setNewTarget] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(apiUrl(`/v1/memory/includes?scope=${scope}`));
      if (r.status === 503) {
        setUnavailable(true);
        setData(null);
        return;
      }
      if (!r.ok) {
        setError(`HTTP ${r.status}`);
        return;
      }
      const body = (await r.json()) as IncludesResponse;
      setUnavailable(false);
      setData(body);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const callJson = useCallback(
    async (method: string, path: string, body: unknown): Promise<void> => {
      setActionBusy(true);
      setActionMessage(null);
      try {
        const r = await fetch(apiUrl(path), {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await r.text();
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          // raw — leave as-is
        }
        if (!r.ok) {
          const obj = (parsed ?? {}) as Record<string, unknown>;
          setActionMessage({
            ok: false,
            text:
              (typeof obj.error === "string" && obj.error) || `HTTP ${r.status}`,
          });
          return;
        }
        const obj = (parsed ?? {}) as Record<string, unknown>;
        const summary =
          (typeof obj.added === "string" && `Added ${obj.added}`) ||
          (typeof obj.removed === "string" && `Removed ${obj.removed}`) ||
          (typeof obj.target === "string" && `Refreshed ${obj.target}`) ||
          "OK";
        setActionMessage({ ok: true, text: summary });
        await refresh();
      } catch (e) {
        setActionMessage({ ok: false, text: String(e) });
      } finally {
        setActionBusy(false);
      }
    },
    [refresh],
  );

  if (unavailable) {
    return (
      <div className="memory-sync-empty">
        Memory tools aren't enabled on this server, so includes are unavailable.
      </div>
    );
  }

  return (
    <div className="memory-includes">
      <div className="memory-includes-header">
        <span className="memory-sync-label">Includes ({scope})</span>
        <button
          type="button"
          className="memory-sync-btn ghost"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? "…" : "Reload"}
        </button>
      </div>

      {error && (
        <div className="memory-sync-error" role="alert">
          {error}
        </div>
      )}

      {data && data.items.length === 0 && (
        <div className="memory-includes-empty">No include directives yet.</div>
      )}

      {data && data.items.length > 0 && (
        <ul className="memory-includes-list">
          {data.items.map((item) => (
            <li
              key={item.target}
              className={`memory-includes-item ${item.resolves ? "ok" : "fail"}`}
            >
              <div className="memory-includes-row">
                <span className={`memory-includes-kind kind-${item.kind}`}>
                  {item.kind === "git_url" ? "git" : "local"}
                </span>
                <code className="memory-includes-target">{item.target}</code>
                <div className="memory-includes-actions">
                  {item.kind === "git_url" && (
                    <button
                      type="button"
                      className="memory-sync-btn ghost"
                      disabled={actionBusy}
                      onClick={() =>
                        void callJson("POST", "/v1/memory/includes/refresh", {
                          target: item.target,
                        })
                      }
                      title="Re-clone the cached git copy"
                    >
                      Refresh
                    </button>
                  )}
                  <button
                    type="button"
                    className="memory-sync-btn ghost"
                    disabled={actionBusy}
                    onClick={() =>
                      void callJson("DELETE", "/v1/memory/includes", {
                        target: item.target,
                        scope,
                      })
                    }
                    title="Remove this directive from MEMORY.md"
                  >
                    Remove
                  </button>
                </div>
              </div>
              {item.resolves ? (
                <div className="memory-includes-detail">
                  resolved → <code>{item.path}</code>
                </div>
              ) : (
                <div className="memory-includes-detail memory-includes-err">
                  {item.error || "unresolved"}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="memory-includes-add">
        <input
          type="text"
          className="memory-sync-input"
          placeholder="/abs/path/memory or git+https://host/r.git[#branch]"
          value={newTarget}
          onChange={(e) => setNewTarget(e.target.value)}
          disabled={actionBusy}
        />
        <button
          type="button"
          className="memory-sync-btn"
          disabled={actionBusy || !newTarget.trim()}
          onClick={() =>
            void callJson("POST", "/v1/memory/includes", {
              target: newTarget.trim(),
              scope,
            }).then(() => setNewTarget(""))
          }
        >
          {actionBusy ? "Adding…" : "Add include"}
        </button>
      </div>

      {actionMessage && (
        <div
          className={`memory-sync-result ${actionMessage.ok ? "ok" : "fail"}`}
          role="status"
        >
          {actionMessage.text}
        </div>
      )}
    </div>
  );
}
