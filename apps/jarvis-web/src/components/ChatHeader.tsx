// Chat header crumb: "Jarvis / <active conversation title>". The
// title resolves to (override → server-derived → "#<id-prefix>"),
// matching the sidebar so the user sees the same name in both places.
//
// Subscribes to `activeId` and `convoRows`; the legacy
// `setActiveLabel` helper is still called by the imperative side
// but is now a no-op since this component owns the slot.

import { useAppStore } from "../store/appStore";
import { resolveTitle } from "../store/persistence";

export function ChatHeader() {
  const activeId = useAppStore((s) => s.activeId);
  const rows = useAppStore((s) => s.convoRows);

  let label = "";
  if (activeId) {
    const row = rows.find((r) => r.id === activeId);
    label = row ? resolveTitle(row) : activeId.slice(0, 8);
  }

  return (
    <div className="project-crumb">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      </svg>
      <span>Jarvis</span>
      {label && <span className="crumb-separator">/</span>}
      <span id="active-id" className="conversation-id">{label}</span>
    </div>
  );
}
