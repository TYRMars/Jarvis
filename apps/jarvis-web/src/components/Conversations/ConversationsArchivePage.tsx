// Full-page conversation history browse. Sibling to the sidebar's
// ConvoList (which is space-constrained and only shows recent rows);
// this page surfaces every persisted conversation with a search box,
// project filter, and date grouping. Click a row → resume the
// conversation and land on the chat layout.
//
// Deep-link: `/conversations/:id` directly resumes that id and
// redirects to `/`. Useful for chat URLs that survive bookmarks /
// browser back even when the row scrolled out of the sidebar.

import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";

import { resumeConversation, refreshConvoList } from "../../services/conversations";
import { useAppStore } from "../../store/appStore";
import type { ConvoListRow } from "../../types/frames";
import { t } from "../../utils/i18n";
import { convoGroupLabel, relTime } from "../../utils/time";

/// `/conversations/:id` — resumes the conversation server-side then
/// redirects to chat. Renders nothing visible.
export function ConversationDeepLinkRedirect() {
  const { id } = useParams<{ id: string }>();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!id) return;
    void resumeConversation(id).finally(() => setDone(true));
  }, [id]);
  if (!id) return <Navigate to="/conversations" replace />;
  if (!done) return null;
  return <Navigate to="/" replace />;
}

/// `/conversations` — full-page archive browse.
export function ConversationsArchivePage() {
  // Subscribe to lang for re-render on toggle
  useAppStore((s) => s.lang);
  const rows = useAppStore((s) => s.convoRows);
  const projects = useAppStore((s) => s.projects);
  const persistEnabled = useAppStore((s) => s.persistEnabled);
  const [query, setQuery] = useState("");
  // Wider type than necessary in spirit, but `string` swallows
  // the `"all"` literal — eslint flags the union as redundant.
  // Plain `string` is fine: we use the sentinel `"all"` only in a
  // single equality check below.
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const navigate = useNavigate();

  useEffect(() => {
    void refreshConvoList();
  }, []);

  const projectsById = useMemo(() => {
    const m = new Map<string, string>();
    projects.forEach((p) => m.set(p.id, p.name));
    return m;
  }, [projects]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (projectFilter !== "all" && row.project_id !== projectFilter) {
        return false;
      }
      if (!q) return true;
      const haystack = [row.title, row.id, row.requirement_title]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [rows, query, projectFilter]);

  const grouped = useMemo(() => groupByDate(filtered), [filtered]);

  return (
    <main
      id="conversations-archive-page"
      className="conversations-archive-page"
      tabIndex={-1}
      style={pageStyle}
    >
      <header style={pageHeaderStyle}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>
            {t("conversationsArchiveTitle")}
          </h1>
          <p style={{ margin: "6px 0 0", opacity: 0.7, fontSize: 13 }}>
            {t("conversationsArchiveSubtitle")}
          </p>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("conversationsArchiveSearchPlaceholder")}
            aria-label={t("conversationsArchiveSearchAria")}
            style={searchInputStyle}
          />
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            aria-label={t("conversationsArchiveProjectFilterAria")}
            style={selectStyle}
          >
            <option value="all">{t("conversationsArchiveProjectAll")}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      {!persistEnabled ? (
        <div style={panelStyle}>
          <p style={emptyStyle}>{t("conversationsArchivePersistDisabled")}</p>
        </div>
      ) : rows.length === 0 ? (
        <div style={panelStyle}>
          <p style={emptyStyle}>{t("conversationsArchiveEmpty")}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div style={panelStyle}>
          <p style={emptyStyle}>{t("conversationsArchiveNoMatch")}</p>
        </div>
      ) : (
        grouped.map(({ label, items }) => (
          <section key={label} style={panelStyle}>
            <header style={groupHeaderStyle}>
              <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>
                {label}
              </h2>
              <span style={{ opacity: 0.55, fontSize: 12 }}>
                {t("conversationsArchiveGroupCount", items.length)}
              </span>
            </header>
            <ul style={listStyle}>
              {items.map((row) => {
                const projectName =
                  row.project_id && projectsById.get(row.project_id);
                return (
                  <li key={row.id} style={rowStyle}>
                    <button
                      type="button"
                      style={rowMainBtnStyle}
                      onClick={() => {
                        // Fire-and-forget: navigate as soon as the
                        // resume frame is in flight; the chat pane
                        // reconciles on the server's reply. Floating
                        // promise is intentional here — eslint's
                        // no-floating-promises wants either await or
                        // explicit `void`, and the latter is what we
                        // want at an event-handler boundary.
                        void resumeConversation(row.id).then(() =>
                          navigate("/"),
                        );
                      }}
                      title={row.id}
                    >
                      <span style={rowTitleStyle}>
                        {row.title || t("conversationsArchiveUntitled")}
                      </span>
                      <span style={rowSubStyle}>
                        {projectName
                          ? `${projectName} · `
                          : t("conversationsArchiveFreeChat") + " · "}
                        {row.message_count}{" "}
                        {t("conversationsArchiveMessageSuffix")}
                        {" · "}
                        {relTime(row.updated_at ?? row.created_at)}
                      </span>
                      {row.requirement_title && (
                        <span style={rowMetaStyle}>
                          {t("conversationsArchiveLinkedRequirement", row.requirement_title)}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </main>
  );
}

// ============================================================
// Helpers
// ============================================================

function groupByDate(
  rows: ConvoListRow[],
): { label: string; items: ConvoListRow[] }[] {
  const map = new Map<string, ConvoListRow[]>();
  // Preserve insertion order so the "newest" group sticks to the top
  // when the input is already sorted desc by updated_at.
  const order: string[] = [];
  for (const r of rows) {
    const label = convoGroupLabel(r);
    if (!map.has(label)) {
      map.set(label, []);
      order.push(label);
    }
    map.get(label)!.push(r);
  }
  return order.map((label) => ({ label, items: map.get(label)! }));
}

// ============================================================
// Inline styles
// ============================================================

const pageStyle: React.CSSProperties = {
  padding: 24,
  display: "flex",
  flexDirection: "column",
  gap: 16,
  overflowY: "auto",
  height: "100vh",
  boxSizing: "border-box",
};

const pageHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: 16,
  flexWrap: "wrap",
};

const panelStyle: React.CSSProperties = {
  border: "1px solid var(--border, #2b2b2b)",
  borderRadius: 8,
  background: "var(--card-bg, rgba(255,255,255,0.02))",
  padding: 12,
};

const groupHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 8,
};

const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  padding: "8px 10px",
  border: "1px solid var(--border-subtle, rgba(255,255,255,0.06))",
  borderRadius: 6,
};

const rowMainBtnStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 2,
  background: "transparent",
  border: "none",
  cursor: "pointer",
  textAlign: "left",
  color: "inherit",
  padding: 0,
};

const rowTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
};

const rowSubStyle: React.CSSProperties = {
  fontSize: 11,
  opacity: 0.65,
};

const rowMetaStyle: React.CSSProperties = {
  fontSize: 11,
  opacity: 0.55,
  marginTop: 2,
};

const emptyStyle: React.CSSProperties = {
  margin: 0,
  padding: "16px 4px",
  fontSize: 12,
  opacity: 0.6,
};

const searchInputStyle: React.CSSProperties = {
  background: "var(--input-bg, rgba(255,255,255,0.04))",
  border: "1px solid var(--border, #2b2b2b)",
  borderRadius: 6,
  padding: "6px 10px",
  color: "inherit",
  fontSize: 13,
  minWidth: 220,
};

const selectStyle: React.CSSProperties = {
  background: "var(--input-bg, rgba(255,255,255,0.04))",
  border: "1px solid var(--border, #2b2b2b)",
  borderRadius: 6,
  padding: "6px 10px",
  color: "inherit",
  fontSize: 13,
};
