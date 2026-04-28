// Left rail: topbar (toggle + open quick search), mode row,
// nav-list (New session + Routines/Customize stubs), conversation
// list, sidebar footer with the account chip + connection status.
//
// Mode-row / Routines+Customize are still UI placeholders (no real
// action yet) — kept so the visual frame matches the design while we
// land the rest of the app, not because they do anything.

import { useAppStore } from "../store/appStore";
import { ConnectionStatus } from "./ConnectionStatus";
import { ConvoList } from "./Sidebar/ConvoList";
import { AccountMenu } from "./Settings/AccountMenu";
import { newConversation } from "../services/conversations";

export function AppSidebar() {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen);
  const focusSearch = () => {
    document.getElementById("convo-search")?.focus();
  };

  return (
    <aside id="sidebar" aria-label="Conversations">
      <div className="sidebar-topbar">
        <button
          id="toggle-sidebar"
          type="button"
          className="ghost-icon"
          title="Toggle sidebar"
          aria-label="Toggle sidebar"
          aria-expanded={sidebarOpen}
          aria-controls="sidebar"
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M9 5v14" />
          </svg>
        </button>
        <button
          id="open-quick-search"
          type="button"
          className="ghost-icon"
          title="Search"
          aria-label="Search"
          onClick={focusSearch}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
        </button>
      </div>

      <div className="mode-row">
        <button type="button" className="ghost-icon" title="Chat" aria-label="Chat">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h7" />
            <path d="M17 8h.01" />
            <path d="M21 8h.01" />
          </svg>
        </button>
        <button type="button" className="mode-pill">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m16 18 6-6-6-6" />
            <path d="m8 6-6 6 6 6" />
          </svg>
          <span>Code</span>
        </button>
      </div>

      <nav className="nav-list" aria-label="Primary">
        <NewConvoButton />
        <button type="button" className="nav-item">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m13 2-9 13h7l-1 7 9-13h-7l1-7Z" />
          </svg>
          <span data-i18n="routines">Routines</span>
        </button>
        <button type="button" className="nav-item">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.43 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 3.6 15a1.7 1.7 0 0 0-.6-1A1.7 1.7 0 0 0 1.9 13H2a2 2 0 1 1 0-4h-.1A1.7 1.7 0 0 0 3.6 7a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 8 3.6a1.7 1.7 0 0 0 1-.6A1.7 1.7 0 0 0 9.43 1.9V2a2 2 0 1 1 4 0v-.1A1.7 1.7 0 0 0 15 3.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 7c.15.36.36.7.6 1 .3.25.7.39 1.1.39H21a2 2 0 1 1 0 4h.1c-.4 0-.8.14-1.1.39-.24.3-.45.64-.6 1Z" />
          </svg>
          <span data-i18n="customize">Customize</span>
        </button>
      </nav>

      <SidebarSearch />
      <ConvoList />

      <div className="sidebar-footer">
        <AccountMenu />
        <ConnectionStatus />
      </div>
    </aside>
  );
}

function SidebarSearch() {
  const search = useAppStore((s) => s.convoSearch);
  const setSearch = useAppStore((s) => s.setConvoSearch);
  return (
    <div className="sidebar-search">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        id="convo-search"
        type="search"
        value={search}
        autoComplete="off"
        spellCheck={false}
        placeholder="Search conversations..."
        data-i18n-placeholder="searchPlaceholder"
        aria-label="Search conversations"
        onChange={(e) => setSearch(e.target.value)}
      />
      {search && (
        <button
          type="button"
          className="sidebar-search-clear"
          title="Clear search"
          aria-label="Clear search"
          onClick={() => setSearch("")}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

/// Sidebar "New session" button. Disabled while persistence is off
/// (server returned 503 from `/v1/conversations`); the empty-state
/// banner in the recents column already explains why.
function NewConvoButton() {
  const persistEnabled = useAppStore((s) => s.persistEnabled);
  return (
    <button
      id="new-convo"
      type="button"
      className="nav-item"
      title="New session"
      data-i18n-title="newConversation"
      disabled={!persistEnabled}
      onClick={() => newConversation()}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </svg>
      <span data-i18n="newSession">New session</span>
    </button>
  );
}
